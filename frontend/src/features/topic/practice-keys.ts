import type { PracticeProblem } from './types'

/** Practice step keys and progress parsing: plain functions, usable on the server and in the browser. */

/**
 * Step keys the student solved, was shown the answer to, or took a hint on; the steps with a checked
 * answer and the ones right on the first check; the highest help rung used per step; the rung each
 * step had reached at its first wrong check (a step is in it only if a miss was recorded); and the
 * answers to "What tripped you up?" by problem (`<problem index>|<title>`).
 */
export type PracticeProgress = {
  solved: string[]
  revealed: string[]
  hinted: string[]
  attempted: string[]
  firstTry: string[]
  rungs: Record<string, number>
  missRungs: Record<string, number>
  trippedUp: Record<string, string>
  /** Steps where "I don't know" was pressed. Kept in this browser only, to choose the next problem; the server has its own record. */
  idk?: string[]
}

/** The rung of a hint opened before rungs existed: the old single hint is the connect hint. */
const LEGACY_HINT_RUNG = 3

export const EMPTY: PracticeProgress = { solved: [], revealed: [], hinted: [], attempted: [], firstTry: [], rungs: {}, missRungs: {}, trippedUp: {} }
export const practiceStepKey = (problemIndex: number, title: string, stepIndex: number): string =>
  `${problemIndex}|${title}|${stepIndex}`
export const problemKey = (problemIndex: number, title: string): string => `${problemIndex}|${title}`

/** Every step key of the current practice content, in order. */
export function practiceKeys(problems: PracticeProblem[] | undefined): string[] {
  return (problems ?? []).flatMap((problem, problemIndex) =>
    problem.steps.map((_step, stepIndex) => practiceStepKey(problemIndex, problem.title, stepIndex))
  )
}

const isRung = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 5

export function parseProgress(raw: string | null | undefined): PracticeProgress {
  if (!raw) return EMPTY
  try {
    const value = JSON.parse(raw) as Partial<PracticeProgress>
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [])
    const isMap = (map: unknown): map is Record<string, unknown> => !!map && typeof map === 'object' && !Array.isArray(map)
    const solved = strings(value.solved)
    const revealed = strings(value.revealed)
    const hinted = strings(value.hinted)
    // Progress stored before rungs: every finished step was checked or had its hint opened, and a hint was the connect hint.
    const stored = Array.isArray(value.attempted)
    const rungs: Record<string, number> = {}
    if (isMap(value.rungs)) for (const [key, rung] of Object.entries(value.rungs)) if (isRung(rung)) rungs[key] = rung
    if (!stored) for (const key of hinted) rungs[key] = LEGACY_HINT_RUNG
    const missRungs: Record<string, number> = {}
    if (isMap(value.missRungs)) for (const [key, rung] of Object.entries(value.missRungs)) if (isRung(rung)) missRungs[key] = rung
    const trippedUp: Record<string, string> = {}
    if (isMap(value.trippedUp)) for (const [key, answer] of Object.entries(value.trippedUp)) if (typeof answer === 'string') trippedUp[key] = answer
    return {
      solved,
      revealed,
      hinted,
      attempted: stored ? strings(value.attempted) : [...new Set([...solved, ...revealed])],
      firstTry: strings(value.firstTry),
      rungs,
      missRungs,
      trippedUp,
      ...(Array.isArray(value.idk) ? { idk: strings(value.idk) } : {}),
    }
  } catch {
    return EMPTY
  }
}

export function solvedCount(progress: PracticeProgress, keys: string[]): number {
  const solved = new Set(progress.solved)
  return keys.filter((key) => solved.has(key)).length
}

/** At least this share of the steps solved counts the practice as done. */
export const PRACTICE_DONE_SHARE = 0.8

// ---------------------------------------------------------------------------------------
// Step keys and the server's per-problem rows

