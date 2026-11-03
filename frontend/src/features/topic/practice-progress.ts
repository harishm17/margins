'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  groupProgress,
  replaceProblem,
  mergeServerProgress,
  parseProgress,
  progressFromProblems,
  type PracticeProgress,
  type ProblemProgress,
} from './practice-keys'

/**
 * Practice progress is kept on the server (POST /api/topics/[id]/practice-progress, one row per
 * problem) so it follows the student across devices, and cached in localStorage so the views read
 * it synchronously and it works offline. Each change is written to the cache at once and sent to
 * the server a moment later. When a topic page opens, <PracticeProgressSync> loads the server's
 * rows into the cache, and uploads whatever the browser has that the server does not (the first
 * time, that is everything the browser stored before the server did).
 *
 * A step is named by its problem's position and title and its own position, so adding problems to
 * the end keeps earlier progress, while a rewrite with new titles starts clean.
 */

const EVENT = 'margins:practice-progress'
const SAVED_EVENT = 'margins:practice-saved'
const REJECTED_EVENT = 'margins:practice-rejected'
const storageKey = (topicId: string) => `margins:practice:${topicId}`
const syncedKey = (topicId: string) => `margins:practice-synced:${topicId}`

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

function read(topicId: string): string {
  try {
    return window.localStorage.getItem(storageKey(topicId)) ?? ''
  } catch {
    return ''
  }
}

function write(topicId: string, progress: PracticeProgress) {
  try {
    window.localStorage.setItem(storageKey(topicId), JSON.stringify(progress))
  } catch {
    // Storage can be full or blocked; progress then lasts until the page is closed.
  }
  window.dispatchEvent(new Event(EVENT))
}

// ---------------------------------------------------------------------------------------
// Sending to the server

type Payload = ProblemProgress & { migrated?: boolean }

