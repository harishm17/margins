/**
 * Prints P50 and P95 of the voice turn timings per mode (spec 19.10), from voice_turn_timings:
 *
 *   cd frontend && set -a && . ./.env && set +a && npx tsx scripts/voice-timing.ts [--days 7]
 *
 * "graded" turns are the ones that ran a graded step (the answer was assessed or recorded); the rest are asks, greetings and
 * requests. The browser's request-to-first-sentence comes from the timing the client sends with the next turn.
 */
import { prisma } from '../src/lib/db/prisma'
import { formatSummary, summarizeTimings } from '../src/lib/voice/turn-timing'

async function main() {
  const flag = process.argv.indexOf('--days')
  const days = flag >= 0 ? Number(process.argv[flag + 1]) : 7
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days takes a positive number')
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await prisma.voiceTurnTiming.findMany({ where: { createdAt: { gte: since } } })
  console.log(`${rows.length} voice turns since ${since.toISOString().slice(0, 10)}`)
  console.log(formatSummary(summarizeTimings(rows)))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
