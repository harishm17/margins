import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'

const root = join(__dirname, '..', '..', '..')
const loader = readFileSync(join(root, 'public', 'hm.js'), 'utf8')
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

type Init = Record<string, unknown> & {
  api_host: string
  before_send: (e: { properties: Record<string, unknown> }) => { properties: Record<string, unknown> }
  loaded: (ph: Record<string, (...args: unknown[]) => void>) => void
  bootstrap: { distinctID?: string }
}

/** Runs public/hm.js in a bare context that looks like a page on `hostname`. */
function visit(opts: { hostname?: string; search?: string; webdriver?: boolean; storage?: Record<string, string> } = {}) {
  const { hostname = 'studymargins.com', search = '', webdriver = false, storage = {} } = opts
  const scripts: string[] = []
  const cookies: string[] = []
  const replaced: string[] = []
  const timers: (() => void)[] = []
  const win: Record<string, unknown> = {}
  const doc = {
    createElement: () => ({}) as Record<string, unknown>,
    getElementsByTagName: () => [{ parentNode: { insertBefore: (el: { src: string }) => scripts.push(el.src) } }],
    set cookie(value: string) {
      cookies.push(value)
    },
  }
  const origin = `https://${hostname}`
  vm.runInNewContext(loader, {
    window: win,
    document: doc,
    navigator: { webdriver },
    location: { hostname, origin, search, href: `${origin}/home${search}` },
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
    localStorage: {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => void (storage[k] = v),
      removeItem: (k: string) => void delete storage[k],
    },
    URL,
    URLSearchParams,
    setTimeout: (fn: () => void) => timers.push(fn),
  })
  const posthog = win.posthog as { _i: [string, Init][] } | undefined
  return { posthog, init: posthog?._i[0]?.[1], scripts, cookies, replaced, timers, storage }
}

describe('analytics loader', () => {
  it('starts on the production host and loads PostHog only through /m on that host', () => {
    const { posthog, init, scripts } = visit()
    assert.equal(posthog?._i.length, 1)
    assert.equal(posthog?._i[0][0], 'phc_nT2JxCxLcAiSQGP4d4iJ2mWef6k3gNa6ptFaEJmz5cJ9')
    assert.equal(init?.api_host, 'https://studymargins.com/m')
    assert.deepEqual(scripts, ['https://studymargins.com/m/static/array.js'])
  })

  it('sends the minimal capture settings', () => {
    const { init } = visit()
    assert.deepEqual(
      {
        ui_host: init?.ui_host,
        defaults: init?.defaults,
        person_profiles: init?.person_profiles,
        autocapture: init?.autocapture,
        capture_pageview: init?.capture_pageview,
        capture_pageleave: init?.capture_pageleave,
        disable_session_recording: init?.disable_session_recording,
        enable_heatmaps: init?.enable_heatmaps,
        capture_dead_clicks: init?.capture_dead_clicks,
        capture_exceptions: init?.capture_exceptions,
        disable_surveys: init?.disable_surveys,
        capture_performance: init?.capture_performance,
        advanced_disable_feature_flags: init?.advanced_disable_feature_flags,
      },
      {
        ui_host: 'https://us.posthog.com',
        defaults: '2026-08-30',
        person_profiles: 'identified_only',
        autocapture: false,
        capture_pageview: 'history_change',
        capture_pageleave: true,
        disable_session_recording: true,
        enable_heatmaps: false,
        capture_dead_clicks: false,
        capture_exceptions: false,
        disable_surveys: true,
        capture_performance: false,
        advanced_disable_feature_flags: true,
      }
    )
  })

  it('registers the site, and drops page titles (a course name is in them) before anything is sent', () => {
    const { init } = visit()
    const registered: Record<string, unknown>[] = []
    init!.loaded({ register: (v) => registered.push(plain(v) as Record<string, unknown>), register_once: () => {} })
    assert.deepEqual(registered, [{ site: 'margins' }])
    const sent = init!.before_send({ properties: { title: 'Linear Algebra Final - Margins', $pathname: '/home' } })
    assert.deepEqual(plain(sent.properties), { $pathname: '/home' })
  })

  it('does nothing on other hosts, in automated browsers and for an opted-out visitor', () => {
    for (const opts of [
      { hostname: 'localhost' },
      { hostname: 'margins-production.up.railway.app' },
      { hostname: 'www.studymargins.com' },
      { webdriver: true },
      { storage: { hm_notrack: '1' } },
    ]) {
      const { posthog, scripts } = visit(opts)
      assert.equal(posthog, undefined, JSON.stringify(opts))
      assert.deepEqual(scripts, [])
    }
  })

  it('opts out with ?notrack=1, forgets the old id, and opts back in with ?notrack=0', () => {
    const storage: Record<string, string> = { 'ph_phc_nT2JxCxLcAiSQGP4d4iJ2mWef6k3gNa6ptFaEJmz5cJ9_posthog': '{}' }
    const out = visit({ search: '?notrack=1', storage })
    assert.equal(out.posthog, undefined)
    assert.equal(storage.hm_notrack, '1')
    assert.equal(Object.keys(storage).some((k) => k.startsWith('ph_')), false)
    assert.ok(out.cookies.every((c) => c.includes('Max-Age=0')))
    const back = visit({ search: '?notrack=0', storage })
    assert.equal(storage.hm_notrack, undefined)
    assert.equal(back.posthog?._i.length, 1)
  })

  it('adopts hm_id from the personal site, tags the visit, and cleans the address bar', () => {
    const { init, timers, replaced } = visit({ search: '?hm_id=0198abcd-1234&utm_source=cv&keep=1' })
    assert.deepEqual(plain(init!.bootstrap), { distinctID: '0198abcd-1234' })
    const once: Record<string, unknown>[] = []
    init!.loaded({ register: () => {}, register_once: (v) => once.push(plain(v) as Record<string, unknown>) })
    assert.deepEqual(once, [{ ref: 'harishmanoharan.com', first_ref: 'harishmanoharan.com' }])
    timers.forEach((fn) => fn())
    assert.deepEqual(replaced, ['/home?keep=1'])
  })

  it('honours ?ref=<tag> and ignores a malformed hm_id', () => {
    const { init } = visit({ search: '?ref=Wedge&hm_id=<script>' })
    assert.deepEqual(plain(init!.bootstrap), {})
    const registered: Record<string, unknown>[] = []
    const once: Record<string, unknown>[] = []
    init!.loaded({ register: (v) => registered.push(plain(v) as Record<string, unknown>), register_once: (v) => once.push(plain(v) as Record<string, unknown>) })
    assert.deepEqual(registered, [{ site: 'margins' }, { ref: 'wedge' }])
    assert.deepEqual(once, [{ first_ref: 'wedge' }])
  })
})

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

