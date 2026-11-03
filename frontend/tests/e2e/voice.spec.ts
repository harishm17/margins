import { expect, test, type Page } from '@playwright/test'
import { signIn as signInAs } from './helpers/auth'
import { clearVoiceSessions, ensureVoiceFixture, makeLoadFactorStrong, VOICE_TEST_EMAIL, type VoiceFixture } from './helpers/voice-fixture'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { overflowing } from './helpers/overflow'
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
  // The Review page the link was on can still be in the document, hidden, while the new screen shows: only the one on screen counts.
  await expect(page.locator('p:visible', { hasText: 'Covers your 3 weakest topics: Recursion basics, Graph search and Sorting by comparison.' })).toBeVisible()
  // A focus screen: Exit leads back to Review.
  await expect(page.getByRole('link', { name: 'Exit' })).toHaveAttribute('href', `/courses/${ids.courseId}/review`)
  await waitForLobby(page)
  await expect(page.getByText(/min left today$/)).toBeVisible()
  await expect(page.getByLabel('Focus (optional)')).toBeVisible()
  // The browser has no speech recognition: the lobby says so before the start, in one line that names the browsers that do.
  await expect(page.getByTestId('voice-no-recognition')).toHaveText("This browser can't listen, so you will type your answers. Talking works in Chrome, Edge and Safari.")
})

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
  // The answer was typed, so the summary does not say "talked".
  await expect(page.getByTestId('voice-summary')).toContainText(/You typed for \d+ minutes?\./)
  await expect(page.getByTestId('voice-summary')).not.toContainText('talked')
  await expect(page.getByTestId('voice-stat-answered')).toHaveText('1')
  await expect(page.getByRole('link', { name: 'Back to review' })).toHaveAttribute('href', `/courses/${ids.courseId}/review`)

  // Start again returns to the lobby.
  await page.getByRole('button', { name: 'Start again' }).click()
  await waitForLobby(page)
})

test('lobby: three style cards, one chosen at a time, each saying what it does', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)
  const styles = page.getByRole('radiogroup', { name: 'Style' })
  await expect(styles.getByRole('radio')).toHaveCount(3)
  const quiz = styles.getByRole('radio', { name: /Quiz me/ })
  const teach = styles.getByRole('radio', { name: /Teach it back/ })
  const reading = styles.getByRole('radio', { name: /Read it with me/ })
  // Quiz me is chosen to begin with. The old free conversation is not offered.
  await expect(quiz).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: /Just talk/ })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /Walk me through it/ })).toHaveCount(0)
  await expect(teach).toContainText('does not explain first')
  await expect(reading).toContainText('you predict it, hear it, then answer one check question')
  await teach.click()
  await expect(teach).toHaveAttribute('aria-checked', 'true')
  await expect(quiz).toHaveAttribute('aria-checked', 'false')
  await screenshotIfAsked(page, 'g1-lobby-cards-1440x900')
  await expectNoAxeViolations(page, 'voice lobby with style cards')
  // Arrow keys move through the cards (held a moment, as a keyboard does: Radix selects on the focus the key causes).
  await teach.focus()
  await page.keyboard.down('ArrowRight')
  await expect(reading).toBeFocused()
  await page.keyboard.up('ArrowRight')
  await expect(reading).toHaveAttribute('aria-checked', 'true')
})

