import { openKeepStudying } from './helpers/review'
import { streamedPartsArrived } from './helpers/settle'
import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { addQuizSet, createCourse, seedDueConcept, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// The Review page's focus and progress (spec §10): the three ideas worth this week's time, unassisted
// accuracy by week, how often help was used, and calibration once there are 30 answers with a confidence.
// Nothing on it counts streaks, points or badges. Set SCREENS_DIR to keep screenshots at both sizes.

const DAY = 24 * 60 * 60 * 1000
const SIZES = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
]

test.use({ timezoneId: ZONE })

async function events(userEmail: string, conceptId: string, specs: { daysAgo: number; count: number; score: (n: number) => number; assistance?: number; confidence?: number }[]) {
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: userEmail }, select: { id: true } })
    const concept = await prisma.concept.findUniqueOrThrow({ where: { id: conceptId }, select: { projectId: true, topicId: true } })
    let serial = 0
    await prisma.evidenceEvent.createMany({
      data: specs.flatMap((spec) =>
        Array.from({ length: spec.count }, (_, n) => ({
          userId: user.id,
          projectId: concept.projectId,
          topicId: concept.topicId,
          conceptId,
          itemKey: `quiz:seed:${serial}`,
          source: 'quiz',
          score: spec.score(n),
          assistance: spec.assistance ?? 0,
          confidence: spec.confidence ?? null,
          weight: 1,
          role: 'primary',
          gradedBy: 'rule',
          sessionKey: `seed-${serial++}`,
          createdAt: new Date(Date.now() - spec.daysAgo * DAY + n * 1000),
        }))
      ),
    })
  })
}

const NOT_GAMIFIED = /streak|points?\b|badge|leaderboard|congrat|great job|well done|keep it up|% complete/i

async function look(page: Page, name: string) {
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height })
    await expect(page.getByRole('heading', { level: 2, name: 'Progress' })).toBeVisible()
    await expectNoAxeViolations(page, `review progress ${size.name}`)
    await screenshotIfAsked(page, `progress-${name}-${size.name}`)
  }
}

/**
 * Opens the review page and waits for its streamed parts to arrive: until then a hidden copy of each part waits in the
 * document, and a text locator finds both (a strict-mode violation) if it runs in between.
 */
async function openReview(page: Page, courseId: string) {
  await page.goto(`/courses/${courseId}/review`)
  await streamedPartsArrived(page)
  // With nothing due the extras (focus, progress) are behind "Keep studying".
  await openKeepStudying(page)
}

