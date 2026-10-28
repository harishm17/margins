import { expect, test, type Page } from '@playwright/test'
import { clearVoiceSessions, ensureVoiceFixture, VOICE_TEST_EMAIL, VOICE_TEST_PASSWORD, type VoiceFixture } from './helpers/voice-fixture'
import { installVoiceStubs } from './helpers/voice-stubs'

// Voice practice against the dev stack with the mock LLM (a scripted coach: the first turn asks a
// question, the next message is graded as the answer). The mock stack cannot write questions the
// voice backend accepts, so helpers/voice-fixture.ts gives a test account a small course with
// hand-written ones. Headless Chromium has no microphone, so voice mode runs on stubs
// (helpers/voice-stubs.ts) and the plain flows run in text mode.

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(VOICE_TEST_EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(VOICE_TEST_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/home', { timeout: 60_000 })
}

let fixture: VoiceFixture
const ids = {
  get courseId() {
    return fixture.courseId
  },
  get topicId() {
    return fixture.topics['Hash tables']
  },
}

test.beforeAll(async ({ baseURL }) => {
  fixture = await ensureVoiceFixture(baseURL ?? 'http://localhost:3000')
})

test.beforeEach(async ({ page }) => {
  await clearVoiceSessions()
  await signIn(page)
})

const startButton = (page: Page) => page.getByRole('button', { name: /Start (voice practice|sprint)/ })

async function waitForLobby(page: Page) {
  await expect(page.getByTestId('voice-lobby')).toBeVisible({ timeout: 30_000 })
  await expect(startButton(page)).toBeEnabled({ timeout: 15_000 })
}

test('the Review page links to voice practice, which has a screen of its own with the weakest topics and the lobby', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/review`)
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Voice practice' })).toBeVisible()
  // The session does not run inside the Review page: there is no lobby here, only the way in.
  await expect(page.getByTestId('voice-lobby')).toHaveCount(0)
  await page.getByRole('link', { name: 'Start voice practice' }).click()
  await expect(page).toHaveURL(new RegExp(`/courses/${ids.courseId}/review/voice$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Voice practice' })).toBeVisible()
  await expect(page.getByText('Covers your 3 weakest topics: Recursion basics, Graph search and Sorting by comparison.')).toBeVisible()
  // A focus screen: Exit leads back to Review.
  await expect(page.getByRole('link', { name: 'Exit' })).toHaveAttribute('href', `/courses/${ids.courseId}/review`)
  await waitForLobby(page)
  await expect(page.getByText(/min left today$/)).toBeVisible()
  await expect(page.getByLabel('Focus (optional)')).toBeVisible()
  // The browser has no speech recognition: the lobby says so.
  await expect(page.getByText("This browser can't hear you, so you will type your answers.")).toBeVisible()
})

