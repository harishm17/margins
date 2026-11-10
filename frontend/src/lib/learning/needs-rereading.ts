/**
 * "Needs re-reading": an active idea with no claim left. Its claims were taken from a file that was deleted (or replaced),
 * so nothing from the student's pages backs it any more. It is derived, not stored: a re-quote job that finds new quotes
 * for it ends the state by writing claims.
 *
 * Every reader that grades against, quotes or points at an idea's claims skips such an idea (or says it needs re-reading)
 * rather than point at nothing; use `needsRereadingWhere` to find them; readers that need something to quote filter on `claims: { some: {} }`.
 */

import type { Prisma } from '@prisma/client'

// An idea the student wrote themselves (origin 'student') never had claims, so it is not one that lost them.
export const needsRereadingWhere = { status: 'active', origin: { not: 'student' }, claims: { none: {} } } satisfies Prisma.ConceptWhereInput

/** Words the screens use, so they agree. */
export const NEEDS_REREADING_TEXT = 'Nothing from your pages is attached to this idea now, so it stays out of recall checks until it is read again.'
