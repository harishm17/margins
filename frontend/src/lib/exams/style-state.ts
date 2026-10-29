/**
 * Whether "Match my past exams" has something to match, and if not, why. Pure: the query in
 * server/queries/mock-exams.ts gathers the inputs.
 *
 * A past-exam file gets a style profile from a `profile_exam` job (a model call) once it has been
 * read. So for the course's past-exam files:
 * - ready: at least one has a profile;
 * - analysing: one is still being read, or its profile job has not finished;
 * - failed: the latest profile job of one of them failed (the code says why);
 * - unavailable: every file was read and analysed, but none gave a style (for example the
 *   analysis decided a file is not an exam);
 * - none: the course has no past-exam file.
 */

export type ExamStyleKind = 'ready' | 'analysing' | 'failed' | 'unavailable' | 'none'

export type ExamStyleFile = {
  id: string
  /** pending while the file is still being checked; valid or invalid after. */
  validationStatus: string
  hasProfile: boolean
}

/** The latest profile_exam job of a file. */
export type ExamStyleJob = { materialId: string; status: string; errorCode: string | null }

export type ExamStyleState = {
  kind: ExamStyleKind
  /** Past-exam files in the course. */
  files: number
  /** For `failed`: the error code of a failed analysis. */
  errorCode: string | null
  /** Files whose analysis failed (for the materials rows). */
  failedFileIds: string[]
}

export const examProfileTarget = (materialId: string) => `profile:${materialId}`

/** The material id of a "profile:<id>" target key, or null. */
export function materialIdFromProfileTarget(targetKey: string | null | undefined): string | null {
  const match = /^profile:(.+)$/.exec(targetKey ?? '')
  return match ? match[1] : null
}

const ACTIVE = ['pending', 'processing']

/** `jobs` newest first; only the first job per file counts. */
export function deriveExamStyleState(files: ExamStyleFile[], jobs: ExamStyleJob[]): ExamStyleState {
  const latest = new Map<string, ExamStyleJob>()
  for (const job of jobs) if (!latest.has(job.materialId)) latest.set(job.materialId, job)

  const failedFiles = files.filter((file) => !file.hasProfile && latest.get(file.id)?.status === 'failed')
  const base = { files: files.length, errorCode: null, failedFileIds: failedFiles.map((file) => file.id) }

  if (files.length === 0) return { ...base, kind: 'none' }
  if (files.some((file) => file.hasProfile)) return { ...base, kind: 'ready' }
  const busy = files.some(
    (file) => file.validationStatus === 'pending' || ACTIVE.includes(latest.get(file.id)?.status ?? '')
  )
  if (busy) return { ...base, kind: 'analysing' }
  if (failedFiles.length > 0) {
    return { ...base, kind: 'failed', errorCode: latest.get(failedFiles[0].id)?.errorCode ?? null }
  }
  return { ...base, kind: 'unavailable' }
}
