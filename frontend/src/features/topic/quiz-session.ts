'use client'

import * as React from 'react'
import { useServerDraft } from '@/features/learning/use-server-draft'
import { countAnswered, normalizeAnswers, type QuizAnswer } from '@/lib/learning/quiz-answers'

/**
 * A quiz in progress is a server draft (spec 18.7, `useServerDraft('quiz', '<topicId>:<setId>')`), so the answers
 * survive a closed tab and open on another device. "Taking" is a separate, per-tab fact: a draft that exists but
 * was not opened in this tab is offered as "Resume" in the lobby.
 *
 * A quiz started before v3.1 is in sessionStorage under `margins:quiz:<topic>:<set>`. It is read once, uploaded as
 * the draft and removed.
 */

/**
 * Answers are `{ answer, confidence?, thinking?, idk? }`. A quiz started before confidence existed has plain
 * strings stored; reading one turns them into the object form, so it carries on and still submits.
 * `predicted` is how many the student expected to get right, when they said.
 */
export type QuizSession = { answers: Record<string, QuizAnswer>; index: number; predicted?: number }

const legacyKey = (topicId: string, setId: string) => `margins:quiz:${topicId}:${setId}`
const takingKey = (topicId: string, setId: string) => `margins:quiz-taking:${topicId}:${setId}`

/** Reads a session from its parsed JSON (a draft, or an old sessionStorage value). Null when it is not one. */
export function sessionFromValue(value: unknown): QuizSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as { answers?: unknown; index?: unknown; predicted?: unknown }
  const session: QuizSession = {
    // normalizeAnswers also turns the old marker text of an "I don't know" into the flag.
    answers: normalizeAnswers(raw.answers),
    index: typeof raw.index === 'number' && raw.index >= 0 ? Math.floor(raw.index) : 0,
  }
  if (typeof raw.predicted === 'number' && Number.isInteger(raw.predicted) && raw.predicted >= 0) {
    session.predicted = raw.predicted
  }
  return session
}

export function parseSession(raw: string): QuizSession | null {
  if (!raw) return null
  try {
    return sessionFromValue(JSON.parse(raw))
  } catch {
    return null
  }
}

const readLocal = (key: string): string | null => {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}
const writeLocal = (key: string, value: string | null) => {
  try {
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, value)
  } catch {
    // Storage can be blocked; the draft on the server is the copy that matters.
  }
}

/**
 * The set this tab is in the middle of, if any. The topic page remounts the quiz view when a newer set arrives
 * (its key is the newest set), so the view asks here which set to stay on.
 */
export function setBeingTaken(topicId: string, setIds: string[]): string | undefined {
  if (typeof window === 'undefined') return undefined
  return setIds.find((setId) => readLocal(takingKey(topicId, setId)) === '1')
}

/**
 * The quiz in progress for one set.
 *   session     the saved answers, or null when there are none
 *   answered    how many questions have an answer (the lobby's "Resume (6 of 10 answered)")
 *   taking      this tab opened the quiz and has not left it
 *   begin(next) start from `next`, or carry on with the saved session when it is omitted
 *   save(next)  keep these answers
 *   pause()     leave the quiz with the answers kept ("Save and finish later")
 *   discard()   leave the quiz and delete the answers
 *   finish()    the quiz was submitted: delete the draft
 *   refused     { opensAt } when the set was taken today and a new draft was refused (RETRY_TOMORROW)
 */
export function useQuizSession(projectId: string, topicId: string, setId: string) {
  const draft = useServerDraft<QuizSession>('quiz', `${topicId}:${setId}`, { projectId, topicId, parse: sessionFromValue })
  const [takingFlag, setTakingFlag] = React.useState<boolean>(() => (typeof window === 'undefined' ? false : readLocal(takingKey(topicId, setId)) === '1'))
  // A different set is a different quiz: read its flag, adjusting state while rendering rather than in an effect.
  const [flagFor, setFlagFor] = React.useState(`${topicId}:${setId}`)
  if (flagFor !== `${topicId}:${setId}`) {
    setFlagFor(`${topicId}:${setId}`)
    setTakingFlag(readLocal(takingKey(topicId, setId)) === '1')
  }

  const setTaking = React.useCallback(
    (value: boolean) => {
      writeLocal(takingKey(topicId, setId), value ? '1' : null)
      setTakingFlag(value)
    },
    [topicId, setId]
  )

  const session = React.useMemo(() => (draft.value ? sessionFromValue(draft.value) : null), [draft.value])

  // A quiz stored in this tab before v3.1: upload it once the server has said there is no draft, and carry on with it.
  const { status, value, set: setDraft } = draft
  React.useEffect(() => {
    if (status === 'loading' || value !== null) return
    const old = readLocal(legacyKey(topicId, setId))
    if (old === null) return
    writeLocal(legacyKey(topicId, setId), null)
    const parsed = parseSession(old)
    if (!parsed) return
    setDraft(parsed)
    // The old session meant "taking"; this tab was in the middle of the quiz.
    writeLocal(takingKey(topicId, setId), '1')
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTakingFlag(true)
  }, [status, value, setDraft, topicId, setId])

  // A new draft the server refused (the set was taken today) is not a quiz in progress. The view is told when the set
  // opens again, and the refused text is dropped from this device.
  const [refusedAt, setRefusedAt] = React.useState<string | null>(null)
  const refusedNow = draft.refused?.opensAt ?? null
  const { clear: clearDraft } = draft
  React.useEffect(() => {
    if (!refusedNow) return
    writeLocal(takingKey(topicId, setId), null)
    /* eslint-disable react-hooks/set-state-in-effect */
    setTakingFlag(false)
    setRefusedAt(refusedNow)
    /* eslint-enable react-hooks/set-state-in-effect */
    void clearDraft()
  }, [refusedNow, clearDraft, topicId, setId])

  const save = React.useCallback((next: QuizSession) => setDraft(next), [setDraft])

  const begin = React.useCallback(
    (next?: QuizSession) => {
      setRefusedAt(null)
      if (next) setDraft(next)
      setTaking(true)
    },
    [setDraft, setTaking]
  )

  const pause = React.useCallback(async () => {
    await draft.flush()
    setTaking(false)
  }, [draft, setTaking])

  const discard = React.useCallback(async () => {
    setTaking(false)
    await draft.clear()
  }, [draft, setTaking])

  return {
    session,
    answered: session ? countAnswered(session.answers) : 0,
    loading: status === 'loading' && session === null,
    taking: takingFlag,
    begin,
    save,
    pause,
    discard,
    finish: discard,
    refused: refusedAt ? { opensAt: refusedAt } : null,
    status,
  }
}