test('board shows the current question with rendered math', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)
  const lines = (events: object[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  let call = 0
  await page.route('**/api/voice/turn', (route) => {
    call += 1
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        call === 1
          ? lines([
              {
                type: 'question',
                index: 1,
                total: 4,
                text: 'If the load factor is $\\alpha = n/m$ and $n$ doubles, what happens to $\\alpha$?',
                questionType: 'multiple_choice',
                options: [
                  { id: 'A', text: '$\\alpha$ halves' },
                  { id: 'B', text: '$\\alpha$ doubles' },
                ],
              },
              { type: 'text', delta: 'Here is a question about the load factor. Take your time.' },
              { type: 'done', text: 'Here is a question about the load factor. Take your time.' },
            ])
          : lines([
              { type: 'text', delta: 'Let us look at the next one.' },
              { type: 'board', kind: 'claim', text: 'The load factor is $\\alpha = n / m$.', question: 'What does $m$ stand for?', source: { label: 'p. 6', href: '/api/materials/m1/file#page=6' } },
              { type: 'done', text: 'Let us look at the next one.' },
            ]),
    })
  })
  await startButton(page).click()
  const board = page.getByTestId('voice-board')
  await expect(board).toBeVisible({ timeout: 30_000 })
  // The question is text on the board, so nothing is only audio, and the formulas are drawn rather than spoken.
  await expect(board.getByTestId('voice-question')).toContainText('what happens to')
  await expect(board.locator('.katex').first()).toBeVisible()
  expect(await board.locator('.katex').count()).toBeGreaterThanOrEqual(4)
  await expect(board.getByText('α halves').or(board.locator('.katex', { hasText: 'α' })).first()).toBeVisible()
  await expect(page.getByTestId('voice-progress')).toHaveText('Question 2 of 4')
  await screenshotIfAsked(page, 'g1-board-question-1440x900')
  await expectNoAxeViolations(page, 'voice board with a question')

  // The next tool result replaces the board: a claim with its page link and the check question under it.
  await page.getByLabel('Your answer').fill('It doubles')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(board).toHaveAttribute('data-kind', 'claim', { timeout: 30_000 })
  await expect(board.locator('.katex').first()).toBeVisible()
  await expect(board.getByTestId('voice-board-check')).toContainText('What does')
  const link = board.getByRole('link', { name: 'Open p. 6 in your files (opens in a new tab)' })
  await expect(link).toHaveAttribute('href', '/api/materials/m1/file#page=6')
  await expect(link).toHaveAttribute('target', '_blank')
  await screenshotIfAsked(page, 'g1-board-claim-1440x900')
  await expectNoAxeViolations(page, 'voice board with a claim')
  await page.getByRole('button', { name: 'End', exact: true }).click()
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
  await expect(page.getByText(/Explain it to me as if I were a classmate/)).toBeVisible({ timeout: 30_000 })
  // No question bank in this style: no Hint or Skip.
  await expect(page.getByRole('button', { name: 'Hint' })).toHaveCount(0)
  await screenshotIfAsked(page, 'g1-teach-back-idea-1440x900')

  // The explanation goes to the recall grader (the mock covers the first claim and misses the second): one probe, no lecture.
  await page.getByLabel('Your answer').fill('Two keys that land in the same bucket are a collision and the table has to cope with it somehow')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/Mock probe 1: what exactly do you mean/)).toBeVisible({ timeout: 30_000 })
  await expectNoAxeViolations(page, 'teach-back session after a probe')

  // The first explanation of the idea is level 0 teach_back evidence, written once.
  const rows = await sessionEvidence('teach_back')
  expect(rows.map((row) => row.assistance)).toEqual([0])

  // A second answer is assessed with the first but is not scored again as an explanation.
  await page.getByLabel('Your answer').fill('The second claim is about lists in each bucket maybe')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/Mock probe 2: what exactly do you mean/)).toBeVisible({ timeout: 30_000 })
  expect((await sessionEvidence('teach_back')).length).toBe(1)
  await page.getByRole('button', { name: 'End', exact: true }).click()
  await expect(page.getByTestId('voice-summary')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Teach-back finished' })).toBeVisible()
})

