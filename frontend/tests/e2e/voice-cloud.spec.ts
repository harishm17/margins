import { expect, test, type Page } from '@playwright/test'
import { signIn as signInAs } from './helpers/auth'
import { clearVoiceSessions, ensureVoiceFixture, VOICE_TEST_EMAIL, type VoiceFixture } from './helpers/voice-fixture'
import { installVoiceStubs } from './helpers/voice-stubs'

// Cloud speech recognition (spec 19.12). The server here has no AssemblyAI key, so the specs say it has one (the
// usage and session answers get `cloudSpeech: true`), answer the token request themselves, and stand in for the
// recognizer with a fake WebSocket. The microphone is the stubs' oscillator, so the page's own capture and audio
// worklet run for real and the frames they make are counted.

let fixture: VoiceFixture

test.beforeAll(async ({ baseURL }) => {
  fixture = await ensureVoiceFixture(baseURL ?? 'http://localhost:3000')
})

test.beforeEach(async ({ page }) => {
  await clearVoiceSessions()
  await signInAs(page, VOICE_TEST_EMAIL)
})

const voiceUrl = () => `/courses/${fixture.courseId}/topics/${fixture.topics['Hash tables']}?view=voice`
const startButton = (page: Page) => page.getByRole('button', { name: /Start (voice practice|sprint)/ })

// A stand-in for both recognizers. Deepgram's is opened with the token as a subprotocol and starts on `open`; AssemblyAI's
// carries the token in the URL and starts on its `Begin` message. `__cloud.refuse = 'deepgram'` makes that one close before
// it opens, as a provider with no credit left would.
const FAKE_SOCKET = `
(() => {
  const Real = window.WebSocket
  const cloud = { sockets: [], frames: 0, urls: [], protocols: [], refuse: null }
  class FakeCloudSocket {
    constructor(url, protocols) {
      this.url = url
      this.readyState = 0
      this.binaryType = 'blob'
      this.provider = String(url).includes('/v1/listen') ? 'deepgram' : 'assemblyai'
      cloud.urls.push(url)
      cloud.protocols.push(protocols || null)
      cloud.sockets.push(this)
      setTimeout(() => {
        if (cloud.refuse === this.provider) {
          this.readyState = 3
          this.onclose && this.onclose({ code: 1006 })
          return
        }
        this.readyState = 1
        if (this.provider === 'deepgram') this.onopen && this.onopen()
        else this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'Begin', id: 'fake' }) })
      }, 50)
    }
    send(data) {
      if (typeof data === 'string') return
      if (this === cloud.sockets[cloud.sockets.length - 1]) cloud.frames += 1
    }
    close() { this.readyState = 3 }
  }
  // One finished (or interim) segment, in the open socket's own format. The words end 300 ms before the audio sent.
  cloud.say = (order, transcript, final) => {
    const socket = cloud.sockets[cloud.sockets.length - 1]
    if (!socket || socket.readyState !== 1) return false
    const endMs = Math.max(0, cloud.frames * 100 - 300)
    const message = socket.provider === 'deepgram'
      ? { type: 'Results', is_final: final, speech_final: final, channel: { alternatives: [{ transcript, words: [{ end: endMs / 1000 }] }] } }
      : { type: 'Turn', turn_order: order, end_of_turn: final, transcript, words: [{ text: 'x', start: 0, end: endMs }] }
    socket.onmessage && socket.onmessage({ data: JSON.stringify(message) })
    return true
  }
  window.__cloud = cloud
  window.WebSocket = function (url, protocols) {
    if (String(url).startsWith('wss://cloud.test/')) return new FakeCloudSocket(url, protocols)
    return new Real(url, protocols)
  }
  window.WebSocket.prototype = Real.prototype
})()
`

const GRANTS = {
  deepgram: { provider: 'deepgram', url: 'wss://cloud.test/v1/listen?model=nova-3', token: 'deepgram-token' },
  assemblyai: { provider: 'assemblyai', url: 'wss://cloud.test/v3/ws?sample_rate=16000', token: 'assemblyai-token' },
} as const

/**
 * The server "has" cloud speech with Deepgram and AssemblyAI, in that order; the token route answers with the first
 * provider the request does not leave out (`exclude`), or fails with 503.
 */
