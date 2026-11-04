import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { signIn } from './helpers/auth'
import { addMaterial, createCourse, createEmptyCourse, signUpAndIn } from './helpers/loop'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { animationsSettled } from './helpers/settle'

// Runs against the demo course (seeded by global-setup.ts) on a stack with the mock AI service.
const course = `/courses/${demoIds().course}`

test('ask: an answer streams in with citations, then the conversation can be deleted', async ({ page }) => {
  await signIn(page, DEMO_EMAIL)
  await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { level: 2, name: 'Ask your materials' })).toBeVisible()

  const question = `What is hashing? ${Date.now()}`
  await page.getByLabel('Ask about your materials').fill(question)
  await page.keyboard.press('Enter')

  const answer = page.locator('article', { hasText: 'Sources' })
  await expect(answer).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/[?&]thread=/)

  // The live answer is replaced by the stored one when it finishes; hover after that.
  await expect(page.locator('article[aria-busy]')).toHaveCount(0)
  // A citation pill opens a hover card with the quote and a way to read it (open the page for a
  // PDF, an excerpt dialog for other files).
  await answer.getByRole('button', { name: /^Source 1/ }).first().hover()
  const card = page.locator('blockquote').first()
  await expect(card).toBeVisible()
  await expect(page.getByRole('button', { name: /^(View excerpt)$/ }).or(page.getByRole('link', { name: 'Open page' })).first()).toBeVisible()

  // The conversation is in the list; delete it.
  const row = page.getByRole('link', { name: question.slice(0, 20) }).first()
  await expect(row).toBeVisible()
  await page.getByRole('button', { name: /^Options for What is hashing/ }).first().click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete conversation' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Ask your materials' })).toBeVisible()
})

test('ask: Stop aborts a slow answer', async ({ page }) => {
  await signIn(page, DEMO_EMAIL)
  // Hold the answer back so there is something to stop.
  await page.route('**/api/projects/*/chat', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await route.abort()
  })
  await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
  await page.getByLabel('Ask about your materials').fill('Explain sorting.')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Searching your materials...')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Searching your materials...')).toBeHidden()
})

test('mock exam: a topic with no pages is left out and said so, and the exam is still the size asked for', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, DEMO_EMAIL)
  await page.goto(`${course}/exams/new`)
  // The demo's "Discrete random variables" has no file behind it; every topic is chosen by default.
  await page.getByRole('radio', { name: '5', exact: true }).click()
  await page.getByRole('radio', { name: '30 min' }).click()
  await page.getByRole('button', { name: 'Create exam' }).click()
  await expect(page).toHaveURL(/\/exams\/[0-9a-f-]{36}$/, { timeout: 180_000 })
  // Said before the exam opens, and kept up for a while.
  await expect(page.getByText('Left out of the exam: Discrete random variables.')).toBeVisible()
  const facts = page.getByText('Questions', { exact: true }).locator('..')
  await expect(facts).toContainText('5')
  await expect(page.getByText('Covers').locator('..')).not.toContainText('Discrete random variables')
})

/** The kinds of the questions of a stored exam, in order, so a spec answers each the way its kind asks and never has to look. */
const questionKinds = (examId: string) =>
  withPrisma(async (prisma) => {
    const exam = await prisma.sampleExam.findUniqueOrThrow({ where: { id: examId }, select: { questions: true } })
    return (exam.questions as { question_type: string }[]).map((question) => question.question_type)
  })

/** Answers the question on screen: text for the kinds that are written, the first option for the others. */
async function answerQuestion(page: Page, kind: string) {
  if (kind === 'multiple_choice' || kind === 'true_false') await page.getByRole('radio').first().click()
  else await page.getByLabel('Your answer').fill('1')
}