test.describe('review focus and progress', () => {
  test('a new course shows no focus and no calibration, and says what is missing', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'progress-empty')
    const course = await createCourse(page, 'Empty progress', [{ name: 'Hash tables' }])
    await openReview(page, course.courseId)

    await expect(page.getByRole('heading', { level: 2, name: 'Progress' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: "This week's focus" })).toHaveCount(0)
    await expect(page.getByText('This appears once a week has 10 first tries without help.')).toBeVisible()
    await expect(page.getByText('No answers yet this week.')).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: /How sure you were/ })).toHaveCount(0)
    await expect(page.locator('main')).not.toHaveText(NOT_GAMIFIED)
    await look(page, 'empty')
  })

  test('three focus ideas in order, weekly accuracy, help used and calibration', async ({ page, context }) => {
    test.setTimeout(120_000)
    await setZoneCookie(context)
    const user = await signUpAndIn(page, 'progress-full')
    const course = await createCourse(page, 'Progress course', [{ name: 'Hash tables' }])
    const topic = course.topics['Hash tables']

    // Four ideas: a live misconception, one failed twice running, one gone cold, and one fresh (left out).
    const mix = await seedDueConcept(user.email, topic, 'Collisions', { orderIndex: 0, daysAgo: 4, misconception: 'Thinks two keys can never share a slot' })
    const stuck = await seedDueConcept(user.email, topic, 'Load factor', { orderIndex: 1, daysAgo: 2 })
    const cold = await seedDueConcept(user.email, topic, 'Open addressing', { orderIndex: 2, daysAgo: 60 })
    await seedDueConcept(user.email, topic, 'Chaining', { orderIndex: 3, daysAgo: 1 })
    await withPrisma((prisma) => prisma.conceptMemory.updateMany({ where: { conceptId: stuck }, data: { consecutiveFails: 2 } }))

    // Two earlier weeks with enough answers to show, and this week with one answer that had a worked example.
    await events(user.email, mix, [
      { daysAgo: 14, count: 12, score: () => 0.5 },
      // 20 Certain (15 right), 10 Unsure (half marks), 6 Fairly sure (4 right).
      { daysAgo: 21, count: 20, score: (n) => (n < 15 ? 1 : 0), confidence: 0.95 },
      { daysAgo: 21, count: 10, score: () => 0.5, confidence: 0.5 },
      { daysAgo: 21, count: 6, score: (n) => (n < 4 ? 1 : 0), confidence: 0.75 },
      { daysAgo: 0, count: 4, score: () => 1 },
      { daysAgo: 0, count: 1, score: () => 0.5, assistance: 2 },
    ])

    await openReview(page, course.courseId)

    // Focus: misconception, then plateau, then the coldest; the fourth idea is not offered.
    const focus = page.getByRole('region', { name: "This week's focus" })
    const items = focus.getByRole('listitem')
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toContainText('Collisions')
    await expect(items.nth(0)).toContainText('specific mix-up')
    // Each card names its topic, and the first the mix-up itself, so no two cards read alike.
    await expect(items.nth(0)).toContainText('Hash tables')
    await expect(items.nth(0)).toContainText('Thinks two keys can never share a slot')
    await expect(items.nth(1)).toContainText('Hash tables')
    await expect(items.nth(1)).toContainText('Load factor')
    await expect(items.nth(1)).toContainText('Missed on your last two tries')
    await expect(items.nth(2)).toContainText('Open addressing')
    await expect(focus.getByText('Chaining')).toHaveCount(0)
    await expect(items.nth(0).getByRole('link', { name: /Practice this/ })).toHaveAttribute('href', `/courses/${course.courseId}/review/session?concept=${mix}`)
    await expect(items.nth(1).getByRole('link', { name: /Practice this/ })).toHaveAttribute('href', `/courses/${course.courseId}/review/session?concept=${stuck}`)
    await expect(items.nth(2).getByRole('link', { name: /Practice this/ })).toHaveAttribute('href', `/courses/${course.courseId}/review/session?concept=${cold}`)
    // The focus sits above everything else, and "Start today's review" stays the one filled button.
    const order = await page.locator('main h2').allTextContents()
    expect(order[0]).toBe("This week's focus")
    expect(order[order.length - 1]).toBe('Progress')

    // Accuracy by week: the numbers are in a table, the chart says the same in its label.
    const progress = page.getByRole('region', { name: 'Progress' })
    const weekly = progress.getByRole('table', { name: /Average score on first tries by week/ })
    await expect(weekly.getByRole('row')).toHaveCount(3) // header and two weeks
    await expect(weekly.getByRole('row').nth(1)).toContainText('12')
    await expect(weekly.getByRole('row').nth(1)).toContainText('50%')
    await expect(weekly.getByRole('row').nth(2)).toContainText('36')
    await expect(weekly.getByRole('row').nth(2)).toContainText('67%')
    await expect(progress.getByRole('img', { name: /^Average score on first tries, by week: week of .* 67%, week of .* 50%\.$/ })).toBeVisible()

    // Help used: 1 of this week's 5 answers.
    await expect(progress.getByText('Help used on 20% of answers this week.')).toBeVisible()

    // Calibration is ready at 36 answers: one sentence and the four levels.
    await expect(progress.getByText('When you are Certain, your average score is 75%.')).toBeVisible()
    const calibration = progress.getByRole('table', { name: /Average score at each level of confidence/ })
    await expect(calibration.getByRole('row')).toHaveCount(5)
    await expect(calibration.getByRole('row').nth(1)).toContainText('Guessing')
    await expect(calibration.getByRole('row').nth(1)).toContainText('no answers')
    await expect(calibration.getByRole('row').nth(2)).toContainText('50%')
    await expect(calibration.getByRole('row').nth(3)).toContainText('67%')
    await expect(calibration.getByRole('row').nth(4)).toContainText('75%')

    await expect(page.locator('main')).not.toHaveText(NOT_GAMIFIED)
    // On a phone the three compact cards leave "Start today's review" on the first screen, clear of the bottom bar.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => window.scrollTo(0, 0))
    const start = await page.getByRole('link', { name: "Start today's review" }).boundingBox()
    expect(start).not.toBeNull()
    expect(start!.y + start!.height).toBeLessThan(844 - 72)
    await look(page, 'full')
  })

  test('Practice this opens a drill on an idea that is not due', async ({ page, context }) => {
    test.setTimeout(120_000)
    await setZoneCookie(context)
    const user = await signUpAndIn(page, 'progress-drill')
    const course = await createCourse(page, 'Drill course', [{ name: 'Hash tables' }])
    const topic = course.topics['Hash tables']
    // Answered a day ago, so its next review is days away; the misconception still puts it in the focus.
    const mix = await seedDueConcept(user.email, topic, 'Collisions', { orderIndex: 0, daysAgo: 1, misconception: 'Thinks two keys can never share a slot' })
    await addQuizSet(
      topic,
      ['one', 'two', 'three', 'four'].map((word) => ({
        question_type: 'true_false',
        question_text: `Statement ${word} about collisions holds.`,
        correct_answer: true,
        explanation: 'It holds.',
        points: 1,
        difficulty: 'medium',
        mode: 'recall',
        concept_ids: [mix],
      }))
    )
    await openReview(page, course.courseId)
    await expect(page.getByRole('link', { name: "Start today's review" })).toHaveCount(0)
    await page.getByRole('link', { name: 'Practice this: Collisions' }).click()
    await expect(page).toHaveURL(new RegExp(`/review/session\\?concept=${mix}`))
    await expect(page.getByRole('heading', { level: 1, name: /^Question 1 of \d/ })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-session-context]').first()).toContainText('Collisions')
  })

  test('progress shows the early weeks line', async ({ page, context }) => {
    await setZoneCookie(context)
    const user = await signUpAndIn(page, 'progress-early')
    const course = await createCourse(page, 'Early weeks', [{ name: 'Hash tables' }])
    const concept = await seedDueConcept(user.email, course.topics['Hash tables'], 'Collisions', { daysAgo: 3 })
    // The first answers are this week: the first of the first four weeks.
    await events(user.email, concept, [{ daysAgo: 0, count: 3, score: () => 0 }])
    await openReview(page, course.courseId)
    const line = page.locator('#main').getByText('Early weeks are usually low; this measures first tries only.')
    await expect(line).toBeVisible()
    // In words under the heading, and it does not take the place of a figure.
    await expect(page.getByRole('region', { name: 'Progress' }).getByText('Only what you answered yourself counts here.')).toBeVisible()
    await look(page, 'early')
    // Said once a day, wherever it was shown: not again on the next visit in this tab.
    await openReview(page, course.courseId)
    await expect(line).toHaveCount(0)
  })

  test('the early weeks line goes once the first four weeks are over', async ({ page, context }) => {
    await setZoneCookie(context)
    const user = await signUpAndIn(page, 'progress-late')
    const course = await createCourse(page, 'Late weeks', [{ name: 'Hash tables' }])
    const concept = await seedDueConcept(user.email, course.topics['Hash tables'], 'Collisions', { daysAgo: 3 })
    await events(user.email, concept, [
      { daysAgo: 40, count: 2, score: () => 1 },
      { daysAgo: 0, count: 2, score: () => 1 },
    ])
    await openReview(page, course.courseId)
    await expect(page.getByRole('heading', { level: 2, name: 'Progress' })).toBeVisible()
    await expect(page.locator('#main').getByText('Early weeks are usually low')).toHaveCount(0)
  })

  test('calibration stays hidden under 30 answers', async ({ page, context }) => {
    await setZoneCookie(context)
    const user = await signUpAndIn(page, 'progress-few')
    const course = await createCourse(page, 'Few answers', [{ name: 'Hash tables' }])
    const concept = await seedDueConcept(user.email, course.topics['Hash tables'], 'Collisions', { daysAgo: 3 })
    await events(user.email, concept, [{ daysAgo: 0, count: 29, score: () => 1, confidence: 0.95 }])
    await openReview(page, course.courseId)
    await expect(page.locator('#main').getByText('No help used on 29 answers this week.')).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: /How sure you were/ })).toHaveCount(0)
    await expect(page.getByRole('table', { name: /confidence/ })).toHaveCount(0)
    await look(page, 'few')
  })
})