/** A key taken apart: "2|Title with | in it|1" is problem 2, that title, step 1. Null when it is not a key. */
export function parseStepKey(key: string): { problemIndex: number; title: string; stepIndex: number } | null {
  const first = key.indexOf('|')
  const last = key.lastIndexOf('|')
  if (first <= 0 || last <= first) return null
  const problemIndex = Number(key.slice(0, first))
  const stepIndex = Number(key.slice(last + 1))
  if (!Number.isInteger(problemIndex) || !Number.isInteger(stepIndex) || problemIndex < 0 || stepIndex < 0) return null
  return { problemIndex, title: key.slice(first + 1, last), stepIndex }
}

/**
 * One problem's progress as the server stores it: step positions (0-based) by state. The fields
 * after `hintedSteps` are absent on rows and uploads from before rungs: the server then records
 * no practice evidence for the problem.
 */
export type ProblemProgress = {
  problemIndex: number
  problemTitle: string
  solvedSteps: number[]
  revealedSteps: number[]
  hintedSteps: number[]
  /** Steps with a checked answer; steps right on the first check; the highest rung per step (step -> rung). */
  attemptedSteps?: number[]
  firstTrySteps?: number[]
  maxRungs?: Record<string, number>
  /** Step -> the rung reached at its first wrong check; a step is here only if a miss was stored. */
  missRungs?: Record<string, number>
  /** The student's answer to "What tripped you up?". */
  trippedUp?: string
}

const sortedUnique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b)

/** Local progress grouped by problem (a problem is its position and title). */
export function groupProgress(progress: PracticeProgress): ProblemProgress[] {
  type Group = ProblemProgress & {
    attemptedSteps: number[]
    firstTrySteps: number[]
    maxRungs: Record<string, number>
    missRungs: Record<string, number>
  }
  const groups = new Map<string, Group>()
  const groupOf = (parsed: { problemIndex: number; title: string }): Group => {
    const id = problemKey(parsed.problemIndex, parsed.title)
    const group = groups.get(id) ?? {
      problemIndex: parsed.problemIndex,
      problemTitle: parsed.title,
      solvedSteps: [],
      revealedSteps: [],
      hintedSteps: [],
      attemptedSteps: [],
      firstTrySteps: [],
      maxRungs: {},
      missRungs: {},
    }
    groups.set(id, group)
    return group
  }
  const add = (keys: string[], field: 'solvedSteps' | 'revealedSteps' | 'hintedSteps' | 'attemptedSteps' | 'firstTrySteps') => {
    for (const key of keys) {
      const parsed = parseStepKey(key)
      if (parsed) groupOf(parsed)[field].push(parsed.stepIndex)
    }
  }
  add(progress.solved, 'solvedSteps')
  add(progress.revealed, 'revealedSteps')
  add(progress.hinted, 'hintedSteps')
  add(progress.attempted, 'attemptedSteps')
  add(progress.firstTry, 'firstTrySteps')
  for (const [key, rung] of Object.entries(progress.rungs)) {
    const parsed = parseStepKey(key)
    if (parsed) groupOf(parsed).maxRungs[String(parsed.stepIndex)] = rung
  }
  for (const [key, rung] of Object.entries(progress.missRungs)) {
    const parsed = parseStepKey(key)
    if (parsed) groupOf(parsed).missRungs[String(parsed.stepIndex)] = rung
  }
  for (const [id, answer] of Object.entries(progress.trippedUp)) {
    const first = id.indexOf('|')
    const problemIndex = Number(id.slice(0, first))
    if (first > 0 && Number.isInteger(problemIndex) && answer.trim()) groupOf({ problemIndex, title: id.slice(first + 1) }).trippedUp = answer
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      solvedSteps: sortedUnique(group.solvedSteps),
      revealedSteps: sortedUnique(group.revealedSteps).filter((step) => !group.solvedSteps.includes(step)),
      hintedSteps: sortedUnique(group.hintedSteps),
      attemptedSteps: sortedUnique(group.attemptedSteps),
      firstTrySteps: sortedUnique(group.firstTrySteps),
    }))
    .sort((a, b) => a.problemIndex - b.problemIndex)
}

