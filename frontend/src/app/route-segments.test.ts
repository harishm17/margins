import assert from 'node:assert/strict'
import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

/**
 * Every page that reads data has a loading state and an error state, its own or the nearest one above it. A page without them shows
 * a blank screen while the server works and Next's bare error page when it throws.
 */
const APP = __dirname

/** Pages with nothing to wait for or fail on: static documents and a redirect-only route. */
const STATIC_PAGES = new Set([
  '(marketing)/page.tsx',
  '(marketing)/privacy/page.tsx',
  '(marketing)/terms/page.tsx',
  '(marketing)/evaluation/page.tsx',
  '(farewell)/account-deleted/page.tsx',
  'exams/[examId]/[[...rest]]/page.tsx',
])

function pages(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) pages(full, found)
    else if (entry.name === 'page.tsx') found.push(path.relative(APP, full))
  }
  return found
}

/** Whether `file` exists in the page's folder or any folder above it up to the app root. */
function inherits(page: string, file: string): boolean {
  let dir = path.dirname(path.join(APP, page))
  while (dir.startsWith(APP)) {
    if (existsSync(path.join(dir, file))) return true
    if (dir === APP) break
    dir = path.dirname(dir)
  }
  return false
}

describe('route segments', () => {
  const dataPages = pages(APP).filter((page) => !STATIC_PAGES.has(page.split(path.sep).join('/')))

  it('finds the app pages', () => {
    assert.ok(dataPages.length > 15)
  })

  it('every data page has a loading state of its own or above', () => {
    const missing = dataPages.filter((page) => !inherits(page, 'loading.tsx'))
    assert.deepEqual(missing, [])
  })

  it('every data page has an error state of its own or above', () => {
    const missing = dataPages.filter((page) => !inherits(page, 'error.tsx'))
    assert.deepEqual(missing, [])
  })
})