test('mock exam: create, take, submit and read the results', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, DEMO_EMAIL)
  await page.goto(`${course}/exams/new`)
  await page.getByRole('radio', { name: '10', exact: true }).click()
  await page.getByRole('radio', { name: '30 min' }).click()
  await page.getByRole('button', { name: 'Create exam' }).click()
  await expect(page.getByText('Writing your exam')).toBeVisible()
  await expect(page).toHaveURL(/\/exams\/[0-9a-f-]{36}$/, { timeout: 180_000 })
  await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible()

  await page.getByRole('button', { name: /^(Start exam|Resume)/ }).click()
  await expect(page).toHaveURL(/\/take$/)
  await expect(page.getByRole('timer')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Question 1 of/ })).toBeVisible()
  const kinds = await questionKinds(/\/exams\/([0-9a-f-]{36})\//.exec(page.url())![1])

  // Answer the first question, flag the second, and the navigator shows both.
  await answerQuestion(page, kinds[0])
  // How sure the student is rides along with the answer.
  await page.getByRole('radio', { name: 'Certain' }).click()
  await expect(page.getByRole('radio', { name: 'Certain', checked: true })).toBeVisible()
  // The tapped level, not just its value, is saved: "Guessing" on a true or false question stores 0.5, like "Unsure".
  await page.getByRole('radio', { name: 'Guessing' }).click()
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 15_000 })
  await page.reload()
  await expect(page.getByRole('radio', { name: 'Guessing', checked: true })).toBeVisible()
  await page.getByRole('radio', { name: 'Certain' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: /Question 2 of/ })).toBeVisible()
  await page.getByRole('button', { name: 'Flag', exact: true }).click()
  await expect(page.getByText(/1 answered, 1 flagged/)).toBeVisible()
  // The same navigator the quiz uses: answered has a check, the current one an outline, a flagged one a flag.
  const navigator = page.getByRole('complementary', { name: 'Question navigator' })
  await expect(navigator.getByRole('button', { name: 'Question 1, answered' }).locator('svg')).toHaveCount(1)
  await expect(navigator.getByRole('button', { name: 'Question 2, not answered, flagged' })).toHaveAttribute('aria-current', 'step')
  expect(await navigator.getByRole('button', { name: /^Question 2,/ }).evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('2px')
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 15_000 })

  // Exit asks first.
  await page.getByRole('link', { name: 'Exit' }).click()
  await expect(page.getByRole('dialog', { name: 'Leave the exam?' })).toBeVisible()
  await page.getByRole('button', { name: 'Stay' }).click()

  // Submitting with blanks asks for confirmation, and says how many are unanswered and flagged.
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  const prompt = page.getByRole('dialog', { name: 'Submit your exam?' })
  await expect(prompt).toContainText(/unanswered and will score zero\. 1 is flagged to come back to\./)
  await prompt.getByRole('button', { name: 'Keep working' }).click()
  await expect(prompt).toHaveCount(0)

  // Answering the rest does not skip the prompt: it still asks, and now says everything is answered.
  const position = page.getByRole('heading', { name: /Question \d+ of \d+/ })
  for (let step = 0; step < 40; step++) {
    const [, number, total] = ((await position.textContent()) ?? '').match(/Question (\d+) of (\d+)/) ?? []
    await answerQuestion(page, kinds[Number(number) - 1])
    if (number === total) break
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(position).not.toHaveText(new RegExp(`Question ${number} of`))
  }
  await expect(page.getByText(/1 flagged/)).toBeVisible()
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(prompt).toContainText(/You answered all \d+ questions\. 1 is flagged to come back to\. You can.t change your answers after you submit\./)
  await animationsSettled(page)
  await screenshotIfAsked(page, 'exam-submit-prompt')
  await prompt.getByRole('button', { name: 'Submit exam' }).click()
  await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  // The exam is over: the course's "in progress" line is gone on its own results, at once, not after a fresh load.
  await expect(page.getByRole('complementary', { name: 'Mock exam in progress' })).toHaveCount(0)

  // Grading, then the score and the review.
  await expect(page.getByText('of ').first()).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('heading', { name: 'Where to focus' })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText(/You were sure about 1 answer and got [01] of them right\./)).toBeVisible()
  await page.getByRole('radio', { name: /^Missed/ }).click()
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
})

