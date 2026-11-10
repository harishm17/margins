import assert from 'node:assert/strict'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { holdJobs, waitForHeld } from './hold'

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

  it('waits until a job of the type is held, and names the held ones', async () => {
    const run = await mkdtemp(join(tmpdir(), 'wf-hold-'))
    const dir = join(run, 'hold')
    const release = await holdJobs('validate_material', run)
    await writeFile(join(dir, 'job-9.request.json'), JSON.stringify({ endpoint: '/jobs/x', payload: { jobId: 'job-9', jobType: 'grade_quiz' } }))
    setTimeout(() => void writeFile(join(dir, 'job-3.request.json'), JSON.stringify({ endpoint: '/jobs/x', payload: { jobId: 'job-3', jobType: 'validate_material' } })), 200)
    assert.deepEqual(await waitForHeld('validate_material', run, 5000), ['job-3'])
    await release()
  })

  it('says so when nothing is held in time', async () => {
    const run = await mkdtemp(join(tmpdir(), 'wf-hold-'))
    await holdJobs('validate_material', run)
    await assert.rejects(waitForHeld('validate_material', run, 300), /No validate_material job was held/)
  })
})
