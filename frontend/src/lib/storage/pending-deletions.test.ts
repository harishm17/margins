import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

// A row delete that skips the queue leaves the stored file behind for good (OPS-L4). Account deletion has its own
// folder sweep with a queued fallback (lib/account/deletion.ts).
test('every place that deletes a material or project row queues its files in the same transaction', () => {
  const offenders: string[] = []
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8')
    if (/\.(material|project)\.(delete|deleteMany)\(/.test(text) && !text.includes('queueFileDeletions(')) {
      offenders.push(path.relative(SRC, file))
    }
  }
  assert.deepEqual(offenders, [])
})