test('text mode: start, first question, answer, evaluation, end, summary', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/review/voice`)
  await waitForLobby(page)
  await startButton(page).click()

  // Automatic text mode, with the alert from the design.
  await expect(page.getByTestId('voice-session')).toBeVisible()
  await expect(page.getByText("Voice input isn't supported in this browser. You can type your answers.")).toBeVisible()

  // The coach greets and asks the first question.
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-progress')).toHaveText(/^Question 1 of \d+$/)
  await expect(page.getByText('Here is your question.')).toBeVisible()

  // Type an answer; the evaluation appears under the coach's reply.
  await page.getByLabel('Your answer').fill('It maps a key to a bucket with a hash function.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('It maps a key to a bucket with a hash function.')).toBeVisible()
  const evaluation = page.getByTestId('voice-evaluation').first()
  await expect(evaluation).toBeVisible({ timeout: 30_000 })
  await expect(evaluation.locator('span').first()).toHaveText(/Correct|Partly|Not quite|Noted/)
  await expect(page.getByText(/Thanks, I have noted that/)).toBeVisible()

  // End shows the summary.
  await page.getByRole('button', { name: 'End', exact: true }).click()
  await expect(page.getByTestId('voice-summary')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Practice finished' })).toBeVisible()
  await expect(page.getByTestId('voice-stat-answered')).toHaveText('1')
  await expect(page.getByRole('link', { name: 'Back to review' })).toHaveAttribute('href', `/courses/${ids.courseId}/review`)

  // Start again returns to the lobby.
  await page.getByRole('button', { name: 'Start again' }).click()
  await waitForLobby(page)
})

test('text mode: Just talk has no Hint or Skip and the coach replies', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)
  // Style control is a radiogroup; Just talk has no questions, so no Hint or Skip.
  await page.getByRole('radio', { name: 'Just talk' }).click()
  await startButton(page).click()
  await expect(page.getByTestId('voice-session')).toBeVisible()
  await expect(page.getByText(/Hi, I am your mock coach/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Hint' })).toHaveCount(0)
  await page.getByLabel('Your answer').fill('Tell me about hashing')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/Mock coach here. You said: Tell me about hashing/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'End', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Conversation finished' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to topic' })).toHaveAttribute(
    'href',
    `/courses/${ids.courseId}/topics/${ids.topicId}`
  )
})

test('voice mode: listening, 800 ms silence sends the answer, speaking, barge-in', async ({ page }) => {
  await installVoiceStubs(page, { speechMs: 600 })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)
  await startButton(page).click()

  // The coach speaks its greeting sentence by sentence.
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => page.evaluate(() => (window as any).__voice.spoken.length)).toBeGreaterThan(0)
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', /speaking|listening/)
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening', { timeout: 15_000 })
  await expect(page.getByTestId('voice-orb-status')).toHaveText('Listening')

  // The student talks: interim text shows live, then the final utterance goes out after silence.
  await page.evaluate(() => (window as any).__voice.interim('a hash function maps'))
  await expect(page.getByTestId('voice-interim')).toHaveText('a hash function maps')
  await page.evaluate(() => (window as any).__voice.final('a hash function maps keys to buckets'))
  await expect(page.getByText('a hash function maps keys to buckets')).toHaveCount(1)
  await expect(page.getByTestId('voice-evaluation').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', /thinking|speaking|listening/)

  // Barge-in: while the coach talks, the student speaks and speech is cancelled at once.
  await page.evaluate(() => {
    ;(window as any).__voice.hold = true
  })
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'speaking', { timeout: 30_000 })
  const cancelledBefore = await page.evaluate(() => (window as any).__voice.cancelled)
  await page.evaluate(() => (window as any).__voice.interim('wait stop'))
  await expect.poll(() => page.evaluate(() => (window as any).__voice.cancelled)).toBeGreaterThan(cancelledBefore)
  await expect(page.getByTestId('voice-orb')).not.toHaveAttribute('data-state', 'speaking')
  await page.evaluate(() => {
    ;(window as any).__voice.hold = false
  })

  await page.getByRole('button', { name: 'End', exact: true }).click()
  await expect(page.getByTestId('voice-summary')).toBeVisible()
})

test('voice mode: pause the mic, type instead, and come back to the microphone', async ({ page }) => {
  await installVoiceStubs(page)
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)
  await startButton(page).click()
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening', { timeout: 30_000 })

  await page.getByRole('button', { name: 'Pause mic' }).click()
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'paused')
  await expect(page.getByTestId('voice-orb-status')).toHaveText('Paused')
  await page.getByRole('button', { name: 'Resume mic' }).click()
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening')

  await page.getByRole('button', { name: 'Type instead' }).click()
  await expect(page.getByLabel('Your answer')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use microphone' })).toBeVisible()
  await page.getByRole('button', { name: 'Use microphone' }).click()
  await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening')
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

test('microphone permission denied falls back to typing with a way to retry', async ({ page }) => {
  await installVoiceStubs(page, { micDenied: true })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)
  await startButton(page).click()
  await expect(page.getByText('Microphone access is blocked')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Your answer')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try the mic again' })).toBeVisible()
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

test('lobby: the daily limit disables Start, the 422 offers to create content', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.route('**/api/voice/usage', (route) =>
    route.fulfill({ json: { dailyMinutes: 30, usedSeconds: 1800, remainingSeconds: 0, hasLiveSession: false } })
  )
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await expect(page.getByTestId('voice-lobby')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('0 min left today')).toBeVisible()
  await expect(startButton(page)).toBeDisabled()
  await expect(page.getByText("You've used today's voice time. It resets within 24 hours.")).toBeVisible()

  await page.unroute('**/api/voice/usage')
  await page.route('**/api/voice/usage', (route) =>
    route.fulfill({ json: { dailyMinutes: 30, usedSeconds: 0, remainingSeconds: 1080, hasLiveSession: false } })
  )
  await page.route('**/api/voice/session', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 422,
          json: { error: { code: 'CONFLICT', message: 'No conceptual questions available' }, requiresGeneration: true },
        })
      : route.continue()
  )
  await page.reload()
  await waitForLobby(page)
  await expect(page.getByText('18 min left today')).toBeVisible()
  await startButton(page).click()
  await expect(page.getByText('Create notes and a quiz first')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create them' })).toHaveAttribute(
    'href',
    `/courses/${ids.courseId}/topics/${ids.topicId}?view=notes`
  )
})

const turnError = (status: number, code: string, message: string, retryable: boolean) => ({
  status,
  json: { error: { code: 'CONFLICT', message, details: { code, retryable } } },
})

test('turn errors: active session and daily limit send you back to the lobby', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)

  await page.route('**/api/voice/turn', (route) => route.fulfill(turnError(409, 'ACTIVE_SESSION', 'Another session is live', false)))
  await startButton(page).click()
  await expect(page.getByText('Another voice practice is open', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-lobby')).toBeVisible()

  await page.unroute('**/api/voice/turn')
  await page.route('**/api/voice/turn', (route) => route.fulfill(turnError(429, 'VOICE_DAILY_LIMIT', 'Limit', false)))
  await startButton(page).click()
  await expect(page.getByText("You've used today's voice time", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(startButton(page)).toBeDisabled()
})

test('turn errors: a retryable failure keeps the session and Try again recovers', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)

  let failures = 1
  await page.route('**/api/voice/turn', (route) => {
    if (failures > 0) {
      failures -= 1
      return route.fulfill(turnError(503, 'LLM_UNAVAILABLE', 'Busy', true))
    }
    return route.continue()
  })
  await startButton(page).click()
  const alert = page.getByTestId('voice-alert')
  // The shared words for a busy AI (lib/ai/messages).
  await expect(alert).toContainText('The AI is busy right now', { timeout: 30_000 })
  await alert.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

test('turn errors: a session that ended on the server shows the summary', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)
  await startButton(page).click()
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })

  await page.route('**/api/voice/turn', (route) => route.fulfill(turnError(409, 'SESSION_ENDED', 'Ended', false)))
  await page.getByLabel('Your answer').fill('my answer')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('voice-summary')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('This session has ended')).toBeVisible()
})

test('stream events: an error event and a finished drill', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)

  const lines = (events: object[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  let call = 0
  await page.route('**/api/voice/turn', (route) => {
    call += 1
    if (call === 1) {
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: lines([
          { type: 'question', index: 7, total: 8, text: 'What is amortised analysis?', questionType: 'short_answer' },
          { type: 'text', delta: 'Last one. ' },
          { type: 'done', text: 'Last one. ' },
        ]),
      })
    }
    if (call === 2) {
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: lines([
          { type: 'text', delta: 'Hmm, ' },
          { type: 'error', code: 'VOICE_INTERRUPTED', message: 'Cut off', retryable: true },
        ]),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: lines([
        { type: 'evaluation', isCorrect: false, score: 0.5, comment: 'You had half of it.', explanation: 'x' },
        { type: 'session_complete' },
        { type: 'text', delta: 'That was the last question. Goodbye.' },
        { type: 'done', text: 'That was the last question. Goodbye.' },
      ]),
    })
  })
  await startButton(page).click()
  await expect(page.getByTestId('voice-progress')).toHaveText('Question 8 of 8', { timeout: 30_000 })

  await page.getByLabel('Your answer').fill('it averages the cost')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('voice-alert')).toContainText('The connection dropped')
  await page.getByTestId('voice-alert').getByRole('button', { name: 'Try again' }).click()

  // The drill finished: the badge shows, then the summary with what to revisit.
  await expect(page.getByTestId('voice-summary')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-stat-answered')).toHaveText('1')
  await expect(page.getByTestId('voice-revisit')).toContainText('What is amortised analysis?')
})

test('the session is ended on page hide and a heartbeat goes out every 30 seconds', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.clock.install()
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await page.clock.resume()
  await waitForLobby(page)

  const patches: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().includes('/api/voice/session')) {
      patches.push(JSON.parse(request.postData() ?? '{}'))
    }
  })
  await startButton(page).click()
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })

  await page.clock.fastForward(31_000)
  await expect.poll(() => patches.some((patch) => patch.heartbeat === true)).toBe(true)

  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await expect.poll(() => patches.some((patch) => patch.status === 'ended')).toBe(true)
})
