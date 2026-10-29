'use client'

import * as React from 'react'
import { X } from '@phosphor-icons/react/dist/ssr'
import { IconButton } from '@/components/ui/icon-button'
import { aiMessage, isUnavailableCode, type AiMessage } from '@/lib/ai/messages'
import { AVAILABLE, type AiStatus } from '@/lib/ai/status'
import { createStatusTracker, statusUrl } from '@/lib/ai/status-tracker'
import { fillResetTime } from '@/lib/budget/copy'
import { cn } from '@/lib/utils'

/**
 * The browser's view of whether AI features can be used (see lib/ai/status). One provider per
 * layout (the app shell, the marketing and sign-in pages) reads /api/ai-status on mount, every
 * minute while the tab is visible and when the tab comes back; a surface that is refused by the
 * server reports the code so every button agrees at once.
 */

type AiStatusContextValue = {
  status: AiStatus
  /** Ask the server again now. */
  refresh: () => void
  /** A request was refused with this code: update the status without waiting for the next poll. */
  report: (code: string | null | undefined) => void
}

const AiStatusContext = React.createContext<AiStatusContextValue | null>(null)

const POLL_MS = 60_000

export function AiStatusProvider({ initial, children }: { initial?: AiStatus; children: React.ReactNode }) {
  const [status, setStatus] = React.useState<AiStatus>(initial ?? AVAILABLE)
  // Older or cached answers never undo a failure the page just reported (lib/ai/status-tracker).
  const [tracker] = React.useState(() => createStatusTracker())

  const load = React.useCallback(
    (fresh: boolean) => {
      const ticket = tracker.begin(fresh)
      fetch(statusUrl(fresh), { cache: 'no-store', credentials: 'same-origin' })
        .then((response) => (response.ok ? (response.json() as Promise<AiStatus>) : null))
        .then((next) => {
          if (next && typeof next.available === 'boolean' && tracker.accepts(ticket)) setStatus(next)
        })
        .catch(() => {})
    },
    [tracker]
  )
  const refresh = React.useCallback(() => load(false), [load])

  // A server render (a refresh) brings a newer status, unless the page has just reported a
  // failure that the server's cache may not know about yet.
  const [seenInitial, setSeenInitial] = React.useState(initial)
  if (initial !== seenInitial) {
    setSeenInitial(initial)
    if (initial && tracker.acceptsServerRender()) setStatus(initial)
  }

  const hasInitial = !!initial
  React.useEffect(() => {
    if (!hasInitial) refresh()
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer === null) timer = setInterval(refresh, POLL_MS)
    }
    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else {
        refresh()
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [hasInitial, refresh])

  const report = React.useCallback(
    (code: string | null | undefined) => {
      if (!code) return
      if (isUnavailableCode(code)) {
        setStatus((current) => ({
          ...current,
          available: false,
          reason: code,
          since: current.since ?? new Date().toISOString(),
          blocked: code,
        }))
      } else if (code === 'LLM_DAILY_BUDGET') {
        setStatus((current) => ({ ...current, blocked: code }))
      } else return
      tracker.noteReport()
      // Ask again past the server's cache, so the answer is newer than the failure.
      load(true)
    },
    [tracker, load]
  )

  const value = React.useMemo(() => ({ status, refresh, report }), [status, refresh, report])
  return <AiStatusContext.Provider value={value}>{children}</AiStatusContext.Provider>
}

export type UseAiStatus = AiStatusContextValue & {
  /** Why AI actions are refused now, in the student's words, or null when they may start. */
  blocked: AiMessage | null
}

const NOOP = () => {}

/** The AI status, with the reason actions are refused. Outside a provider: always available. */
export function useAiStatus(): UseAiStatus {
  const context = React.useContext(AiStatusContext)
  const status = context?.status ?? AVAILABLE
  const blocked = React.useMemo(() => {
    if (!status.blocked) return null
    const message = aiMessage(status.blocked)
    return { ...message, text: fillResetTime(message.text) }
  }, [status.blocked])
  return { status, refresh: context?.refresh ?? NOOP, report: context?.report ?? NOOP, blocked }
}

/**
 * The line under an AI action that is turned off: why, in one sentence. Renders nothing while the
 * action may start. Pair it with `disabled={!!blocked}` on the button.
 */
export function AiBlockedNote({ className }: { className?: string }) {
  const { blocked } = useAiStatus()
  if (!blocked) return null
  return <p className={cn('text-small text-fg-2', className)}>{blocked.text}</p>
}

const DISMISS_KEY = 'margins:ai-banner-dismissed'

const subscribeNever = () => () => {}

/**
 * Across the top of the page while AI is unavailable for everyone. It can be closed; it stays
 * closed for the rest of the browser session, until a new outage starts.
 */
export function AiStatusBanner({ className }: { className?: string }) {
  const { status } = useAiStatus()
  const key = `${status.reason ?? ''}:${status.since ?? ''}`
  const storedKey = React.useSyncExternalStore(
    subscribeNever,
    () => window.sessionStorage.getItem(DISMISS_KEY),
    () => null
  )
  const [dismissedKey, setDismissedKey] = React.useState<string | null>(null)
  const visible = !status.available && dismissedKey !== key && storedKey !== key
  const ref = React.useRef<HTMLDivElement>(null)

  // Pages that fill the screen (Ask) subtract --ai-banner-height, so the banner never pushes
  // their bottom edge out of view.
  React.useLayoutEffect(() => {
    const root = document.documentElement
    const element = ref.current
    if (!visible || !element) {
      root.style.removeProperty('--ai-banner-height')
      return
    }
    const update = () => root.style.setProperty('--ai-banner-height', `${element.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--ai-banner-height')
    }
  }, [visible])

  if (!visible) return null

  const message = BANNER
  return (
    <div
      ref={ref}
      role="status"
      className={cn('flex items-start gap-3 border-b border-border bg-warning-soft px-4 py-2.5 text-warning-soft-fg md:px-6', className)}
    >
      <p className="min-w-0 flex-1 text-small">
        <span className="font-medium">{message.title}.</span> {message.text}
      </p>
      <IconButton
        label="Close this notice"
        icon={<X />}
        noTooltip
        size="sm"
        variant="ghost"
        className="-my-1 text-current hover:bg-transparent hover:text-current"
        onClick={() => {
          try {
            window.sessionStorage.setItem(DISMISS_KEY, key)
          } catch {
            // Private mode: it stays closed until the page is reloaded.
          }
          setDismissedKey(key)
        }}
      />
    </div>
  )
}

/** The banner's words (copy for review). */
export const BANNER = {
  title: 'AI features are paused',
  text: 'New notes, quizzes, Ask and voice practice are unavailable for now. Your files, plan and anything already written still work.',
}
