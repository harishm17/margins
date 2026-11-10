import { expect, test, type Page } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { addContent, createCourse, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { streamedPartsArrived } from './helpers/settle'

// UX review fixes, workstream 1: bugs that lose work or break a flow (items 1, 2, 5, 6, 7 and 14 of the review).
test.use({ timezoneId: ZONE })

// ---------------------------------------------------------------------------------------------------------- 1. unsent text

test.describe('unsent text survives a reload', () => {
  test('worked examples: the prediction, the reveal and the grade come back', async ({ page }) => {
    // This is about the guess boxes of an example on screen together: the "See the steps" view (the default is "Try each step").
    await page.addInitScript(() => localStorage.setItem('margins.examplesStepMode', 'all'))
    await page.setViewportSize({ width: 1280, height: 900 })
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, 'ws1-examples', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Examples ${Date.now()}`, [{ name: 'Novice topic' }])
    const topicId = course.topics['Novice topic']
    const example = (title: string) => ({
      title,
      difficulty: 'medium',
      problem_statement: `Insert keys for ${title}.`,
      solution_steps: [1, 2, 3].map((n) => ({ step_number: n, description: `${title} step ${n}`, work: `Work ${title} ${n}.`, explanation: `Reason ${title} ${n}.` })),
      final_answer: `Answer ${title}.`,
      key_concepts: ['Chaining'],
    })
    await addContent(topicId, { solved_examples: [example('Alpha'), example('Beta')] })
    const url = `/courses/${course.courseId}/topics/${topicId}?view=examples`
    await page.goto(url)
    await streamedPartsArrived(page)

    const whys = page.getByRole('group', { name: 'Why this step? Write your guess' })
    await whys.nth(0).getByLabel('Your guess').fill('Because the bucket was taken.')
    await whys.nth(0).getByRole('button', { name: 'Show why' }).click()
    await page.getByRole('button', { name: 'Got it' }).click()
    await expect(page.getByRole('status').filter({ hasText: /(Saved|Noted, not counted): Got it/ })).toBeVisible()
    // A guess that was written and not yet revealed.
    await whys.first().getByLabel('Your guess').fill('Because of the load factor.')
    await expect(page.getByTestId('examples-draft-status')).toHaveText('Saved', { timeout: 15_000 })

    await page.reload()
    await streamedPartsArrived(page)
    await expect(page.getByText('Reason Alpha 1.')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('status').filter({ hasText: /(Saved|Noted, not counted): Got it/ })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Why this step? Write your guess' }).first().getByLabel('Your guess')).toHaveValue('Because of the load factor.')
  })
})

// ---------------------------------------------------------------------------------------------------------- 3. voice: Quiz me says before Start

test.describe('voice lobby: Quiz me', () => {
  const lobby = (page: Page) => page.getByTestId('voice-lobby')

  test('a quiz whose questions mention numbers is not treated as empty, and Quiz me can start', async ({ page }) => {
    const { email } = await signUpAndIn(page, 'ws1-voice-ready', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Voice ready ${Date.now()}`, [{ name: 'Hash tables' }])
    const topicId = course.topics['Hash tables']
    // The wording a real quiz has: a digit in a step, a big-O in the key, and words that merely contain "sum" or "solve".
    await addContent(topicId, {
      topic_quiz: [
        { question_type: 'true_false', question_text: 'A hash lookup is O(1) on average.', correct_answer: true, explanation: 'Averaged over 100 keys.', points: 1, difficulty: 'medium' },
        { question_type: 'true_false', question_text: 'We assume the hash spreads keys evenly, and resolve collisions by chaining.', correct_answer: true, points: 1, difficulty: 'medium' },
      ],
    })
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=voice`)
    await expect(lobby(page)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('voice-quiz-missing')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start voice practice' })).toBeEnabled({ timeout: 15_000 })
    // The server agrees: a session starts with both questions.
    const started = await page.request.post('/api/voice/session', {
      data: { projectId: course.courseId, topicId, mode: 'topic_drill', style: 'oral_quiz', language: 'en' },
    })
    expect(started.ok()).toBeTruthy()
    expect((await started.json()).questionCount).toBe(2)
  })
})