// ---------------------------------------------------------------------------------------------------------
// Attempt-first Ask (spec §6.3). The mock AI service routes by the first words of a message (explain, solve)
// and plays the intent's reply, so the flow below runs through the real route, state and evidence code.

const ASK_CONCEPTS = ['Hash functions', 'Collision resolution', 'Load factor']

async function addAskConcepts() {
  await withPrisma(async (prisma) => {
    const topic = await prisma.topic.findFirstOrThrow({ where: { projectId: demoIds().course, name: 'Hash tables' }, select: { id: true } })
    for (const [index, name] of ASK_CONCEPTS.entries()) {
      if (await prisma.concept.findFirst({ where: { projectId: demoIds().course, name } })) continue
      await prisma.concept.create({
        data: { projectId: demoIds().course, topicId: topic.id, name, summary: `${name}.`, kind: 'concept', orderIndex: index - 10, objectiveIndexes: [] },
      })
    }
  })
}

/** The demo course goes back to what the other specs expect: no concepts of ours, no threads, no exam in progress. */
async function removeAskTraces() {
  await withPrisma(async (prisma) => {
    await prisma.concept.deleteMany({ where: { projectId: demoIds().course, name: { in: ASK_CONCEPTS } } })
    await prisma.chatThread.deleteMany({ where: { projectId: demoIds().course, user: { email: DEMO_EMAIL } } })
    await prisma.sampleExam.deleteMany({ where: { projectId: demoIds().course, name: 'Ask guard exam' } })
  })
}

const composer = (page: Page) => page.getByLabel('Ask about your materials')
/** The top edge of the composer's whole box (the form around the text box, its border and padding), where the messages end. */
const composerBoxTop = async (page: Page) => (await page.locator('[data-ask-composer]').boundingBox().then((box) => box?.y)) ?? 0
// Ask allows ten questions a minute per student and these specs share one, so each message waits for room.
const sentAt: number[] = []
async function say(page: Page, message: string) {
  await expect
    .poll(
      () => {
        const now = Date.now()
        while (sentAt.length > 0 && now - sentAt[0] > 60_000) sentAt.shift()
        return sentAt.length < 6
      },
      { intervals: [2_000], timeout: 120_000, message: 'room for another message under the per-minute limit' }
    )
    .toBe(true)
  sentAt.push(Date.now())
  await composer(page).fill(message)
  await page.keyboard.press('Enter')
}
const lastReply = (page: Page) => page.locator('article:not([aria-busy])').last()
const settled = (page: Page) => expect(page.locator('article[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 })

/** The chat stream is held in the page (window.__chat.push), so each step of a reply can be looked at. Aborting it errors the read, as a real fetch does. */
async function holdChatStream(page: Page) {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window)
    const w = window as unknown as { __chat?: { push: (event: unknown) => void; close: () => void } }
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (!url.endsWith('/chat') || init?.method !== 'POST') return real(input, init)
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          w.__chat = { push: (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')), close: () => controller.close() }
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      })
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }))
    }
  })
}