async function offerCloud(page: Page, token: 'ok' | 'fail') {
  const withCloud = async (route: import('@playwright/test').Route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: { ...body, cloudSpeech: true, cloudProviders: ['deepgram', 'assemblyai'] } })
  }
  await page.route('**/api/voice/usage', withCloud)
  await page.route('**/api/voice/session', (route) => (route.request().method() === 'POST' ? withCloud(route) : route.continue()))
  const grants: string[][] = []
  await page.route('**/api/voice/speech-token', (route) => {
    const exclude: string[] = JSON.parse(route.request().postData() ?? '{}').exclude ?? []
    grants.push(exclude)
    const next = (['deepgram', 'assemblyai'] as const).find((provider) => !exclude.includes(provider))
    if (token === 'fail' || !next) {
      return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_ERROR', message: 'Cloud speech is not available' } } })
    }
    return route.fulfill({ json: GRANTS[next] })
  })
  return grants
}

function watchTurns(page: Page) {
  const turns: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/voice/turn')) turns.push(JSON.parse(request.postData() ?? '{}'))
  })
  return turns
}

test('cloud speech: the lobby says where the voice goes, the page streams audio, and the words make the answer', async ({ page }) => {
  await installVoiceStubs(page, { speechMs: 200 })
  await page.addInitScript(FAKE_SOCKET)
  await offerCloud(page, 'ok')
  const turns = watchTurns(page)

  await page.goto(voiceUrl())
  await expect(page.getByTestId('voice-lobby')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-privacy')).toContainText('Margins sends your voice to Deepgram')
  await expect(page.getByTestId('voice-privacy')).toContainText('AssemblyAI if it is unavailable')
  await expect(page.getByTestId('voice-cloud-toggle')).toBeVisible()
  await expect(startButton(page)).toBeEnabled({ timeout: 15_000 })
  await startButton(page).click()
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 })

  // The worklet makes a frame every 100 ms, and every one goes to the recognizer.
  await expect.poll(() => page.evaluate(() => (window as any).__cloud.frames), { timeout: 10_000 }).toBeGreaterThan(5)
  // Deepgram first, with the token as the bearer subprotocol (not in the address).
  const first = await page.evaluate(() => ({ url: (window as any).__cloud.urls[0] as string, protocols: (window as any).__cloud.protocols[0] }))
  expect(first.url).toContain('/v1/listen')
  expect(first.url).not.toContain('deepgram-token')
  expect(first.protocols).toEqual(['bearer', 'deepgram-token'])
  // Browser recognition is not used alongside it.
  expect(await page.evaluate(() => (window as any).__voice.starts)).toBe(0)

  const before = turns.length
  await page.evaluate(() => (window as any).__cloud.say(0, 'a hash function maps', false))
  await expect(page.getByTestId('voice-interim')).toContainText('a hash function maps')
  await page.evaluate(() => (window as any).__cloud.say(0, 'A hash function maps keys to buckets.', true))
  await page.getByTestId('voice-done').click()
  await expect.poll(() => turns.length).toBeGreaterThan(before)
  expect(turns[turns.length - 1].utterance).toBe('A hash function maps keys to buckets.')
  await expect(page.getByTestId('voice-evaluation').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 })

  // The next turn reports that the cloud heard the last one.
  const sent = turns.length
  // The fake says the segment closed after some quiet, so the turn may end on its own before Done shows: either way it goes.
  await page.evaluate(() => (window as any).__cloud.say(1, 'Because lookups are fast.', true))
  await expect.poll(() => turns.length, { timeout: 8_000 }).toBeGreaterThan(sent)
  expect(turns[turns.length - 1].utterance).toBe('Because lookups are fast.')
  expect((turns[turns.length - 1].timing as Record<string, unknown> | undefined)?.recognizer).toBe('cloud')
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

