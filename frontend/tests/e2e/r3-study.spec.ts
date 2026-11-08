import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { addContent, addQuizSet, createCourse, practiceProblem, quizQuestions, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { expectNoSidewaysScroll } from './helpers/overflow'
import { streamedPartsArrived } from './helpers/settle'
import { recallWorld } from './helpers/v31-recall'

// The study screens after the third design review: while an attempt is open (a warm-up question, a recall answer, a practice
// problem, a quiz) a phone shows a small bar (the topic and Exit) in place of the topic header and the five-step path, so the task
// and its next action sit above the course bar. The lobbies and results keep the path. Wide screens keep the path throughout.
// Set SCREENS_DIR to keep screenshots; SCREENS_THEME=dark keeps the dark ones.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

async function theme(page: Page) {
  const dark = process.env.SCREENS_THEME === 'dark'
  await page.addInitScript((value) => {
    localStorage.setItem('theme', value)
    document.documentElement.classList.toggle('dark', value === 'dark')
  }, dark ? 'dark' : 'light')
}
// The path: one line on a phone (the button that opens the steps), the five tabs on a wide screen. Only the visible one counts.
const pathTabs = (page: Page) => page.locator('[data-testid="phone-path"], nav[aria-label="Topic path"]').locator('visible=true')
const attemptBar = (page: Page) => page.getByTestId('attempt-bar')

/** The action ends above the course bar without scrolling to it: it is in the first screen. */
async function expectAboveCourseBar(page: Page, action: Locator, label: string) {
  // The course bar gives way during an attempt (the shell hides it), so the action need only end inside the screen then.
  const tabs = page.getByRole('navigation', { name: 'Course tabs' })
  const bar = (await tabs.count()) > 0 ? await tabs.boundingBox() : null
  const box = await action.boundingBox()
  expect(box, `${label} is on screen`).not.toBeNull()
  expect(box!.y + box!.height, `${label} ends above the course bar`).toBeLessThanOrEqual(bar ? bar.y : (page.viewportSize()?.height ?? 844))
}
async function expectCompact(page: Page) {
  await expect(attemptBar(page)).toBeVisible()
  await expect(attemptBar(page).getByText('Exit')).toBeVisible()
  await expect(pathTabs(page)).toBeHidden()
}

test.describe('an attempt on a phone', () => {
  test('a warm-up question and a recall answer fit above the course bar, with the path put away; wide screens keep the path', async ({ page }) => {
    test.setTimeout(180_000)
    await theme(page)
    await page.setViewportSize(PHONE)
    const { topicUrl, course } = await recallWorld(page, 'r3-warmup', { warmup: true, readAt: false })
    await page.goto(`${topicUrl}?view=warmup`)

    // The lobby keeps the path and says the misses are fine.
    await expect(pathTabs(page)).toBeVisible()
    await expect(attemptBar(page)).toHaveCount(0)
    await expect(page.getByText('Try what you know; answers and page pointers come at the end').locator('visible=true')).toBeVisible()
    await screenshotIfAsked(page, 'r3-warmup-intro-390x844')
    await page.getByRole('button', { name: 'Start warm-up' }).click()

    await expect(page.getByRole('heading', { name: 'Warm-up question 1 of 3' })).toBeVisible()
    await expectCompact(page)
    // The question, how sure, and the way on are all in the first screen.
    await expectAboveCourseBar(page, page.getByRole('button', { name: "I don't know" }), "I don't know")
    await expectAboveCourseBar(page, page.getByRole('button', { name: 'Next question' }), 'Next question')
    await screenshotIfAsked(page, 'r3-warmup-question-390x844')
    await expectNoSidewaysScroll(page, page.url())

    // Wide screens keep the whole path.
    await page.setViewportSize(DESKTOP)
    await expect(pathTabs(page)).toBeVisible()
    await expect(attemptBar(page)).toBeHidden()
    await screenshotIfAsked(page, 'r3-warmup-question-1440x900')
    await page.setViewportSize(PHONE)

    // Exit leaves the attempt for the Topics list.
    await attemptBar(page).getByRole('link', { name: 'Exit' }).click()
    await expect(page).toHaveURL(new RegExp(`/courses/${course.courseId}/topics$`))

    // Recall: the prompt, the answer box and Check my answer are in the first screen.
    await page.goto(`${topicUrl}?view=recall`)
    await expect(page.getByRole('heading', { name: 'Close the book and say what you remember' })).toBeVisible()
    await expectCompact(page)
    await expectAboveCourseBar(page, page.getByRole('button', { name: 'Check my answer' }), 'Check my answer')
    await screenshotIfAsked(page, 'r3-recall-390x844')
  })

  test('a practice problem and a quiz are compact too; the quiz has one question picker and Exit asks before it leaves', async ({ page }) => {
    test.setTimeout(180_000)
    await theme(page)
    await page.setViewportSize(PHONE)
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, 'r3-practice', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `R3 attempts ${Date.now()}`, [{ name: 'Graphs' }, { name: 'Trees' }])
    const topicId = course.topics.Graphs
    await addContent(topicId, { section_notes: '# Notes\n\nSome notes.', interactive_examples: [practiceProblem('Squares')] })
    await addQuizSet(topicId, quizQuestions(4))
    const base = `/courses/${course.courseId}/topics/${topicId}`

    await page.goto(`${base}?view=practice`)
    await streamedPartsArrived(page)
    await expect(page.getByRole('heading', { level: 2, name: /Squares/ })).toBeVisible()
    await expectCompact(page)
    await expectAboveCourseBar(page, page.getByRole('button', { name: 'Check' }), 'Check')
    // Kind, time and source are one folded row.
    await expect(page.getByRole('button', { name: 'About this problem' })).toHaveAttribute('aria-expanded', 'false')
    await screenshotIfAsked(page, 'r3-practice-390x844')

    await page.goto(`${base}?view=quiz`)
    // The lobby keeps the path and offers the optional guess in words.
    await expect(pathTabs(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Guess your score (optional)' })).toBeVisible()
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await expect(page.getByRole('heading', { name: 'Question 1 of 4' })).toBeVisible()
    await expectCompact(page)
    // One navigator: the Questions button, not a row of chips beside it.
    await expect(page.getByRole('button', { name: 'Questions', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Question 1, / })).toBeHidden()
    await expectAboveCourseBar(page, page.getByRole('button', { name: 'Next' }), 'Next')
    await screenshotIfAsked(page, 'r3-quiz-390x844')
    await expectNoAxeViolations(page, 'quiz taking, 390')

    // Exit is the quiz's own question, not a silent leave.
    await attemptBar(page).getByRole('button', { name: 'Exit' }).click()
    await expect(page.getByRole('heading', { name: 'Leave this quiz?' })).toBeVisible()
    await page.getByRole('button', { name: 'Keep going' }).click()
    await expect(page.getByRole('heading', { name: 'Question 1 of 4' })).toBeVisible()

    // Wide screens: the row of numbers and the path.
    await page.setViewportSize(DESKTOP)
    await expect(page.getByRole('button', { name: /^Question 1, / })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Questions', exact: true })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Exit' })).toBeVisible()
    await screenshotIfAsked(page, 'r3-quiz-1440x900')
  })
})

