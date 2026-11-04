import { expect, test, type Page } from '@playwright/test'
import { animationsSettled } from './helpers/settle'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { markAiAvailable, markAiUnavailable, withPrisma } from './helpers/db'
import { addContent, createCourse, practiceProblem, quizQuestions, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// The topic's "Next" card (spec §8.1) steps aside while the student is in the middle of an activity and is
// back, with the refreshed next activity, once it is done; and the quiz results and the topic header say the
// same thing about the next review and show one mastery figure.

test.use({ timezoneId: ZONE })

const SIZES = [
  ['1440x900', { width: 1440, height: 900 }],
  ['390x844', { width: 390, height: 844 }],
] as const

/** Pixels under the top bar where the content starts on a phone with both cards showing. */
const CONTENT_START_WITH_CARDS = 265

const card = (page: Page) => page.getByRole('region', { name: 'Next on this topic' })

async function markRead(email: string, topicId: string) {
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const data = { readAt: new Date(Date.now() - 3_600_000) }
    await prisma.topicProgress.upsert({ where: { topicId_userId: { topicId, userId: user.id } }, create: { topicId, userId: user.id, ...data }, update: data })
  })
}

test('the next card waits while a quiz is taken and comes back with the refreshed next activity', async ({ page }) => {
  test.setTimeout(180_000)
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'next-card', { own: true })
  const course = await createCourse(page, `Next card ${Date.now()}`, [{ name: 'Unread topic' }, { name: 'Read topic' }])
  const unread = course.topics['Unread topic']
  const read = course.topics['Read topic']
  for (const id of [unread, read]) await addContent(id, { section_notes: '# Notes\n\nSome notes to read.', topic_quiz: quizQuestions(3) })
  await markRead(email, read)
  const url = (id: string) => `/courses/${course.courseId}/topics/${id}?view=quiz`

  // A topic not read yet: reading is next, but the student chose the quiz and has not taken it, so the quiz lobby has no card ...
  await page.setViewportSize(SIZES[0][1])
  await page.goto(url(unread))
  await expect(card(page)).toHaveCount(0)
  // ... steps aside as soon as the quiz is being taken ...
  await page.getByRole('button', { name: 'Start quiz' }).click()
  await expect(page.getByText('Question 1 of')).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  await screenshotIfAsked(page, 'next-card-quiz-taking-1440x900')
  await page.getByRole('radio', { name: 'False' }).click()
  await page.getByRole('radio', { name: 'Certain' }).click()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(card(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Question 3', exact: false }).first().click()
  await page.getByRole('button', { name: 'Submit quiz' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Submit quiz' }).click()
  // ... and is back once the results are in (the quiz is finished), still saying to read (nothing about the quiz changes that).
  await expect(page.getByRole('heading', { name: /points/ })).toBeVisible({ timeout: 60_000 })
  await expect(card(page)).toContainText('Read the topic next.')
  await expect(card(page).getByRole('link', { name: 'Start reading' })).toBeVisible()

  // A topic that is read: the student chose the quiz and has not taken it, so there is no card on it, and after the quiz the
  // card names the new next activity (practice), read again from the server.
  await page.goto(url(read))
  await expect(page.getByRole('button', { name: 'Start quiz' })).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Start quiz' }).click()
  await expect(page.getByText('Question 1 of')).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  await page.getByRole('radio', { name: 'False' }).click()
  await page.getByRole('radio', { name: 'Certain' }).click()
  await page.getByRole('button', { name: 'Question 3', exact: false }).first().click()
  await page.getByRole('button', { name: 'Submit quiz' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Submit quiz' }).click()
  await expect(page.getByRole('heading', { name: /points/ })).toBeVisible({ timeout: 60_000 })
  await expect(card(page)).toContainText('Practise to keep it fresh.')
  await expect(card(page).getByRole('link', { name: 'Practise' })).toHaveAttribute('href', /view=practice/)
  await screenshotIfAsked(page, 'next-card-quiz-results-1440x900')

  // The results and the header agree: one review date in the same words, and one mastery figure.
  const results = page.locator('[data-tab-panel]')
  const header = page.locator('main header')
  await expect(results.getByText(/Next review/)).toHaveCount(1)
  const said = ((await results.getByText(/Next review/).textContent()) ?? '').match(/Next review [A-Za-z0-9 ]+?(?=\.|$)/)?.[0]
  expect(said).toBeTruthy()
  await expect(header.getByText(said!)).toBeVisible()
  await expect(results.getByText(/Mastery is/)).toHaveCount(0)
  await expect(header.getByText(/Learning \d+%|Getting there \d+%|Strong \d+%/)).toHaveCount(1)
  // The header shows the best score; the results do not repeat it when it is this attempt's own.
  await expect(header.getByText(/Best quiz \d+%/)).toBeVisible()
  await expect(results.getByText(/Your best is/)).toHaveCount(0)

  // Rating how sure they felt moves the review date: the line and the header move together.
  // The same four words as each question had, not a second 1 to 5 scale.
  const sure = results.getByRole('radiogroup', { name: 'How sure were you overall?' })
  await expect(sure.getByRole('radio')).toHaveText(['Guessing', 'Unsure', 'Fairly sure', 'Certain'])
  await expect(results.getByRole('button', { name: /^[1-5], / })).toHaveCount(0)
  // On a phone the score line keeps room for its words: the heading is not squeezed into a narrow column by the buttons beside it.
  for (const [name, size] of SIZES) {
    await page.setViewportSize(size)
    expect((await results.getByRole('heading', { name: /points/ }).boundingBox())!.width, `score heading width, ${name}`).toBeGreaterThanOrEqual(150)
  }
  await page.setViewportSize(SIZES[0][1])
  await results.getByRole('radio', { name: 'Guessing' }).click()
  await expect(results.getByText('Next review tomorrow').first()).toBeVisible()
  await expect(header.getByText('Next review tomorrow')).toBeVisible()
  await screenshotIfAsked(page, 'next-card-quiz-results-rated-1440x900')

  for (const [name, size] of SIZES) {
    await page.setViewportSize(size)
    await expectNoAxeViolations(page, `quiz results with the next card, ${name}`)
  }
  // On a phone, with both cards on the screen (the one-time card is one line after its first view, the next card
  // one line with its reason behind "Why"), the results start close under the top bar.
  await page.setViewportSize(SIZES[1][1])
  // The card closed itself when the quiz began (the student was answering); put it back to look at the two cards together.
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: null } }))
  await page.evaluate(() => window.sessionStorage.clear())
  await page.reload()
  await expect(page.getByRole('heading', { name: /points|Quiz/ }).first()).toBeVisible()
  await animationsSettled(page)
  await page.evaluate(() => window.scrollTo(0, 0))
  const intro = page.getByRole('region', { name: /Margins asks you to try before it helps/ })
  await expect(intro).toBeVisible()
  await expect(intro.getByText('It will feel slower than reading a summary.')).toBeHidden()
  await expect(intro.getByRole('button', { name: 'Show more' })).toBeVisible()
  // The fold button is a 44px target at phone width.
  const caret = (await intro.getByRole('button', { name: 'Show more' }).boundingBox())!
  expect(Math.min(caret.width, caret.height), 'the fold button is at least 44px').toBeGreaterThanOrEqual(44)
  await expect(card(page)).toBeVisible()
  await expect(card(page).getByText('Practise to keep it fresh.')).toBeHidden()
  await screenshotIfAsked(page, 'next-card-both-cards-390x844')
  const lobbyTop = (await page.locator('[data-tab-panel]').boundingBox())!.y
  const topbar = (await page.locator('header').first().boundingBox())!
  expect(lobbyTop - (topbar.y + topbar.height), `the content starts ${lobbyTop}px down`).toBeLessThan(CONTENT_START_WITH_CARDS)
  await card(page).getByRole('button', { name: 'Why' }).click()
  await expect(card(page).getByText('Practise to keep it fresh.')).toBeVisible()
  await intro.getByRole('button', { name: 'Show more' }).click()
  await expect(intro.getByText('It will feel slower than reading a summary.')).toBeVisible()
  await expectNoAxeViolations(page, 'both cards open, 390')
  await screenshotIfAsked(page, 'next-card-both-cards-open-390x844')
})


test('in practice the next card stays away from the first check until every problem is done, instead of coming back at each new problem', async ({ page }) => {
  test.setTimeout(120_000)
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'next-card-practice', { own: true })
  const course = await createCourse(page, `Practice card ${Date.now()}`, [{ name: 'Squares' }])
  const topic = course.topics.Squares
  await addContent(topic, { section_notes: '# Notes\n\nSome notes.', topic_quiz: quizQuestions(3), interactive_examples: [practiceProblem('First'), practiceProblem('Second')] })
  await markRead(email, topic)
  await page.setViewportSize(SIZES[0][1])
  await page.goto(`/courses/${course.courseId}/topics/${topic}?view=practice`)
  const answerBox = page.getByLabel('Your answer').locator('visible=true')
  const check = page.getByRole('button', { name: 'Check', exact: true })
  // Nothing begun: practice is the next step and is where the student is, so there is no card.
  await expect(card(page)).toHaveCount(0)
  await answerBox.fill('4')
  await check.click()
  await expect(page.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByText('What is 3 squared?').locator('visible=true')).toBeVisible()
  await answerBox.fill('9')
  await check.click()
  // The last step is solved: Finish ends the problem, and its "Problem complete" card offers the next one. The card stays away (it came back here before).
  await page.getByRole('button', { name: 'Finish', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Problem complete' })).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  await page.getByRole('status').filter({ hasText: 'Problem complete' }).getByRole('button', { name: 'Next problem' }).click()
  // The second problem has not begun: the card stays away there too.
  await expect(page.getByRole('heading', { name: /^Problem 2 of 2/ })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Problems' }).getByRole('button', { name: 'Problem 2' })).toHaveAttribute('aria-current', 'true')
  await expect(card(page)).toHaveCount(0)
})

/** One concept of the topic with a claim on page 5, and the topic read and recalled; optionally the concept's last retrieval failed. */
async function seedConceptTopic(email: string, topicId: string, options: { failed?: boolean; recalled?: boolean } = {}) {
  return withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { projectId: true } })
    const material = await prisma.material.findFirstOrThrow({ where: { projectId: topic.projectId }, select: { id: true } })
    const concept = await prisma.concept.create({ data: { projectId: topic.projectId, topicId, name: 'Collision', summary: 'Collision.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] } })
    await prisma.conceptClaim.create({ data: { conceptId: concept.id, text: 'Two keys can land in one bucket.', quote: 'Two keys.', materialId: material.id, chunkId: 'chunk-5', orderIndex: 0, pageStart: 5 } })
    await prisma.topic.update({ where: { id: topicId }, data: { evidenceBackfilledAt: new Date() } })
    const at = new Date(Date.now() - 3_600_000)
    await prisma.topicProgress.upsert({
      where: { topicId_userId: { topicId, userId: user.id } },
      create: { topicId, userId: user.id, warmupAt: at, readAt: at, ...(options.recalled === false ? {} : { recallAt: at }) },
      update: { warmupAt: at, readAt: at, ...(options.recalled === false ? {} : { recallAt: at }) },
    })
    if (options.failed) {
      // A 0-of-N drill: the group was graded Again an hour ago and nothing has been shown since.
      const card = { due: new Date(Date.now() + 86_400_000).toISOString(), stability: 1, difficulty: 7, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, learning_steps: 0, state: 1, last_review: at.toISOString() }
      await prisma.evidenceEvent.create({
        data: { userId: user.id, projectId: topic.projectId, topicId, conceptId: concept.id, itemKey: 'drill:s:0', source: 'drill', score: 0, assistance: 0, weight: 1, role: 'primary', gradedBy: 'rule', sessionKey: 'drill:s', createdAt: at },
      })
      await prisma.conceptMemory.create({
        data: {
          userId: user.id, projectId: topic.projectId, topicId, conceptId: concept.id, card, dueAt: new Date(card.due), stability: 1, lastReviewAt: at, nUnassisted: 1, lastEvidenceAt: at,
          consecutiveFails: 1, mastery: 0, label: 'shaky',
          derived: { firstEvidenceDay: at.toISOString().slice(0, 10), itemKeysSeen: ['drill:s:0'], delayedNewSuccess: false, explainedWell: false, modeReached: 'recall', lastMaxRung: null, lastMissKind: 'cue_miss', lastFailAt: at.toISOString(), lastInstructionAt: null, lastIdkAt: null, latestGrade: 1, level0Scores: [{ score: 0, at: at.toISOString() }] },
        },
      })
    }
    return concept.id
  })
}

test('next card offers reading after a failed drill, and the reading ends the wait', async ({ page }) => {
  test.setTimeout(120_000)
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'next-card-instruct', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Instruct ${Date.now()}`, [{ name: 'Hash tables' }])
  const topic = course.topics['Hash tables']
  await addContent(topic, { section_notes: '# Notes\n\nSome notes to read.', interactive_examples: [practiceProblem('First')] })
  const conceptId = await seedConceptTopic(email, topic, { failed: true, recalled: false })
  await page.setViewportSize(SIZES[0][1])

  // Home, the overview and the plan say the same thing as the topic: one next activity (spec 8.1).
  const instruct = `/courses/${course.courseId}/topics/${topic}?view=read&focus=${conceptId}#chunk-chunk-5`
  const sentence = 'You missed Collision last time. Read p. 5 again before trying again.'
  await page.goto('/home')
  const home = page.getByRole('region', { name: /Up next/ })
  await expect(home.getByRole('link', { name: 'Read about it' })).toHaveAttribute('href', instruct)
  await expect(home).toContainText(sentence)
  await page.goto(`/courses/${course.courseId}`)
  const upNext = page.getByRole('region', { name: 'Up next' })
  await expect(upNext.getByRole('link', { name: 'Read about it' })).toHaveAttribute('href', instruct)
  await expect(upNext).toContainText(sentence)
  await page.goto(`/courses/${course.courseId}/plan`)
  const planRow = page.getByRole('listitem').filter({ has: page.locator(`a[href="${instruct}"]`) }).first()
  await expect(planRow).toContainText(sentence)

  // A bare topic address goes to the instruction, at the concept; not back to the drill or the review.
  await page.goto(`/courses/${course.courseId}/topics/${topic}?view=practice`)
  await expect(card(page)).toContainText('You missed Collision last time. Read p. 5 again before trying again.')
  await expect(card(page).getByRole('link', { name: 'Read about it' })).toHaveAttribute('href', `/courses/${course.courseId}/topics/${topic}?view=read&focus=${conceptId}#chunk-chunk-5`)
  await screenshotIfAsked(page, 'v31-next-card-instruct-1440x900')
  await page.goto(`/courses/${course.courseId}/topics/${topic}`)
  await expect(page).toHaveURL(new RegExp(`view=read&focus=${conceptId}`))

  // Opening the pointer is an instruction event, once, and moves no card.
  await withPrisma(async (prisma) => {
    const events = await prisma.evidenceEvent.findMany({ where: { conceptId, source: 'instruction' } })
    expect(events).toHaveLength(1)
    expect([events[0].assistance, events[0].weight, events[0].score, events[0].itemKey]).toEqual([3, 0, 0, `instruction:pointer:${conceptId}`])
  })
  await page.reload()
  await withPrisma(async (prisma) => expect(await prisma.evidenceEvent.count({ where: { conceptId, source: 'instruction' } })).toBe(1))

  // The fail has been followed by instruction: the card no longer says to read about it.
  await page.goto(`/courses/${course.courseId}/topics/${topic}?view=practice`)
  await expect(page.getByRole('region', { name: 'Next on this topic' }).getByText(/You missed/)).toHaveCount(0)
  await expectNoAxeViolations(page, 'next card after instruction, 1440')
  await page.setViewportSize(SIZES[1][1])
  await page.goto(`/courses/${course.courseId}/topics/${topic}?view=practice`)
  await expectNoAxeViolations(page, 'next card after instruction, 390')
})

test('with the AI down the next card skips recall and says so; reading still works', async ({ page }) => {
  test.setTimeout(120_000)
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'next-card-ai-down', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `AI down ${Date.now()}`, [{ name: 'Hash tables' }])
  const topic = course.topics['Hash tables']
  await addContent(topic, { section_notes: '# Notes\n\nSome notes to read.', topic_quiz: quizQuestions(3) })
  await seedConceptTopic(email, topic, { recalled: false })
  await page.setViewportSize(SIZES[0][1])
  try {
    // On a tool: the practice step, unfinished, would say nothing (the student chose it).
    await page.goto(`/courses/${course.courseId}/topics/${topic}?view=examples`)
    await expect(card(page)).toContainText('Close the book and say what you remember.')
    await expect(card(page).getByRole('link', { name: 'Start recall' })).toBeVisible()

    await markAiUnavailable()
    await page.reload()
    await expect(card(page)).toContainText('Recall needs the AI, which is down. This works without it.')
    await expect(card(page).getByRole('link', { name: 'Start recall' })).toHaveCount(0)
    await expect(card(page).getByRole('link', { name: 'Take quiz' })).toHaveAttribute('href', /view=quiz/)
    await screenshotIfAsked(page, 'v31-next-card-ai-down-1440x900')
    await expectNoAxeViolations(page, 'next card with the AI down')
  } finally {
    await markAiAvailable()
  }
})
