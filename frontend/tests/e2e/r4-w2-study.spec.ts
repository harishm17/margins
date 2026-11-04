import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { expectNoSidewaysScroll } from './helpers/overflow'
import { withPrisma } from './helpers/db'
import { addContent, addQuizSet, createCourse, practiceProblem, quizQuestions, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { streamedPartsArrived } from './helpers/settle'
import { recallWorld } from './helpers/v31-recall'

// The topic study screens after the fourth design review (workstream W2): the phone header and path, a warm-up that never
// blocks on a rating and ends in "Ready to read", one note above the reading, recall before and after grading, a practice
// problem that ends in the quiz, and a quiz that can be finished from any question.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const phonePath = (page: Page) => page.getByTestId('phone-path')

test.describe('the phone study shell', () => {
  test('outside an attempt the header is the title and one button, and the first task is in the top of the screen', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(PHONE)
    const { topicUrl } = await recallWorld(page, 'r4w2-shell', { warmup: true, readAt: false })
    await page.goto(`${topicUrl}?view=warmup`)

    // The path is one line that opens the steps; the five-tab strip is for wider screens.
    await expect(phonePath(page)).toHaveText(/Step 1 of 5: Warm-up/)
    await expect(page.getByRole('navigation', { name: 'Topic path' })).toHaveCount(0)
    // The numbers (progress, best score, next review, time) are behind "Details".
    const details = page.getByRole('button', { name: /^Details/ })
    await expect(details).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('Topic progress').locator('visible=true')).toHaveCount(0)
    await details.click()
    await expect(page.getByText('Topic progress').locator('visible=true').first()).toBeVisible()
    await details.click()

    // The first task heading is in the top 45% of the screen.
    const heading = await page.getByRole('heading', { name: 'Try a few questions first' }).boundingBox()
    expect(heading, 'the warm-up heading is on screen').not.toBeNull()
    expect(heading!.y).toBeLessThan(PHONE.height * 0.45)
    await expectNoSidewaysScroll(page, page.url())
    await screenshotIfAsked(page, 'r4w2-warmup-intro-390x844')

    // The steps open in a sheet, and a step goes to its view.
    await screenshotIfAsked(page, 'r4w2-warmup-intro-390x844')
    await phonePath(page).click()
    const list = page.getByRole('navigation', { name: 'Topic path' })
    await expect(list.getByRole('link')).toHaveCount(5)
    await screenshotIfAsked(page, 'r4w2-path-sheet-390x844')
    await expectNoAxeViolations(page, 'path sheet, 390')
    await list.getByRole('link', { name: /Read/ }).click()
    await expect(page).toHaveURL(/view=read/)
    await expect(phonePath(page)).toHaveText(/Step 2 of 5: Read/)

    // Wide screens keep the five tabs.
    await page.setViewportSize(DESKTOP)
    await expect(page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Warm-up/ })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Quiz/ })).toBeVisible()
    await expect(phonePath(page)).toBeHidden()
  })
})

test.describe('the warm-up', () => {
  test('is fine without a confidence rating, never says there are no hints, and ends in Ready to read with the way on first', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(PHONE)
    const { topicUrl } = await recallWorld(page, 'r4w2-warmup', { warmup: true, readAt: false })
    await page.goto(`${topicUrl}?view=warmup`)

    await expect(page.getByText("This won't affect your quiz score.")).toBeVisible()
    await expect(page.getByText(/no hints/i)).toHaveCount(0)
    await page.getByRole('button', { name: 'Start warm-up' }).click()
    await expect(page.getByRole('heading', { name: 'Warm-up question 1 of 3' })).toBeVisible()
    await expect(page.getByText('Answers come at the end')).toBeVisible()

    for (let n = 1; n <= 3; n += 1) {
      // The confidence is one folded line, optional, and never in the way: an answer alone goes on.
      if (n === 1) {
        const row = page.locator('[data-confidence-row]')
        await expect(row.getByRole('button', { name: 'How sure are you? (optional)' })).toBeVisible()
        await expect(page.getByText('Tap one to go on')).toHaveCount(0)
      }
      await page.getByRole('radio').nth(n === 1 ? 0 : 1).click()
      const next = page.getByRole('button', { name: n === 3 ? 'See answers' : 'Next question' })
      await expect(next).toBeEnabled()
      await next.click()
      if (n < 3) await expect(page.getByRole('heading', { name: `Warm-up question ${n + 1} of 3` })).toBeVisible()
    }

    // The results: a short headline, the way on first, then one line per question (the misses first), each opening its answer.
    const done = page.getByRole('heading', { name: 'Ready to read' })
    await expect(done).toBeVisible()
    const start = page.getByRole('link', { name: 'Start reading' })
    const firstRow = page.locator('section[aria-labelledby="warmup-done-heading"] ol > li').first()
    await expect(start).toBeVisible()
    expect((await start.boundingBox())!.y).toBeLessThan((await firstRow.boundingBox())!.y)
    await expect(page.getByText(/idea.? to focus on|answered every question right/)).toBeVisible()
    await expect(firstRow.locator('details')).not.toHaveAttribute('open', '')
    await firstRow.locator('summary').click()
    await expect(firstRow.getByText('Your answer')).toBeVisible()
    await expectNoSidewaysScroll(page, page.url())
    await screenshotIfAsked(page, 'r4w2-warmup-results-390x844')

    // Nothing was rated: the evidence carries no confidence.
    await withPrisma(async (prisma) => {
      const events = await prisma.evidenceEvent.findMany({ where: { source: 'warmup' } })
      expect(events.length).toBeGreaterThan(0)
      expect(events.some((event) => event.confidence === null)).toBeTruthy()
    })
  })
})

