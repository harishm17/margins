/**
 * NextAuth configuration
 */

import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import GoogleProvider from 'next-auth/providers/google'
import { prisma } from '@/lib/db/prisma'
import { trackFromRequest } from '@/lib/analytics/server'
import { resolveAuthSecret } from './secret'
import { decideGoogleSignIn } from './google-link'
import { ACCOUNT_GONE, assertAccountExists } from './account-check'
import { googleOAuthSettings } from './google-config'
import { isLocalRequest, isTestLoginEmail, isTestLoginEnabled, TEST_LOGIN_PROVIDER_ID } from './test-login'

const nextAuthSecret = resolveAuthSecret()
const google = googleOAuthSettings(process.env)
const testLogin = isTestLoginEnabled(process.env)

/**
 * Which ways to sign in this server offers, for the login page. (A credentials provider reports its
 * id as "credentials" until NextAuth reads its options, so the providers list cannot tell.)
 */
export const signInMethods = { google: google !== null, testLogin } as const

export const authOptions: NextAuthOptions = {
  providers: [
    // Google is the only way students sign in. A deployed server refuses to start without it
    // (startup.ts); locally the login page says it is not set up.
    ...(google ? [GoogleProvider({ clientId: google.clientId, clientSecret: google.clientSecret })] : []),
    // The test sign-in for e2e, screenshots and local development: see test-login.ts for its fences.
    ...(testLogin
      ? [
          CredentialsProvider({
            id: TEST_LOGIN_PROVIDER_ID,
            name: 'Test sign-in',
            credentials: {
              email: { label: 'Email', type: 'email' },
              name: { label: 'Name', type: 'text' },
            },
            async authorize(credentials, req) {
              if (!isTestLoginEnabled(process.env) || !isLocalRequest(req?.headers)) return null
              const email = credentials?.email?.trim().toLowerCase() ?? ''
              if (!isTestLoginEmail(email)) return null
              const name = credentials?.name?.trim() || null
              // Signs in to the account with this email, making it the first time.
              const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, name } })
              return { id: user.id, email: user.email, name: user.name }
            },
          }),
        ]
      : []),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      // Handle OAuth sign-in (Google)
      if (account?.provider === 'google') {
        const email = user.email?.toLowerCase()
        if (!email) return false

        const existingUser = await prisma.user.findUnique({
          where: { email },
        })

        const decision = decideGoogleSignIn({
          emailVerified: (profile as { email_verified?: unknown } | undefined)?.email_verified,
          providerAccountId: account.providerAccountId,
          existing: existingUser
            ? { oauthProvider: existingUser.oauthProvider, oauthId: existingUser.oauthId }
            : null,
        })

        if (decision.action === 'refuse') {
          // Sends the browser back to the login page, which explains why.
          return `/login?error=${decision.error}`
        }

        let signedInUser = existingUser
        if (decision.action === 'link' && existingUser) {
          // An account made with a password before sign-in became Google only: the same verified
          // email, so it is the same person.
          await prisma.user.update({
            where: { id: existingUser.id },
            data: {
              oauthProvider: account.provider,
              oauthId: account.providerAccountId,
              name: user.name || existingUser.name,
            },
          })
        } else if (decision.action === 'create') {
          signedInUser = await prisma.user.create({
            data: {
              email,
              name: user.name,
              oauthProvider: account.provider,
              oauthId: account.providerAccountId,
            },
          })
        }

        // Funnel: a new account is a signup, any other sign-in a login (no account detail is sent).
        trackFromRequest(decision.action === 'create' ? 'signup_completed' : 'login_completed')

        // Set user.id for JWT callback
        if (signedInUser) user.id = signedInUser.id
      }
      return true
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.email = user.email
        token.name = user.name
        return token
      }
      // Every later read: a token for a deleted account signs out (see account-check).
      await assertAccountExists(token.id, async (id) => (await prisma.user.count({ where: { id } })) > 0)
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string
        session.user.email = token.email as string
        session.user.name = token.name as string
      }
      return session
    },
  },
  logger: {
    error(code, metadata) {
      // Common when a cookie was signed with an older NEXTAUTH_SECRET.
      // Keep runtime logs clean while users refresh/sign in again.
      const metadataMessage =
        typeof metadata === 'object' && metadata && 'message' in metadata
          ? String((metadata as { message?: unknown }).message ?? '')
          : ''
      const metadataUrl =
        typeof metadata === 'object' && metadata && 'url' in metadata
          ? String((metadata as { url?: unknown }).url ?? '')
          : ''
      if (
        code === 'JWT_SESSION_ERROR' &&
        metadataMessage.toLowerCase().includes('decryption operation failed')
      ) {
        return
      }
      // A session of a deleted account, signed out on purpose (see account-check).
      if (code === 'JWT_SESSION_ERROR' && metadataMessage === ACCOUNT_GONE) {
        return
      }
      if (
        code === 'CLIENT_FETCH_ERROR' &&
        metadataUrl === '/api/auth/session' &&
        metadataMessage.toLowerCase().includes('load failed')
      ) {
        return
      }
      console.error(`[next-auth][error][${code}]`, metadata)
    },
  },
  secret: nextAuthSecret,
}