describe('where the loader is used', () => {
  it('is added by the root layout only, so files and API answers never carry it', () => {
    const users = files(join(root, 'src')).filter((f) => !f.includes('.test.') && /\.(ts|tsx)$/.test(f) && readFileSync(f, 'utf8').includes('src="/hm.js"'))
    assert.deepEqual(users.map((f) => f.slice(root.length + 1)), ['src/app/layout.tsx'])
    const api = files(join(root, 'src', 'app', 'api')).concat(files(join(root, 'src', 'lib', 'http')))
    for (const file of api) assert.equal(/hm\.js|posthog/i.test(readFileSync(file, 'utf8')), false, file)
  })

  it('keeps PostHog out of the pages: the only host the browser talks to is this one', () => {
    for (const file of ['public/hm.js', 'src/app/layout.tsx']) {
      const text = readFileSync(join(root, file), 'utf8')
      // ui_host is a label for the PostHog toolbar link; nothing is fetched from it.
      const hosts = (text.match(/https?:\/\/[^\s'"`)]+/g) ?? []).filter((u) => !u.startsWith('https://studymargins.com'))
      assert.deepEqual(hosts.filter((h) => /posthog/.test(h)), file === 'public/hm.js' ? ['https://us.posthog.com'] : [])
    }
  })
})

describe('response headers', () => {
  const nextConfig = createRequire(__filename)(join(root, 'next.config.js')) as {
    headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>
    skipTrailingSlashRedirect?: boolean
  }

  it('add no Content-Security-Policy, so none can be looser than before, and name no PostHog host', async () => {
    const rules = await nextConfig.headers()
    const all = rules.flatMap((rule) => rule.headers)
    assert.equal(all.some((h) => /content-security-policy/i.test(h.key)), false)
    assert.equal(all.some((h) => /posthog/i.test(`${h.key}${h.value}`)), false)
    // The security headers that were there stay.
    for (const key of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) {
      assert.ok(all.some((h) => h.key === key), key)
    }
  })

  it('leave the trailing slash of /m/i/v0/e/ alone (a redirect would lose the POST body)', () => {
    assert.equal(nextConfig.skipTrailingSlashRedirect, true)
  })
})
