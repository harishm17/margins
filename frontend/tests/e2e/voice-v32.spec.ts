import { expect, test, type Page } from '@playwright/test'
import { signIn as signInAs } from './helpers/auth'
import { clearVoiceSessions, ensureVoiceFixture, VOICE_TEST_EMAIL, type VoiceFixture } from './helpers/voice-fixture'
import { installVoiceStubs } from './helpers/voice-stubs'

// v3.2 voice (spec 19): end of turn, interruptions, settings, privacy line, silence. The speech APIs are
// stubs (helpers/voice-stubs.ts), so these check the logic of the page. Real recognition, real voices,
// iOS and Android behaviour need a real device.

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
const voice = (page: Page) => ({
  say: (text: string) => page.evaluate((words) => (window as any).__voice.final(words), text),
  interim: (text: string) => page.evaluate((words) => (window as any).__voice.interim(words), text),
  end: () => page.evaluate(() => (window as any).__voice.end()),
  hold: (on: boolean) => page.evaluate((value) => ((window as any).__voice.hold = value), on),
})

async function waitForLobby(page: Page) {
  await expect(page.getByTestId('voice-lobby')).toBeVisible({ timeout: 30_000 })
  await expect(startButton(page)).toBeEnabled({ timeout: 15_000 })
}

async function startListening(page: Page) {
  await page.goto(voiceUrl())
  await waitForLobby(page)
  await startButton(page).click()
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 })
}

function watchTurns(page: Page) {
  const turns: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/voice/turn')) turns.push(JSON.parse(request.postData() ?? '{}'))
  })
  return turns
}

test('end of turn: still listening, Done ends the turn at once, Enter does the same', async ({ page }) => {
  await installVoiceStubs(page, { speechMs: 200 })
  const turns = watchTurns(page)
  await startListening(page)
  await expect(page.getByTestId('voice-done')).toHaveCount(0)

  await voice(page).say('a hash function maps keys to buckets')
  await expect(page.getByTestId('voice-done')).toBeVisible()
  await expect(page.getByTestId('voice-orb-status')).toHaveText('Still listening', { timeout: 3_000 })
  const before = turns.length
  await page.getByTestId('voice-done').click()
  await expect(page.getByText('a hash function maps keys to buckets')).toHaveCount(1)
  await expect.poll(() => turns.length).toBeGreaterThan(before)
  await expect(page.getByTestId('voice-evaluation').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 })

  await voice(page).say('because it is fast')
  await expect(page.getByTestId('voice-done')).toBeVisible()
  const sent = turns.length
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Enter')
  await expect.poll(() => turns.length).toBeGreaterThan(sent)
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

test('end of turn: a trailing "and" holds the turn longer, and a browser auto-stop keeps the words', async ({ page }) => {
  await installVoiceStubs(page)
  const turns = watchTurns(page)
  await startListening(page)
  const base = turns.length
  const startsBefore = await page.evaluate(() => (window as any).__voice.starts as number)

  await voice(page).say('a hash function maps keys and')
  await page.waitForTimeout(1900)
  expect(turns.length).toBe(base) // 1.2 s plus 1.5 s for "and"
  // Chrome ends the recognizer after a pause: it starts again, and the words are kept.
  await voice(page).end()
  await expect.poll(() => page.evaluate(() => (window as any).__voice.starts as number)).toBeGreaterThan(startsBefore)
  await expect(page.getByTestId('voice-interim')).toHaveText('a hash function maps keys and')
  await voice(page).say('values to buckets')
  await expect(page.getByText('a hash function maps keys and values to buckets')).toHaveCount(1, { timeout: 6_000 })
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

test('interruptions: "yeah" does not interrupt, Interrupt does, and the next turn carries the timing', async ({ page }) => {
  await installVoiceStubs(page, { speechMs: 600 })
  const turns = watchTurns(page)
  await startListening(page)
  await voice(page).say('a hash function maps keys to buckets')
  await page.getByTestId('voice-done').click()
  await expect(page.getByTestId('voice-evaluation').first()).toBeVisible({ timeout: 30_000 })

  await voice(page).hold(true)
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'speaking', { timeout: 30_000 })
  await expect(page.getByTestId('voice-interrupt')).toBeVisible()
  const cancelled = await page.evaluate(() => (window as any).__voice.cancelled as number)
  await voice(page).say('yeah')
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => (window as any).__voice.cancelled as number)).toBe(cancelled)
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'speaking')

  await page.getByTestId('voice-interrupt').click()
  await expect.poll(() => page.evaluate(() => (window as any).__voice.cancelled as number)).toBeGreaterThan(cancelled)
  await expect(page.getByTestId('voice-interrupt')).toHaveCount(0)
  await voice(page).hold(false)

  await page.getByRole('button', { name: 'Type instead' }).click()
  await page.getByLabel('Your answer').fill('It maps keys to slots')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => turns.length).toBeGreaterThanOrEqual(4)
  const last = turns[turns.length - 1]
  const timing = last.timing as Record<string, unknown>
  expect(timing).toBeTruthy()
  expect(timing.interrupted).toBe(true)
  expect(typeof timing.requestToFirstEventMs).toBe('number')
  expect(typeof timing.requestToFirstSentenceMs).toBe('number')
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

test('settings: Speak replies off means no speech and the turn still works; the choice is kept', async ({ page }) => {
  await installVoiceStubs(page)
  await page.goto(voiceUrl())
  await waitForLobby(page)
  const toggle = page.getByTestId('voice-speak-toggle')
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('margins.voice.prefs.v1') ?? '{}').speak)).toBe(false)
  await startButton(page).click()
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 })
  expect(await page.evaluate(() => (window as any).__voice.spoken.length as number)).toBe(0)
  await expect(page.getByTestId('voice-coach-turn').first()).toContainText(/\w/)

  await voice(page).say('a hash function maps keys to buckets')
  await page.getByTestId('voice-done').click()
  await expect(page.getByTestId('voice-evaluation').first()).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(() => (window as any).__voice.spoken.length as number)).toBe(0)

  await page.getByTestId('voice-settings-trigger').click()
  const panel = page.getByTestId('voice-settings')
  await panel.getByTestId('voice-speak-toggle').click()
  await panel.getByTestId('voice-rate').fill('1.3')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('margins.voice.prefs.v1') ?? '{}'))).toMatchObject({ speak: true, rate: 1.3 })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'End', exact: true }).click()
  await page.reload()
  await waitForLobby(page)
  await expect(page.getByTestId('voice-speak-toggle')).toBeChecked()
  await page.evaluate(() => localStorage.removeItem('margins.voice.prefs.v1'))
})

test('silence: ten seconds after a question there is one gentle line, once, and it is not a turn', async ({ page }) => {
  await installVoiceStubs(page, { speechMs: 200 })
  const turns = watchTurns(page)
  await startListening(page)
  const base = turns.length
  await page.waitForTimeout(8_000)
  await expect(page.getByTestId('voice-coach-note')).toHaveCount(0)
  await expect(page.getByTestId('voice-coach-note')).toHaveCount(1, { timeout: 8_000 })
  await expect(page.getByTestId('voice-coach-note')).toContainText("I don't know")
  await page.waitForTimeout(5_000)
  await expect(page.getByTestId('voice-coach-note')).toHaveCount(1)
  expect(turns.length).toBe(base)
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