test.describe('the reading', () => {
  test('has one note above it, and closing it is remembered on the account', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(PHONE)
    const { topicUrl, email } = await recallWorld(page, 'r4w2-read', { readAt: false })
    await page.goto(`${topicUrl}?view=read`)
    await streamedPartsArrived(page)
    const note = page.getByTestId('reader-note')
    await expect(note).toBeVisible()
    await expect(note).toContainText('Text from a PDF can lose its layout and maths')
    // The reading itself starts in the first screen.
    const passage = await page.locator('[data-passage]').first().boundingBox()
    expect(passage!.y).toBeLessThan(PHONE.height)

    await screenshotIfAsked(page, 'r4w2-read-390x844')
    await note.getByRole('button', { name: 'Close this note' }).click()
    await expect(note).toHaveCount(0)
    await expect.poll(() => withPrisma(async (prisma) => (await prisma.user.findUniqueOrThrow({ where: { email } })).seenReaderNoteAt !== null)).toBeTruthy()
    await page.reload()
    await streamedPartsArrived(page)
    await expect(page.getByTestId('reader-note')).toHaveCount(0)
  })
})

test.describe('recall', () => {
  test('asks first and scores later; once graded it is "Recall feedback" with the student\'s words, a result line and one way on', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(PHONE)
    const { topicUrl, topicId } = await recallWorld(page, 'r4w2-recall', { readAt: true })
    await page.goto(`${topicUrl}?view=recall`)

    // Before grading: the instruction is one sentence, the scoring text is behind a button, and skipping is a quiet link.
    await expect(page.getByRole('heading', { name: 'Close the book and say what you remember' })).toBeVisible()
    const scored = page.getByRole('button', { name: 'How this is scored' })
    await expect(scored).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('The reading stays closed while you answer.')).toBeHidden()
    await scored.click()
    await expect(page.getByText('The reading stays closed while you answer.')).toBeVisible()
    const skip = page.getByRole('link', { name: 'Skip recall for now' })
    await expect(skip).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check my answer' })).toBeVisible()

    // Grade every prompt through the API (the mock grader leaves gaps), then read the page again.
    const answer = 'A hash table sends each key to a bucket and keeps a list in the bucket when two keys land together, which is how it avoids losing a key.'
    for (const body of [{ objectiveIndex: 0 }, { objectiveIndex: 1 }, {}]) {
      const graded = await page.request.post(`/api/topics/${topicId}/recall`, { data: { kind: 'recall', answer, ...body } })
      expect(graded.ok()).toBeTruthy()
    }
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Recall feedback' })).toBeVisible()
    await expect(page.getByTestId('recall-submitted').first()).toContainText('A hash table sends each key to a bucket')
    await expect(page.getByTestId('recall-result-line').first()).toHaveText(/You covered \d+ of \d+ ideas?\.|You covered every idea/)
    // One way on: the explanation of the gaps, with the next step as the plain choice beside it, and the skip link gone.
    await expect(page.getByRole('link', { name: 'Read the explanation of your gaps' })).toBeVisible()
    await expect(page.getByTestId('recall-skip-explainer')).toHaveText('Continue to Practice')
    await screenshotIfAsked(page, 'r4w2-recall-graded-390x844')
    await expect(page.getByRole('link', { name: 'Skip recall for now' })).toHaveCount(0)

    // The path and the button name the same thing: Practice is tagged next (the explanation leads back to it), and the explainer
    // page does not repeat "Next: Read the explanation" above itself.
    await page.getByRole('link', { name: 'Read the explanation of your gaps' }).click()
    await expect(page).toHaveURL(/view=explainer/)
    await expect(page.getByRole('region', { name: 'Next on this topic' })).toHaveCount(0)
  })
})

