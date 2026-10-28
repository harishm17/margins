/**
 * NextAuth configuration
 */

import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import GoogleProvider from 'next-auth/providers/google'
import { compare } from 'bcryptjs'
import { prisma } from '@/lib/db/prisma'
import { resolveAuthSecret } from './secret'
import { decideGoogleSignIn } from './google-link'
import { ACCOUNT_GONE, assertAccountExists } from './account-check'

const nextAuthSecret = resolveAuthSecret()

export const authOptions: NextAuthOptions = {
  providers: [
    // Google sign-in only when its OAuth client is configured; the login page asks which
    // providers exist before showing the button.
    ...(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
          }),
        ]
      : []),
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error('Email and password are required')
        }

        // Find user by email
        const user = await prisma.user.findUnique({
          where: { email: credentials.email.toLowerCase() },
        })

        if (!user || !user.passwordHash) {
          throw new Error('Invalid email or password')
        }

        // Verify password
        const isPasswordValid = await compare(
          credentials.password,
          user.passwordHash
        )

        if (!isPasswordValid) {
          throw new Error('Invalid email or password')
        }

        // Return user object
        return {
          id: user.id,
          email: user.email,
          name: user.name,
        }
      },
    }),
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
          // A password account the same person is now reaching through Google.
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
