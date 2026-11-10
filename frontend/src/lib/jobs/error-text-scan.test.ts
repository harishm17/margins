import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

// SEC-L3 / contract C5: a stored error is a code plus the public text for that code. Nothing in the web app selects
// the stored text to send it on, or reads it back to show it; pages and routes work from `errorCode`.
// Writing a fixed string to `errorMessage: '...'` is allowed.
const SRC = join(__dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

test('no route, query or component selects or reads a job\'s errorMessage', () => {
  const offenders = sources(SRC).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, index) => ({ line, at: `${relative(SRC, file)}:${index + 1}` }))
      .filter(({ line }) => /errorMessage:\s*true|\.errorMessage\b|errorMessage\?:/.test(line))
      .map(({ at }) => at)
  )
  assert.deepEqual(offenders, [])
})