test('cloud speech: when no token can be had, the browser recognizer takes over', async ({ page }) => {
  await installVoiceStubs(page, { speechMs: 200 })
  await page.addInitScript(FAKE_SOCKET)
  await offerCloud(page, 'fail')
  const turns = watchTurns(page)

  await page.goto(voiceUrl())
  await expect(startButton(page)).toBeEnabled({ timeout: 30_000 })
  await startButton(page).click()
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => page.evaluate(() => (window as any).__voice.starts), { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 })

  const before = turns.length
  await page.evaluate(() => (window as any).__voice.final('a hash function maps keys to buckets'))
  await page.getByTestId('voice-done').click()
  await expect.poll(() => turns.length).toBeGreaterThan(before)
  expect(turns[turns.length - 1].utterance).toBe('a hash function maps keys to buckets')
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

test('cloud speech: turned off in the lobby, the browser recognizer is used and the privacy line says so', async ({ page }) => {
  await installVoiceStubs(page, { speechMs: 200 })
  await page.addInitScript(FAKE_SOCKET)
  await offerCloud(page, 'ok')

  await page.goto(voiceUrl())
  await expect(page.getByTestId('voice-cloud-toggle')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('voice-cloud-toggle').click()
  await expect(page.getByTestId('voice-cloud-toggle')).not.toBeChecked()
  await expect(page.getByTestId('voice-privacy')).not.toContainText('Deepgram')
  await expect(startButton(page)).toBeEnabled({ timeout: 15_000 })
  await startButton(page).click()
  await expect.poll(() => page.evaluate(() => (window as any).__voice.starts), { timeout: 15_000 }).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any).__cloud.urls.length)).toBe(0)
  await page.getByRole('button', { name: 'End', exact: true }).click()
  // The choice is saved on the device: put the default back for the specs that follow.
  expect(await page.evaluate(() => window.localStorage.getItem('margins.voice.prefs.v1'))).toContain('"recognition":"browser"')
  await page.evaluate(() => window.localStorage.removeItem('margins.voice.prefs.v1'))
})

test('cloud speech: a microphone that drops mid-session is opened again on the same stream', async ({ page }) => {
  await installVoiceStubs(page, { speechMs: 200 })
  await page.addInitScript(FAKE_SOCKET)
  // Count the microphone openings and keep the last stream, so the spec can end its track as a device change would.
  await page.addInitScript(() => {
    const w = window as any
    w.__mic = { opens: 0, stream: null }
    const wrap = () => {
      const devices = navigator.mediaDevices as any
      if (!devices?.getUserMedia || devices.__wrapped) return
      const original = devices.getUserMedia.bind(devices)
      const wrapped = async (constraints: MediaStreamConstraints) => {
        const stream = await original(constraints)
        w.__mic.opens += 1
        w.__mic.stream = stream
        return stream
      }
      Object.defineProperty(navigator, 'mediaDevices', { value: { ...devices, getUserMedia: wrapped, __wrapped: true }, configurable: true })
    }
    wrap()
    document.addEventListener('DOMContentLoaded', wrap)
  })
  await offerCloud(page, 'ok')
  const turns = watchTurns(page)

  await page.goto(voiceUrl())
  await expect(startButton(page)).toBeEnabled({ timeout: 30_000 })
  await startButton(page).click()
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => page.evaluate(() => (window as any).__cloud.frames), { timeout: 10_000 }).toBeGreaterThan(5)
  const opensBefore = await page.evaluate(() => (window as any).__mic.opens)

  await page.evaluate(() => (window as any).__mic.stream.getAudioTracks()[0].dispatchEvent(new Event('ended')))
  await expect.poll(() => page.evaluate(() => (window as any).__mic.opens), { timeout: 5_000 }).toBeGreaterThan(opensBefore)
  const framesAfter = await page.evaluate(() => (window as any).__cloud.frames)
  await expect.poll(() => page.evaluate(() => (window as any).__cloud.frames), { timeout: 5_000 }).toBeGreaterThan(framesAfter + 5)
  // The same recognizer stream carried on: no new connection, no browser recognizer.
  expect(await page.evaluate(() => (window as any).__cloud.urls.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).__voice.starts)).toBe(0)

  const before = turns.length
  await page.evaluate(() => (window as any).__cloud.say(0, 'A hash function maps keys to buckets.', true))
  await expect.poll(() => turns.length, { timeout: 8_000 }).toBeGreaterThan(before)
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

