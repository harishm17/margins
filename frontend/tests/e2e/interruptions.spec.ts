import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'
import { withPrisma } from './helpers/db'
import { failRequests, reloadNow, swallowResponses } from './helpers/interrupt'
import { addQuizSet, createCourse, reviewItem, seedDueConcept, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { clearVoiceSessions, ensureVoiceFixture, VOICE_TEST_EMAIL, type VoiceFixture } from './helpers/voice-fixture'
import { installVoiceStubs } from './helpers/voice-stubs'

// What happens when the student reloads or loses the connection in the middle of a task: the work is still there, or the screen says
// plainly what was lost and offers a way on. Each test reloads at the worst moment and breaks the main request on purpose.
// Add a surface's own "what if this fails" check here, with the helpers in helpers/interrupt.ts.

test.use({ timezoneId: ZONE })

const stamp = Date.now()

// ---------------------------------------------------------------------------------------------------------------------
// Mock exam: an answer survives a reload a moment after it was given, even when the save could not get through.

const examQuestions = (topicId: string) => [
  {
    question_type: 'multiple_choice',
    question_text: 'Which structure does breadth-first search use?',
    options: [
      { id: 'A', text: 'A queue' },
      { id: 'B', text: 'A stack' },
    ],
    correct_answer: 'A',
    explanation: 'It visits nodes in the order they were found.',
    points: 2,
    topic_id: topicId,
    topic_name: 'Graph search',
  },
  {
    question_type: 'multiple_choice',
    question_text: 'Which structure does depth-first search use?',
    options: [
      { id: 'A', text: 'A queue' },
      { id: 'B', text: 'A stack' },
    ],
    correct_answer: 'B',
    explanation: 'It goes as deep as it can first.',
    points: 2,
    topic_id: topicId,
    topic_name: 'Graph search',
  },
]

async function startExam(page: Page, label: string) {
  const { email } = await signUpAndIn(page, label, { own: true })
  const course = await createCourse(page, `${label} ${Date.now()}`, [{ name: 'Graph search' }])
  const exam = await withPrisma((prisma) =>
    prisma.sampleExam.create({
      data: {
        projectId: course.courseId,
        name: 'Sample Exam - 2026-11-20',
        durationMinutes: 30,
        difficultyLevel: 'medium',
        topicsCovered: ['Graph search'],
        questions: examQuestions(course.topics['Graph search']),
      },
      select: { id: true },
    })
  )
  await page.goto(`/courses/${course.courseId}/exams/${exam.id}`)
  await page.getByRole('button', { name: /^(Start exam|Resume)/ }).click()
  await expect(page).toHaveURL(/\/take$/)
  await expect(page.getByRole('heading', { name: /Question 1 of 2/ })).toBeVisible()
  return { email, examId: exam.id }
}

const savedAnswers = (examId: string) =>
  withPrisma(async (prisma) => (await prisma.examSubmission.findFirst({ where: { sampleExamId: examId, status: 'in_progress' } }))?.answers ?? null)

test.describe('mock exam', () => {
  test('an answer given a moment before a reload is still selected', async ({ page }) => {
    test.setTimeout(120_000)
    await startExam(page, `int-exam-quick-${stamp}`)
    await page.getByRole('radio', { name: 'A queue' }).click()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    // No wait for "Saved": the reload comes straight away.
    await reloadNow(page)
    await expect(page.getByRole('heading', { name: /Question 2 of 2/ })).toBeVisible()
    await page.getByRole('button', { name: 'Previous' }).click()
    await expect(page.getByRole('radio', { name: 'A queue', checked: true })).toBeVisible()
  })

  test('with saving blocked, the answer comes back after a reload and reaches the server once the connection does', async ({ page }) => {
    test.setTimeout(120_000)
    const { examId } = await startExam(page, `int-exam-offline-${stamp}`)
    const blocked = await failRequests(page, /\/api\/exams\/[^/]+\/attempt$/, 'PUT')
    await page.getByRole('radio', { name: 'A queue' }).click()
    // The header does not claim "Saved" for a change the server does not have.
    await expect(page.getByTestId('exam-save-status')).toContainText(/Not saved/, { timeout: 15_000 })
    await expect(page.getByTestId('exam-save-status')).not.toHaveText('Saved')
    expect(JSON.stringify(await savedAnswers(examId))).not.toContain('"0"')
    await reloadNow(page)
    await expect(page.getByRole('radio', { name: 'A queue', checked: true })).toBeVisible()

    await blocked.restore()
    await expect(page.getByTestId('exam-save-status')).toHaveText('Saved', { timeout: 30_000 })
    const answers = (await savedAnswers(examId)) as Record<string, unknown> | null
    expect(JSON.stringify(answers)).toContain('"0":"A"')
  })

  test('the submit dialog of an empty exam says so once and names what the button does', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 390, height: 844 })
    await startExam(page, `int-exam-blank-${stamp}`)
    await expect(page.getByRole('button', { name: 'Questions · 0/2 answered' })).toBeVisible()
    await page.getByRole('button', { name: 'Submit exam', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'All 2 questions are blank' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('submit-counts')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Submit empty exam' })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Voice practice: a reload ends the session on the server; the lobby offers it back.

test.describe('voice practice', () => {
  let fixture: VoiceFixture
  test.beforeAll(async ({ baseURL }) => {
    fixture = await ensureVoiceFixture(baseURL ?? 'http://localhost:3000')
  })

  async function typedSession(page: Page) {
    await clearVoiceSessions()
    await signIn(page, VOICE_TEST_EMAIL)
    await installVoiceStubs(page, { recognition: false, synthesis: false })
    await page.goto(`/courses/${fixture.courseId}/review/voice`)
    await expect(page.getByTestId('voice-lobby')).toBeVisible({ timeout: 30_000 })
    const start = page.getByRole('button', { name: /Start (voice practice|sprint)/ })
    await expect(start).toBeEnabled({ timeout: 15_000 })
    await start.click()
    await expect(page.getByTestId('voice-question')).toBeVisible({ timeout: 30_000 })
    await page.getByLabel('Your answer').fill('It maps a key to a bucket with a hash function.')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByTestId('voice-evaluation').first()).toBeVisible({ timeout: 30_000 })
    await page.getByLabel('Your answer').fill('An unsent second answer')
    // The snapshot is written a moment after the last change.
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('margins-voice:')).length)).toBe(1)
    await expect
      .poll(() => page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('margins-voice-draft:'))?.[1] ?? ''))
      .toContain('An unsent second answer')
  }

  test('reload mid-practice: the lobby offers to pick up, Continue brings back the lines and the unsent answer', async ({ page }) => {
    test.setTimeout(120_000)
    await typedSession(page)
    await reloadNow(page)
    const card = page.getByTestId('voice-resume')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('Pick up where you left off')
    await expect(card.getByTestId('voice-resume-draft')).toContainText('An unsent second answer')
    await card.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByTestId('voice-session')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByLabel('Your answer')).toHaveValue('An unsent second answer')
    await expect(page.getByTestId('voice-restored')).toContainText('It maps a key to a bucket with a hash function.')
  })

  test('Start fresh forgets the snapshot', async ({ page }) => {
    test.setTimeout(120_000)
    await typedSession(page)
    await reloadNow(page)
    const card = page.getByTestId('voice-resume')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('button', { name: 'Start fresh' }).click()
    await expect(card).toHaveCount(0)
    await reloadNow(page)
    await expect(page.getByTestId('voice-lobby')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('voice-resume')).toHaveCount(0)
  })

  test('ending a practice on purpose leaves nothing to pick up', async ({ page }) => {
    test.setTimeout(120_000)
    await typedSession(page)
    await page.getByRole('button', { name: 'End', exact: true }).click()
    await expect(page.getByTestId('voice-summary')).toBeVisible()
    await reloadNow(page)
    await expect(page.getByTestId('voice-lobby')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('voice-resume')).toHaveCount(0)
  })

  test('an untouched typing session does not report talking or an invented minute', async ({ page }) => {
    test.setTimeout(120_000)
    await clearVoiceSessions()
    await signIn(page, VOICE_TEST_EMAIL)
    await installVoiceStubs(page, { recognition: false, synthesis: false })
    await page.goto(`/courses/${fixture.courseId}/review/voice`)
    const start = page.getByRole('button', { name: /Start (voice practice|sprint)/ })
    await expect(start).toBeEnabled({ timeout: 30_000 })
    await start.click()
    await expect(page.getByTestId('voice-session')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'End', exact: true }).click()
    const summary = page.getByTestId('voice-summary')
    await expect(summary).toContainText('No answers sent. The session lasted under a minute.')
    await expect(summary).not.toContainText('talked')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Review: the feedback the student was reading is still there after a reload.

test.describe('review session', () => {
  test('a reload on a miss keeps its feedback, Next goes on, and Previous answer reopens it', async ({ page }) => {
    test.setTimeout(120_000)
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, `int-review-${stamp}`, { own: true })
    const course = await createCourse(page, `Review int ${stamp}`, [{ name: 'Hash tables' }, { name: 'Sorting' }])
    for (const [topicName, conceptName] of [
      ['Hash tables', 'Hashing'],
      ['Sorting', 'Quicksort'],
    ] as const) {
      const topicId = course.topics[topicName]
      const conceptId = await seedDueConcept(email, topicId, conceptName)
      await addQuizSet(topicId, [
        reviewItem(conceptId, `${conceptName} statement 1 holds.`, 'easy'),
        reviewItem(conceptId, `${conceptName} statement 2 holds.`, 'easy'),
        reviewItem(conceptId, `${conceptName} statement 3 holds.`, 'easy'),
      ])
    }
    await page.goto(`/courses/${course.courseId}/review/session`)
    await expect(page.getByRole('heading', { name: /^Question 1 of 2/ })).toBeVisible({ timeout: 60_000 })
    // The size of the commitment is said before the first answer.
    await expect(page.getByTestId('session-entry-note')).toContainText(/About \d+ minutes · 2 questions/)

    await page.getByRole('radio', { name: 'False' }).click()
    await page.getByRole('button', { name: 'Check answer' }).click()
    await expect(page.getByTestId('length-notice')).toBeVisible()
    await reloadNow(page)
    // Same feedback, not the next question.
    await expect(page.getByRole('heading', { name: /^Question 1 of 2/ })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Next question', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Next question', exact: true }).click()
    await expect(page.getByRole('heading', { name: /^Question 2 of 2/ })).toBeVisible()
    await reloadNow(page)
    await expect(page.getByRole('heading', { name: /^Question 2 of 2/ })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Check answer' })).toBeVisible()

    await page.getByRole('button', { name: 'Previous answer' }).click()
    await expect(page.getByRole('heading', { name: /^Question 1 of 2/ })).toBeVisible()
    await expect(page.getByTestId('length-notice')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Ask: a send the server took is never shown as unsent, and a failed send says which half failed.

const demoCourse = `/courses/${demoIds().course}`
const composer = (page: Page) => page.getByLabel('Ask about your materials')
const chatUrl = /\/api\/projects\/[^/]+\/chat$/

test.describe('ask', () => {
  test('a question sent just before a reload opens its conversation, never an "unsent" box', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${demoCourse}/ask`, { waitUntil: 'networkidle' })
    await swallowResponses(page, chatUrl, 'POST')
    const question = `What is hashing? ${Date.now()}`
    await composer(page).fill(question)
    await page.keyboard.press('Enter')
    // The server takes the question; the page never hears back.
    await expect.poll(() => withPrisma((prisma) => prisma.chatMessage.count({ where: { content: question } }))).toBe(1)
    await reloadNow(page)
    await expect(page.getByTestId('ask-restored')).toHaveCount(0)
    await expect(page.getByText(question).first()).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/[?&]thread=/, { timeout: 30_000 })
    await expect(page.locator("span.sr-only", { hasText: "You:" })).toHaveCount(1)
    await expect(composer(page)).toHaveValue('')
  })

  test('a question that never reached the server comes back as unsent after the grace', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${demoCourse}/ask`, { waitUntil: 'networkidle' })
    await failRequests(page, chatUrl, 'POST')
    const question = `Never sent ${Date.now()}`
    await composer(page).fill(question)
    await page.keyboard.press('Enter')
    await expect(page.getByText("Your question wasn't sent. Check your connection, then try again.")).toBeVisible()
    // Edit question puts the text back without a second copy of the failed turn.
    await page.getByRole('button', { name: 'Edit question' }).click()
    await expect(composer(page)).toHaveValue(question)
    await expect(page.locator('span.sr-only', { hasText: 'You:' })).toHaveCount(0)
  })

  test('the same send twice stores one question', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, DEMO_EMAIL)
    const requestId = randomUUID()
    const question = `Double send ${Date.now()}`
    const send = () => page.request.post(`/api/projects/${demoIds().course}/chat`, { data: { question, clientRequestId: requestId } })
    const first = await send()
    expect(first.ok()).toBe(true)
    await first.text()
    const second = await send()
    expect(second.ok()).toBe(true)
    expect(await second.json()).toMatchObject({ duplicate: true })
    expect(await withPrisma((prisma) => prisma.chatMessage.count({ where: { content: question } }))).toBe(1)
    const lookup = await page.request.get(`/api/projects/${demoIds().course}/chat/threads?requestId=${requestId}`)
    expect((await lookup.json()).thread).toBeTruthy()
  })

  test('after the first reply the box invites an answer, and the sources sit behind one control', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${demoCourse}/ask`, { waitUntil: 'networkidle' })
    await expect(composer(page)).toHaveAttribute('placeholder', 'Ask about your materials...')
    await composer(page).fill(`What is hashing? ${Date.now()}`)
    await page.keyboard.press('Enter')
    const answer = page.locator('article', { hasText: /\d sources?/ })
    await expect(answer).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('article[aria-busy]')).toHaveCount(0)
    await expect(composer(page)).toHaveAttribute('placeholder', 'Write your answer or ask a follow-up...')
    const toggle = answer.getByRole('button', { name: /^\d sources?$/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(answer.getByRole('list')).toBeVisible()
  })

  test('phone: the title, two suggestions and the box fit without scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${demoCourse}/ask`, { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { level: 2, name: 'Ask your materials' })).toBeInViewport()
    const suggestions = page.getByRole('list', { name: 'Suggested questions' }).getByRole('button')
    await expect(suggestions.nth(0)).toBeInViewport()
    await expect(suggestions.nth(1)).toBeInViewport()
    await expect(suggestions.nth(2)).toBeHidden()
    await expect(composer(page)).toBeInViewport()
    await page.getByRole('button', { name: 'More suggestions' }).click()
    await expect(suggestions.nth(2)).toBeVisible()
  })
})
