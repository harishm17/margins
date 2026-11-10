import { expect, test, type Page } from '@playwright/test'
import { signIn as signInAs } from './helpers/auth'
import { clearVoiceSessions, ensureVoiceFixture, makeLoadFactorStrong, VOICE_TEST_EMAIL, type VoiceFixture } from './helpers/voice-fixture'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { installVoiceStubs } from './helpers/voice-stubs'

import { END_OF_TURN_WAIT_MS } from '../../src/lib/voice/turn-contract'
// Voice practice against the dev stack with the mock LLM (a scripted coach: the first turn asks a
// question, the next message is graded as the answer). The mock stack cannot write questions the
// voice backend accepts, so helpers/voice-fixture.ts gives a test account a small course with
// hand-written ones. Headless Chromium has no microphone, so voice mode runs on stubs
// (helpers/voice-stubs.ts) and the plain flows run in text mode.

const signIn = (page: Page) => signInAs(page, VOICE_TEST_EMAIL)

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

test('text mode: start, first question, answer, evaluation, end, summary', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/review/voice`)
  await waitForLobby(page)
  await startButton(page).click()

  // Automatic text mode: the lobby said so already, so the session has no "Your turn" mic and no late notice, and the text box
  // (focused) is the way in.
  await expect(page.getByTestId('voice-session')).toBeVisible()
  await expect(page.getByLabel('Your answer')).toBeFocused()
  await expect(page.getByTestId('voice-orb')).toHaveCount(0)
  await expect(page.getByText('Your turn')).toHaveCount(0)
  await expect(page.getByTestId('voice-mic-notice')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Use microphone' })).toHaveCount(0)

  // The coach greets and asks the first question.
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-progress')).toHaveText(/^Question 1 of \d+$/)
  await expect(page.getByTestId('voice-transcript').getByText('Here is your question.')).toBeVisible()

  // Type an answer; the evaluation appears under the coach's reply.
  await page.getByLabel('Your answer').fill('It maps a key to a bucket with a hash function.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('It maps a key to a bucket with a hash function.')).toBeVisible()
  const evaluation = page.getByTestId('voice-evaluation').first()
  await expect(evaluation).toBeVisible({ timeout: 30_000 })
  await expect(evaluation.locator('span').first()).toHaveText(/Correct|Partly|Not quite|Noted/)
  await expect(page.getByTestId('voice-transcript').getByText(/Thanks, I have noted that/)).toBeVisible()

  // End shows the summary.
  await page.getByRole('button', { name: 'End', exact: true }).click()
  await expect(page.getByTestId('voice-summary')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Practice finished' })).toBeVisible()
  // The answer was typed, so the summary does not say "talked".
  await expect(page.getByTestId('voice-summary')).toContainText(/You typed for (under a minute|\d+ minutes?)\./)
  await expect(page.getByTestId('voice-summary')).not.toContainText('talked')
  await expect(page.getByTestId('voice-stat-answered')).toHaveText('1')
  await expect(page.getByRole('link', { name: 'Back to review' })).toHaveAttribute('href', `/courses/${ids.courseId}/review`)

  // Start again returns to the lobby.
  await page.getByRole('button', { name: 'Start again' }).click()
  await waitForLobby(page)
})

async function startStyle(page: Page, style: RegExp) {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)
  await page.getByRole('radio', { name: style }).click()
  await startButton(page).click()
  await expect(page.getByTestId('voice-session')).toBeVisible()
}

const sessionEvidence = (source: string) =>
  withPrisma((prisma) =>
    prisma.evidenceEvent.findMany({
      where: { user: { email: VOICE_TEST_EMAIL }, source },
      orderBy: { createdAt: 'asc' },
      select: { assistance: true, score: true, conceptId: true, itemKey: true },
    })
  )

test('teach it back: the idea is on the board, the explanation is assessed against the pages, and the coach probes', async ({ page }) => {
  // An earlier run today would make this a second try (the same local day is assisted), so start from none.
  await withPrisma(async (prisma) => {
    await prisma.evidenceEvent.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL }, source: { in: ['teach_back', 'voice'] } } })
    await prisma.recallAttempt.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL } } })
  })
  await makeLoadFactorStrong()
  await startStyle(page, /Teach it back/)

  // The weakest idea comes first, asked as the prompt on the board and in the coach's words.
  const board = page.getByTestId('voice-board')
  await expect(board).toHaveAttribute('data-kind', 'concept', { timeout: 30_000 })
  await expect(board).toContainText('Explain "Collision" in your own words')
  await expect(page.getByTestId('voice-transcript').getByText(/Explain it to me as if I were a classmate/)).toBeVisible({ timeout: 30_000 })
  // No question bank in this style: no Hint or Skip.
  await expect(page.getByRole('button', { name: 'Hint' })).toHaveCount(0)
  await screenshotIfAsked(page, 'g1-teach-back-idea-1440x900')

  // The explanation goes to the recall grader (the mock covers the first claim and misses the second): one probe, no lecture.
  await page.getByLabel('Your answer').fill('Two keys that land in the same bucket are a collision and the table has to cope with it somehow')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('voice-transcript').getByText(/Mock probe 1: what exactly do you mean/)).toBeVisible({ timeout: 30_000 })
  await expectNoAxeViolations(page, 'teach-back session after a probe')

  // The first explanation of the idea is level 0 teach_back evidence, written once.
  const rows = await sessionEvidence('teach_back')
  expect(rows.map((row) => row.assistance)).toEqual([0])

  // A second answer is assessed with the first but is not scored again as an explanation.
  await page.getByLabel('Your answer').fill('The second claim is about lists in each bucket maybe')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('voice-transcript').getByText(/Mock probe 2: what exactly do you mean/)).toBeVisible({ timeout: 30_000 })
  expect((await sessionEvidence('teach_back')).length).toBe(1)
  await page.getByRole('button', { name: 'End', exact: true }).click()
  await expect(page.getByTestId('voice-summary')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Teach-back finished' })).toBeVisible()
})

test('guided reading: predict first, then the claim on the board with its page, then one check question', async ({ page }) => {
  await withPrisma((prisma) => prisma.evidenceEvent.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL }, source: { in: ['teach_back', 'voice'] } } }))
  await startStyle(page, /Read it with me/)

  // The prediction comes first: the board names the idea and does not show the claim.
  const board = page.getByTestId('voice-board')
  await expect(board).toHaveAttribute('data-kind', 'prediction', { timeout: 30_000 })
  await expect(board).toContainText('Load factor')
  await expect(page.getByText(/The load factor is/)).toHaveCount(0)
  await screenshotIfAsked(page, 'g1-guided-predict-1440x900')

  await page.getByLabel('Your answer').fill('I think it measures how full the table is')
  await page.getByRole('button', { name: 'Send' }).click()

  // Then the claim, drawn with its maths, linked to the page it came from, with the check question under it.
  await expect(board).toHaveAttribute('data-kind', 'claim', { timeout: 30_000 })
  await expect(board.locator('.katex').first()).toBeVisible()
  await expect(board.getByTestId('voice-board-check')).toContainText('In your own words, what do your pages say about "Load factor"?')
  const link = board.getByTestId('voice-board-source')
  await expect(link).toHaveText('p. 6')
  await expect(link).toHaveAttribute('href', /\/api\/materials\/[^/]+\/file#page=6$/)
  await screenshotIfAsked(page, 'g1-guided-claim-1440x900')
  await expectNoAxeViolations(page, 'guided reading with a claim on the board')

  // The check is level 2 voice evidence on the claim's concept, and the next claim opens as a prediction again.
  await page.getByLabel('Your answer').fill('The number of entries divided by the number of buckets')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('voice-evaluation').first()).toBeVisible({ timeout: 30_000 })
  const rows = await sessionEvidence('voice')
  expect(rows.map((row) => [row.assistance, row.score])).toEqual([[2, 1]])
  await page.getByRole('button', { name: 'End', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Reading finished' })).toBeVisible()
})

test('lobby: a topic with no claims starts on Quiz me even when a link asks for Teach it back, and says why before the start', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  const bare = `/courses/${ids.courseId}/topics/${fixture.topics['Recursion basics']}`
  await page.goto(`${bare}?view=voice&style=teach_back`)
  await waitForLobby(page)
  await expect(page.getByRole('radio', { name: /Quiz me/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: /Teach it back/ })).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByText("Your pages aren't read into ideas yet")).toBeVisible()
  await expectNoAxeViolations(page, 'voice lobby on a topic with no claims')
  // A topic that has claims keeps the style the link names.
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice&style=teach_back`)
  await waitForLobby(page)
  await expect(page.getByRole('radio', { name: /Teach it back/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText("Your pages aren't read into ideas yet")).toHaveCount(0)
})

