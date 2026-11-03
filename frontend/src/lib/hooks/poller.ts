/**
 * The timing rules of the page's polling, with no React in it so they can be tested: a tick every
 * `intervalMs` while the tab is visible, none while it is hidden, one at once when the tab comes
 * back (if a whole interval has passed), and a stop after `maxPolls` ticks.
 */
export type PollerEnv = {
  isHidden: () => boolean
  now: () => number
  setInterval: (callback: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  /** Calls back when the tab is shown or hidden; returns the way to stop listening. */
  onVisibilityChange: (callback: () => void) => () => void
}

export type PollerOptions = {
  intervalMs: number
  /** Ticks (taken while the tab was visible) before the poller gives up. */
  maxPolls: number
  onTick: () => void
  /** Called once when the cap is reached. */
  onGiveUp?: () => void
}

export function createPoller(options: PollerOptions, env: PollerEnv): () => void {
  let count = 0
  let lastTick = env.now()
  let stopped = false
  let handle: unknown = null

  const stop = () => {
    stopped = true
    if (handle !== null) env.clearInterval(handle)
    handle = null
    removeListener()
  }

  const tick = () => {
    if (stopped || env.isHidden()) return
    count += 1
    if (count > options.maxPolls) {
      stop()
      options.onGiveUp?.()
      return
    }
    lastTick = env.now()
    options.onTick()
  }

  const removeListener = env.onVisibilityChange(() => {
    // Back on the tab: ask now rather than waiting out the rest of the interval.
    if (!env.isHidden() && env.now() - lastTick >= options.intervalMs) tick()
  })
  handle = env.setInterval(tick, options.intervalMs)
  return stop
}

export const browserPollerEnv: PollerEnv = {
  isHidden: () => document.hidden,
  now: () => Date.now(),
  setInterval: (callback, ms) => window.setInterval(callback, ms),
  clearInterval: (handle) => window.clearInterval(handle as number),
  onVisibilityChange: (callback) => {
    document.addEventListener('visibilitychange', callback)
    return () => document.removeEventListener('visibilitychange', callback)
  },
}
