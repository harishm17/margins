// The attempt that comes before "Explain this passage" (spec §5.2), and the turns after it (spec §18.6). One
// definition, read by the margin (to enable the buttons, to word a reply) and by the server (to refuse a request
// without an attempt, to count replies, to choose the turn).

/** The shortest take that counts as an attempt. */
export const MIN_TAKE_CHARS = 8
/** What the one-tap answer stands for, in the student's voice. */
export const CANT_PARSE_TEXT = "I can't parse any of it"

export const isAttempt = (take: string): boolean => take.trim().length >= MIN_TAKE_CHARS

/** The rung of a restatement, asked for once "I can't parse any of it" has been tapped this many times on one passage. */
export const RESTATE_RUNG = 4
export const RESTATE_AFTER_CANT_PARSE = 2
/** Tutor replies a passage gets in one local day: explanations, restatements and verdicts together. */
export const MAX_REPLIES_PER_DAY = 4
/** What the "I don't know" button on a check question stands for. */
export const CHECK_DONT_KNOW_TEXT = "I don't know"

export type CheckVerdict = 'right' | 'partly' | 'not_yet'
export const VERDICT_LABELS: Record<CheckVerdict, string> = { right: 'Right', partly: 'Partly', not_yet: 'Not yet' }
/** The score a verdict is shown with (display only: the answer comes right after an explanation, level 2). */
export const VERDICT_SCORES: Record<CheckVerdict, number> = { right: 1, partly: 0.5, not_yet: 0 }
