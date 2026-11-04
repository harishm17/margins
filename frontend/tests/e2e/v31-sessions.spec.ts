import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations } from './helpers/axe'
import { animationsSettled } from './helpers/settle'
import { markAiAvailable, markAiUnavailable, withPrisma } from './helpers/db'
import { addQuizSet, createCourse, dayIn, reviewItem, seedDueConcept, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { addClaim, answeredChips, applyScreenSize, shot, seedConcepts, setProgress, trueFalse, world } from './helpers/v31-sessions'

// v3.1 workstream S: quiz drafts and the retake rule, quiz results with help after misses, AI-down partial
// grading, review sessions and drills, the ten-minute session and quick-pass triage.
// Set SCREENS_DIR to keep screenshots at both sizes.

test.use({ timezoneId: ZONE })
test.beforeEach(async ({ page }) => applyScreenSize(page))

const stamp = Date.now()

/** Ten true/false questions, each testing one of the topic's concepts. */
const tenQuestions = (concepts: string[]) =>
  Array.from({ length: 10 }, (_, i) => trueFalse(`Statement ${i + 1} about the topic holds.`, [concepts[i % concepts.length]]))

const quizUrl = (courseId: string, topicId: string, extra = '') => `/courses/${courseId}/topics/${topicId}?view=quiz${extra}`

/** Answers questions 1..n with "True" and goes to the next one (stays on question n+1, or n when it is the last). */
async function answerTrue(page: Page, n: number) {
  for (let i = 0; i < n; i += 1) {
    await expect(page.getByText(`Question ${i + 1} of`)).toBeVisible()
    await page.getByRole('radio', { name: 'True' }).click()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
  }
}

test.describe('S1: quiz drafts, save and finish later, retake rule, I do not know', () => {
  test('exit saves and resume restores 6 of 10', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await world(page, `s1-save-${stamp}`, [{ name: 'Graphs', concepts: ['Queues', 'Stacks'] }])
    const concepts = Object.values(w.concepts)
    await withPrisma(async (prisma) => prisma.topicQuiz.create({ data: { topicId: w.topics.Graphs, questions: tenQuestions(concepts) } }))
    await page.goto(quizUrl(w.courseId, w.topics.Graphs))
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await answerTrue(page, 6)

    // Exit offers to save (the default) or discard.
    await page.getByRole('button', { name: 'Exit' }).click()
    const dialog = page.getByRole('dialog', { name: 'Leave this quiz?' })
    await expect(dialog).toContainText("Your answers are saved. Pick up where you left off from this quiz's page.")
    await expect(dialog).not.toContainText('cleared')
    await expect(dialog.getByRole('button', { name: 'Save and finish later' })).toBeFocused()
    await animationsSettled(page)
    await shot(page, 'quiz-exit-dialog')
    await dialog.getByRole('button', { name: 'Save and finish later' }).click()

    // The lobby offers Resume with the count; resuming restores the answers and the place.
    await expect(page.getByText("Your answers are saved. Pick up where you left off from this quiz's page.")).toBeVisible()
    await page.reload()
    const resume = page.getByRole('button', { name: 'Resume (6 of 10 answered)' })
    await expect(resume).toBeVisible()
    await shot(page, 'quiz-lobby-resume')
    await resume.click()
    await expect(page.getByText('Question 7 of 10')).toBeVisible()
    expect(await answeredChips(page)).toBe(6)
  })

  test('quiz resumes from server draft in a new context', async ({ page, browser }) => {
    test.setTimeout(120_000)
    const w = await world(page, `s1-ctx-${stamp}`, [{ name: 'Graphs', concepts: ['Queues'] }])
    await withPrisma(async (prisma) => prisma.topicQuiz.create({ data: { topicId: w.topics.Graphs, questions: tenQuestions(Object.values(w.concepts)) } }))
    await page.goto(quizUrl(w.courseId, w.topics.Graphs))
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await answerTrue(page, 6)
    // Close the tab while the quiz is open: the pagehide flush saves what was typed.
    const state = await page.context().storageState()
    await page.close()

    const other = await browser.newContext({ storageState: state, timezoneId: ZONE })
    const tab = await other.newPage()
    await tab.goto(quizUrl(w.courseId, w.topics.Graphs))
    await expect(tab.getByRole('button', { name: 'Resume (6 of 10 answered)' })).toBeVisible({ timeout: 30_000 })
    await tab.getByRole('button', { name: 'Resume (6 of 10 answered)' }).click()
    await expect(tab.getByText('Question 7 of 10')).toBeVisible()
    expect(await answeredChips(tab)).toBe(6)
    await other.close()
  })

  test('the legacy first quiz resumes from the server draft in a new context', async ({ page, browser }) => {
    test.setTimeout(120_000)
    const w = await world(page, `s1-legacy-${stamp}`, [{ name: 'Graphs', concepts: ['Queues'] }])
    // A topic whose first quiz predates quiz sets: the questions are only in topic_content, there is no TopicQuiz row.
    await withPrisma(async (prisma) => {
      await prisma.topicQuiz.deleteMany({ where: { topicId: w.topics.Graphs } })
      await prisma.topicContent.upsert({
        where: { topicId_contentType: { topicId: w.topics.Graphs, contentType: 'topic_quiz' } },
        create: { topicId: w.topics.Graphs, contentType: 'topic_quiz', contentData: tenQuestions(Object.values(w.concepts)) },
        update: { contentData: tenQuestions(Object.values(w.concepts)) },
      })
    })
    await page.goto(quizUrl(w.courseId, w.topics.Graphs))
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await answerTrue(page, 6)
    await expect.poll(() => withPrisma((prisma) => prisma.studyDraft.count({ where: { topicId: w.topics.Graphs, surface: 'quiz' } }))).toBe(1)
    const state = await page.context().storageState()
    await page.close()

    const other = await browser.newContext({ storageState: state, timezoneId: ZONE })
    const tab = await other.newPage()
    await tab.goto(quizUrl(w.courseId, w.topics.Graphs))
    const resume = tab.getByRole('button', { name: 'Resume (6 of 10 answered)' })
    await expect(resume).toBeVisible({ timeout: 30_000 })
    await resume.click()
    await expect(tab.getByText('Question 7 of 10')).toBeVisible()
    expect(await answeredChips(tab)).toBe(6)
    await other.close()
  })

  test('discard deletes the answers', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, `s1-discard-${stamp}`, [{ name: 'Graphs', concepts: ['Queues'] }])
    await withPrisma(async (prisma) => prisma.topicQuiz.create({ data: { topicId: w.topics.Graphs, questions: tenQuestions(Object.values(w.concepts)) } }))
    await page.goto(quizUrl(w.courseId, w.topics.Graphs))
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await answerTrue(page, 3)
    await page.getByRole('button', { name: 'Exit' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard my answers' }).click()
    await expect(page.getByRole('button', { name: 'Start quiz' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Start quiz' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Resume/ })).toHaveCount(0)
    await expect.poll(() => withPrisma((prisma) => prisma.studyDraft.count({ where: { topicId: w.topics.Graphs } }))).toBe(0)
  })

  test('retake the same day offers new questions', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await world(page, `s1-again-${stamp}`, [{ name: 'Graphs', concepts: ['Queues'] }])
    const concepts = Object.values(w.concepts)
    const questions = Array.from({ length: 4 }, (_, i) => trueFalse(`Statement ${i + 1} about graphs holds.`, concepts))
    const setId = await withPrisma(async (prisma) => (await prisma.topicQuiz.create({ data: { topicId: w.topics.Graphs, questions } })).id)
    await page.goto(quizUrl(w.courseId, w.topics.Graphs))
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await answerTrue(page, 3)
    await page.getByRole('radio', { name: 'True' }).click()
    await page.getByRole('button', { name: 'Submit quiz' }).click()
    await expect(page.getByRole('heading', { name: /points/ })).toBeVisible({ timeout: 60_000 })

    // The results offer new questions, not the identical set.
    await expect(page.getByRole('button', { name: 'Retake' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New questions' })).toBeVisible()
    await page.getByRole('button', { name: 'Back to quiz' }).click()
    // The lobby says why the same questions wait, and Start quiz is not offered for this set.
    await expect(page.getByText('Available tomorrow. Re-answering the same question right away mostly tests short-term memory.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start quiz' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New questions' })).toBeVisible()
    await shot(page, 'quiz-lobby-new-questions')

    // The server holds the same line: a new draft of this set today is refused.
    const refused = await page.request.put(`/api/drafts?surface=quiz&key=${w.topics.Graphs}:${setId}`, {
      data: { payload: { answers: {}, index: 0 }, version: 0, projectId: w.courseId, topicId: w.topics.Graphs },
    })
    expect(refused.status()).toBe(409)
    expect((await refused.json()).error.details.code).toBe('RETRY_TOMORROW')
  })

  test('idk is a miss with no confidence and a same-day repeat is level 2', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await world(page, `s1-idk-${stamp}`, [{ name: 'Graphs', concepts: ['Queues', 'Stacks'] }])
    const [queues, stacks] = [w.concepts.Queues, w.concepts.Stacks]
    const questions = [trueFalse('Queues are first in, first out.', [queues]), trueFalse('Stacks are last in, first out.', [stacks]), trueFalse('A queue serves the oldest item first.', [queues])]
    const setId = await withPrisma(async (prisma) => (await prisma.topicQuiz.create({ data: { topicId: w.topics.Graphs, questions } })).id)
    await page.goto(quizUrl(w.courseId, w.topics.Graphs))
    await page.getByRole('button', { name: 'Start quiz' }).click()
    // Question 1: right and certain. Question 2: I don't know. Question 3: right.
    await page.getByRole('radio', { name: 'True' }).click()
    await page.getByRole('radio', { name: 'Certain' }).click()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('button', { name: "I don't know" }).click()
    await expect(page.getByTestId('idk-marked')).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Certain' })).toHaveCount(0)
    await expectNoAxeViolations(page, 'quiz question, I do not know')
    await shot(page, 'quiz-idk')
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('radio', { name: 'True' }).click()
    const request = page.waitForRequest((req) => req.url().includes('/quiz-attempts') && req.method() === 'POST')
    await page.getByRole('button', { name: 'Submit quiz' }).click()
    const sent = (await request).postDataJSON() as { answers: Record<string, unknown> }
    expect(sent.answers['1']).toEqual({ answer: '', idk: true })
    await expect(page.getByRole('heading', { name: /points/ })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('2 of 3 points')).toBeVisible()

    const events = await withPrisma((prisma) => prisma.evidenceEvent.findMany({ where: { topicId: w.topics.Graphs, source: 'quiz' }, orderBy: { createdAt: 'asc' } }))
    const idk = events.find((event) => event.conceptId === stacks)!
    expect(idk.score).toBe(0)
    expect(idk.assistance).toBe(0)
    expect(idk.confidence).toBeNull()
    expect((idk.metadata as Record<string, unknown>).idk).toBe(true)
    expect((idk.metadata as Record<string, unknown>).missKind).toBe('cue_miss')

    // The same set submitted again the same day (an older client): accepted, recorded at level 2.
    const again = await page.request.post(`/api/topics/${w.topics.Graphs}/quiz-attempts`, {
      data: { quizSetId: setId, answers: { '0': 'true', '1': 'true', '2': 'true' } },
    })
    expect(again.ok()).toBeTruthy()
    const later = await withPrisma((prisma) => prisma.evidenceEvent.findMany({ where: { topicId: w.topics.Graphs, source: 'quiz', assistance: 2 } }))
    expect(later.length).toBeGreaterThan(0)
    expect(later.every((event) => (event.metadata as Record<string, unknown>).repeat === 'same_day')).toBe(true)
  })

  test('legacy string answers still submit', async ({ page }) => {
    const w = await world(page, `s1-legacy-${stamp}`, [{ name: 'Graphs', concepts: ['Queues'] }])
    const questions = [trueFalse('Queues are first in, first out.', Object.values(w.concepts))]
    const setId = await withPrisma(async (prisma) => (await prisma.topicQuiz.create({ data: { topicId: w.topics.Graphs, questions } })).id)
    const response = await page.request.post(`/api/topics/${w.topics.Graphs}/quiz-attempts`, { data: { quizSetId: setId, answers: { '0': 'true' } } })
    expect(response.ok()).toBeTruthy()
    expect((await response.json()).status).toBe('graded')
  })
})

test.describe('S2: quiz results with help after misses, strong start, difficulty from the band', () => {
  /** A quiz of nine true/false questions on three concepts (4, 2 and 3 questions), all keyed true. */
  async function nineQuestionWorld(page: Page, label: string) {
    const w = await world(page, label, [{ name: 'Graphs', concepts: ['Queues', 'Stacks', 'Heaps'] }])
    const { Queues, Stacks, Heaps } = w.concepts
    const questions = [
      ...[1, 2, 3, 4].map((i) => trueFalse(`Queue statement ${i} holds.`, [Queues])),
      ...[1, 2].map((i) => trueFalse(`Stack statement ${i} holds.`, [Stacks])),
      ...[1, 2, 3].map((i) => trueFalse(`Heap statement ${i} holds.`, [Heaps])),
    ]
    const setId = await withPrisma(async (prisma) => (await prisma.topicQuiz.create({ data: { topicId: w.topics.Graphs, questions } })).id)
    return { ...w, setId }
  }

  const sure = { confidence: 0.75, confidenceLevel: 'fairly' }

  test('88 percent quiz moves the path past reading', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await nineQuestionWorld(page, `s2-strong-${stamp}`)
    const card = page.getByRole('region', { name: 'Next on this topic' })
    await page.goto(`/courses/${w.courseId}/topics/${w.topics.Graphs}?view=examples`)
    await expect(card).toContainText('Read the topic next.')

    // Eight of nine right and not guessed (one queue statement wrong: its concept still grades Good).
    const answers = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), { answer: i === 3 ? 'false' : 'true', ...sure }]))
    const response = await page.request.post(`/api/topics/${w.topics.Graphs}/quiz-attempts`, { data: { quizSetId: w.setId, answers } })
    expect(response.ok()).toBeTruthy()
    expect((await response.json()).score).toBeGreaterThan(80)

    await expect.poll(() => withPrisma((prisma) => prisma.topicProgress.findFirst({ where: { topicId: w.topics.Graphs }, select: { testedOutAt: true } }))).toMatchObject({ testedOutAt: expect.any(Date) })
    await page.goto(`/courses/${w.courseId}/topics/${w.topics.Graphs}?view=examples`)
    await expect(card).not.toContainText('Read the topic next.')
    await page.goto(`/courses/${w.courseId}/topics/${w.topics.Graphs}`)
    await expect(page).not.toHaveURL(/view=read/)
  })

  test('a quiz of guesses does not test out', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await nineQuestionWorld(page, `s2-guess-${stamp}`)
    const answers = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), { answer: 'true', confidence: 0.5, confidenceLevel: 'guess' }]))
    const response = await page.request.post(`/api/topics/${w.topics.Graphs}/quiz-attempts`, { data: { quizSetId: w.setId, answers } })
    expect((await response.json()).score).toBe(100)
    const progress = await withPrisma((prisma) => prisma.topicProgress.findFirst({ where: { topicId: w.topics.Graphs }, select: { testedOutAt: true } }))
    expect(progress?.testedOutAt ?? null).toBeNull()
  })

  test('missed questions show where to look, and a low first score says it is common', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await nineQuestionWorld(page, `s2-help-${stamp}`)
    await page.goto(quizUrl(w.courseId, w.topics.Graphs))
    await page.getByRole('button', { name: 'Start quiz' }).click()
    // Right on the first three, wrong on the rest: 3 of 9 is under 60%.
    for (let i = 0; i < 9; i += 1) {
      await page.getByRole('radio', { name: i < 3 ? 'True' : 'False' }).click()
      if (i < 8) await page.getByRole('button', { name: 'Next', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Submit quiz' }).click()
    await expect(page.getByRole('heading', { name: /points/ })).toBeVisible({ timeout: 60_000 })

    await expect(page.getByText('A low first score is common, and useful: the misses show where to spend your time.')).toBeVisible()
    // Each missed question has its pointer: the page of the first claim of its concept, as a link to the reader.
    const pointers = page.getByTestId('where-to-look')
    await expect(pointers).toHaveCount(6)
    const first = pointers.first().getByRole('link')
    await expect(first).toHaveText(/^p\. \d+$/)
    await expect(first).toHaveAttribute('href', /view=read&focus=.*#chunk-/)
    // After a miss the one primary step is going back to the first missed idea; new questions and voice practice are secondary.
    await expect(page.getByTestId('review-first-missed')).toHaveText('Review the first missed idea')
    await expect(page.getByTestId('review-first-missed')).toHaveAttribute('href', /view=read&focus=/)
    await expect(page.getByRole('button', { name: 'New questions' })).toBeVisible()
    await expectNoAxeViolations(page, 'quiz results with pointers')
    await shot(page, 'quiz-results-pointers')
    await first.click()
    await expect(page).toHaveURL(/view=read&focus=/)
  })

  test('every answer right and sure says solid for now and offers a harder set', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await nineQuestionWorld(page, `s2-solid-${stamp}`)
    await page.goto(quizUrl(w.courseId, w.topics.Graphs))
    await page.getByRole('button', { name: 'Start quiz' }).click()
    for (let i = 0; i < 9; i += 1) {
      await page.getByRole('radio', { name: 'True' }).click()
      await page.getByRole('radio', { name: 'Certain' }).click()
      if (i < 8) await page.getByRole('button', { name: 'Next', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Submit quiz' }).click()
    await expect(page.getByRole('heading', { name: /points/ })).toBeVisible({ timeout: 60_000 })
    // Focus moves to the results when they arrive.
    await expect(page.getByRole('heading', { name: /points/ })).toBeFocused()
    await expect(page.getByTestId('solid-for-now')).toHaveText('Solid for now. It counts as solid once it holds up on another day.')
    await expect(page.getByText('A low first score is common')).toHaveCount(0)
    await expectNoAxeViolations(page, 'quiz results, solid for now')
    await shot(page, 'quiz-results-solid')
    const request = page.waitForRequest((req) => req.url().includes('/regenerate-content') && req.method() === 'POST')
    await page.getByRole('button', { name: 'Harder set' }).click()
    expect((await request).postDataJSON().preferences.difficulty_level).toBe('hard')
  })

  test('new set difficulty follows the band', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await nineQuestionWorld(page, `s2-band-${stamp}`)
    // No evidence yet: every concept starts with support, so New questions asks for an easy set.
    const response = await page.request.post(`/api/topics/${w.topics.Graphs}/fresh-review`)
    expect(response.ok()).toBeTruthy()
    const job = await withPrisma((prisma) => prisma.processingJob.findFirstOrThrow({ where: { targetKey: `content:${w.topics.Graphs}:topic_quiz` }, orderBy: { createdAt: 'desc' } }))
    const preferences = (job.inputData as { preferences: { difficulty_level: string } }).preferences
    expect(preferences.difficulty_level).toBe('easy')
  })
})

test.describe('S4: review sessions and drills', () => {
  /** Two topics, each with one overdue concept that has a claim on a page and easy items to serve. */
  async function reviewWorld(page: Page, label: string, options: { items?: number } = {}) {
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, label, { own: true })
    const course = await createCourse(page, `Review ${label} ${Date.now()}`, [{ name: 'Hash tables' }, { name: 'Sorting' }])
    const concepts: Record<string, string> = {}
    for (const [topicName, conceptName] of [['Hash tables', 'Hashing'], ['Sorting', 'Quicksort']] as const) {
      const topicId = course.topics[topicName]
      const conceptId = await seedDueConcept(email, topicId, conceptName)
      concepts[conceptName] = conceptId
      await addClaim(conceptId, course.courseId, conceptName === 'Hashing' ? 12 : 31)
      const count = options.items ?? 2
      await addQuizSet(
        topicId,
        Array.from({ length: count }, (_, n) => reviewItem(conceptId, `${conceptName} statement ${n + 1} holds.`, 'easy'))
      )
    }
    return { email, course, concepts, sessionUrl: `/courses/${course.courseId}/review/session` }
  }

  test('correct review answer needs one tap', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await reviewWorld(page, `s4-tap-${stamp}`)
    await page.goto(w.sessionUrl)
    await expect(page.getByRole('heading', { name: /^Question 1 of 2/ })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('radio', { name: 'True' }).click()
    await page.getByRole('button', { name: 'Check answer' }).click()
    // One tap: the next question is on screen, with a note that the last one was right and its feedback a tap away.
    await expect(page.getByRole('heading', { name: /^Question 2 of 2/ })).toBeVisible()
    await expect(page.getByTestId('right-note')).toContainText('Correct.')
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'See the feedback' }).click()
    await expect(page.getByTestId('right-note').getByText(/statement 1 holds\./)).toBeVisible()
    await shot(page, 'review-right-note')
  })

  test('length notice appears on the first miss', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await reviewWorld(page, `s4-notice-${stamp}`, { items: 3 })
    await page.goto(w.sessionUrl)
    await expect(page.getByRole('heading', { name: /^Question 1 of 2/ })).toBeVisible({ timeout: 60_000 })
    await shot(page, 'review-question')
    await page.getByRole('radio', { name: 'False' }).click()
    await page.getByRole('button', { name: 'Check answer' }).click()
    // A miss waits for the student: the feedback, where to look, the notice, and Next.
    await expect(page.getByTestId('length-notice')).toHaveText('Misses come back once at the end in a new form.')
    await expect(page.getByTestId('where-to-look').getByRole('link')).toHaveText(/^p\. (12|31)$/)
    await shot(page, 'review-first-miss')
    await page.getByRole('button', { name: 'Next question', exact: true }).click()
    // The counter says a retest is to come.
    await expect(page.getByRole('heading', { name: /^Question 2 of 2 \(\+1 to retest\)/ })).toBeVisible()
    // The notice is for the first miss only.
    await page.getByRole('radio', { name: 'False' }).click()
    await page.getByRole('button', { name: 'Check answer' }).click()
    await expect(page.getByTestId('where-to-look')).toBeVisible()
    await expect(page.getByTestId('length-notice')).toHaveCount(0)
  })

  test('I do not know is a miss with the answer shown, and its concept comes back', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await reviewWorld(page, `s4-idk-${stamp}`, { items: 3 })
    await page.goto(w.sessionUrl)
    await expect(page.getByRole('heading', { name: /^Question 1 of 2/ })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: "I don't know" }).click()
    await expect(page.getByTestId('length-notice')).toBeVisible()
    await expect(page.getByText('It is true.').first()).toBeVisible()
    const events = await withPrisma((prisma) => prisma.evidenceEvent.findMany({ where: { projectId: w.course.courseId, source: 'review' } }))
    expect(events).toHaveLength(1)
    expect(events[0].score).toBe(0)
    expect(events[0].confidence).toBeNull()
    expect((events[0].metadata as Record<string, unknown>).idk).toBe(true)
  })

  test('review resumes today\'s session', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await reviewWorld(page, `s4-resume-${stamp}`)
    await page.goto(w.sessionUrl)
    await expect(page.getByRole('heading', { name: /^Question 1 of 2/ })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('radio', { name: 'True' }).click()
    await page.getByRole('button', { name: 'Check answer' }).click()
    await expect(page.getByRole('heading', { name: /^Question 2 of 2/ })).toBeVisible()
    const sessionId = new URL(page.url()).searchParams.get('session')!
    expect(sessionId).toBeTruthy()

    // Leave. The Review page offers to resume instead of starting another.
    await page.goto(`/courses/${w.course.courseId}/review`)
    const resume = page.getByRole('link', { name: "Resume today's review (1 of 2)" })
    await expect(resume).toBeVisible()
    await expectNoAxeViolations(page, 'review page with resume')
    await shot(page, 'review-resume')
    await resume.click()
    await expect(page.getByRole('heading', { name: /^Question 2 of 2/ })).toBeVisible()
    expect(new URL(page.url()).searchParams.get('session')).toBe(sessionId)
    // A plain link to today's review goes on with it too.
    await page.goto(w.sessionUrl)
    await expect(page.getByRole('heading', { name: /^Question 2 of 2/ })).toBeVisible({ timeout: 30_000 })
    expect(await withPrisma((prisma) => prisma.itemSession.count({ where: { projectId: w.course.courseId } }))).toBe(1)
  })

  test('drill end screen shows what to read', async ({ page }) => {
    test.setTimeout(180_000)
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, `s4-drill-${stamp}`, { own: true })
    const course = await createCourse(page, `Drill ${stamp}`, [{ name: 'Hash tables' }])
    const topicId = course.topics['Hash tables']
    const conceptId = await seedDueConcept(email, topicId, 'Hashing')
    await addClaim(conceptId, course.courseId, 12)
    await addQuizSet(topicId, [
      reviewItem(conceptId, 'Hashing statement 1 holds.', 'medium', 'recall'),
      reviewItem(conceptId, 'Hashing statement 2 holds.', 'medium', 'recall'),
      reviewItem(conceptId, 'Hashing statement 3 holds.', 'hard', 'composition'),
      reviewItem(conceptId, 'Hashing statement 4 holds.', 'hard', 'composition'),
    ])
    await page.goto(`/courses/${course.courseId}/review/session?concept=${conceptId}`)
    await expect(page.getByRole('heading', { name: /^Question 1 of \d/ })).toBeVisible({ timeout: 60_000 })
    const total = Number((await page.getByRole('heading', { name: /^Question 1 of \d/ }).textContent())?.match(/of (\d+)/)?.[1])
    // 0 of N.
    for (let i = 0; i < total; i += 1) {
      await page.getByRole('radio', { name: 'False' }).click()
      await page.getByRole('button', { name: 'Check answer' }).click()
      await page.getByRole('button', { name: /^(Next question|See session summary|Continue)$/ }).click()
    }
    await expect(page.getByRole('heading', { name: 'Drill done' })).toBeVisible()
    await expect(page.getByText(`You got 0 of ${total} questions right.`)).toBeVisible()
    // Not a dead end: what to read leads, the drill is second, and no "not retested" line.
    const read = page.getByRole('link', { name: 'Read about Hashing' })
    await expect(read).toBeVisible()
    await expect(read).toHaveAttribute('href', /view=read&focus=.*#chunk-/)
    await expect(page.getByTestId('what-to-read')).toContainText('p. 12')
    await expect(page.getByText("That was a hard set, and that's normal at this stage. Here's what to look at.")).toBeVisible()
    await expect(page.getByText('Not retested')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Drill this again' })).toBeVisible()
    await expectNoAxeViolations(page, 'drill end screen')
    await shot(page, 'drill-end-screen')
    // After the drill the next activity is the explanation or the pages, not the same drill again (spec 8.1).
    // The topic's one next signal says to read again (the tag is on Read); a tool carries the sentence, the quiz step has its own buttons.
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=examples`)
    const card = page.getByRole('region', { name: 'Next on this topic' })
    await expect(card).toContainText('Read p. 12 again before trying again.')
  })
})

test.describe('S5: the 10-minute session and quick-pass triage', () => {
  test.afterEach(markAiAvailable)

  /** A course with `concepts` overdue concepts over two topics, each concept with two easy items. */
  async function dueWorld(page: Page, label: string, concepts: number) {
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, label, { own: true })
    const course = await createCourse(page, `Short ${label} ${Date.now()}`, [{ name: 'Hash tables' }, { name: 'Sorting' }])
    const topicIds = [course.topics['Hash tables'], course.topics.Sorting]
    for (let n = 0; n < concepts; n += 1) {
      const topicId = topicIds[n % 2]
      const conceptId = await seedDueConcept(email, topicId, `Concept ${n}`, { orderIndex: n })
      // Items at every difficulty, so no question has to be written before the session starts.
      await addQuizSet(topicId, [
        reviewItem(conceptId, `Concept ${n} statement one holds.`, 'easy'),
        reviewItem(conceptId, `Concept ${n} statement two holds.`, 'medium'),
        reviewItem(conceptId, `Concept ${n} statement three holds.`, 'hard'),
        reviewItem(conceptId, `Concept ${n} statement four holds.`, 'easy'),
      ])
    }
    // The 10-minute check opens after a first quiz: give the first topic a score.
    await setProgress(email, topicIds[0], { quizScore: 70 })
    // Seeded memories have no evidence behind them: mark the topics converted, or opening one would rebuild its concepts from nothing.
    await withPrisma((prisma) => prisma.topic.updateMany({ where: { projectId: course.courseId }, data: { evidenceBackfilledAt: new Date() } }))
    return { email, course }
  }

  test('ten-minute session from Home finishes in at most six items', async ({ page }) => {
    test.setTimeout(180_000)
    await dueWorld(page, `s5-home-${stamp}`, 8)
    await page.goto('/home')
    const card = page.getByTestId('short-session').locator('visible=true')
    await expect(card.getByRole('heading', { name: 'Quick practice' })).toBeVisible()
    await expect(card).toContainText('About 9 minutes · 6 reviews')
    await expectNoAxeViolations(page, 'home with the short session')
    // A long course name is cut inside its card, not pushed past the screen edge (the page was 402px wide on a 390px phone).
    const original = page.viewportSize()
    await page.setViewportSize({ width: 390, height: 844 })
    await animationsSettled(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    if (original) await page.setViewportSize(original)
    await shot(page, 'home-short-session')
    await card.getByRole('button', { name: 'Start' }).click()

    await expect(page.getByRole('heading', { name: /^Question 1 of 6/ })).toBeVisible({ timeout: 60_000 })
    for (let n = 1; n <= 6; n += 1) {
      await expect(page.getByRole('heading', { name: new RegExp(`^Question ${n} of 6`) })).toBeVisible()
      await page.getByRole('radio', { name: 'True' }).click()
      await page.getByRole('button', { name: 'Check answer' }).click()
    }
    // Six right: nothing to retest, so the summary follows the sixth answer.
    await expect(page.getByRole('heading', { name: 'Review done' })).toBeVisible()
    await expect(page.getByText('You got 6 of 6 questions right.')).toBeVisible()
    const session = await withPrisma((prisma) => prisma.itemSession.findFirstOrThrow({ where: { project: { name: { startsWith: `Short s5-home-${stamp}` } } } }))
    expect((session.results as { short?: boolean; retestCap?: number }).short).toBe(true)
    expect((session.results as { retestCap?: number }).retestCap).toBe(2)
    expect((session.items as unknown[]).length).toBe(6)
    // Not a quiz attempt (D7).
    expect(await withPrisma((prisma) => prisma.quizAttempt.count({ where: { topic: { project: { name: { startsWith: `Short s5-home-${stamp}` } } } } }))).toBe(0)
  })

  test('the Review page offers the same action, and a miss adds at most two retests', async ({ page }) => {
    test.setTimeout(180_000)
    const w = await dueWorld(page, `s5-review-${stamp}`, 8)
    await page.goto(`/courses/${w.course.courseId}/review`)
    const card = page.getByTestId('short-session').locator('visible=true')
    await expect(card).toContainText('Quick practice')
    await card.getByRole('button', { name: 'Start' }).click()
    await expect(page.getByRole('heading', { name: /^Question 1 of 6/ })).toBeVisible({ timeout: 60_000 })
    // Miss all six: the counter caps the retests at two.
    await page.getByRole('radio', { name: 'False' }).click()
    await page.getByRole('button', { name: 'Check answer' }).click()
    await page.getByRole('button', { name: 'Next question', exact: true }).click()
    await expect(page.getByRole('heading', { name: /^Question 2 of 6 \(\+1 to retest\)/ })).toBeVisible()
    await page.getByRole('radio', { name: 'False' }).click()
    await page.getByRole('button', { name: 'Check answer' }).click()
    await page.getByRole('button', { name: 'Next question', exact: true }).click()
    await expect(page.getByRole('heading', { name: /^Question 3 of 6 \(\+2 to retest\)/ })).toBeVisible()
    await page.getByRole('radio', { name: 'False' }).click()
    await page.getByRole('button', { name: 'Check answer' }).click()
    await page.getByRole('button', { name: 'Next question', exact: true }).click()
    // A third miss does not raise it past the cap.
    await expect(page.getByRole('heading', { name: /^Question 4 of 6 \(\+2 to retest\)/ })).toBeVisible()
  })

  test('read but not recalled offers one recall card, and the AI down offers a short check instead', async ({ page }) => {
    test.setTimeout(120_000)
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, `s5-recall-${stamp}`, { own: true })
    const course = await createCourse(page, `Short recall ${stamp}`, [{ name: 'Hash tables' }])
    const topicId = course.topics['Hash tables']
    const concepts = await seedConcepts(topicId, ['Hashing', 'Collisions'])
    await addQuizSet(topicId, Object.values(concepts).map((id, n) => reviewItem(id, `Statement ${n} holds.`, 'easy')))
    // A first quiz (a score on the topic) opens the 10-minute check; before it Home says what opens it.
    await setProgress(email, topicId, { readAt: new Date(Date.now() - 3_600_000), quizScore: 70 })

    await page.goto('/home')
    const card = page.getByTestId('short-session').locator('visible=true')
    await expect(card).toContainText('About 5 minutes · one recall card')
    await expect(card.getByRole('link', { name: 'Start' })).toHaveAttribute('href', `/courses/${course.courseId}/topics/${topicId}?view=recall`)

    // With the AI down the recall card is not offered: a short check on rule-graded items stands in.
    await markAiUnavailable()
    await page.goto('/home')
    // The card says the number the session really has (the world holds two questions), not the format's ceiling of four.
    await expect(page.getByTestId('short-session').locator('visible=true')).toContainText('About 2 minutes · 2 questions')
    await page.getByTestId('short-session').locator('visible=true').getByRole('button', { name: 'Start' }).click()
    await expect(page.getByRole('heading', { name: /^Question 1 of 2/ })).toBeVisible({ timeout: 60_000 })
  })

  test('quick pass shortens a topic and re-fits the plan, and undo puts it back', async ({ page }) => {
    test.setTimeout(180_000)
    await setZoneCookie(page.context())
    await signUpAndIn(page, `s5-triage-${stamp}`, { own: true })
    const names = ['Intro', 'Mid', 'Hard', 'Tricky', 'Extra']
    const course = await createCourse(page, `Triage ${stamp}`, names.map((name) => ({ name })), { examDate: dayIn(ZONE, 9), dailyMinutes: 45 })
    await page.goto(`/courses/${course.courseId}/plan`)
    const alert = page.getByRole('alert').filter({ hasText: 'Time is short' })
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('Left out:')
    const panel = page.getByTestId('quick-pass').locator('visible=true')
    await expect(panel).toContainText('Quick pass: a warm-up and a quiz, then review what you miss. You can do the full topic later.')
    // The choice sits where the problem is stated: after the alert and the "Not scheduled" chips, before the first week.
    const notScheduled = page.getByRole('region', { name: /^Not scheduled:/ })
    const firstWeek = page.locator('section[aria-labelledby^="week-"]').first()
    const top = async (target: typeof panel) => (await target.boundingBox())!.y
    expect(await top(alert)).toBeLessThan(await top(notScheduled))
    expect(await top(notScheduled)).toBeLessThan(await top(panel))
    expect(await top(panel)).toBeLessThan(await top(firstWeek))
    const buttons = panel.getByRole('button', { name: /^Quick pass \(about 20 minutes\)/ })
    const before = await buttons.count()
    expect(before).toBeGreaterThan(0)
    await expectNoAxeViolations(page, 'plan with quick pass')
    await shot(page, 'plan-quick-pass')

    // Take a quick pass on every topic that did not fit.
    for (let n = 0; n < before; n += 1) {
      await panel.getByRole('button', { name: /^Quick pass \(about 20 minutes\)/ }).first().click()
      await expect(panel.getByRole('button', { name: /^Undo quick pass/ })).toHaveCount(n + 1)
    }
    const quick = await withPrisma((prisma) => prisma.topicProgress.findMany({ where: { topic: { projectId: course.courseId }, triage: 'quick' }, select: { topicId: true, triageAt: true } }))
    expect(quick).toHaveLength(before)
    expect(quick.every((row) => row.triageAt !== null)).toBe(true)
    // The plan is laid out again: the topics on a quick pass have 20-minute blocks.
    await page.reload()
    await expect(panel.getByRole('button', { name: /^Undo quick pass/ })).toHaveCount(before)
    expect(await page.getByText('20 min', { exact: false }).count()).toBeGreaterThan(0)

    // A quick topic skips read and recall: its next activity is the warm-up or the quiz.
    const quickTopicId = quick[0].topicId
    await page.goto(`/courses/${course.courseId}/topics/${quickTopicId}?view=examples`)
    const next = page.getByRole('region', { name: 'Next on this topic' }).locator('visible=true')
    await expect(next).toContainText('Take the quiz to see what you know.')
    await expect(next).not.toContainText(/Read the topic next|Close the book/)

    // Undo puts the full block back.
    await page.goto(`/courses/${course.courseId}/plan`)
    await panel.getByRole('button', { name: /^Undo quick pass/ }).first().click()
    await expect(panel.getByRole('button', { name: /^Undo quick pass/ })).toHaveCount(before - 1)
    await expect.poll(() => withPrisma((prisma) => prisma.topicProgress.count({ where: { topic: { projectId: course.courseId }, triage: 'quick' } }))).toBe(before - 1)
  })
})
