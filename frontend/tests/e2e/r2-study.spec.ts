import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { addContent, addQuizSet, createCourse, quizQuestions, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { streamedPartsArrived } from './helpers/settle'
import { seedTutorReading } from './helpers/v31-tutors'

// The study screens after the second design review (round 2, workstream S): the Topics list in words, the margin that offers
// help on request, the quiz as a focus view with one way to a new set, the tracks that can be seen.
// Set SCREENS_DIR to keep screenshots at both sizes.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

async function world(page: Page, label: string) {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, label, { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  return email
}

const opacityOf = (locator: ReturnType<Page['locator']>) => locator.evaluate((el) => Number(getComputedStyle(el.parentElement as HTMLElement).opacity))

test.describe('the Topics list', () => {
  test('says where each topic stands in words; a unit nobody has touched is Not started, not Learning 0%', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize(DESKTOP)
    await world(page, 'r2-topics')
    const course = await createCourse(page, `Topics ${Date.now()}`, [{ name: 'Sorting', unit: 'Unit one' }, { name: 'Hashing', unit: 'Unit one' }, { name: 'Loose topic' }])
    await page.goto(`/courses/${course.courseId}/topics`)
    const group = page.getByRole('region', { name: 'Unit one' })
    await expect(group).toContainText('Not started')
    await expect(group).not.toContainText('Learning')
    // Topics with no unit are named as such, not a bare "Topics" under a list of Topics.
    await expect(page.getByRole('heading', { level: 2, name: 'Not in a unit' })).toBeVisible()
    // The row is words and a bar with an edge, not a strip of icons that needed a hover.
    const row = page.getByRole('link', { name: /Sorting/ })
    // One recommended move and one status at rest; the steps done, quiz score and mastery are one tap away in the row's details.
    await expect(row).toContainText('Next:')
    await expect(row).toContainText('Not started')
    await expect(row).not.toContainText(/steps done/)
    await expect(row.getByRole('img')).toHaveCount(0)
    await page.getByRole('button', { name: 'Show details: Sorting' }).click()
    await expect(page.getByText(/0 of \d steps done/).first()).toBeVisible()
    await page.getByRole('button', { name: 'Hide details: Sorting' }).click()
    await screenshotIfAsked(page, 'r2-topics-list-1440x900')
    await expectNoAxeViolations(page, 'topics list, 1440')
    await page.setViewportSize(PHONE)
    await screenshotIfAsked(page, 'r2-topics-list-390x844')
    await expectNoAxeViolations(page, 'topics list, 390')
  })
})

test.describe('the reader margin', () => {
  test('Add a note and Explain this passage show on hover or focus; on a phone one Margin notes button opens them', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize(DESKTOP)
    const email = await world(page, 'r2-margin')
    void email
    const course = await createCourse(page, `Margin ${Date.now()}`, [{ name: 'Hash tables' }])
    const topicId = course.topics['Hash tables']
    await seedTutorReading(topicId)
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=read`)
    await streamedPartsArrived(page)
    const passage = page.locator('[data-passage]').nth(1)
    const add = passage.getByRole('button', { name: /Add a note on passage 2/ })
    const explain = passage.getByRole('button', { name: /Explain this passage: passage 2/ })
    // Reading first: at rest nothing sits in the margin.
    await page.mouse.move(2, 2)
    expect(await opacityOf(add)).toBe(0)
    expect(await opacityOf(explain)).toBe(0)
    // Hover shows both, and so does keyboard focus on either (they stay in the tab order).
    await passage.hover()
    await expect.poll(() => opacityOf(add)).toBe(1)
    await page.mouse.move(2, 2)
    await expect.poll(() => opacityOf(add)).toBe(0)
    await explain.focus()
    await expect.poll(() => opacityOf(add)).toBe(1)
    await screenshotIfAsked(page, 'r2-read-margin-1440x900')

    // The PDF caveat is said once and can be put away for good.
    const note = page.getByTestId('reader-pdf-note')
    if ((await note.count()) > 0) {
      await note.getByRole('button', { name: 'Got it' }).click()
      await expect(note).toHaveCount(0)
      await page.reload()
      await streamedPartsArrived(page)
      await expect(page.getByTestId('reader-pdf-note')).toHaveCount(0)
    }

    await page.setViewportSize(PHONE)
    const toggle = page.locator('[data-passage]').nth(1).getByRole('button', { name: 'Margin notes' })
    await expect(toggle).toBeVisible()
    await expect(page.locator('[data-passage]').nth(1).getByRole('button', { name: /Add a note on passage 2/ })).toBeHidden()
    await toggle.click()
    await expect(page.locator('[data-passage]').nth(1).getByRole('button', { name: /Add a note on passage 2/ })).toBeVisible()
    await screenshotIfAsked(page, 'r2-read-margin-390x844')
  })
})

test.describe('the quiz', () => {
  test('is a focus view while it is taken, has one way to a new set once taken, and a 50% quiz is not a green check', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(DESKTOP)
    await world(page, 'r2-quiz')
    const course = await createCourse(page, `Quiz ${Date.now()}`, [{ name: 'Graphs' }, { name: 'Trees' }])
    const topicId = course.topics.Graphs
    await addContent(topicId, { section_notes: '# Notes\n\nSome notes.' })
    await addQuizSet(topicId, quizQuestions(4))
    const url = `/courses/${course.courseId}/topics/${topicId}?view=quiz`
    await page.goto(url)

    // The lobby of a set not taken: Start quiz is the filled button, and a new set is the quiet "New quiz set".
    await expect(page.getByRole('button', { name: 'Start quiz' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New quiz set' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New questions' })).toHaveCount(0)
    await expect(page.getByText('Guess your score to compare it with your result (optional)')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Tools' })).toBeVisible()

    await page.getByRole('button', { name: 'Start quiz' }).click()
    await expect(page.getByRole('heading', { name: 'Question 1 of 4' })).toBeVisible()
    // Ask, the tools and the topic arrows are put away, as in the mock exam.
    await expect(page.getByRole('button', { name: 'Ask about this' })).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Tools' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^(Previous|Next): / })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'More actions' })).toHaveCount(0)
    // The bracket keys do not leave the quiz either.
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press(']')
    await expect(page).toHaveURL(url)
    // The track of the questions answered has an edge you can see before the first answer.
    const track = page.getByRole('progressbar', { name: 'Questions answered' })
    expect(await track.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px')
    await screenshotIfAsked(page, 'r2-quiz-taking-1440x900')
    // The controls are in the first screenful at 1440x900.
    const next = await page.getByRole('button', { name: 'Next', exact: true }).boundingBox()
    expect(next!.y + next!.height, 'Previous / Exit / Next are inside the first screen').toBeLessThanOrEqual(DESKTOP.height)

    // Half right: True, True, False, False.
    for (const [index, value] of ['True', 'True', 'False', 'False'].entries()) {
      await page.getByRole('radio', { name: value, exact: true }).click()
      if (index < 3) await page.getByRole('button', { name: 'Next', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Submit quiz' }).click()
    await expect(page.getByRole('heading', { name: /points/ })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('quiz-counts')).toContainText('2 of 4 questions right')
    // The tools are back, and the path does not give a done-well check to a half score.
    await expect(page.getByRole('group', { name: 'Tools' })).toBeVisible()
    const quizStep = page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Quiz/ })
    await expect(quizStep.getByRole('img', { name: 'Taken, 50%' })).toBeVisible()
    await expect(quizStep.getByRole('img', { name: 'Completed' })).toHaveCount(0)
    // One next signal: the results' own buttons, no "Next" line above them.
    await expect(page.getByRole('region', { name: 'Next on this topic' })).toHaveCount(0)
    await screenshotIfAsked(page, 'r2-quiz-results-1440x900')

    // Back in the lobby the attempted set has a visible state, and one way to a new set.
    await page.getByRole('button', { name: 'Back to quiz' }).click()
    const retake = page.getByRole('button', { name: 'Retake tomorrow' })
    await expect(retake).toBeDisabled()
    await expect(retake).toHaveAccessibleDescription(/same questions open tomorrow/)
    await expect(page.getByRole('button', { name: 'New questions' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New quiz set' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start quiz' })).toHaveCount(0)
    await screenshotIfAsked(page, 'r2-quiz-lobby-retake-1440x900')
    await expectNoAxeViolations(page, 'quiz lobby after an attempt, 1440')
    await page.setViewportSize(PHONE)
    await screenshotIfAsked(page, 'r2-quiz-lobby-retake-390x844')
    await expectNoAxeViolations(page, 'quiz lobby after an attempt, 390')
  })
})

test.describe('one next signal', () => {
  test('a tool carries the line; the steps carry the tag and no line; the tools label is gone', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize(DESKTOP)
    await world(page, 'r2-signal')
    const course = await createCourse(page, `Signal ${Date.now()}`, [{ name: 'Graphs' }])
    const topicId = course.topics.Graphs
    await addContent(topicId, { section_notes: '# Notes\n\nSome notes.', topic_quiz: quizQuestions(3), solved_examples: [] })
    const base = `/courses/${course.courseId}/topics/${topicId}`
    const path = page.getByRole('navigation', { name: 'Topic path' })
    // A step has its own action: the tag in the path is the only next signal.
    await page.goto(`${base}?view=quiz`)
    await expect(page.getByRole('region', { name: 'Next on this topic' })).toHaveCount(0)
    await expect(path.getByText('(next up)')).toHaveCount(1)
    // The words "Tools" are not drawn beside the links (a label that looks like a menu).
    await expect(path.getByRole('group', { name: 'Tools' })).toBeVisible()
    await expect(path.getByText('Tools', { exact: true })).toHaveCount(0)
    // Step numbers are at least 12px.
    const size = await path.locator('a span[aria-hidden="true"]').filter({ hasText: /^\d$/ }).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(size).toBeGreaterThanOrEqual(12)
    await screenshotIfAsked(page, 'r2-path-1440x900')
    await page.setViewportSize(PHONE)
    await screenshotIfAsked(page, 'r2-path-390x844')
    await expectNoAxeViolations(page, 'topic path, 390')
  })
})
