/**
 * Runs `fn` with one environment variable set, then puts it back as it was. An unset variable is deleted again:
 * assigning `undefined` to process.env stores the string "undefined", which every later reader takes for a value.
 */
export function withEnv<T>(name: string, value: string, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, name)
  const before = process.env[name]
  process.env[name] = value
  try {
    return fn()
  } finally {
    if (had) process.env[name] = before
    else delete process.env[name]
  }
}
