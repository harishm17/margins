'use client'

import * as React from 'react'
import { preload } from 'react-dom'
import { getImageProps } from 'next/image'
import { Pause, Play } from '@phosphor-icons/react/dist/ssr'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { type LoopStep } from './content'
import { LOOP_AUTOPLAY, LOOP_STEP_MS, LoopAutoplay, type AutoplayState } from './loop-autoplay'
import { Shot, shotSrc } from './shot'

const FRAME = 'overflow-hidden rounded-card border border-border bg-surface'
const PANEL_SIZES = '(min-width: 1280px) 650px, 55vw'
/** The width the steps and the screenshot sit side by side from (Tailwind `lg`). */
const WIDE = '(min-width: 1024px)'

/** Fetch a step's screenshot (the theme on show) before its tab opens, so the frame is never empty. */
function preloadShot(step: LoopStep) {
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  const { props } = getImageProps({ alt: '', src: shotSrc(step.shot, theme), ...step.desktop, sizes: PANEL_SIZES })
  preload(props.src, { as: 'image', imageSrcSet: props.srcSet, imageSizes: PANEL_SIZES })
}

const IDLE: AutoplayState = { index: 0, running: false, active: false, userPaused: false }

/**
 * Wires `LoopAutoplay` to the page: the media queries that allow it, the loop being half in view, the
 * pointer and focus over the steps or the screenshot, the tab being hidden, and the visitor's clicks
 * and keys. Returns the state for the UI and the handlers for the two areas that pause it.
 */
function useLoopAutoplay(steps: number, zone: React.RefObject<HTMLElement | null>, onAdvance: (index: number) => void) {
  const [state, setState] = React.useState<AutoplayState>(IDLE)
  const controller = React.useRef<LoopAutoplay | null>(null)
  const advance = React.useRef(onAdvance)
  React.useEffect(() => {
    advance.current = onAdvance
  })
  // Pointer and focus over either area (the steps, the screenshot) pause it; tracked per area.
  const over = React.useRef({ tabs: false, panel: false })
  const within = React.useRef({ tabs: false, panel: false })

  React.useEffect(() => {
    const element = zone.current
    if (!LOOP_AUTOPLAY || !element) return
    const wide = window.matchMedia(WIDE)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (!wide.matches || reduce.matches) return

    const autoplay = new LoopAutoplay({
      steps,
      enabled: true,
      onAdvance: (index) => advance.current(index),
      onState: setState,
    })
    controller.current = autoplay
    autoplay.setHidden(document.hidden)

    const observer = new IntersectionObserver(([entry]) => autoplay.setInView(entry.isIntersecting), { threshold: 0.5 })
    observer.observe(element)
    const onVisibility = () => autoplay.setHidden(document.hidden)
    const onMedia = () => {
      if (!wide.matches || reduce.matches) autoplay.disable()
    }
    document.addEventListener('visibilitychange', onVisibility)
    wide.addEventListener('change', onMedia)
    reduce.addEventListener('change', onMedia)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      wide.removeEventListener('change', onMedia)
      reduce.removeEventListener('change', onMedia)
      autoplay.dispose()
      controller.current = null
      setState(IDLE)
    }
  }, [steps, zone])

  const area = (name: 'tabs' | 'panel') => ({
    onPointerEnter: () => {
      over.current[name] = true
      controller.current?.setHovered(true)
    },
    onPointerLeave: () => {
      over.current[name] = false
      controller.current?.setHovered(over.current.tabs || over.current.panel)
    },
    onFocus: () => {
      within.current[name] = true
      controller.current?.setFocused(true)
    },
    onBlur: (event: React.FocusEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      within.current[name] = false
      controller.current?.setFocused(within.current.tabs || within.current.panel)
    },
    // Any click or key in the loop is the visitor taking over: auto-advance stops for good.
    onPointerDown: () => controller.current?.stop(),
    onKeyDownCapture: () => controller.current?.stop(),
  })

  const setPaused = (paused: boolean) => controller.current?.setUserPaused(paused)
  return { state, area, setPaused }
}

/**
 * The loop from files to exam day. On a wide screen it is a list of steps with one screenshot beside it
 * (a vertical tab list: arrow keys move between steps, and the open step explains itself). Once it is
 * in view it steps through the six by itself, once (see loop-autoplay.ts), with a pause button. On a
 * phone every step shows its own phone-sized screenshot under its text, because a shrunken desktop page
 * cannot be read.
 */
