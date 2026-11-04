'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  deriveOrbState,
  initialSessionState,
  sessionReducer,
  summarize,
  type OrbState,
  type SessionState,
  type SessionSummary,
} from './session-state'
import {
  createVoiceController,
  type StartConfig,
  type VoiceController,
  type VoiceControllerOptions,
} from './voice-controller'
import { clearVoiceSnapshot, persistLiveSession, setActiveVoiceScope } from './use-voice-draft'

export type VoiceSession = {
  state: SessionState
  orb: OrbState
  summary: SessionSummary
  controller: VoiceController
}

export type { StartConfig }

/** One voice practice: the reducer state for the UI plus the controller that drives it. */
export function useVoiceSession(options: VoiceControllerOptions): VoiceSession {
  const [state, dispatch] = React.useReducer(sessionReducer, initialSessionState)
  const router = useRouter()
  const [controller] = React.useState<VoiceController>(() =>
    createVoiceController({ dispatch, options, onFinished: () => router.refresh() })
  )
  React.useEffect(() => {
    controller.setOptions(options)
  }, [controller, options])

  // What a reload would take away is kept in this tab while the practice is open (see use-voice-draft.ts): the lines so far, the
  // question and the typed words. Writes are throttled; the latest state is also written the moment the page is hidden.
  const scope = options.mode === 'topic' ? (options.topic?.id ?? 'topic') : 'sprint'
  setActiveVoiceScope(scope)
  const latest = React.useRef({ state, courseId: options.courseId, mode: options.mode, scope })
  React.useEffect(() => {
    latest.current = { state, courseId: options.courseId, mode: options.mode, scope }
  })
  const writeNow = React.useCallback(() => {
    const { state: current, courseId, mode, scope: key } = latest.current
    const config = controller.getConfig()
    if (current.phase !== 'live' || !config) return
    persistLiveSession(
      { courseId, scope: key, mode: mode === 'topic' ? 'topic' : 'sprint', config },
      { entries: current.entries, question: current.question?.text ?? null }
    )
  }, [controller])
  React.useEffect(() => {
    if (state.phase === 'summary') {
      // A practice that ended on purpose (or ran out) has nothing to pick up.
      clearVoiceSnapshot(options.courseId, scope)
      return
    }
    if (state.phase !== 'live') return
    const timer = setTimeout(writeNow, 300)
    return () => clearTimeout(timer)
  }, [state.phase, state.entries, state.question, options.courseId, scope, writeNow])

  React.useEffect(() => {
    const onHide = () => {
      writeNow()
      controller.pageHide()
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      controller.dispose()
    }
  }, [controller, writeNow])

  const orb = deriveOrbState(state)
  const summary = React.useMemo(() => summarize(state), [state])
  return { state, orb, summary, controller }
}
