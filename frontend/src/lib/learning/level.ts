/**
 * The one adaptivity model (spec 18.6). `conceptBand` is the only place a support level is decided: review
 * selection, drills, quiz generation, the next practice problem, worked-example fading, voice teach-back, Ask and
 * the reader tutor all call it (or one of the small functions below that read a band). Pure.
 *
 * Bands: 0 support, 1 core, 2 stretch.
 *
 * ```
 * ability(c) = q_all(c) · R_now(c)       q_all: recency-weighted mean of the level-0 and level-1 group scores
 *                                        (the §3.6 weights, without the evidence cap)
 * base(c)    = has evidence ? (ability < 0.4 ? 0 : ability < 0.75 ? 1 : 2)
 *            : prior !== null ? (prior < 0.5 ? 0 : prior < 1 ? 1 : 2)
 *            : 0                         // unknown: start with support
 * step(c)    = -1 when lastMaxRung >= 3, the latest event is an IDK, or consecutiveFails >= 1
 *            = +1 when lastMaxRung = 0 and the latest group graded Good or Easy
 *            =  0 otherwise
 * band(c)    = clamp(base + step, 0, 2)
 * ```
 *
 * The label (§3.6) still uses capped mastery: the band decides support, never what the student is told they know.
 * Without the cap, one strong first session raises support at once; the label waits for a delayed success.
 */

import { Rating, type Grade } from 'ts-fsrs'
import { recencyWeightedMean } from './concept-mastery'
import type { ConceptMemoryState } from './memory'

export type Band = 0 | 1 | 2

/** What `conceptBand` reads about one concept. `bandInputsFromState` builds it from a replay. */
export type BandInputs = {
  abilityInputs: {
    /** The scores of the concept's level-0 and level-1 groups, oldest first; a level-1 failure counts as 0. */
    groupScores: { score: number; at: Date }[]
    /** FSRS retrievability now; 0 with no card. */
    retrievability: number
  }
  /** The concept's warm-up score with guessed answers counted as 0 (`warmupPriorByConcept`), or null. */
  prior: number | null
  /** The highest tutor rung used on the concept's latest practice answer, or null. */
  lastMaxRung: number | null
  /** The student's latest answer on the concept was an "I don't know". */
  latestIsIdk: boolean
  consecutiveFails: number
  /** The grade the latest group earned. */
  latestGrade: Grade | null
}

/** A concept nothing is known about: it starts with support (band 0). */
export const UNKNOWN_BAND_INPUTS: BandInputs = {
  abilityInputs: { groupScores: [], retrievability: 0 },
  prior: null,
  lastMaxRung: null,
  latestIsIdk: false,
  consecutiveFails: 0,
  latestGrade: null,
}

const Q_WINDOW = 5
const SUPPORT_BELOW = 0.4
const CORE_BELOW = 0.75
const PRIOR_SUPPORT_BELOW = 0.5
const PRIOR_STRETCH_AT = 1

/** `ability = q_all · R_now`: the recency-weighted mean of the last five group scores times retrievability. */
export function abilityOf(inputs: BandInputs['abilityInputs']): number | null {
  const scores = inputs.groupScores.slice(-Q_WINDOW).map((s) => s.score)
  const q = recencyWeightedMean(scores)
  return q === null ? null : q * inputs.retrievability
}

export function conceptBand(c: BandInputs): Band {
  const ability = abilityOf(c.abilityInputs)
  let base: number
  if (ability !== null) base = ability < SUPPORT_BELOW ? 0 : ability < CORE_BELOW ? 1 : 2
  else if (c.prior !== null) base = c.prior < PRIOR_SUPPORT_BELOW ? 0 : c.prior < PRIOR_STRETCH_AT ? 1 : 2
  else base = 0

  let step = 0
  if ((c.lastMaxRung !== null && c.lastMaxRung >= 3) || c.latestIsIdk || c.consecutiveFails >= 1) step = -1
  else if (c.lastMaxRung === 0 && c.latestGrade !== null && c.latestGrade >= Rating.Good) step = 1
  return Math.min(2, Math.max(0, base + step)) as Band
}

/** The band inputs of a replayed concept. `prior` comes from the topic's warm-up (`warmupPriorByConcept`). */
export function bandInputsFromState(state: ConceptMemoryState, retrievability: number, prior: number | null): BandInputs {
  return {
    abilityInputs: { groupScores: state.level0Scores, retrievability },
    prior,
    lastMaxRung: state.lastMaxRung,
    latestIsIdk: state.lastIdkAt !== null && (state.lastEvidenceAt === null || state.lastIdkAt >= state.lastEvidenceAt),
    consecutiveFails: state.consecutiveFails,
    latestGrade: state.latestGrade,
  }
}

/** The topic's band: the rounded mean of its concepts' bands that are not solid, or 2 when all are solid. */
export function topicBand(bands: { band: Band; solid: boolean }[]): Band {
  if (bands.length === 0) return 0
  const open = bands.filter((b) => !b.solid)
  if (open.length === 0) return 2
  return Math.round(open.reduce((sum, b) => sum + b.band, 0) / open.length) as Band
}

/** The difficulty of a new quiz set (a new set, Fix it now, a retake's same-day replacement), and of review and drill items. */
export function quizDifficultyFor(band: Band): 'easy' | 'medium' | 'hard' {
  return (['easy', 'medium', 'hard'] as const)[band]
}

/** Voice teach-back: how many probes of a gap before the coach explains it. One in band 0, two otherwise. */
export function probesBeforeExplaining(band: Band): 1 | 2 {
  return band === 0 ? 1 : 2
}

/** Ask `understand`: how many non-attempt turns before a short explanation. One in band 0, two otherwise. */
export function askExplainThreshold(band: Band): 1 | 2 {
  return band === 0 ? 1 : 2
}
