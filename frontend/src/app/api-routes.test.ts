import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

/**
 * The rules every API route follows (SEC-M4, OPS-M1), checked by reading the source so a new route that skips them
 * fails here instead of in production:
 *
 *  1. A body is read with `readJson` (lib/api/read-json.ts), which caps its size. No route calls `request.json()`,
 *     `.text()`, `.formData()`, `.arrayBuffer()` or `.blob()`. The material upload streams `request.body` itself, with
 *     its own size check (lib/storage/upload-limits.ts).
 *  2. Every string, list and record in a route's request schema has a bound (lib/api/fields.ts).
 *  3. Every handler that changes data counts against a limiter, so one student cannot hammer it.
 *  4. No server code keeps limiter state in memory: counters are in the database (lib/api/rate-limit.ts).
 */
const SRC = path.resolve(__dirname, '..')
const API = path.join(SRC, 'app', 'api')

function files(dir: string, match: (name: string) => boolean, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files(full, match, found)
    else if (match(entry.name)) found.push(full)
  }
  return found
}

const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/')
const read = (file: string) => readFileSync(file, 'utf8')

const routes = files(API, (name) => name === 'route.ts')
/** Server code outside the API folder that also reads requests. */
const serverFiles = [
  ...files(path.join(SRC, 'server'), isSource),
  ...files(path.join(SRC, 'app', 'm'), isSource),
  path.join(SRC, 'lib', 'analytics', 'proxy.ts'),
]

/** Files that declare request schemas outside the route files. */
const schemaFiles = [path.join(SRC, 'lib', 'jobs', 'regenerate.ts'), path.join(SRC, 'lib', 'exams', 'attempt-timing.ts')]

/** Allowed body readers, with the reason each is not `readJson`. Empty on purpose. */
const BODY_READER_ALLOW = new Map<string, string>()

/** Handlers that change data but are not limited per student, with the reason. */
const UNLIMITED_ALLOW = new Map<string, string>()

describe('API routes', () => {
  it('finds the routes', () => {
    assert.ok(routes.length > 50)
  })

  it('read bodies through readJson, never request.json() or friends', () => {
    const reader = /\b(?:request|req|_request|_req)\.(?:json|text|formData|arrayBuffer|blob)\s*\(/
    const found = [...routes, ...serverFiles]
      .filter((file) => reader.test(read(file)) && !BODY_READER_ALLOW.has(rel(file)))
      .map(rel)
    assert.deepEqual(found, [])
  })

  it('bound every string, list and record in a request schema', () => {
    const problems: string[] = []
    for (const file of [...routes, ...schemaFiles]) {
      const source = read(file)
      for (const match of source.matchAll(/\bz\s*\.\s*(string|array|record)\s*\(/g)) {
        const kind = match[1]
        const chain = methodsAfter(source, match.index! + match[0].length - 1)
        const line = source.slice(0, match.index).split('\n').length
        const bounded =
          kind === 'string'
            ? chain.some((name) => ['max', 'length', 'uuid', 'cuid', 'datetime', 'email'].includes(name))
            : kind === 'array'
              ? chain.some((name) => ['max', 'length'].includes(name))
              : false // a record is made with record() from lib/api/fields.ts, which caps its keys and size
        if (!bounded) problems.push(`${rel(file)}:${line} z.${kind}() has no bound`)
      }
    }
    assert.deepEqual(problems, [])
  })

  it('limit every handler that changes data', () => {
    const problems: string[] = []
    const limited = /Limiter\.check\(|enforceLimit\(|enforceMutationLimit\(|rateLimited\(/
    for (const file of routes) {
      const source = read(file)
      const functions = [...source.matchAll(/^(?:export )?async function (\w+)\b/gm)]
      for (const [index, fn] of functions.entries()) {
        if (!/^(?:POST|PUT|PATCH|DELETE|handle(?:POST|PUT|PATCH|DELETE|Post))$/.test(fn[1])) continue
        const body = source.slice(fn.index, functions[index + 1]?.index ?? source.length)
        if (!limited.test(body) && !UNLIMITED_ALLOW.has(`${rel(file)}#${fn[1]}`)) problems.push(`${rel(file)} ${fn[1]}`)
      }
    }
    assert.deepEqual(problems, [])
  })

  it('keep no limiter state in memory', () => {
    const problems: string[] = []
    const holder = /^(?:export )?(?:const|let)\s+(\w+)(?::[^=]+)?\s*=\s*new (?:Map|Set|WeakMap)\b/gm
    for (const file of [...files(SRC, isSource)]) {
      const path_ = rel(file)
      if (/^(features|components)\//.test(path_)) continue // runs in the browser
      const source = read(file)
      for (const match of source.matchAll(holder)) {
        if (/limit|rate|throttl|hits|window|bucket|attempts|quota/i.test(match[1])) problems.push(`${path_} ${match[1]}`)
      }
    }
    assert.deepEqual(problems, [])
  })
})

/** The names of the `.method(...)` calls chained after the call whose opening parenthesis is at `open`. */
function methodsAfter(source: string, open: number): string[] {
  const names: string[] = []
  let position = closing(source, open) + 1
  for (;;) {
    const rest = /^\s*\.\s*(\w+)\s*\(/.exec(source.slice(position))
    if (!rest) return names
    names.push(rest[1])
    position = closing(source, position + rest[0].length - 1) + 1
  }
}

/** The index of the parenthesis that closes the one at `open` (strings and regex literals with parentheses are not used in these schemas). */
function closing(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')' && --depth === 0) return i
  }
  return source.length
}