/** Server rows back into local keys. */
export function progressFromProblems(problems: ProblemProgress[]): PracticeProgress {
  const key = (problem: ProblemProgress, step: number) => practiceStepKey(problem.problemIndex, problem.problemTitle, step)
  const rungs: Record<string, number> = {}
  const missRungs: Record<string, number> = {}
  const trippedUp: Record<string, string> = {}
  for (const problem of problems) {
    for (const [step, rung] of Object.entries(problem.missRungs ?? {})) missRungs[key(problem, Number(step))] = rung
    for (const [step, rung] of Object.entries(problem.maxRungs ?? {})) rungs[key(problem, Number(step))] = rung
    // A hint opened before rungs were stored was the connect hint.
    for (const step of problem.hintedSteps) rungs[key(problem, step)] ??= LEGACY_HINT_RUNG
    if (problem.trippedUp) trippedUp[problemKey(problem.problemIndex, problem.problemTitle)] = problem.trippedUp
  }
  return {
    solved: problems.flatMap((problem) => problem.solvedSteps.map((step) => key(problem, step))),
    revealed: problems.flatMap((problem) => problem.revealedSteps.map((step) => key(problem, step))),
    hinted: problems.flatMap((problem) => problem.hintedSteps.map((step) => key(problem, step))),
    // Rows from before rungs store no attempts: a finished step was checked or had its hint opened.
    attempted: problems.flatMap((problem) =>
      sortedUnique([...(problem.attemptedSteps ?? []), ...problem.solvedSteps, ...problem.revealedSteps]).map((step) => key(problem, step))
    ),
    firstTry: problems.flatMap((problem) => (problem.firstTrySteps ?? []).map((step) => key(problem, step))),
    rungs,
    missRungs,
    trippedUp,
  }
}

/** Progress with everything of one problem taken out (to put the server's state of it in its place). */
export function withoutProblem(progress: PracticeProgress, problemIndex: number, title: string): PracticeProgress {
  const other = (key: string) => {
    const parsed = parseStepKey(key)
    return !parsed || parsed.problemIndex !== problemIndex || parsed.title !== title
  }
  const keep = <T,>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([key]) => other(key)))
  return {
    solved: progress.solved.filter(other),
    revealed: progress.revealed.filter(other),
    hinted: progress.hinted.filter(other),
    attempted: progress.attempted.filter(other),
    firstTry: progress.firstTry.filter(other),
    rungs: keep(progress.rungs),
    missRungs: keep(progress.missRungs),
    trippedUp: Object.fromEntries(Object.entries(progress.trippedUp).filter(([id]) => id !== problemKey(problemIndex, title))),
  }
}

/**
 * The progress with one problem replaced by the server's row of it (or emptied when the server has
 * none): the server's state wins for that problem and nothing of the browser's is kept. Used when the
 * server refuses a save.
 */
export function replaceProblem(
  progress: PracticeProgress,
  problemIndex: number,
  title: string,
  server: ProblemProgress | null
): PracticeProgress {
  const rest = withoutProblem(progress, problemIndex, title)
  if (!server) return rest
  const theirs = progressFromProblems([server])
  return {
    solved: [...rest.solved, ...theirs.solved],
    revealed: [...rest.revealed, ...theirs.revealed],
    hinted: [...rest.hinted, ...theirs.hinted],
    attempted: [...rest.attempted, ...theirs.attempted],
    firstTry: [...rest.firstTry, ...theirs.firstTry],
    rungs: { ...rest.rungs, ...theirs.rungs },
    missRungs: { ...rest.missRungs, ...theirs.missRungs },
    trippedUp: { ...rest.trippedUp, ...theirs.trippedUp },
  }
}

const sameProblem = (a: { problemIndex: number; problemTitle: string }, b: { problemIndex: number; problemTitle: string }) =>
  a.problemIndex === b.problemIndex && a.problemTitle === b.problemTitle

