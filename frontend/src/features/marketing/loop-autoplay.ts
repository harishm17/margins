/**
 * The landing loop's auto-advance: on a wide screen the open step moves on by itself, once, so a
 * visitor who only watches still sees all six steps. The rules:
 * - It only runs where `enabled` says so: a wide screen (on a phone every step is stacked and
 *   visible), no reduced-motion preference, and `LOOP_AUTOPLAY` on.
 * - It runs only while the loop is at least half in view, and pauses while the pointer or focus is
 *   inside it, while the tab is hidden, and while the visitor has pressed pause.
 * - Any click, key or tab choice inside the loop stops it for good (`stop`).
 * - One pass: after the last step it goes back to the first and stops. It never loops.
 * A paused step keeps the time it had left, so the line that fills as its timer resumes where it was.
 *
 * Plain TypeScript with an injected clock, so the rules are unit tested (loop-autoplay.test.ts);
 * loop.tsx wires it to the DOM.
 */

/** Switch the auto-advance off here (one line). */
export const LOOP_AUTOPLAY = true

/** How long each step stays open, in ms. The open step's line fills over this time. */
export const LOOP_STEP_MS = 7000

export type Clock = {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Why the loop is not advancing right now, for the UI (the pause button, the filling line). */
export type AutoplayState = {
  /** The step on show. */
  index: number
  /** Advancing now: the line is filling. */
  running: boolean
  /** Still part of the page: not stopped by the visitor and not finished. Paused counts as active. */
  active: boolean
  /** The visitor pressed pause (the button shows Play). */
  userPaused: boolean
}

type Options = {
  steps: number
  stepMs?: number
  enabled: boolean
  clock?: Clock
  /** The step changes (also back to the first at the end). The caller shows it without moving focus. */
  onAdvance: (index: number) => void
  onState?: (state: AutoplayState) => void
}

export class LoopAutoplay {
  private readonly steps: number
  private readonly stepMs: number
  private readonly clock: Clock
  private readonly onAdvance: (index: number) => void
  private readonly onState?: (state: AutoplayState) => void

  private index = 0
  private enabled: boolean
  private stopped = false
  private finished = false
  private userPaused = false
  private inView = false
  private hovered = false
  private focused = false
  private hidden = false

  private remaining: number
  private runningSince: number | null = null
  private timer: unknown = null

  constructor({ steps, stepMs = LOOP_STEP_MS, enabled, clock = realClock, onAdvance, onState }: Options) {
    this.steps = steps
    this.stepMs = stepMs
    this.enabled = enabled && steps > 1
    this.clock = clock
    this.onAdvance = onAdvance
    this.onState = onState
    this.remaining = stepMs
  }

  get state(): AutoplayState {
    return { index: this.index, running: this.runningSince !== null, active: this.isActive(), userPaused: this.userPaused }
  }

  setInView(value: boolean) {
    this.inView = value
    this.update()
  }

  setHovered(value: boolean) {
    this.hovered = value
    this.update()
  }

  setFocused(value: boolean) {
    this.focused = value
    this.update()
  }

  setHidden(value: boolean) {
    this.hidden = value
    this.update()
  }

  /** The pause/play button. Not an interaction that stops it: pressing play carries on. */
  setUserPaused(value: boolean) {
    this.userPaused = value
    this.update()
  }

  /** The conditions changed (a narrow window, reduced motion turned on): off for good. */
  disable() {
    this.enabled = false
    this.update()
  }

  /** A click, key or tab choice inside the loop: stop for good, leaving the visitor's step open. */
  stop() {
    this.stopped = true
    this.update()
  }

  dispose() {
    this.pause()
  }

  private isActive(): boolean {
    return this.enabled && !this.stopped && !this.finished
  }

  private shouldRun(): boolean {
    return this.isActive() && this.inView && !this.hovered && !this.focused && !this.hidden && !this.userPaused
  }

  private update() {
    const run = this.shouldRun()
    if (run && this.runningSince === null) this.resume()
    else if (!run && this.runningSince !== null) this.pause()
    this.emit()
  }

  private resume() {
    this.runningSince = this.clock.now()
    this.timer = this.clock.setTimeout(() => this.advance(), this.remaining)
  }

  private pause() {
    if (this.runningSince === null) return
    this.remaining = Math.max(0, this.remaining - (this.clock.now() - this.runningSince))
    this.runningSince = null
    this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private advance() {
    this.runningSince = null
    this.timer = null
    this.remaining = this.stepMs
    const last = this.index === this.steps - 1
    this.index = last ? 0 : this.index + 1
    if (last) this.finished = true
    this.onAdvance(this.index)
    this.update()
  }

  private emit() {
    this.onState?.(this.state)
  }
}
