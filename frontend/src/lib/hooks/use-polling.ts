'use client'

import * as React from 'react'
import { browserPollerEnv, createPoller } from './poller'

type UsePollingOptions = {
  /** Poll only while this is true. */
  active: boolean
  intervalMs: number
  /** Ticks, counted while the tab is visible, before polling stops. Default: about five minutes. */
  maxPolls?: number
}

/**
 * The one way a page asks the server again on a timer (router.refresh, a status read). It pauses while
 * the tab is hidden, asks at once when the student comes back, and stops after `maxPolls` ticks so a
 * stuck job cannot keep a tab busy for ever. `waitedOut` is true after it stops; `again` starts a new
 * round (a button for it, or the student coming back to the tab, is the student's choice to look again).
 */
export function usePolling(onTick: () => void, { active, intervalMs, maxPolls }: UsePollingOptions) {
  const cap = maxPolls ?? Math.ceil(300_000 / intervalMs)
  const [round, setRound] = React.useState(0)
  const [waitedOut, setWaitedOut] = React.useState(false)
  const tickRef = React.useRef(onTick)
  React.useEffect(() => {
    tickRef.current = onTick
  })

  React.useEffect(() => {
    if (!active) return
    const stop = createPoller(
      { intervalMs, maxPolls: cap, onTick: () => tickRef.current(), onGiveUp: () => setWaitedOut(true) },
      browserPollerEnv
    )
    return stop
  }, [active, intervalMs, cap, round])

  // After giving up, coming back to the tab is a new look: one more round.
  React.useEffect(() => {
    if (!active || !waitedOut) return
    const onShown = () => {
      if (document.hidden) return
      setWaitedOut(false)
      setRound((value) => value + 1)
    }
    document.addEventListener('visibilitychange', onShown)
    return () => document.removeEventListener('visibilitychange', onShown)
  }, [active, waitedOut])

  const again = React.useCallback(() => {
    setWaitedOut(false)
    setRound((value) => value + 1)
  }, [])
  return { waitedOut: active && waitedOut, again }
}