test.describe('practice and the quiz', () => {
  test('a miss leaves one primary and the hint under it, the hint button does not talk about scoring, and the last problem goes on to the quiz', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(PHONE)
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, 'r4w2-practice', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `R4 W2 practice ${Date.now()}`, [{ name: 'Graphs' }])
    const topicId = course.topics.Graphs
    const problem = practiceProblem('Squares')
    const hinted = { ...problem, steps: problem.steps.map((step) => ({ ...step, hints: ['Look at the number.', 'Squaring is repeated product.', 'n times n.'] })) }
    await addContent(topicId, { section_notes: '# Notes\n\nSome notes.', interactive_examples: [hinted] })
    await addQuizSet(topicId, quizQuestions(4))
    const base = `/courses/${course.courseId}/topics/${topicId}`

    await page.goto(`${base}?view=practice`)
    await streamedPartsArrived(page)
    await expect(page.getByRole('heading', { level: 2, name: /Squares/ })).toBeVisible()
    // "More practice" is on the page once.
    await expect(page.getByRole('button', { name: 'More practice' })).toHaveCount(1)

    // A miss: one primary (Try again) with the first hint directly under it, worded as an action, with the cost on request.
    await page.getByRole('textbox', { name: 'Your answer' }).fill('5')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    const retry = page.getByRole('button', { name: 'Try again' })
    const hint = page.getByRole('button', { name: /Show where to look/ })
    await expect(retry).toBeVisible()
    await expect(hint).toBeVisible()
    expect((await hint.boundingBox())!.y).toBeGreaterThan((await retry.boundingBox())!.y)
    await expect(hint).not.toContainText(/harder one|count/i)
    await expect(page.getByText(/Opening this hint/)).toBeHidden()
    await screenshotIfAsked(page, 'r4w2-practice-miss-390x844')
    await page.getByRole('button', { name: 'How hints count' }).click()
    await expect(page.getByText(/Opening this hint: /)).toBeVisible()
    await retry.click()

    // Finish both steps; the problem ends in the quiz, not only in "Start over".
    await page.getByRole('textbox', { name: 'Your answer' }).fill('4')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await page.getByRole('button', { name: 'Next step' }).click()
    await page.getByRole('textbox', { name: 'Your answer' }).fill('9')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await page.getByRole('button', { name: 'Finish' }).click()
    await expect(page.getByText('Problem complete')).toBeVisible()
    await screenshotIfAsked(page, 'r4w2-practice-done-390x844')
    const toQuiz = page.getByTestId('practice-to-quiz')
    await expect(toQuiz).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start over' })).toBeVisible()
    await toQuiz.click()
    await expect(page).toHaveURL(/view=quiz/)
    await expect(page.getByRole('button', { name: 'Start quiz' })).toBeVisible()
    // The guess is an optional extra after the way in.
    await expect(page.getByRole('button', { name: 'Guess your score (optional)' })).toBeVisible()
    await expect(page.getByLabel('Expected questions correct (optional)')).toBeHidden()
  })

  test('a quiz can be finished from any question, and its dialog says Keep working', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(PHONE)
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, 'r4w2-quiz', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `R4 W2 quiz ${Date.now()}`, [{ name: 'Graphs' }])
    const topicId = course.topics.Graphs
    await addContent(topicId, { section_notes: '# Notes\n\nSome notes.' })
    await addQuizSet(topicId, quizQuestions(4))
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=quiz`)
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await expect(page.getByRole('heading', { name: 'Question 1 of 4' })).toBeVisible()

    // On a phone it is in the Questions sheet; on question 1 of 4, with nothing answered, the dialog names the cost.
    await page.getByRole('button', { name: 'Questions', exact: true }).click()
    await page.getByRole('button', { name: 'Finish and submit' }).click()
    const dialog = page.getByRole('dialog', { name: 'Submit your quiz?' })
    await expect(dialog).toContainText('4 unanswered. They\'ll be marked wrong.')
    await screenshotIfAsked(page, 'r4w2-quiz-submit-390x844')
    await dialog.getByRole('button', { name: 'Keep working' }).click()
    await expect(page.getByRole('heading', { name: 'Question 1 of 4' })).toBeVisible()

    // A wide screen has it in the toolbar on every question but the last.
    await page.setViewportSize(DESKTOP)
    await expect(page.getByTestId('finish-and-submit')).toBeVisible()
  })
})

test.describe('the explainer', () => {
  test('the locked explainer gives one instruction', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize(PHONE)
    const { topicUrl } = await recallWorld(page, 'r4w2-gate', { readAt: false })
    await page.goto(`${topicUrl}?view=explainer`)
    await expect(page.getByRole('heading', { name: 'Try Recall to get an explanation of your gaps' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Start recall' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Read the topic first' })).toBeVisible()
    await expect(page.getByText('Finishing the reading also opens the explanation.').first()).toBeVisible()
  })
})
