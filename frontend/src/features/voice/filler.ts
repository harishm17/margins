/**
 * The neutral line the coach says when a graded answer is still being checked after 1.2 s
 * (spec 19.3), so a graded turn is never silent. Never evaluative (no "good", "okay", "right"),
 * never the same line twice in a row, at most once per turn. The lines are in the session language.
 */

/** Wait this long after the student's turn ended before saying anything. */
export const FILLER_AFTER_MS = 1200

export const FILLER_LINES: Record<string, string[]> = {
  en: ['One moment.', 'Let me look at that.', 'Give me a second.', 'Just a moment.', 'Let me think about that.'],
  es: ['Un momento.', 'Déjame verlo.', 'Dame un segundo.'],
  fr: ['Un instant.', 'Je regarde ça.', 'Donnez-moi une seconde.'],
  de: ['Einen Moment.', 'Ich schaue mir das an.', 'Gib mir kurz Zeit.'],
  it: ['Un momento.', 'Fammi guardare.', 'Dammi un secondo.'],
  pt: ['Um momento.', 'Deixa eu ver.', 'Me dá um segundo.'],
  hi: ['एक पल।', 'ज़रा रुकिए।', 'मुझे एक सेकंड दीजिए।'],
  zh: ['稍等一下。', '我看一下。', '给我一秒钟。'],
  ja: ['少々お待ちください。', '確認します。', '少し時間をください。'],
  ko: ['잠시만요.', '확인해 볼게요.', '잠깐만 기다려 주세요.'],
}

/** One line from the language's pool that is not `last`. English when the language has no pool. */
export function pickFiller(language: string, last: string | null, random: () => number = Math.random): string {
  const pool = FILLER_LINES[language] ?? FILLER_LINES.en
  const choices = pool.filter((line) => line !== last)
  const from = choices.length > 0 ? choices : pool
  return from[Math.min(from.length - 1, Math.floor(random() * from.length))]
}

/**
 * How much longer to wait before the line is due: 1.2 s after the turn ended, counted from now.
 * Zero when that time has already passed.
 */
export function fillerWaitMs(turnEndedAt: number, now: number): number {
  return Math.max(0, turnEndedAt + FILLER_AFTER_MS - now)
}
