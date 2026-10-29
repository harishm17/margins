'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { type LoopStep } from './content'
import { Shot } from './shot'
import { SLOT_SIZES } from './shot-sources'

const FRAME = 'overflow-hidden rounded-card border border-border bg-surface'

/**
 * The loop from files to exam day. On a wide screen it is a list of steps with one screenshot beside it
 * (a vertical tab list: arrow keys move between steps, and the open step explains itself). On a phone every
 * step shows its own phone-sized screenshot under its text, because a shrunken desktop page cannot be read.
 */
export function Loop({ steps }: { steps: LoopStep[] }) {
  const [active, setActive] = React.useState(0)
  const [visited, setVisited] = React.useState<Set<number>>(() => new Set([0]))
  const tabs = React.useRef<(HTMLButtonElement | null)[]>([])

  const select = (index: number, focus = false) => {
    setActive(index)
    setVisited((previous) => (previous.has(index) ? previous : new Set(previous).add(index)))
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
      <div className="hidden gap-12 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div role="tablist" aria-label="From your files to exam day" aria-orientation="vertical" className="flex flex-col" onKeyDown={onKeyDown}>
          {steps.map((step, index) => {
            const open = index === active
            return (
              <div key={step.id} className={cn('border-l-2 py-4 pl-6 transition-colors duration-120', open ? 'border-accent' : 'border-border')}>
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
                {open ? <p className="mt-2 max-w-[46ch] text-reading text-fg-2">{step.text}</p> : null}
              </div>
            )
          })}
        </div>
        <div>
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
                  alt={step.alt}
                  sizes={SLOT_SIZES.loopPanel}
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
                mobile
                desktopMedia="(min-width: 768px) and (max-width: 1023px)"
                alt={step.alt}
                sizes={SLOT_SIZES.loopList}
                className="h-auto w-full"
              />
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}
