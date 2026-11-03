/**
 * How many voice turns (and graded voice answers) one student may send in a minute. 30 is far past anyone
 * talking to the coach. The e2e stack raises it (scripts/e2e-stack.sh): every voice spec signs in as the same
 * account, and together they send more turns in a minute than a person would.
 */
export function voiceTurnsPerMinute(): number {
  const raw = Number(process.env.VOICE_TURNS_PER_MINUTE)
  return Number.isInteger(raw) && raw > 0 ? raw : 30
}