test('the teach-back card links "Do it out loud" to the voice lobby with Teach it back chosen for that idea, and the summary lists what closed', async ({ page }) => {
  await withPrisma(async (prisma) => {
    await prisma.evidenceEvent.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL }, source: { in: ['teach_back', 'voice'] } } })
    await prisma.recallAttempt.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL } } })
  })
  const concept = await withPrisma((prisma) => prisma.concept.findFirstOrThrow({ where: { topicId: ids.topicId, name: 'Load factor' }, select: { id: true } }))
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  const base = `/courses/${ids.courseId}/topics/${ids.topicId}`
  // The whole-topic teach-back names no idea; the lobby will pick the weakest.
  await page.goto(`${base}?view=recall&mode=teach_back`)
  await expect(page.getByTestId('do-it-out-loud')).toHaveAttribute('href', `${base}?view=voice&style=teach_back`)
  // A card for one idea carries it along.
  await page.goto(`${base}?view=recall&mode=teach_back&concept=${concept.id}`)
  const link = page.getByRole('link', { name: 'Do it out loud' })
  await expect(link).toHaveAttribute('href', `${base}?view=voice&style=teach_back&concept=${concept.id}`)
  await screenshotIfAsked(page, 'g1-do-it-out-loud-1440x900')
  await expectNoAxeViolations(page, 'teach-back card with the Do it out loud link')
  await link.click()
  // It lands on the voice page of the topic (not written recall), with Teach it back chosen.
  await expect(page).toHaveURL(new RegExp(`/topics/${ids.topicId}\\?view=voice&style=teach_back&concept=${concept.id}$`))
  await waitForLobby(page)
  await expect(page.getByRole('heading', { level: 2, name: 'Voice practice' })).toBeVisible()
  await expect(page.getByRole('radio', { name: /Teach it back/ })).toHaveAttribute('aria-checked', 'true')
  await startButton(page).click()

  // The session starts on that idea, although another is weaker.
  const board = page.getByTestId('voice-board')
  await expect(board).toContainText('Explain "Load factor" in your own words', { timeout: 30_000 })
  const created = await withPrisma((prisma) => prisma.voiceDrillSession.findFirstOrThrow({ where: { user: { email: VOICE_TEST_EMAIL } }, orderBy: { createdAt: 'desc' } }))
  expect((created.coachState as { teach: { current: string } }).teach.current).toBe(concept.id)

  // Covering the only claim asks one new example, and the answer closes the idea as explained.
  await page.getByLabel('Your answer').fill('The load factor is entries divided by the number of buckets in the table')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/Mock example: what happens in a new case/)).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Your answer').fill('If the entries double and the buckets stay the same, the load factor doubles')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/Mock wrap-up/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'End', exact: true }).click()
  await expect(page.getByTestId('voice-ideas-explained')).toContainText('Load factor')
  await expect(page.getByTestId('voice-ideas-taught')).toHaveCount(0)
  await expect(page.getByTestId('voice-summary')).toContainText(/You typed for \d+ minutes? and sent 2 messages\./)
  // Everything was explained: the one next step is to explain it again tomorrow.
  await expect(page.getByTestId('voice-next-step')).toContainText('Explain it again tomorrow')
  await expect(page.getByRole('link', { name: 'Practice this' })).toHaveCount(0)
  await page.setViewportSize({ width: 1440, height: 900 })
  await screenshotIfAsked(page, 'g1-teach-back-summary-1440x900')
  await expectNoAxeViolations(page, 'teach-back summary')
})

test('a teach-back ended before the first idea closes has the same summary: what was covered, what to revisit, a next step', async ({ page }) => {
  await withPrisma(async (prisma) => {
    await prisma.evidenceEvent.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL }, source: { in: ['teach_back', 'voice'] } } })
    await prisma.recallAttempt.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL } } })
  })
  const concept = await withPrisma((prisma) => prisma.concept.findFirstOrThrow({ where: { topicId: ids.topicId, name: 'Load factor' }, select: { id: true } }))
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  const base = `/courses/${ids.courseId}/topics/${ids.topicId}`
  await page.goto(`${base}?view=voice&style=teach_back&concept=${concept.id}`)
  await waitForLobby(page)
  await startButton(page).click()
  await expect(page.getByTestId('voice-board')).toContainText('Explain "Load factor" in your own words', { timeout: 30_000 })
  await page.getByRole('button', { name: 'End', exact: true }).click()

  const summary = page.getByTestId('voice-summary')
  await expect(summary).toBeVisible()
  // Covered: nothing was finished, and it says so. To revisit: the idea that was open. Next step: practise it.
  await expect(page.getByTestId('voice-ideas-none')).toContainText('No idea was finished before the session ended.')
  await expect(summary.getByRole('heading', { name: 'To revisit' })).toBeVisible()
  await expect(page.getByTestId('voice-ideas-revisit')).toContainText('Load factor: not finished')
  await expect(page.getByTestId('voice-next-step')).toContainText('Practise what came up short')
  await expect(page.getByRole('link', { name: 'Practice this' })).toHaveAttribute('href', new RegExp(`concept=${concept.id}`))
  await screenshotIfAsked(page, 'final-teach-back-ended-early-1440x900')
  await expectNoAxeViolations(page, 'teach-back summary, ended early')
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

