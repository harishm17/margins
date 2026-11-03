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

const FAKE_SOCKET = `
(() => {
  const Real = window.WebSocket
  const cloud = { sockets: [], frames: 0, urls: [] }
  class FakeCloudSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.binaryType = 'blob'
      cloud.urls.push(url)
      cloud.sockets.push(this)
      setTimeout(() => {
        this.readyState = 1
        this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'Begin', id: 'fake' }) })
      }, 50)
    }
    send(data) {
      if (typeof data === 'string') return
      cloud.frames += 1
    }
    close() { this.readyState = 3 }
  }
  cloud.turn = (order, transcript, final) => {
    const socket = cloud.sockets[cloud.sockets.length - 1]
    if (!socket || socket.readyState !== 1) return false
    socket.onmessage && socket.onmessage({ data: JSON.stringify({
      type: 'Turn', turn_order: order, end_of_turn: final, transcript,
      words: [{ text: 'x', start: 0, end: Math.max(0, cloud.frames * 100 - 300) }],
    }) })
    return true
  }
  window.__cloud = cloud
  window.WebSocket = function (url, protocols) {
    if (String(url).startsWith('wss://cloud.test/')) return new FakeCloudSocket(url)
    return new Real(url, protocols)
  }
  window.WebSocket.prototype = Real.prototype
})()
`

/** The server "has" cloud speech; the token route answers with a fake recognizer address, or fails. */
async function offerCloud(page: Page, token: 'ok' | 'fail') {
  const withCloud = async (route: import('@playwright/test').Route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: { ...body, cloudSpeech: true } })
  }
  await page.route('**/api/voice/usage', withCloud)
  await page.route('**/api/voice/session', (route) => (route.request().method() === 'POST' ? withCloud(route) : route.continue()))
  await page.route('**/api/voice/speech-token', (route) =>
    token === 'ok'
      ? route.fulfill({ json: { provider: 'assemblyai', url: 'wss://cloud.test/v3/ws?sample_rate=16000', token: 'fake-token' } })
      : route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_ERROR', message: 'Cloud speech is not available' } } })
  )
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
  await expect(page.getByTestId('voice-privacy')).toContainText('AssemblyAI')
  await expect(page.getByTestId('voice-cloud-toggle')).toBeVisible()
  await expect(startButton(page)).toBeEnabled({ timeout: 15_000 })
  await startButton(page).click()
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 })

  // The worklet makes a frame every 100 ms, and every one goes to the recognizer.
  await expect.poll(() => page.evaluate(() => (window as any).__cloud.frames), { timeout: 10_000 }).toBeGreaterThan(5)
  const url = await page.evaluate(() => (window as any).__cloud.urls[0] as string)
  expect(url).toContain('token=fake-token')
  // Browser recognition is not used alongside it.
  expect(await page.evaluate(() => (window as any).__voice.starts)).toBe(0)

  const before = turns.length
  await page.evaluate(() => (window as any).__cloud.turn(0, 'a hash function maps', false))
  await expect(page.getByTestId('voice-interim')).toContainText('a hash function maps')
  await page.evaluate(() => (window as any).__cloud.turn(0, 'A hash function maps keys to buckets.', true))
  await page.getByTestId('voice-done').click()
  await expect.poll(() => turns.length).toBeGreaterThan(before)
  expect(turns[turns.length - 1].utterance).toBe('A hash function maps keys to buckets.')
  await expect(page.getByTestId('voice-evaluation').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 })

  // The next turn reports that the cloud heard the last one.
  const sent = turns.length
  // The fake says the segment closed after some quiet, so the turn may end on its own before Done shows: either way it goes.
  await page.evaluate(() => (window as any).__cloud.turn(1, 'Because lookups are fast.', true))
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
  await expect(page.getByTestId('voice-privacy')).not.toContainText('AssemblyAI')
  await expect(startButton(page)).toBeEnabled({ timeout: 15_000 })
  await startButton(page).click()
  await expect.poll(() => page.evaluate(() => (window as any).__voice.starts), { timeout: 15_000 }).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any).__cloud.urls.length)).toBe(0)
  await page.getByRole('button', { name: 'End', exact: true }).click()
  // The choice is saved on the device: put the default back for the specs that follow.
  expect(await page.evaluate(() => window.localStorage.getItem('margins.voice.prefs.v1'))).toContain('"recognition":"browser"')
  await page.evaluate(() => window.localStorage.removeItem('margins.voice.prefs.v1'))
})
