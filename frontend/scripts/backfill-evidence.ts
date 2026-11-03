/**
 * Turns existing quiz, exam, practice and voice history into learner-model evidence (spec §12).
 * Idempotent and safe to re-run: a source row that already has evidence is skipped, so a second run
 * writes nothing. The course overview does the same for a project the first time it is opened once
 * all its topics have concepts; this runs it ahead of that, for every project or one.
 *
 * Run (from the frontend directory, with DATABASE_URL set):
 *   set -a && . ./.env && set +a && npx tsx scripts/backfill-evidence.ts [projectId] [--tz=Area/City] [--again]
 *
 * Without --again, a project is run only when every topic has concepts and it is not yet marked
 * (evidence_backfilled_at). With --again every project that has concepts is run again, which still
 * writes only what is missing.
 */
import { prisma } from '@/lib/db/prisma'
import { backfillEvidence, backfillIfDue } from '@/lib/learning/backfill'

async function main() {
  const args = process.argv.slice(2)
  const timeZone = args.find((arg) => arg.startsWith('--tz='))?.slice(5) || 'UTC'
  const again = args.includes('--again')
  const projectId = args.find((arg) => !arg.startsWith('--'))

  const projects = await prisma.project.findMany({
    where: projectId ? { id: projectId } : {},
    select: { id: true, userId: true, name: true },
    orderBy: { createdAt: 'asc' },
  })
  let events = 0
  for (const project of projects) {
    if (again) {
      const result = await backfillEvidence(project.userId, project.id, { timeZone })
      events += result.events
      console.log(`${project.id} ${project.name}: ${result.events} events`)
    } else {
      const outcome = await backfillIfDue(project.userId, project.id, { timeZone })
      console.log(`${project.id} ${project.name}: ${outcome}`)
    }
  }
  console.log(`${projects.length} projects${again ? `, ${events} events written` : ''}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
