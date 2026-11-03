export const CONFIDENCE_LEVELS = [
  { id: 'guess', value: 0.25 },
  { id: 'unsure', value: 0.5 },
  { id: 'fairly', value: 0.75 },
  { id: 'certain', value: 0.95 },
] as const

export type ConfidenceId = (typeof CONFIDENCE_LEVELS)[number]['id']

/** The four words, wherever a student says or reads how sure they were (a question, a quiz as a whole, the progress panel). */
export const CONFIDENCE_WORDS: Record<ConfidenceId, string> = {
  guess: 'Guessing',
  unsure: 'Unsure',
  fairly: 'Fairly sure',
  certain: 'Certain',
}

/**
 * How sure the student was of a whole quiz, on the 1 to 5 the review date reads (the confidence route, spec §8):
 * 1 and 2 bring the review back tomorrow, 4 and up lengthen the interval. The student taps the four words; 3 is unused.
 */
export const QUIZ_RATING: Record<ConfidenceId, number> = { guess: 1, unsure: 2, fairly: 4, certain: 5 }

export const CALIBRATION_MIN_EVENTS = 30

/** Stored value for a confidence tap. A guess is chance level, 1 over the option count. */
export function confidenceValue(id: ConfidenceId, optionCount?: number): number {
  if (id === 'guess' && optionCount && optionCount >= 2) return 1 / optionCount
  return CONFIDENCE_LEVELS.find((l) => l.id === id)!.value
}

export const isConfidenceId = (value: unknown): value is ConfidenceId =>
  CONFIDENCE_LEVELS.some((l) => l.id === value)

/**
 * The level a stored value belongs to, for an answer kept without its level id: the nearest level by
 * the value it stores on this question. On a two-option question a guess and "unsure" both store 0.5;
 * that tie goes to the non-guess level (the later one), because the id is the only thing that tells them apart.
 */
export function confidenceLevelOf(value: number, optionCount?: number): ConfidenceId {
  let best: ConfidenceId = CONFIDENCE_LEVELS[0].id
  let bestGap = Infinity
  for (const level of CONFIDENCE_LEVELS) {
    const gap = Math.abs(confidenceValue(level.id, optionCount) - value)
    if (gap <= bestGap + 1e-9) {
      best = level.id
      bestGap = Math.min(gap, bestGap)
    }
  }
  return best
}

/** The level to show selected: the stored id when there is one, else the one the stored value maps to, else none. */
export function selectedConfidenceLevel(id: unknown, value: number | undefined, optionCount?: number): ConfidenceId | '' {
  if (isConfidenceId(id)) return id
  return value === undefined ? '' : confidenceLevelOf(value, optionCount)
}

export type CalibrationBin ={ label: ConfidenceId; n: number; accuracy: number }

export type CalibrationResult = {
  n: number
  brier: number
  bins: CalibrationBin[]
  ready: boolean
}

/** Answers sharing one stored confidence: how many, the sum of their scores and of their squares. */
export type ConfidenceGroup = { confidence: number; n: number; sumScore: number; sumSquares: number }

/** Pure; pass level-0 events that carry a confidence. Each event goes to the nearest level. */
export function calibration(events: { confidence: number; score: number }[]): CalibrationResult {
  const groups = new Map<number, ConfidenceGroup>()
  for (const e of events) {
    const g = groups.get(e.confidence) ?? { confidence: e.confidence, n: 0, sumScore: 0, sumSquares: 0 }
    g.n += 1
    g.sumScore += e.score
    g.sumSquares += e.score ** 2
    groups.set(e.confidence, g)
  }
  return calibrationFromGroups([...groups.values()])
}

/**
 * `calibration` from totals per stored confidence, for a caller that summed in the database. Each group
 * goes to the nearest level; the Brier sum of (c - s)^2 expands to n*c^2 - 2*c*sum(s) + sum(s^2).
 */
export function calibrationFromGroups(groups: ConfidenceGroup[]): CalibrationResult {
  const sums = CONFIDENCE_LEVELS.map(() => ({ n: 0, score: 0 }))
  let brierSum = 0
  let n = 0
  for (const g of groups) {
    let best = 0
    for (let i = 1; i < CONFIDENCE_LEVELS.length; i++) {
      if (Math.abs(CONFIDENCE_LEVELS[i].value - g.confidence) < Math.abs(CONFIDENCE_LEVELS[best].value - g.confidence)) best = i
    }
    sums[best].n += g.n
    sums[best].score += g.sumScore
    brierSum += g.n * g.confidence ** 2 - 2 * g.confidence * g.sumScore + g.sumSquares
    n += g.n
  }
  return {
    n,
    brier: n ? brierSum / n : 0,
    bins: CONFIDENCE_LEVELS.map((l, i) => ({
      label: l.id,
      n: sums[i].n,
      accuracy: sums[i].n ? sums[i].score / sums[i].n : 0,
    })),
    ready: n >= CALIBRATION_MIN_EVENTS,
  }
}