export function Loop({ steps }: { steps: LoopStep[] }) {
  const [active, setActive] = React.useState(0)
  const [visited, setVisited] = React.useState<Set<number>>(() => new Set([0]))
  const tabs = React.useRef<(HTMLButtonElement | null)[]>([])
  const zone = React.useRef<HTMLDivElement>(null)
  const pauseButton = React.useRef<HTMLButtonElement>(null)

  // Auto-advance shows a step exactly as a click does, but never moves focus.
  const show = React.useCallback((index: number) => {
    setActive(index)
    setVisited((previous) => (previous.has(index) ? previous : new Set(previous).add(index)))
  }, [])
  const autoplay = useLoopAutoplay(steps.length, zone, show)
  const { running, active: autoplaying, userPaused } = autoplay.state

  // The next step's screenshot is fetched while this one is open.
  React.useEffect(() => {
    const next = steps[(active + 1) % steps.length]
    if (next && window.matchMedia(WIDE).matches) preloadShot(next)
  }, [active, steps])

  // The pause button goes when auto-advance ends; focus on it moves to the open step instead of the page.
  React.useEffect(() => {
    if (!autoplaying && pauseButton.current && document.activeElement === pauseButton.current) tabs.current[active]?.focus()
  }, [autoplaying, active])

  const select = (index: number, focus = false) => {
    show(index)
    if (focus) tabs.current[index]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = steps.length - 1
    const move: Record<string, number> = {
      ArrowDown: active === last ? 0 : active + 1,
      ArrowUp: active === 0 ? last : active - 1,
      Home: 0,
      End: last,
    }
    if (event.key in move) {
      event.preventDefault()
      select(move[event.key], true)
    }
  }

  return (
    <>
      <div ref={zone} className="hidden gap-12 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex flex-col items-start">
          <div
            role="tablist"
            aria-label="From your files to exam day"
            aria-orientation="vertical"
            className="flex w-full flex-col"
            onKeyDown={onKeyDown}
            {...autoplay.area('tabs')}
          >
            {steps.map((step, index) => {
              const open = index === active
              // While auto-advance is on, the open step's line is its timer: it fills from the top.
              const timer = open && autoplaying
              return (
                <div
                  key={step.id}
                  className={cn('relative border-l-2 py-4 pl-6 transition-colors duration-120', open && !timer ? 'border-accent' : 'border-border')}
                >
                  {timer ? (
                    <span
                      key={`timer-${index}`}
                      aria-hidden="true"
                      data-loop-timer
                      className="absolute -left-0.5 top-0 h-full w-0.5 origin-top bg-accent"
                      style={{ animation: `loop-fill ${LOOP_STEP_MS}ms linear both`, animationPlayState: running ? 'running' : 'paused' }}
                    />
                  ) : null}
                  <button
                    ref={(node) => {
                      tabs.current[index] = node
                    }}
                    type="button"
                    role="tab"
                    id={`loop-tab-${step.id}`}
                    aria-selected={open}
                    aria-controls={`loop-panel-${step.id}`}
                    tabIndex={open ? 0 : -1}
                    onClick={() => select(index)}
                    className={cn(
                      'block w-full rounded-chip text-left text-heading transition-colors duration-120',
                      open ? 'text-fg' : 'text-fg-2 hover:text-fg'
                    )}
                  >
                    {step.title}
                  </button>
                  {/* Every description is in the page; the open one grows from no height (0fr to 1fr
                      rows) in step with the screenshot's fade, so the steps below glide instead of jumping.
                      Closed ones are inert: hidden from reading and from the tab order. */}
                  <div
                    inert={!open}
                    className={cn(
                      'grid transition-[grid-template-rows] ease-enter',
                      open ? 'grid-rows-[1fr] duration-240' : 'grid-rows-[0fr] duration-180'
                    )}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <p className="max-w-[46ch] pt-2 text-reading text-fg-2">{step.text}</p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          {autoplaying ? (
            <IconButton
              ref={pauseButton}
              label={userPaused ? 'Play the steps' : 'Pause the steps'}
              icon={userPaused ? <Play weight="fill" /> : <Pause weight="fill" />}
              variant="ghost"
              size="sm"
              tooltipSide="right"
              className="-ml-3 mt-3"
              onClick={() => autoplay.setPaused(!userPaused)}
            />
          ) : null}
        </div>
        <div {...autoplay.area('panel')}>
          {steps.map((step, index) => (
            <div
              key={step.id}
              role="tabpanel"
              id={`loop-panel-${step.id}`}
              aria-labelledby={`loop-tab-${step.id}`}
              hidden={index !== active}
              className={cn(FRAME, 'aspect-[4/3]', index === active && 'animate-fade-in')}
            >
              {visited.has(index) ? (
                <Shot
                  name={step.shot}
                  desktop={step.desktop}
                  alt={step.alt}
                  sizes={PANEL_SIZES}
                  className="h-full w-full object-cover object-left-top"
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <ol className="flex flex-col gap-14 lg:hidden">
        {steps.map((step) => (
          <li key={step.id}>
            <h3 className="text-heading text-fg">{step.title}</h3>
            <p className="mt-2 max-w-[52ch] text-reading text-fg-2">{step.text}</p>
            <div className={cn(FRAME, 'mx-auto mt-5 max-w-[420px] md:max-w-none')}>
              <Shot
                name={step.shot}
                desktop={step.desktop}
                mobile={step.mobile}
                desktopMedia="(min-width: 768px) and (max-width: 1023px)"
                alt={step.alt}
                sizes="(min-width: 768px) 704px, 100vw"
                className="h-auto w-full"
              />
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}