test('phone: the style cards and the board fit at 390 wide, with axe clean and the claim page link a touch target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice`)
  await waitForLobby(page)
  expect(await overflowing(page)).toEqual([])
  await page.getByRole('radio', { name: /Read it with me/ }).click()
  await expect(page.getByRole('radio', { name: /Quiz me/ })).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('radio', { name: /Quiz me/ })).toHaveAttribute('data-state', 'unchecked')
  await page.mouse.move(0, 0)
  await screenshotIfAsked(page, 'g1-lobby-cards-390x844')
  await expectNoAxeViolations(page, 'voice lobby with style cards on a phone')
  await startButton(page).click()
  const board = page.getByTestId('voice-board')
  await expect(board).toHaveAttribute('data-kind', 'prediction', { timeout: 30_000 })
  await page.getByLabel('Your answer').fill('I think it measures how full the table is')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(board).toHaveAttribute('data-kind', 'claim', { timeout: 30_000 })
  await expect(board.locator('.katex').first()).toBeVisible()
  expect(await overflowing(page)).toEqual([])
  const box = await board.getByTestId('voice-board-source').boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(43)
  await screenshotIfAsked(page, 'g1-guided-claim-390x844')
  await expectNoAxeViolations(page, 'guided reading claim on a phone')
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

test('voice view: no Next bar and no intro card over the lobby, and on a phone all three style cards sit above the nav', async ({ page }) => {
  await withPrisma((prisma) => prisma.user.update({ where: { email: VOICE_TEST_EMAIL }, data: { seenEffortIntroAt: null } }))
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  const base = `/courses/${ids.courseId}/topics/${ids.topicId}`
  // On another view of the same topic the card and the Next bar are there.
  await page.goto(`${base}?view=practice`)
  await expect(page.getByRole('heading', { name: 'Margins asks you to try before it helps.' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${base}?view=voice`)
  await waitForLobby(page)
  await expect(page.getByRole('region', { name: 'Next on this topic' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Margins asks you to try before it helps.' })).toHaveCount(0)
  // The three cards are fully above the bottom nav.
  const nav = await page.getByRole('navigation', { name: 'Course tabs' }).boundingBox()
  expect(nav).not.toBeNull()
  const cards = page.getByRole('radiogroup', { name: 'Style' }).getByRole('radio')
  await expect(cards).toHaveCount(3)
  for (let index = 0; index < 3; index += 1) {
    const box = await cards.nth(index).boundingBox()
    expect(box, `card ${index + 1}`).not.toBeNull()
    expect((box?.y ?? 0) + (box?.height ?? 0), `card ${index + 1} ends above the nav`).toBeLessThanOrEqual((nav?.y ?? 0) + 1)
  }
  expect(await overflowing(page)).toEqual([])
  await page.mouse.move(0, 0)
  await screenshotIfAsked(page, 'g1-lobby-above-the-fold-390x844')
  await expectNoAxeViolations(page, 'voice lobby on a phone, compact cards')
  // The card was kept: it is there again on the next view.
  await page.goto(`${base}?view=practice`)
  await expect(page.getByRole('heading', { name: 'Margins asks you to try before it helps.' })).toBeVisible()
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

test('lobby: an idea with no claims in a topic that has some starts on Quiz me and says the idea is missing them; one with claims keeps Teach it back; the choice follows the link when it changes', async ({ page }) => {
  const bare = await withPrisma((prisma) =>
    prisma.concept.create({ data: { projectId: ids.courseId, topicId: ids.topicId, name: 'Bare idea', summary: 'No claims.', kind: 'concept', orderIndex: 90 } })
  )
  try {
    const loadFactor = await withPrisma((prisma) => prisma.concept.findFirstOrThrow({ where: { topicId: ids.topicId, name: 'Load factor' }, select: { id: true } }))
    await installVoiceStubs(page, { recognition: false, synthesis: false })
    const url = (concept: string) => `/courses/${ids.courseId}/topics/${ids.topicId}?view=voice&style=teach_back&concept=${concept}`
    const teachBack = page.getByRole('radio', { name: /Teach it back/ })
    const quiz = page.getByRole('radio', { name: /Quiz me/ })
    await page.goto(url(bare.id))
    await waitForLobby(page)
    await expect(quiz).toHaveAttribute('aria-checked', 'true')
    await expect(teachBack).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByText("This idea isn't read from your pages yet")).toBeVisible()
    await expect(page.getByText("Your pages aren't read into ideas yet")).toHaveCount(0)
    await expectNoAxeViolations(page, 'voice lobby on an idea with no claims in a topic that has some')
    // The same page asked again for an idea that has claims (no reload, the lobby stays mounted): Teach it back is the choice, and the note goes.
    await page.evaluate((href) => (window as unknown as { next: { router: { push: (to: string) => void } } }).next.router.push(href), url(loadFactor.id))
    await expect(page).toHaveURL(new RegExp(`concept=${loadFactor.id}$`))
    await expect(teachBack).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText("This idea isn't read from your pages yet")).toHaveCount(0)
    // And back to the idea without: Quiz me again.
    await page.evaluate((href) => (window as unknown as { next: { router: { push: (to: string) => void } } }).next.router.push(href), url(bare.id))
    await expect(page).toHaveURL(new RegExp(`concept=${bare.id}$`))
    await expect(quiz).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText("This idea isn't read from your pages yet")).toBeVisible()
  } finally {
    await withPrisma((prisma) => prisma.concept.delete({ where: { id: bare.id } }))
  }
})

test('teach-back summary: what was taught after questions links to the pages, one next step leads to practice', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${ids.topicId}?view=voice&style=teach_back`)
  await waitForLobby(page)
  const lines = (events: object[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  let call = 0
  await page.route('**/api/voice/turn', (route) => {
    call += 1
    // The opening turn is the coach's greeting; the idea closes on the answer.
    if (call === 1) return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines([{ type: 'text', delta: 'Explain it to me.' }, { type: 'done', text: 'Explain it to me.' }]) })
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: lines([
        { type: 'text', delta: 'Good. Let us wrap up this idea.' },
        { type: 'idea_done', name: 'Load factor', outcome: 'explained', conceptId: 'load-id' },
        { type: 'idea_done', name: 'Collision', outcome: 'taught', conceptId: 'collision-id', lookAgain: ['p. 5', 'page 9', 'pp. 12\u201313'], lookLinks: [{ label: 'p. 5', href: '/api/materials/m1/file#page=5' }, { label: 'pp. 8-10', href: '/api/materials/m1/file#page=8' }, { label: 'pp. 12-13', href: '/api/materials/m1/file#page=12' }] },
        { type: 'done', text: 'Good. Let us wrap up this idea.' },
      ]),
    })
  })
  await startButton(page).click()
  await expect(page.getByLabel('Your answer')).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Your answer').fill('Keys that share a bucket collide.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Good. Let us wrap up this idea.')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'End', exact: true }).click()

  const summary = page.getByTestId('voice-summary')
  await expect(summary).toBeVisible()
  await expect(page.getByTestId('voice-ideas-explained')).toContainText('Load factor')
  await expect(page.getByTestId('voice-ideas-taught')).toContainText('Collision')
  // To revisit: the page, as a link to the student's own file.
  const revisit = page.getByTestId('voice-ideas-revisit')
  await expect(revisit).toContainText('Collision: look again at p. 5')
  const pageLink = revisit.getByRole('link', { name: /p\. 5/ })
  await expect(pageLink).toHaveAttribute('href', '/api/materials/m1/file#page=5')
  await expect(pageLink).toHaveAttribute('target', '_blank')
  // A page said another way ("page 9", an en dash) still finds the link whose range covers it.
  await expect(revisit.getByRole('link', { name: /^page 9/ })).toHaveAttribute('href', '/api/materials/m1/file#page=8')
  await expect(revisit.getByRole('link', { name: /^pp\. 12.13/ })).toHaveAttribute('href', '/api/materials/m1/file#page=12')
  // One next step, with the way to do it. One idea came up short, so the drill is on that idea.
  const next = page.getByTestId('voice-next-step')
  await expect(next).toContainText('Practise what came up short')
  await expect(next.getByRole('link', { name: 'Practice this' })).toHaveAttribute('href', `/courses/${ids.courseId}/review/session?concept=collision-id`)
  await page.setViewportSize({ width: 1440, height: 900 })
  await screenshotIfAsked(page, 'g1-teach-back-summary-taught-1440x900')
  await expectNoAxeViolations(page, 'teach-back summary with a taught idea and a next step')
})

