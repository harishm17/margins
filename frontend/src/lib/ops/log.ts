/**
 * The one way server code logs an error (OPS-M6, SEC-L3). An error's message can carry student text: a Prisma error
 * quotes the query's values, a fetch error the upstream body, a parse error the input. So only the error's class, its
 * code and its stack frames are logged, never its message, and `context` takes only ids, counts and flags.
 *
 * `console.error` is banned elsewhere in server code by the lint rule in eslint.config.mjs.
 */

export type LogContext = Record<string, string | number | boolean | null | undefined>

/** What is safe to log about an error: its class, its code (Prisma's P2002, a Node errno, an API code) and its frames. */
export function describeError(error: unknown): { name: string; code?: string; frames: string[] } {
  if (!(error instanceof Error)) return { name: error === null ? 'null' : typeof error, frames: [] }
  const raw = (error as { code?: unknown }).code
  const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined
  // The first stack line repeats the message; frames are the lines that start with "at".
  const frames = (error.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, 8)
  return { name: error.name || error.constructor?.name || 'Error', code, frames }
}

export function logServerError(label: string, error?: unknown, context: LogContext = {}): void {
  const { name, code, frames } = describeError(error)
  const parts = [`[${label}]`, error === undefined ? '' : code ? `${name}(${code})` : name]
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) parts.push(`${key}=${value}`)
  }
  let line = parts.filter(Boolean).join(' ')
  if (frames.length > 0) line += '\n    ' + frames.join('\n    ')
  // The one allowed console.error in server code.
  console.error(line)
}