test.describe('attempt-first Ask', () => {
  test.beforeAll(addAskConcepts)
  test.afterAll(removeAskTraces)

  test('understand question gets a question back, then an explanation with a check card', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })

    // First, a question back: nothing is explained to a student who has not said what they think.
    await say(page, 'Explain load factor')
    await expect(page.getByText(/What do you think this means\?/)).toBeVisible({ timeout: 30_000 })
    await settled(page)
    await expect(page.getByRole('group', { name: 'Check yourself' })).toHaveCount(0)
    await expect(page.getByText('Nothing in your materials matched closely')).toHaveCount(0)
    await expect(page).toHaveURL(/[?&]thread=/)
    await animationsSettled(page)
    await screenshotIfAsked(page, 'f2-understand-question-back-1440x900')

    // Then the attempt: the explanation arrives with a check question card, and the answer is not on the page.
    await say(page, 'Explain load factor: it is the number of keys divided by the number of buckets')
    const card = page.getByRole('group', { name: 'Check yourself' })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await settled(page)
    await expect(lastReply(page).getByText(/You have part of it\./)).toBeVisible()
    await expect(card.getByText('In your own words, what is the key point?')).toBeVisible()
    await expect(card.getByText('The answer', { exact: true })).toHaveCount(0)
    await expect(lastReply(page).getByText('<check_question>')).toHaveCount(0)
    await expectNoAxeViolations(page, 'ask: explanation with a check card')
    await screenshotIfAsked(page, 'f2-understand-explanation-card-1440x900')

    // Answer from memory, say how sure, look at the answer, grade it.
    await expect(card.getByRole('button', { name: 'Show the answer' })).toBeDisabled()
    await card.getByLabel(/^Your answer:/).fill('Keys divided by buckets')
    await card.getByRole('radio', { name: 'Fairly sure' }).click()
    await card.getByRole('button', { name: 'Show the answer' }).click()
    await expect(card.getByText('The answer', { exact: true })).toBeVisible()
    await expect(card.getByRole('group', { name: 'How did you do?' })).toBeVisible()
    // The buttons that were pressed are gone: focus is on the answer, then on the saved line.
    await expect(card.locator('.border-l-2')).toBeFocused()
    await animationsSettled(page)
    await screenshotIfAsked(page, 'f2-understand-card-revealed-1440x900')
    await expectNoAxeViolations(page, 'ask: check card revealed')
    await card.getByRole('button', { name: 'Got it', exact: true }).click()
    await expect(card.getByText('Saved: Got it')).toBeVisible()
    await expect(card.getByText('Saved: Got it')).toBeFocused()

    // What was recorded: the explanation is level 3 on the concept; the card is level 2, graded by the student, with the confidence.
    const rows = await withPrisma((prisma) =>
      prisma.evidenceEvent.findMany({
        where: { user: { email: DEMO_EMAIL }, concept: { name: 'Load factor', projectId: demoIds().course } },
        orderBy: { createdAt: 'asc' },
        select: { source: true, assistance: true, gradedBy: true, score: true, confidence: true, itemKey: true },
      })
    )
    expect(rows.map((row) => [row.source, row.assistance, row.gradedBy, row.score])).toEqual([
      ['ask_check', 3, 'rule', 0],
      ['ask_check', 2, 'self', 1],
    ])
    expect(rows[0].itemKey).toMatch(/:explained$/)
    expect(rows[1].confidence).toBe(0.75)

    // The conversation comes back as it was, the card already graded.
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByRole('group', { name: 'Check yourself' }).getByText('Saved: Got it')).toBeVisible()
    await expectNoAxeViolations(page, 'ask: reopened conversation with a graded card')

    // The pieces fit end to end: the card's own "Show the answer" stored the attempt on the server, and the server then gave
    // the answer; take that attempt away and the same route refuses until one is given again.
    const message = await withPrisma(async (prisma) => {
      const rows = await prisma.chatMessage.findMany({
        where: { role: 'assistant', thread: { userId: (await prisma.user.findFirstOrThrow({ where: { email: DEMO_EMAIL } })).id, projectId: demoIds().course } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, tutor: true },
      })
      return rows.find((row) => (row.tutor as { check?: { attempt?: unknown } } | null)?.check?.attempt)
    })
    expect(message, 'the message holds the student\'s attempt').toBeTruthy()
    expect(((message!.tutor as { check: { attempt: { text: string; idk: boolean } } }).check.attempt)).toEqual({ text: 'Keys divided by buckets', idk: false })
    await withPrisma((prisma) => prisma.$executeRaw`UPDATE chat_messages SET tutor = tutor #- '{check,attempt}' #- '{check,grade}' WHERE id = ${message!.id}`)
    const refused = await page.request.post('/api/ask-checks/reveal', { data: { messageId: message!.id } })
    expect(refused.status()).toBe(400)
    expect(await refused.text()).not.toContain('Keys divided')
    const granted = await page.request.post('/api/ask-checks/reveal', { data: { messageId: message!.id, idk: true } })
    expect(granted.ok()).toBe(true)
    expect(Object.keys(await granted.json()).sort()).toEqual(['answer', 'explanation'])
    // And a grade is of an answer that was given: with no attempt there is none (here one was just stored, so it counts).
    const graded = await page.request.post('/api/ask-checks', { data: { messageId: message!.id, grade: 'missed', idk: true } })
    expect(graded.ok()).toBe(true)
  })

  test('a broad question offers places to start, taken from the course map', async ({ page }) => {
    test.setTimeout(90_000)
    await signIn(page, DEMO_EMAIL)
    // Asked about one topic, so the places to start are that topic's own concepts, in course order.
    const topicId = await withPrisma(async (prisma) => (await prisma.topic.findFirstOrThrow({ where: { projectId: demoIds().course, name: 'Hash tables' }, select: { id: true } })).id)
    await page.goto(`${course}/ask?topic=${topicId}`, { waitUntil: 'networkidle' })
    await say(page, 'Explain everything about hash tables')
    const places = page.getByRole('group', { name: 'Places to start' })
    await expect(places).toBeVisible({ timeout: 30_000 })
    await settled(page)
    await expect(places.getByRole('button')).toHaveText(ASK_CONCEPTS)
    await expect(page.getByRole('group', { name: 'Check yourself' })).toHaveCount(0)
    await animationsSettled(page)
    await screenshotIfAsked(page, 'f2-broad-entry-points-1440x900')
    await expectNoAxeViolations(page, 'ask: places to start')

    // Picking one asks about it: a question back, and the places to start are gone with the next reply.
    await places.getByRole('button', { name: 'Load factor' }).click()
    await expect(page.getByText(/What do you think this means\?/)).toBeVisible({ timeout: 30_000 })
    await settled(page)
    await expect(page.getByRole('group', { name: 'Places to start' })).toHaveCount(0)
  })

  test("the worked example is the student's button, after one genuine attempt", async ({ page }) => {
    test.setTimeout(90_000)
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
    await say(page, 'Solve problem 3 for me')
    await expect(page.getByText(/What have you tried so far/)).toBeVisible({ timeout: 30_000 })
    await settled(page)
    await expect(page.getByRole('button', { name: 'Show me a worked example' })).toHaveCount(0)

    await say(page, 'Solve it: I tried dividing the keys by the buckets but the answer looks too big')
    const worked = page.getByRole('button', { name: 'Show me a worked example' })
    await expect(worked).toBeVisible({ timeout: 30_000 })
    await settled(page)
    await expectNoAxeViolations(page, 'ask: worked example offered')
    await screenshotIfAsked(page, 'f2-worked-example-button-1440x900')
    await worked.click()
    await expect(page.locator('article:not([aria-busy])')).toHaveCount(3, { timeout: 30_000 })

    const state = await withPrisma((prisma) =>
      prisma.tutorState.findFirstOrThrow({ where: { user: { email: DEMO_EMAIL }, scope: 'ask' }, orderBy: { updatedAt: 'desc' } })
    )
    expect([state.rung, state.maxRung, state.attempts]).toEqual([5, 5, 1])
  })

  test('ask declines while mock exam in progress', async ({ page }) => {
    test.setTimeout(120_000)
    const pasted = 'Which collision strategy keeps colliding keys in a linked list at each bucket of the table?'
    // A student of its own with a course of its own: the chat limit is per user (10 a minute) and the demo student has used
    // it up by the time this test runs, and an exam left in progress on the demo course would decline other tests' questions.
    const { email } = await signUpAndIn(page, 'ask-guard', { own: true })
    const ownId = await createEmptyCourse(page, 'Ask guard course')
    await addMaterial(page, ownId)
    const own = await createCourse(page, 'Ask guard course', [{ name: 'Hash tables' }], { existingCourseId: ownId })
    const ownCourse = `/courses/${own.courseId}`
    const examId = await withPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
      const exam = await prisma.sampleExam.create({
        data: {
          projectId: own.courseId,
          name: 'Ask guard exam',
          questions: [{ question_type: 'short_answer', question_text: pasted, points: 2 }],
          durationMinutes: 30,
          difficultyLevel: 'medium',
          topicsCovered: [],
        },
      })
      await prisma.examSubmission.create({
        data: { sampleExamId: exam.id, userId: user.id, answers: {}, status: 'in_progress', startedAt: new Date(), deadlineAt: new Date(Date.now() + 30 * 60_000) },
      })
      return exam.id
    })
    await page.goto(`${ownCourse}/ask`, { waitUntil: 'networkidle' })

    // The pasted question is declined, with no model call: the stream has no route and no sources.
    const declined = page.waitForResponse((response) => response.url().endsWith('/chat') && response.request().method() === 'POST')
    await say(page, pasted)
    const stream = await (await declined).text()
    await expect(page.getByText("That looks like a question from the mock exam you're taking. Finish it first, then ask me.")).toBeVisible({ timeout: 30_000 })
    await settled(page)
    expect(stream).not.toContain('"type":"route"')
    expect(stream).not.toContain('"type":"retrieved"')
    await expect(page.getByText('Nothing in your materials matched closely')).toHaveCount(0)
    await expect(page.getByText('Sources')).toHaveCount(0)
    // The decline leads back to the exam in progress, and still does after a reload (the link is part of the stored reply).
    // (The top of every course page says the exam is in progress with the same link; this is the one in the decline.)
    const back = lastReply(page).getByRole('link', { name: 'Back to your mock exam' })
    await expect(back).toHaveAttribute('href', `${ownCourse}/exams/${examId}/take`)
    await animationsSettled(page)
    await screenshotIfAsked(page, 'f2-exam-guard-1440x900')
    await expectNoAxeViolations(page, 'ask: declined during a mock exam')

    // A question about the concept is not the exam question: it is answered.
    await say(page, 'What is a hash table?')
    await expect(page.getByText(/Mock answer to "What is a hash table\?"/)).toBeVisible({ timeout: 30_000 })

    // The decline stays in the conversation when it is reopened, without the "nothing matched" note.
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByText("That looks like a question from the mock exam you're taking. Finish it first, then ask me.")).toBeVisible()
    await expect(page.getByText('Nothing in your materials matched closely')).toHaveCount(0)
    const decline = page.locator('article', { hasText: "That looks like a question from the mock exam you're taking." })
    await expect(decline.getByRole('link', { name: 'Back to your mock exam' })).toHaveAttribute('href', `${ownCourse}/exams/${examId}/take`)
    // The exam question itself is not kept: the conversation is titled neutrally and holds a note in its place.
    await expect(page.getByText('A question from the mock exam in progress. It is not kept.')).toBeVisible()
    await expect(page.getByText(/linked list at each bucket/)).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Question from a mock exam' }).first()).toBeVisible()

    await decline.getByRole('link', { name: 'Back to your mock exam' }).click()
    await expect(page).toHaveURL(new RegExp(`/exams/${examId}/take$`))
    await page.goBack()
    // Once the exam is handed in, the same question is an ordinary one.
    await withPrisma((prisma) => prisma.examSubmission.updateMany({ where: { sampleExamId: examId }, data: { status: 'submitted' } }))
    await say(page, pasted)
    await expect(page.getByText(/Mock answer to "Which collision strategy/)).toBeVisible({ timeout: 30_000 })
  })

  test('a solve reply is written and checked before it is shown, and the wait says so', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    // The chat stream is held in the page, so each step of a buffered reply can be looked at.
    await holdChatStream(page)
    await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
    await say(page, 'Solve problem 3')
    const push = (event: unknown) => page.evaluate((e) => (window as unknown as { __chat: { push: (x: unknown) => void } }).__chat.push(e), event)
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __chat?: unknown }).__chat))).toBe(true)
    await push({ type: 'thread', threadId: '11111111-1111-4111-8111-111111111111', title: 'Solve problem 3', isNew: true })
    await push({ type: 'route', intent: 'solve', has_attempt: false, wants_answer: false, concepts: [], concept_ids: [], broad: false, degraded: false })
    await push({ type: 'retrieved', count: 3 })
    await expect(page.getByText('Searching your materials...')).toBeVisible()
    await push({ type: 'progress', stage: 'writing' })
    await expect(page.getByText('Writing the reply...')).toBeVisible()
    await push({ type: 'progress', stage: 'checking' })
    await expect(page.getByText('Checking the reply...')).toBeVisible()
    await animationsSettled(page)
    await screenshotIfAsked(page, 'f2-checking-the-reply-1440x900')
    await expectNoAxeViolations(page, 'ask: checking the reply')
    await push({ type: 'text', delta: 'What have you tried so far?' })
    await push({ type: 'done', text: 'What have you tried so far?', sources: [], marks: [], retrieved: 3, stop_reason: 'end_turn' })
    await expect(page.getByText('What have you tried so far?')).toBeVisible()
    await expect(page.getByText('Checking the reply...')).toHaveCount(0)
  })

  test('the Stop button names its Esc key on a wide screen and not at phone width', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await holdChatStream(page)
    await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
    await say(page, 'Explain load factor')
    const stop = page.getByRole('button', { name: /^Stop/ })
    await expect(stop).toBeVisible()
    await expect(stop.locator('kbd')).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(stop).toBeVisible()
    await expect(stop.locator('kbd')).toBeHidden()
    await screenshotIfAsked(page, 'f2-stop-without-esc-390x844')
    await page.keyboard.press('Escape')
  })

  test('a stopped explanation gets its check card once the server has stored the reply', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await holdChatStream(page)
    const threadId = '22222222-2222-4222-8222-222222222222'
    // What the server stored while the student had stopped reading: the full reply and its card.
    await page.route(`**/chat/threads/${threadId}`, (route) =>
      route.fulfill({
        json: {
          thread: { id: threadId, title: 'Explain load factor', workedAllowed: false },
          messages: [
            { id: '33333333-3333-4333-8333-333333333333', role: 'user', content: 'Explain load factor: keys over buckets', citations: null, createdAt: new Date().toISOString() },
            {
              id: '44444444-4444-4444-8444-444444444444',
              role: 'assistant',
              content: 'You have part of it. The whole explanation, stored in full.',
              citations: null,
              turn: { intent: 'understand', entryPoints: [], check: { question: 'In your own words, what is the key point?', conceptName: 'Load factor', grade: null } },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      })
    )
    await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
    await say(page, 'Explain load factor: keys over buckets')
    const push = (event: unknown) => page.evaluate((e) => (window as unknown as { __chat: { push: (x: unknown) => void } }).__chat.push(e), event)
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __chat?: unknown }).__chat))).toBe(true)
    await push({ type: 'thread', threadId, title: 'Explain load factor', isNew: true })
    await push({ type: 'route', intent: 'understand', has_attempt: true, wants_answer: false, concepts: ['Load factor'], concept_ids: [], broad: false, degraded: false })
    await push({ type: 'text', delta: 'You have part of it. The whole' })
    await expect(page.getByText('You have part of it. The whole')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('Stopped early.')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Check yourself' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('The whole explanation, stored in full.')).toBeVisible()
    await expect(page.getByText('Stopped early.')).toHaveCount(0)
  })

  test('on a phone the check card scrolls fully into view above the composer when the answer is shown', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 390, height: 844 })
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
    await say(page, 'Explain load factor')
    await expect(page.getByText(/What do you think this means\?/)).toBeVisible({ timeout: 30_000 })
    await settled(page)
    await say(page, 'Explain load factor: it is the number of keys divided by the number of buckets')
    const card = page.getByRole('group', { name: 'Check yourself' })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await settled(page)
    // As soon as the card appears, all of it is above the composer: the confidence row and the buttons are not under it.
    const composerTop = () => composerBoxTop(page)
    const clearOfComposer = async (target: Locator) => {
      const box = await target.boundingBox()
      return box !== null && box.y + box.height <= (await composerTop())
    }
    const confidence = card.getByText('How sure are you?')
    await expect.poll(() => clearOfComposer(confidence), { timeout: 5_000, message: 'the confidence row ends above the composer' }).toBe(true)
    await expect.poll(() => clearOfComposer(card.getByRole('button', { name: "I don't know" })), { timeout: 5_000, message: 'the card buttons end above the composer' }).toBe(true)
    await animationsSettled(page)
    await screenshotIfAsked(page, 'f2-check-card-in-view-390x844')
    await card.getByLabel(/^Your answer:/).fill('Keys divided by buckets')
    await card.getByRole('button', { name: 'Show the answer' }).click()
    const grades = card.getByRole('group', { name: 'How did you do?' })
    await expect(grades).toBeVisible()
    const above = async () => {
      const [bottom, top] = await Promise.all([
        grades.boundingBox().then((box) => (box ? box.y + box.height : Infinity)),
        composerBoxTop(page),
      ])
      return bottom <= top
    }
    await expect.poll(above, { timeout: 5_000 }).toBe(true)
    await animationsSettled(page)
    await screenshotIfAsked(page, 'f2-card-revealed-in-view-390x844')
    await card.getByRole('button', { name: 'Partly' }).click()
    await expect(card.getByText('Saved: Partly')).toBeVisible()
    await expect.poll(async () => (await card.boundingBox().then((box) => (box ? box.y + box.height : Infinity))) <= (await composerBoxTop(page)), { timeout: 5_000 }).toBe(true)
    await expectNoAxeViolations(page, 'ask: card graded on a phone')
  })

  test('a follow-up leaves the thread at the new reply: it does not jump back up to the older check card', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 390, height: 844 })
    // Which check card (by its place on the page) each scrollIntoView call was for.
    await page.addInitScript(() => {
      const w = window as unknown as { __cardScrolls: number[] }
      w.__cardScrolls = []
      const real = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (this: Element, ...args: Parameters<Element['scrollIntoView']>) {
        if (this.hasAttribute('data-ask-check')) w.__cardScrolls.push([...document.querySelectorAll('[data-ask-check]')].indexOf(this))
        return real.apply(this, args)
      }
    })
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
    await say(page, 'Explain load factor')
    await expect(page.getByText(/What do you think this means\?/)).toBeVisible({ timeout: 30_000 })
    await settled(page)
    await say(page, 'Explain load factor: it is the number of keys divided by the number of buckets')
    const card = page.getByRole('group', { name: 'Check yourself' })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await settled(page)
    const cardScrolls = () => page.evaluate(() => (window as unknown as { __cardScrolls: number[] }).__cardScrolls.length)
    const before = await cardScrolls()
    // The messages are the scrolling part above the composer; the card is in view at the foot of them.
    const thread = card.locator('xpath=ancestor::div[contains(@class, "overflow-y-auto")][1]')
    const fromBottom = () => thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    await expect.poll(fromBottom, { timeout: 5_000 }).toBeLessThan(24)
    // Ask again without answering the card. The thread follows the new reply down; the older card is not scrolled back to.
    await say(page, 'What is a hash function?')
    await settled(page)
    await expect(page.locator('article:not([aria-busy])')).toHaveCount(3)
    // Any smooth scroll the page starts has run its course after some frames; look only then.
    await page.evaluate(() => new Promise<void>((done) => { let n = 0; const tick = () => (++n >= 60 ? done() : requestAnimationFrame(tick)); tick() }))
    expect(await fromBottom(), 'the thread is at its foot, on the newest reply').toBeLessThan(24)
    // The first card (index 0) was not scrolled to again: only a card that has just appeared may bring itself into view.
    const later = await page.evaluate((from) => (window as unknown as { __cardScrolls: number[] }).__cardScrolls.slice(from), before)
    expect(later.filter((index) => index === 0), 'scrollIntoView calls for the older card').toEqual([])
    const newest = (await lastReply(page).boundingBox())!
    expect(newest.y + newest.height, 'the newest reply is above the composer').toBeLessThanOrEqual(await composerBoxTop(page))
  })
})
