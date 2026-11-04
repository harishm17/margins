import type { Page, Route } from '@playwright/test'

/**
 * Helpers for the interruption specs (interruptions.spec.ts): make one request fail or hang on purpose, then reload the page in the
 * middle of the task. Other specs use them to add their own "what if this fails" assertions.
 */

type Matcher = string | RegExp
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Fails every matching request (a dropped connection) until `restore()`. `calls` counts how many were refused. */
export async function failRequests(page: Page, url: Matcher, method?: Method) {
  const state = { calls: 0 }
  const handler = async (route: Route) => {
    if (method && route.request().method() !== method) return route.fallback()
    state.calls += 1
    await route.abort('connectionfailed')
  }
  await page.route(url, handler)
  return {
    state,
    restore: () => page.unroute(url, handler),
  }
}

/**
 * Lets a matching request reach the server and run, but never gives the answer back to the page: the server has done the work and the
 * browser does not know. Reloading the page then is "the request was in flight".
 */
export async function swallowResponses(page: Page, url: Matcher, method?: Method) {
  const handler = async (route: Route) => {
    if (method && route.request().method() !== method) return route.fallback()
    await route.fetch().catch(() => undefined)
    // No fulfil: the page waits until it is reloaded away.
    await new Promise(() => undefined).catch(() => undefined)
  }
  await page.route(url, handler)
  return { restore: () => page.unroute(url, handler) }
}

/** Reloads the page without waiting for anything to settle first, as a student pressing refresh would. */
export async function reloadNow(page: Page) {
  await page.reload({ waitUntil: 'domcontentloaded' })
}