test.describe('the study copy', () => {
  test('the explainer gate says where reading stands, the examples caption does not claim "fully worked"', async ({ page }) => {
    test.setTimeout(120_000)
    await theme(page)
    await page.setViewportSize(PHONE)
    const { topicUrl } = await recallWorld(page, 'r3-gate', { readAt: false })
    await page.goto(`${topicUrl}?view=explainer`)
    await expect(page.getByRole('heading', { name: 'Try Recall to get an explanation of your gaps' })).toBeVisible()
    await expect(page.getByText('Writing what you remember first is what makes an explanation stick.')).toBeVisible()
    await expect(page.getByText('Finishing the reading also opens the explanation.')).toBeVisible()
    const read = page.getByRole('link', { name: 'Read the topic first' })
    await expect(read).toHaveAttribute('href', /view=read/)
    // A standalone link is a 44px target on a phone.
    expect((await read.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await screenshotIfAsked(page, 'r3-explainer-gate-390x844')
  })
})

test.describe('the mock exam', () => {
  test('a new exam is one recommended preset; the settings, a name and the topics\' pages are explicit', async ({ page }) => {
    test.setTimeout(120_000)
    await theme(page)
    await page.setViewportSize(PHONE)
    await setZoneCookie(page.context())
    await signUpAndIn(page, 'r3-exam', { own: true })
    const course = await createCourse(page, `R3 exam ${Date.now()}`, [{ name: 'Graphs' }, { name: 'Trees' }])
    await page.goto(`/courses/${course.courseId}/exams/new`)
    await expect(page.getByTestId('exam-preset').locator('visible=true')).toContainText('20 questions, 1 hr, medium, balanced mix')
    // The five question counts, seven limits, difficulty and mix are behind one button.
    const settings = page.getByRole('button', { name: 'Change settings' })
    await expect(settings).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('radio', { name: '30 min', exact: true })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Create exam' })).toBeVisible()
    await screenshotIfAsked(page, 'r3-exam-new-390x844')
    await settings.click()
    await page.getByRole('radio', { name: '30 min', exact: true }).click()
    await expect(page.getByTestId('exam-preset').locator('visible=true')).toContainText('30 min')
    await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible()
    await screenshotIfAsked(page, 'r3-exam-new-settings-390x844')
    // A topic with no pages linked says so beside its name, before the exam is written.
    await expect(page.getByText('Add source pages to include.').first()).toBeVisible()
    await expectNoAxeViolations(page, 'new exam, 390')
  })
})