async function send(topicId: string, payload: Payload): Promise<{ completedNow: boolean } | null> {
  try {
    const response = await fetch(`/api/topics/${topicId}/practice-progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    })
    if (response.status === 400 || (response.status === 409 && (await refusedForNoAttempt(response)))) {
      await restoreFromServer(topicId, payload)
      return null
    }
    if (!response.ok) return null
    const body = (await response.json()) as { completedNow?: boolean }
    if (body.completedNow) window.dispatchEvent(new Event(SAVED_EVENT))
    return { completedNow: !!body.completedNow }
  } catch {
    // Offline or the server is down: the browser keeps the progress and uploads it on the next visit.
    return null
  }
}

/** The server held back Connect or deeper help, or a shown answer, because the step has no attempt (409 ATTEMPT_FIRST, spec 18.4). */
async function refusedForNoAttempt(response: Response): Promise<boolean> {
  const body = (await response.clone().json().catch(() => null)) as { code?: unknown } | null
  return body?.code === 'ATTEMPT_FIRST'
}

/**
 * The server refused a problem's state (it cannot follow what is stored, for example after progress
 * was changed on another device). The browser takes the server's state of that problem, and the view
 * says so.
 */
async function restoreFromServer(topicId: string, payload: Payload) {
  try {
    const response = await fetch(`/api/topics/${topicId}/practice-progress`)
    if (response.ok) {
      const { problems } = (await response.json()) as { problems: ProblemProgress[] }
      const row = problems.find((item) => item.problemIndex === payload.problemIndex && item.problemTitle === payload.problemTitle)
      write(topicId, replaceProblem(parseProgress(read(topicId)), payload.problemIndex, payload.problemTitle, row ?? null))
    }
  } catch {
    // Offline: the notice still shows, and the next visit loads the server's rows.
  }
  window.dispatchEvent(new Event(REJECTED_EVENT))
}

const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>()
/** The last request of each problem: the next one starts when it has ended, so the server sees a problem's saves in the order they were made. */
const inFlight = new Map<string, Promise<unknown>>()

function enqueue(id: string, task: () => Promise<unknown>) {
  const next = (inFlight.get(id) ?? Promise.resolve()).then(task, task)
  inFlight.set(id, next)
  void next.finally(() => {
    if (inFlight.get(id) === next) inFlight.delete(id)
  })
}

/** Sends the problems whose progress changed, a moment after the last change. The latest state is read when it is sent. */
function scheduleSync(topicId: string, problemKeys: { problemIndex: number; problemTitle: string }[]) {
  for (const { problemIndex, problemTitle } of problemKeys) {
    const id = `${topicId}:${problemIndex}:${problemTitle}`
    const pending = timers.get(id)
    if (pending) clearTimeout(pending.timer)
    const run = () => {
      timers.delete(id)
      enqueue(id, () => {
        const group = groupProgress(parseProgress(read(topicId))).find(
          (item) => item.problemIndex === problemIndex && item.problemTitle === problemTitle
        )
        // Nothing left locally means the problem was started over.
        return send(topicId, group ?? { problemIndex, problemTitle, solvedSteps: [], revealedSteps: [], hintedSteps: [], attemptedSteps: [], firstTrySteps: [], maxRungs: {} })
      })
    }
    timers.set(id, { timer: setTimeout(run, 250), run })
  }
}

/** Sends every change still waiting out its moment, now. The page is being hidden or closed, so a timer would never fire (the requests are keepalive). */
function flushPending() {
  for (const { timer, run } of [...timers.values()]) {
    clearTimeout(timer)
    run()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPending)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPending()
  })
}

const sameProblem = (a: ProblemProgress, b: { problemIndex: number; problemTitle: string }) =>
  a.problemIndex === b.problemIndex && a.problemTitle === b.problemTitle

/** The problems whose steps differ between two states, including problems that became empty. */
function changedProblems(before: PracticeProgress, after: PracticeProgress) {
  const a = groupProgress(before)
  const b = groupProgress(after)
  const same = (x: ProblemProgress, y: ProblemProgress) => JSON.stringify(x) === JSON.stringify(y)
  const changed: { problemIndex: number; problemTitle: string }[] = []
  for (const group of b) if (!a.some((other) => same(other, group))) changed.push(group)
  for (const group of a) if (!b.some((other) => sameProblem(other, group))) changed.push(group)
  return changed
}

// ---------------------------------------------------------------------------------------
// The hook the views use

/** The raw stored string is the snapshot (a primitive, so React can compare it). */
export function usePracticeProgress(topicId: string) {
  const raw = React.useSyncExternalStore(
    subscribe,
    () => read(topicId),
    () => ''
  )
  const progress = React.useMemo(() => parseProgress(raw), [raw])
  /** True after the server refused a change and the browser went back to the server's state. */
  const [rejected, setRejected] = React.useState(false)
  /** How many saves were refused: a view can tell that what it showed before is stale. */
  const [rejections, setRejections] = React.useState(0)
  React.useEffect(() => {
    const onRejected = () => {
      setRejected(true)
      setRejections((count) => count + 1)
    }
    window.addEventListener(REJECTED_EVENT, onRejected)
    return () => window.removeEventListener(REJECTED_EVENT, onRejected)
  }, [])

  const update = React.useCallback(
    (change: (current: PracticeProgress) => PracticeProgress) => {
      const before = parseProgress(read(topicId))
      const next = change(before)
      write(topicId, next)
      scheduleSync(topicId, changedProblems(before, next))
    },
    [topicId]
  )

  /**
   * A checked answer. The step counts as attempted; a right one solves it, and it is a first-try success
   * when it is the step's first check.
   */
  const recordCheck = React.useCallback(
    (key: string, correct: boolean) =>
      update((current) => {
        const firstCheck = !current.attempted.includes(key)
        return {
          ...current,
          // The rung the student had reached at their first wrong check: a hint after it is not a clean success.
          missRungs: !correct && current.missRungs[key] === undefined ? { ...current.missRungs, [key]: current.rungs[key] ?? 0 } : current.missRungs,
          attempted: firstCheck ? [...current.attempted, key] : current.attempted,
          solved: correct && !current.solved.includes(key) ? [...current.solved, key] : current.solved,
          revealed: correct ? current.revealed.filter((item) => item !== key) : current.revealed,
          firstTry: correct && firstCheck ? [...current.firstTry, key] : current.firstTry,
        }
      }),
    [update]
  )
  const markRevealed = React.useCallback(
    (key: string) =>
      update((current) => ({
        ...current,
        revealed: current.revealed.includes(key) || current.solved.includes(key) ? current.revealed : [...current.revealed, key],
      })),
    [update]
  )
  /**
   * "I don't know" on a step: its first check, wrong. The step counts as attempted and as a miss at the rung it had reached;
   * nothing solves it. The server's tutor state has its own record of the button (practice-tutor, event `dont_know`).
   */
  const markDontKnow = React.useCallback(
    (key: string) =>
      update((current) => ({
        ...current,
        missRungs: current.missRungs[key] === undefined ? { ...current.missRungs, [key]: current.rungs[key] ?? 0 } : current.missRungs,
        attempted: current.attempted.includes(key) ? current.attempted : [...current.attempted, key],
        idk: (current.idk ?? []).includes(key) ? current.idk : [...(current.idk ?? []), key],
      })),
    [update]
  )
  /** A hint of a step was opened, at this rung: the step no longer counts towards the score when the problem is finished. */
  const markHinted = React.useCallback(
    (key: string, rung: number) =>
      update((current) => ({
        ...current,
        hinted: current.hinted.includes(key) ? current.hinted : [...current.hinted, key],
        rungs: { ...current.rungs, [key]: Math.max(current.rungs[key] ?? 0, rung) },
      })),
    [update]
  )
  /** The one-line answer to "What tripped you up?" for a problem (see problemKey). */
  const setTrippedUp = React.useCallback(
    (problem: string, answer: string) => update((current) => ({ ...current, trippedUp: { ...current.trippedUp, [problem]: answer } })),
    [update]
  )
  /** Forget the given steps and the problem's "tripped up" answer, to work a problem again. */
  const clear = React.useCallback(
    (keys: string[], problem: string) =>
      update((current) => ({
        solved: current.solved.filter((item) => !keys.includes(item)),
        revealed: current.revealed.filter((item) => !keys.includes(item)),
        hinted: current.hinted.filter((item) => !keys.includes(item)),
        attempted: current.attempted.filter((item) => !keys.includes(item)),
        firstTry: current.firstTry.filter((item) => !keys.includes(item)),
        rungs: Object.fromEntries(Object.entries(current.rungs).filter(([item]) => !keys.includes(item))),
        missRungs: Object.fromEntries(Object.entries(current.missRungs).filter(([item]) => !keys.includes(item))),
        idk: (current.idk ?? []).filter((item) => !keys.includes(item)),
        trippedUp: Object.fromEntries(Object.entries(current.trippedUp).filter(([item]) => item !== problem)),
      })),
    [update]
  )

  return { progress, rejected, rejections, dismissRejected: () => setRejected(false), recordCheck, markDontKnow, markRevealed, markHinted, setTrippedUp, clear }
}

// ---------------------------------------------------------------------------------------
// Loading from the server, once per topic page

/**
 * Loads the server's practice progress into the browser's cache when a topic page opens (so a
 * reload or another device shows it), uploads what only the browser has (the first time: the
 * progress kept before the server stored any, without scoring it), and refreshes the page when a
 * finished problem moved the topic's mastery. Renders nothing.
 */
export function PracticeProgressSync({ topicId, server }: { topicId: string; server: ProblemProgress[] }) {
  const router = useRouter()
  const done = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (done.current === topicId) return
    done.current = topicId
    const local = parseProgress(read(topicId))
    const { merged, toUpload } = mergeServerProgress(local, server)
    if (JSON.stringify(merged) !== JSON.stringify(local)) write(topicId, merged)

    let alreadySynced = false
    try {
      alreadySynced = window.localStorage.getItem(syncedKey(topicId)) === '1'
    } catch {
      // Without storage the upload simply repeats; the server joins it with what it has.
    }
    for (const problem of toUpload) void send(topicId, { ...problem, migrated: !alreadySynced })
    // A step left with a miss on an earlier day is settled as a failed first try when the progress is read (spec 18.4).
    if (server.some((problem) => (problem.attemptedSteps ?? []).some((step) => !problem.solvedSteps.includes(step) && !problem.revealedSteps.includes(step)))) {
      void fetch(`/api/topics/${topicId}/practice-progress`).catch(() => undefined)
    }
    try {
      window.localStorage.setItem(syncedKey(topicId), '1')
    } catch {
      // See above.
    }
  }, [topicId, server])

  React.useEffect(() => {
    const onSaved = () => React.startTransition(() => router.refresh())
    window.addEventListener(SAVED_EVENT, onSaved)
    return () => window.removeEventListener(SAVED_EVENT, onSaved)
  }, [router])

  return null
}
