// Test helpers (database tests only): make writes fail for one user, the way a database error after a
// result committed would, until the returned function is called.
import type { PrismaClient } from '@prisma/client'

async function refuseWrites(prisma: PrismaClient, userId: string, table: string, events: string, when: string) {
  const user = userId.replace(/'/g, '')
  const name = `fail_${table}_${userId.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'write refused'; END $$`
  )
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE ${events} ON ${table} FOR EACH ROW WHEN (NEW.user_id = '${user}'${when}) EXECUTE FUNCTION ${name}()`
  )
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`)
  }
}

/** Inserts into evidence_events fail for the user. */
export const failEvidenceWrites = (prisma: PrismaClient, userId: string) =>
  refuseWrites(prisma, userId, 'evidence_events', 'INSERT', '')

/** Marking an exam submission's evidence as written fails for the user. */
export const failExamEvidenceMarking = (prisma: PrismaClient, userId: string) =>
  refuseWrites(prisma, userId, 'exam_submissions', 'UPDATE', ' AND NEW.evidence_recorded_at IS NOT NULL')
