/**
 * What the upload list says about files on their way, and SW7's rule for its estimates. Pure, so the rule has unit tests
 * (uploads.test.ts); the workflows collect the moments.
 */

export type Row = { name: string; status: string }
/** The upload list at one moment, `at` ms after the files were chosen. */
export type Moment = { at: number; rows: Row[]; cutOff: string[] }
/** One upload being watched; `earlierDone` when other files had finished before it, so a typical time was known. */
export type Watched = { file: string; earlierDone: boolean; moments: Moment[] }

/** Statuses of a file still on its way: "Uploading 40%", "Reading pages, step 2 of 3, ...". */
const BUSY = /Uploading|step \d of \d/

/** Whether a status is final: ready, or a problem the row explains. */
export const settled = (status: string) => status !== '' && !BUSY.test(status)

/** The estimate in a status, in seconds ("usually about 35 seconds", "a few seconds", "about a minute"), or null. */
export function estimateSeconds(status: string): number | null {
  if (/usually a few seconds/.test(status)) return 10
  if (/usually about a minute/.test(status)) return 60
  const match = /usually about (\d+) (seconds|minutes)/.exec(status)
  return match ? Number(match[1]) * (match[2] === 'minutes' ? 60 : 1) : null
}

/**
 * SW7's estimate rule for one watched upload: an estimate, once shown, is kept to within twice its time or the status says
 * the file is taking longer than usual; and a wait of more than 10 s shows one once earlier files have finished (before
 * then there is nothing to estimate from).
 */
export function estimateProblems({ file, earlierDone, moments }: Watched): string[] {
  const statuses = moments.map((moment) => ({ at: moment.at, status: moment.rows.find((row) => row.name.includes(file))?.status ?? '' }))
  const done = statuses.find((entry) => settled(entry.status))
  if (!done) return [`${file}: never finished`]
  const estimate = statuses.map((entry) => estimateSeconds(entry.status)).find((seconds) => seconds !== null) ?? null
  const seconds = Math.round(done.at / 1000)
  if (estimate === null) return earlierDone && done.at > 10_000 ? [`${file}: no estimate during a ${seconds} s wait`] : []
  const saidLate = statuses.some((entry) => /taking longer than usual/.test(entry.status))
  if (done.at > 2 * estimate * 1000 && !saidLate) return [`${file}: said about ${estimate} s, took ${seconds} s and never said it was late`]
  return []
}
