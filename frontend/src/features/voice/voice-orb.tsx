'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import type { MicMeter } from './mic-meter'
import { ORB_LABEL, type OrbState } from './session-state'
import './voice-orb.css'

type VoiceOrbProps = {
  state: OrbState
  /** Source of the mic level while listening. */
  meter?: MicMeter
  size?: 'md' | 'sm'
  /** The word under the orb when it is not the state's usual one ("Still listening"). */
  label?: string
  className?: string
}

/**
 * The orb and its status word. While listening, a requestAnimationFrame loop reads the mic
 * level and writes it to the --orb-level CSS variable on the orb element: no React state, so
 * a 60 fps meter never re-renders anything. Under reduced motion the loop does not run.
 *
 * On the phone sheet (below md, the breakpoint session-view.tsx turns the session into a sheet at) the orb is a small
 * mark beside its word, so the coach's words get the room (finding 86).
 */
export function VoiceOrb({ state, meter, size = 'md', label, className }: VoiceOrbProps) {
  const orbRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const element = orbRef.current
    if (!element) return
    element.style.setProperty('--orb-level', '0')
    if (state !== 'listening' || !meter) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.style.setProperty('--orb-level', '0.35')
      return
    }
    let frame = 0
    const tick = () => {
      element.style.setProperty('--orb-level', meter.read().toFixed(3))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [state, meter])

  return (
    <div className={cn('flex flex-col items-center gap-3 max-md:flex-row max-md:gap-2.5', className)}>
      <div
        ref={orbRef}
        className={cn('voice-orb max-md:[--orb-size:28px]', size === 'sm' ? 'md:[--orb-size:96px]' : 'md:[--orb-size:128px]')}
        data-state={state}
        data-size={size}
        data-testid="voice-orb"
        aria-hidden="true"
      >
        <span className="voice-orb__halo" />
        <span className="voice-orb__ring" />
        <span className="voice-orb__core" />
      </div>
      <p role="status" aria-live="polite" className="text-body-strong text-fg-2" data-testid="voice-orb-status">
        {label ?? ORB_LABEL[state]}
      </p>
    </div>
  )
}
