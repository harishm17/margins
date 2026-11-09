import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Holds the app's jobs of one type before they are sent, so the wait they cause stays on screen until a step has read it.
 * The stack's test-only hook does the holding (src/lib/tasks/dispatch.ts, E2E_HOLD_DIR=$E2E_RUN_DIR/hold from
 * scripts/e2e-stack.sh): while `<type>.hold` exists, a job about to go writes `<jobId>.request.json` and waits for
 * `<jobId>.release`. The returned release stops holding and lets every held job of the type go.
 */
export async function holdJobs(jobType: string, runDir = process.env.E2E_RUN_DIR || join(process.cwd(), '..', '.e2e')): Promise<() => Promise<void>> {
  const dir = join(runDir, 'hold')
  const gate = join(dir, `${jobType}.hold`)
  await mkdir(dir, { recursive: true })
  await writeFile(gate, '')
  const letGo = async () => {
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.request.json')) continue
      const { payload } = JSON.parse(await readFile(join(dir, name), 'utf8')) as { payload?: { jobId?: string; jobType?: string } }
      if (payload?.jobId && payload.jobType === jobType) await writeFile(join(dir, `${payload.jobId}.release`), '')
    }
  }
  return async () => {
    await rm(gate, { force: true })
    await letGo()
    // A job that saw the gate just before it went writes its request a moment later.
    await new Promise((resolve) => setTimeout(resolve, 300))
    await letGo()
  }
}

/** Waits until at least one job of `jobType` is held at the gate, and returns the ids of those held. */
export async function waitForHeld(jobType: string, runDir = process.env.E2E_RUN_DIR || join(process.cwd(), '..', '.e2e'), timeout = 60_000): Promise<string[]> {
  const dir = join(runDir, 'hold')
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const held: string[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.request.json')) continue
      const { payload } = JSON.parse(await readFile(join(dir, name), 'utf8')) as { payload?: { jobId?: string; jobType?: string } }
      if (payload?.jobId && payload.jobType === jobType) held.push(payload.jobId)
    }
    if (held.length > 0) return held
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`No ${jobType} job was held in ${timeout / 1000} s`)
}
