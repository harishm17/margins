import { prisma } from '@/lib/db/prisma'
import { computeSpendKey } from './spend-key'

/** Records when a key was first seen. Kept after the account is deleted: the AI service reads an account's age from it. */
export async function recordSpendAccount(spendKey: string, firstSeenAt?: Date): Promise<void> {
  await prisma.spendAccount.createMany({
    data: [{ spendKey, ...(firstSeenAt ? { firstSeenAt } : {}) }],
    skipDuplicates: true,
  })
}

/**
 * The account's spend key, computed and stored now if the account does not have one yet (an account made before spend
 * keys, until the start-up backfill reaches it). Null only when the user is gone.
 */
export async function spendKeyFor(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, oauthProvider: true, oauthId: true, spendKey: true, createdAt: true },
  })
  if (!user) return null
  if (user.spendKey) return user.spendKey
  const spendKey = computeSpendKey(user)
  await recordSpendAccount(spendKey, user.createdAt)
  await prisma.user.updateMany({ where: { id: userId, spendKey: null }, data: { spendKey } })
  return spendKey
}
