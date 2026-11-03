/**
 * The answer the warm-up's "I don't know" button sends (spec 18.3). A warm-up question is a choice, so the answer is an
 * option id and the typed-text detector (`isDontKnow`) does not apply: it would read the option "A" as an admission. The
 * button sends this marker instead. No server or browser imports.
 */
export const WARMUP_IDK_ANSWER = '__idk__'