test('lobby: teach it back on a topic with no claims from the pages says so, and quiz me still starts', async ({ page }) => {
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/topics/${fixture.topics['Recursion basics']}?view=voice`)
  await waitForLobby(page)
  await page.getByRole('radio', { name: /Teach it back/ }).click()
  await startButton(page).click()
  const alert = page.getByText("Your pages aren't read into ideas yet")
  await expect(alert).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Quiz me still works.')).toBeVisible()
  await expect(page.getByTestId('voice-lobby')).toBeVisible()
  await screenshotIfAsked(page, 'g1-lobby-no-claims-1440x900')
  await expectNoAxeViolations(page, 'voice lobby with the no-claims alert')
  await page.getByRole('radio', { name: /Quiz me/ }).click()
  await startButton(page).click()
  await expect(page.getByTestId('voice-board')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'End', exact: true }).click()
})

test('new topic_conversation session rejected; old one renders', async ({ page }) => {
  // A new session cannot be a free conversation any more.
  const rejected = await page.request.post('/api/voice/session', { data: { projectId: ids.courseId, topicId: ids.topicId, style: 'topic_conversation' } })
  expect(rejected.status()).toBe(400)
  // Teach it back and guided reading need claims from the student's pages: a topic without any says so.
  const bare = await page.request.post('/api/voice/session', { data: { projectId: ids.courseId, topicId: fixture.topics['Recursion basics'], style: 'teach_back' } })
  expect(bare.status()).toBe(422)
  expect((await bare.json()).requiresClaims).toBe(true)
  // A stale tab that still says guided notes gets guided reading.
  const stale = await page.request.post('/api/voice/session', { data: { projectId: ids.courseId, topicId: ids.topicId, style: 'guided_notes' } })
  expect(stale.status()).toBe(200)
  expect((await stale.json()).style).toBe('guided_reading')
  await clearVoiceSessions()

  // A conversation that was open before the change carries on: the coach replies in the same style.
  const old = await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: VOICE_TEST_EMAIL } })
    return prisma.voiceDrillSession.create({
      data: { userId: user.id, projectId: ids.courseId, topicId: ids.topicId, style: 'topic_conversation', questionSet: [] },
    })
  })
  const turn = await page.request.post('/api/voice/turn', { data: { sessionId: old.id, utterance: 'Tell me about hashing' } })
  expect(turn.status()).toBe(200)
  const body = await turn.text()
  expect(body).toContain('Mock coach here. You said: Tell me about hashing')
  expect(body).not.toContain('"type":"question"')
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
    `/courses/${ids.courseId}/topics/${ids.topicId}?view=read`
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

// The turn route allows 30 turns a minute per student, and the tests above have used most of them: the three below start in a fresh window.
test.beforeEach(async ({}, testInfo) => {
  if (testInfo.title.includes("I-don't-know")) await new Promise((resolve) => setTimeout(resolve, testInfo.title.startsWith('oral quiz') ? 45_000 : 0))
})

test("oral quiz: an I-don't-know is a wrong answer at level 0 with score 0, and no grader is asked", async ({ page }) => {
  test.setTimeout(120_000)
  await withPrisma((prisma) => prisma.evidenceEvent.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL }, source: { in: ['teach_back', 'voice'] } } }))
  await installVoiceStubs(page, { recognition: false, synthesis: false })
  await page.goto(`/courses/${ids.courseId}/review/voice`)
  await waitForLobby(page)
  await startButton(page).click()
  await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Your answer').fill("I don't know")
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('voice-evaluation').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-evaluation').first().locator('span').first()).toHaveText(/Not quite|Noted/)
  await expectNoAxeViolations(page, 'oral quiz after an I do not know')
  const rows = await withPrisma((prisma) =>
    prisma.evidenceEvent.findMany({ where: { user: { email: VOICE_TEST_EMAIL }, source: 'voice' }, select: { assistance: true, score: true, confidence: true, metadata: true } })
  )
  expect(rows.length).toBeLessThanOrEqual(1)
  for (const row of rows) {
    expect([row.assistance, row.score, row.confidence]).toEqual([0, 0, null])
    expect((row.metadata as { idk?: boolean }).idk).toBe(true)
  }
})

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
  await expect(page.getByText(/Mock explain first: here is the idea from your pages/)).toBeVisible({ timeout: 30_000 })
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

test("guided reading: an I-don't-know on the check is missed at level 2 and the reading goes on", async ({ page }) => {
  await withPrisma((prisma) => prisma.evidenceEvent.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL }, source: { in: ['teach_back', 'voice'] } } }))
  await startStyle(page, /Read it with me/)
  const board = page.getByTestId('voice-board')
  await expect(board).toHaveAttribute('data-kind', 'prediction', { timeout: 30_000 })
  await page.getByLabel('Your answer').fill('I think it measures how full the table is')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(board).toHaveAttribute('data-kind', 'claim', { timeout: 30_000 })
  await expect(board.getByTestId('voice-board-check')).toContainText('In your own words, what do your pages say about "Load factor"?')
  await expect(page.getByText(/Mock claim from your pages/)).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Your answer').fill("I don't know")
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('voice-evaluation').first()).toBeVisible({ timeout: 30_000 })
  const rows = await sessionEvidence('voice')
  expect(rows.map((row) => [row.assistance, row.score])).toEqual([[2, 0]])
})