/**
 * What a browser holds after loading: the server's rows are authoritative for the problems they cover
 * (another device may have worked on them, or started one over), and local progress is kept for
 * problems the server has no row for yet. `toUpload` lists those local-only problems, to be sent once.
 */
export function mergeServerProgress(
  local: PracticeProgress,
  server: ProblemProgress[]
): { merged: PracticeProgress; toUpload: ProblemProgress[] } {
  const localGroups = groupProgress(local)
  const localOnly = localGroups.filter((group) => !server.some((row) => row.problemIndex === group.problemIndex))
  // A server row for the same position but another title is an older rewrite: the local group is stale too.
  const staleLocal = localGroups.filter((group) => server.some((row) => row.problemIndex === group.problemIndex && !sameProblem(row, group)))
  const keep = localOnly.filter((group) => !staleLocal.includes(group))
  return { merged: progressFromProblems([...server, ...keep]), toUpload: keep }
}

/** Score of a finished problem: steps solved without a hint, over all its steps. */
export function problemScore(problem: Pick<ProblemProgress, 'solvedSteps' | 'hintedSteps'>, stepsTotal: number): number {
  if (stepsTotal <= 0) return 0
  const hinted = new Set(problem.hintedSteps)
  const clean = problem.solvedSteps.filter((step) => !hinted.has(step)).length
  return Math.min(1, clean / stepsTotal)
}

/** Every step is solved or shown. */
export function problemFinished(problem: Pick<ProblemProgress, 'solvedSteps' | 'revealedSteps'>, stepsTotal: number): boolean {
  if (stepsTotal <= 0) return false
  const closed = new Set([...problem.solvedSteps, ...problem.revealedSteps])
  return closed.size >= stepsTotal
}

/** Step positions cleaned for storage: whole numbers inside the problem, once each, solved over shown. */
export function cleanSteps(
  input: { solvedSteps: number[]; revealedSteps: number[]; hintedSteps: number[] },
  stepsTotal: number
): { solvedSteps: number[]; revealedSteps: number[]; hintedSteps: number[] } {
  const inside = (values: number[]) => sortedUnique(values.filter((value) => Number.isInteger(value) && value >= 0 && value < stepsTotal))
  const solvedSteps = inside(input.solvedSteps)
  return {
    solvedSteps,
    revealedSteps: inside(input.revealedSteps).filter((step) => !solvedSteps.includes(step)),
    hintedSteps: inside(input.hintedSteps),
  }
}

/** Step positions of one list, whole numbers inside the problem, once each. */
export const cleanStepList = (values: number[], stepsTotal: number): number[] =>
  sortedUnique(values.filter((value) => Number.isInteger(value) && value >= 0 && value < stepsTotal))

/** Rungs by step position: whole numbers 0 to 5 for steps inside the problem; anything else is dropped. */
export function cleanRungs(rungs: Record<string, number> | null | undefined, stepsTotal: number): Record<string, number> {
  const clean: Record<string, number> = {}
  for (const [step, rung] of Object.entries(rungs ?? {})) {
    const index = Number(step)
    if (Number.isInteger(index) && index >= 0 && index < stepsTotal && isRung(rung)) clean[String(index)] = rung
  }
  return clean
}

/** The union of two stored states of one problem (used when local progress is uploaded for the first time). */
export function unionSteps(
  a: { solvedSteps: number[]; revealedSteps: number[]; hintedSteps: number[] },
  b: { solvedSteps: number[]; revealedSteps: number[]; hintedSteps: number[] }
) {
  return {
    solvedSteps: sortedUnique([...a.solvedSteps, ...b.solvedSteps]),
    revealedSteps: sortedUnique([...a.revealedSteps, ...b.revealedSteps]),
    hintedSteps: sortedUnique([...a.hintedSteps, ...b.hintedSteps]),
  }
}
