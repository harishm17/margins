import assert from 'node:assert/strict'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { holdJobs } from './hold'

describe('holding the app’s jobs', () => {
  it('sets the gate for one job type, and its release lets the held jobs of that type go and stops holding', async () => {
    const run = await mkdtemp(join(tmpdir(), 'wf-hold-'))
    const dir = join(run, 'hold')
    const release = await holdJobs('generate_review_items', run)
    assert.deepEqual(await readdir(dir), ['generate_review_items.hold'])

    // Two jobs reach the gate (src/lib/tasks/dispatch.ts writes what it holds), one of them of another type.
    const held = (jobId: string, jobType: string) => writeFile(join(dir, `${jobId}.request.json`), JSON.stringify({ endpoint: '/jobs/x', payload: { jobId, jobType } }))
    await held('job-1', 'generate_review_items')
    await held('job-2', 'grade_quiz')
    await release()

    const names = (await readdir(dir)).sort()
    assert.ok(names.includes('job-1.release'))
    assert.ok(!names.includes('job-2.release'))
    assert.ok(!names.includes('generate_review_items.hold'))
  })
})