test('voice mode: listening, a short answer is sent after its adaptive wait, speaking, barge-in', async ({ page }) => {
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
  // A quiz answer is a short answer: the turn goes out 1.2 s after the last words (END_OF_TURN_WAIT_MS), not before.
  const turnSent = page.waitForRequest((request) => request.url().includes('/api/voice/turn') && request.method() === 'POST')
  const finalAt = Date.now()
  await page.evaluate(() => (window as any).__voice.final('a hash function maps keys to buckets'))
  await turnSent
  expect(Date.now() - finalAt).toBeGreaterThanOrEqual(END_OF_TURN_WAIT_MS.short_answer - 200)
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
  await expect(page.getByText('Quiz me needs a quiz first')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Write the quiz' })).toHaveAttribute(
    'href',
    `/courses/${ids.courseId}/topics/${ids.topicId}?view=quiz`
  )
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
        { type: 'evaluation', isCorrect: false, score: 0.5, comment: 'You had half of it.', explanation: 'x', lookLinks: [{ label: 'pp. 4-6', href: '/api/materials/m1/file#page=4' }] },
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
  // The question's pages are a link into the student's own file.
  const pages = page.getByTestId('voice-revisit').getByRole('link', { name: /pp\. 4-6/ })
  await expect(pages).toHaveAttribute('href', '/api/materials/m1/file#page=4')
  await expect(pages).toHaveAttribute('target', '_blank')
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

// ---------------------------------------------------------------------------------------------------------
// v3.1 (spec 5.8, 18.3, 18.6): a spoken "I don't know" is a try, and the coach explains first.
// (The turn limit is no reason to wait here: scripts/e2e-stack.sh gives the web app VOICE_TURNS_PER_MINUTE=1000.)

test("teach it back: an I-don't-know is explained at once, with no probe, and is level 1 with score 0", async ({ page }) => {
  await withPrisma(async (prisma) => {
    await prisma.evidenceEvent.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL }, source: { in: ['teach_back', 'voice', 'instruction'] } } })
    await prisma.recallAttempt.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL } } })
  })
  await makeLoadFactorStrong()
  await startStyle(page, /Teach it back/)
  await expect(page.getByTestId('voice-board')).toHaveAttribute('data-kind', 'concept', { timeout: 30_000 })
  await page.getByLabel('Your answer').fill("I don't know")
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('voice-transcript').getByText(/Mock explain first: here is the idea from your pages/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Mock probe/)).toHaveCount(0)
  await page.setViewportSize({ width: 1440, height: 900 })
  await screenshotIfAsked(page, 'voice-explain-first-1440x900')
  await expectNoAxeViolations(page, 'teach-back session after an explain-first')
  const rows = await sessionEvidence('teach_back')
  expect(rows.map((row) => [row.assistance, row.score])).toEqual([[1, 0]])
  // The explanation is instruction, written once per explained claim.
  const instruction = await sessionEvidence('instruction')
  expect(instruction.map((row) => [row.assistance, row.score, row.itemKey.split(':')[1]])).toEqual([[3, 0, 'voice_explain']])
})
