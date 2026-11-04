'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

type Options = {
  examId: string
  /** The attempt the answers belong to: the local copy is kept under it. */
  attemptId: string
  /** The answers as they stand now. A change schedules a save. */
  answers: Record<string, unknown>
  /** What the server already has, so opening a resumed attempt does not save straight away. */
  savedAnswers: Record<string, unknown>
  /** Stop saving, e.g. while the exam is being submitted. */
  enabled?: boolean
  /** The server closed the attempt: time ran out (and it was submitted as saved) or it was submitted elsewhere. */
  onEnded: (submissionId: string | null) => void
  /** The page was reloaded before the last change reached the server: the answers kept in this browser are newer. */
  onRestore?: (answers: Record<string, unknown>) => void
  debounceMs?: number
}

const RETRY_MS = 10_000
/** A change made while a save was out goes as soon as that save is back. */
const FOLLOW_UP_MS = 250

/** What this browser holds of an attempt: the answers, and the server copy they were last known to match. */
export type LocalAnswers = { answers: Record<string, unknown>; syncedJson: string; savedAt: number }

const localKey = (attemptId: string) => `margins-exam-answers:${attemptId}`

/**
 * Which answers a resumed attempt should start from. The copy kept in this browser wins when it differs from the server's and was
 * made on top of the server's current copy (`syncedJson`): that is a change that never arrived. If the server's copy has moved on
 * since (another device saved), the server wins. Returns the local answers to use, or null to keep the server's.
 */
export function reconcileAnswers(local: LocalAnswers | null, server: Record<string, unknown>): Record<string, unknown> | null {
  if (!local) return null
  const serverJson = JSON.stringify(server)
  if (JSON.stringify(local.answers) === serverJson) return null
  return local.syncedJson === serverJson ? local.answers : null
}

export function readLocalAnswers(attemptId: string): LocalAnswers | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(localKey(attemptId)) ?? 'null') as Partial<LocalAnswers> | null
    if (!parsed || typeof parsed.syncedJson !== 'string' || !parsed.answers || typeof parsed.answers !== 'object') return null
    return { answers: parsed.answers, syncedJson: parsed.syncedJson, savedAt: Number(parsed.savedAt) || 0 }
  } catch {
    return null
  }
}

export function writeLocalAnswers(attemptId: string, answers: Record<string, unknown>, syncedJson: string) {
  try {
    window.localStorage.setItem(localKey(attemptId), JSON.stringify({ answers, syncedJson, savedAt: Date.now() } satisfies LocalAnswers))
  } catch {
    // Storage can be full or blocked; the server copy still works.
  }
}

export function clearLocalAnswers(attemptId: string) {
  try {
    window.localStorage.removeItem(localKey(attemptId))
  } catch {
    // Nothing to clear if storage is blocked.
  }
}

/**
 * Saves exam answers in two places. Every change is written to this browser at once (so a reload a moment later loses nothing and
 * the next load sends what the server never got), and goes to the server a moment after the last change, and at once when the tab
 * is hidden, loses focus or closes. A failed save is retried until it works or the attempt ends. Answers are saved whole, so a later
 * save always replaces an earlier one.
 */
export function useExamAutosave({
  examId,
  attemptId,
  answers,
  savedAnswers,
  enabled = true,
  onEnded,
  onRestore,
  debounceMs = 1500,
}: Options) {
  const [status, setStatus] = useState<Exclude<SaveStatus, 'dirty'>>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  // The server copy as last confirmed; kept in state as well as the ref so the "not saved yet" label follows it.
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(savedAnswers))

  const latestRef = useRef(answers)
  const savedJsonRef = useRef(JSON.stringify(savedAnswers))
  const inFlightRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const endedRef = useRef(false)
  const enabledRef = useRef(enabled)
  const onEndedRef = useRef(onEnded)
  const onRestoreRef = useRef(onRestore)
  // True from the moment a newer local copy is handed back until the restored answers arrive, so the first write does not overwrite it.
  const restoringRef = useRef(false)
  // The retry timers call the latest save without the callback referring to itself.
  const saveRef = useRef<(keepalive?: boolean) => Promise<void>>(async () => {})

  useEffect(() => {
    latestRef.current = answers
    enabledRef.current = enabled
    onEndedRef.current = onEnded
    onRestoreRef.current = onRestore
  })

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  // A reload: pick up the answers kept in this browser when they are newer than the server's (before the write below can replace them).
  useLayoutEffect(() => {
    const restored = reconcileAnswers(readLocalAnswers(attemptId), savedAnswers)
    restoringRef.current = restored !== null
    if (restored) onRestoreRef.current?.(restored)
    // Only on arrival at the attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId])

  // Every change is kept in this browser straight away, before the commit paints, with the server copy it is built on.
  useLayoutEffect(() => {
    if (restoringRef.current) {
      restoringRef.current = false
      return
    }
    if (!enabled || endedRef.current) return
    writeLocalAnswers(attemptId, answers, savedJsonRef.current)
  }, [answers, attemptId, enabled])

  const save = useCallback(
    async (keepalive = false) => {
      if (!enabledRef.current || endedRef.current || inFlightRef.current) return
      const sentJson = JSON.stringify(latestRef.current)
      if (sentJson === savedJsonRef.current) return

      clearTimer()
      inFlightRef.current = true
      setStatus('saving')
      const body = JSON.stringify({ answers: latestRef.current })
      try {
        const response = await fetch(`/api/exams/${examId}/attempt`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive,
        })
        if (response.status === 409) {
          const payload = await response.json().catch(() => ({}))
          endedRef.current = true
          clearLocalAnswers(attemptId)
          onEndedRef.current(payload?.error?.details?.submissionId ?? null)
          return
        }
        if (!response.ok) throw new Error(`Save failed (${response.status})`)
        savedJsonRef.current = sentJson
        setSavedJson(sentJson)
        // The browser copy now rests on this server copy.
        writeLocalAnswers(attemptId, latestRef.current, sentJson)
        setLastSavedAt(new Date())
        setStatus('saved')
      } catch {
        setStatus('error')
        timerRef.current = setTimeout(() => void saveRef.current(), RETRY_MS)
        return
      } finally {
        inFlightRef.current = false
      }
      // Answers changed while the request was out.
      if (JSON.stringify(latestRef.current) !== savedJsonRef.current) {
        timerRef.current = setTimeout(() => void saveRef.current(), FOLLOW_UP_MS)
      }
    },
    [examId, attemptId]
  )

  useEffect(() => {
    saveRef.current = save
  }, [save])

  // Save a moment after the last change.
  useEffect(() => {
    if (!enabled) return
    if (JSON.stringify(answers) === savedJsonRef.current) return
    clearTimer()
    timerRef.current = setTimeout(() => void save(), debounceMs)
    return clearTimer
  }, [answers, enabled, debounceMs, save])

  // Save at once when the student leaves the tab or the page. The browser copy is already current; this also tries the server.
  useEffect(() => {
    const flush = () => void save(true)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', flush)
      window.removeEventListener('pagehide', flush)
      clearTimer()
    }
  }, [save])

  // A change the server has not confirmed yet says so: "Saved" is only ever shown for what is saved.
  const dirty = enabled && JSON.stringify(answers) !== savedJson
  const shown: SaveStatus = status === 'error' || status === 'saving' ? status : dirty ? 'dirty' : status

  const saveNow = useCallback(() => save(), [save])
  /** The attempt is over (submitted or closed): the browser copy is no longer needed. */
  const clearLocal = useCallback(() => clearLocalAnswers(attemptId), [attemptId])

  return { status: shown, lastSavedAt, saveNow, clearLocal }
}
