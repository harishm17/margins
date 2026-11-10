/**
 * A request the student abandoned must stop the work it started in the AI service.
 *
 * A route that calls the model wraps its handler in `withClientSignal`, which keeps the request's abort signal
 * (it fires when the browser disconnects) for everything the handler awaits. Every call into the AI service builds
 * its signal with `callSignal(timeoutMs)`, which is that signal combined with the call's own timeout. The AI service
 * sees the connection drop and cancels the model call (its non-streaming routes poll for the disconnect), so a closed
 * tab stops costing money.
 *
 * This is one mechanism instead of a signal parameter through every layer: a call made outside a wrapped route (a
 * job, a script) just has its timeout. A test (client-signal.test.ts) fails if a route that reaches the model is not
 * wrapped, or if a client builds its own signal.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const clientSignal = new AsyncLocalStorage<AbortSignal>()

/** Wrap a route handler: `export const POST = withClientSignal(async (request, ctx) => ...)`. */
export function withClientSignal<A extends [Request, ...unknown[]], R>(
  handler: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return (...args: A) => clientSignal.run(args[0].signal, () => handler(...args))
}

/** The signal for one call into the AI service: the timeout, and the client's disconnect when a wrapped route is running. */
export function callSignal(timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  const client = clientSignal.getStore()
  return client ? AbortSignal.any([client, timeout]) : timeout
}
