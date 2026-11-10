import { withPrisma } from '../../e2e/helpers/db'

/**
 * Days passing for one student. Reviews fall due a day or more after a quiz, and the app reads the server's
 * clock, so a workflow that needs "the next day" moves the student's stored times back instead: every time column
 * of every row that is theirs, by whole days. The rest of the database keeps its times. The exam date is a day the
 * student picked on the calendar, so it stays and comes nearer, as it would. The scheduling card inside a concept
 * memory carries its own due and last-review dates, and they move with the row.
 *
 * Call it with no job running: a job's lease moves back too, and the AI service would send the job again.
 */
export async function daysPass(email: string, days = 1): Promise<void> {
  await withPrisma(async (prisma) => {
    const [user] = await prisma.$queryRawUnsafe<{ id: string }[]>('SELECT "id" FROM "users" WHERE "email" = $1', email)
    if (!user) throw new Error(`No student ${email}`)
    const rows = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string; data_type: string }[]>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%' ORDER BY table_name, ordinal_position`
    )
    const statements = shiftStatements(timeColumns(rows), days)
    await prisma.$transaction(statements.map((statement) => prisma.$executeRawUnsafe(statement, user.id)))
    console.log(`note: ${days} day${days === 1 ? '' : 's'} passed for ${email} (${statements.length} tables moved back)`)
  })
}

/** A table's time columns and the columns that say whose a row is. */
export type TimeColumns = { table: string; owners: string[]; times: string[]; cards?: string[] }[]

/** Owner columns in the order they are used: the student, then their course, then the course's topic. */
const OWNERS = ['user_id', 'project_id', 'topic_id'] as const
/** Columns that hold a scheduling card (ts-fsrs) with dates inside it. */
const CARDS: Record<string, string[]> = { concept_memories: ['card'] }
/** Times that are days on the calendar the student picked: they do not move. */
const FIXED: Record<string, string[]> = { projects: ['exam_date'] }

export function timeColumns(rows: { table_name: string; column_name: string; data_type: string }[]): TimeColumns {
  const tables = new Map<string, { owners: string[]; times: string[] }>()
  for (const row of rows) {
    const entry = tables.get(row.table_name) ?? { owners: [], times: [] }
    if ((OWNERS as readonly string[]).includes(row.column_name)) entry.owners.push(row.column_name)
    if (row.data_type.startsWith('timestamp')) entry.times.push(row.column_name)
    tables.set(row.table_name, entry)
  }
  return [...tables].map(([table, entry]) => ({ table, ...entry, ...(CARDS[table] ? { cards: CARDS[table] } : {}) }))
}

/** One UPDATE per table that has the student's rows and times in them; `$1` is the student's id. */
export function shiftStatements(columns: TimeColumns, days: number): string[] {
  if (!Number.isInteger(days) || days < 1) throw new Error(`Days pass in whole days forward, not ${days}`)
  const back = `interval '${days} days'`
  const statements: string[] = []
  for (const { table, owners, times, cards = [] } of columns) {
    const moved = times.filter((column) => !FIXED[table]?.includes(column))
    const where = whose(table, owners)
    if (!where || moved.length + cards.length === 0) continue
    const sets = [
      ...moved.map((column) => `${quote(column)} = ${quote(column)} - ${back}`),
      ...cards.map((column) => `${quote(column)} = ${cardDates(quote(column), back)}`),
    ]
    statements.push(`UPDATE ${quote(table)} SET ${sets.join(', ')} WHERE ${where}`)
  }
  return statements
}

function whose(table: string, owners: string[]): string | null {
  if (table === 'users') return `"id" = $1`
  if (owners.includes('user_id')) return `"user_id" = $1`
  if (owners.includes('project_id')) return `"project_id" IN (SELECT "id" FROM "projects" WHERE "user_id" = $1)`
  if (owners.includes('topic_id'))
    return `"topic_id" IN (SELECT t."id" FROM "topics" t JOIN "projects" p ON p."id" = t."project_id" WHERE p."user_id" = $1)`
  return null
}

/** The card with its `due` and `last_review` moved back; a card without one keeps it as it was. */
function cardDates(card: string, back: string): string {
  const move = (value: string, key: string) =>
    `CASE WHEN ${value}->>'${key}' IS NOT NULL THEN jsonb_set(${value}, '{${key}}', to_jsonb(to_char(((${value}->>'${key}')::timestamptz - ${back}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) ELSE ${value} END`
  return move(`(${move(card, 'due')})`, 'last_review')
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
