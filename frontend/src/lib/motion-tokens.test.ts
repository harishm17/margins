import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// Motion lengths are 120, 180 or 240 ms (the --animate-* tokens in app/globals.css). A Tailwind
// `duration-300` or a bare `transition-opacity` (150 ms by default) quietly adds a fourth speed.

const SRC = path.join(__dirname, '..')
const TOKENS = new Set([120, 180, 240])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return files(full)
    return full.endsWith('.tsx') ? [full] : []
  })
}

test('every duration-N class in src uses a motion token', () => {
  const offenders: string[] = []
  for (const file of files(SRC)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const match of line.matchAll(/(?<![\w-])duration-(\d+)\b/g)) {
          if (!TOKENS.has(Number(match[1]))) offenders.push(`${path.relative(SRC, file)}:${index + 1} ${match[0]}`)
        }
      })
  }
  assert.deepEqual(offenders, [], 'use duration-120, duration-180 or duration-240')
})

test('a transition-opacity, transition-colors or transition-transform class names its duration', () => {
  const offenders: string[] = []
  for (const file of files(SRC)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/(?<![\w-])transition-(opacity|colors|transform|all|shadow)\b/.test(line) && !/duration-\d+/.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${index + 1}`)
        }
      })
  }
  assert.deepEqual(offenders, [], 'add duration-120, duration-180 or duration-240 next to the transition')
})
