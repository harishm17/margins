import { prisma } from '@/lib/db/prisma'
import { computeSpendKey } from './spend-key'
import { recordSpendAccount } from './spend-key-store'

const BATCH = 200

/**
 * Gives every account made before spend keys its key, then stamps the key on the spend and voice minutes recorded
 * before it existed. Safe to run again and from several servers at once: each step only fills what is empty.
 * (spendKeyFor() does the same for one account on demand, so nothing waits for this.)
 */
export async function backfillSpendKeys(): Promise<{ users: number }> {
  let users = 0
  for (;;) {
    const batch = await prisma.user.findMany({
      where: { spendKey: null },
      select: { id: true, email: true, oauthProvider: true, oauthId: true, createdAt: true },
      take: BATCH,
    })
    if (batch.length === 0) break
    for (const user of batch) {
      const spendKey = computeSpendKey(user)
      await recordSpendAccount(spendKey, user.createdAt)
      await prisma.user.updateMany({ where: { id: user.id, spendKey: null }, data: { spendKey } })
      users += 1
    }
  }
  await prisma.$executeRaw`
    UPDATE llm_usage_events e SET spend_key = u.spend_key
    FROM users u
    WHERE e.user_id = u.id AND e.spend_key IS NULL AND u.spend_key IS NOT NULL`
  await prisma.$executeRaw`
    UPDATE voice_usage v SET spend_key = u.spend_key
    FROM voice_drill_sessions s JOIN users u ON u.id = s.user_id
    WHERE v.session_id = s.id AND v.spend_key IS NULL AND u.spend_key IS NOT NULL`
  return { users }
}
