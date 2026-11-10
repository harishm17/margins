/**
 * A4: prints time, cost and prompt-cache use per kind of work, as Markdown tables (see src/lib/usage/table.ts):
 *
 *   cd frontend && set -a && . ./.env && set +a && npx tsx scripts/usage-table.ts [--days 30]
 *
 * It only reads. Jobs are the completed ones, timed from start to finish of their last attempt; a failed attempt's
 * spend is on the ledger, not here. On a database from before A4, jobs have no split by purpose and the ledger's cache
 * columns read as unknown (each column is read from the row as JSON, so a missing one is null, not an error).
 */
import { prisma } from '../src/lib/db/prisma'
import { formatUsageTables, jobUsageFromRow, ledgerUsageFromRow } from '../src/lib/usage/table'

async function main() {
  const flag = process.argv.indexOf('--days')
  const days = flag >= 0 ? Number(process.argv[flag + 1]) : 30
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days takes a positive number')
  const since = new Date(Date.now() - days * 86_400_000)

  const jobs = await prisma.$queryRaw<{ job_type: string; input_data: unknown; seconds: number | null; llm_cost_usd: unknown; result_data: unknown }[]>`
    SELECT job_type, input_data, result_data, llm_cost_usd::float8 AS llm_cost_usd,
           EXTRACT(EPOCH FROM (completed_at - started_at))::float8 AS seconds
    FROM processing_jobs
    WHERE status = 'completed' AND created_at >= ${since}`
  const ledger = await prisma.$queryRaw<{ source: string; cost_usd: unknown; output_tokens: unknown; cache_read: unknown; cache_write: unknown; reply: unknown }[]>`
    SELECT e.source, e.cost_usd::float8 AS cost_usd, e.output_tokens,
           (to_jsonb(e) ->> 'cache_read_tokens')::int AS cache_read,
           (to_jsonb(e) ->> 'cache_write_tokens')::int AS cache_write,
           m.content AS reply
    FROM llm_usage_events e
    LEFT JOIN chat_messages m ON e.source = 'chat' AND m.id = e.source_id AND m.role = 'assistant'
    WHERE e.source <> 'job' AND e.created_at >= ${since}`

  console.log(`${jobs.length} completed jobs and ${ledger.length} other ledger rows since ${since.toISOString().slice(0, 10)}\n`)
  console.log(formatUsageTables({ jobs: jobs.map(jobUsageFromRow), ledger: ledger.map(ledgerUsageFromRow), days }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
