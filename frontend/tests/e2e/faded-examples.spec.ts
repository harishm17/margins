import { streamedPartsArrived } from './helpers/settle'
import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { addContent, createCourse, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { expectNoSidewaysScroll } from './helpers/overflow'

// Faded worked examples (spec §5.5, §18.6), on three levels. `full`: every step shown, each "why" waiting for a guess (the start
// for a topic the student knows nothing about). `partial`: the last step to predict, the last two from the third example.
// `problem_first`: only the problem, every step on prediction. The start level comes from the topic's band; `?fade=` asks for
// one. Predictions are typed before the reveal and self-graded (level 2, source=example).
// Set SCREENS_DIR to keep screenshots at both sizes.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const example = (title: string, steps: number) => ({
  title,
  difficulty: 'medium',
  problem_statement: `Insert keys into a table for ${title}.`,
  solution_steps: Array.from({ length: steps }, (_, index) => ({
    step_number: index + 1,
    description: `${title} step ${index + 1}: apply the rule to the next key`,
    work: `Work for ${title} step ${index + 1}.`,
    explanation: `Reason for ${title} step ${index + 1}.`,
  })),
  final_answer: `Final answer for ${title}.`,
  key_concepts: ['Chaining'],
})

const EXAMPLES = [example('Alpha', 3), example('Beta', 3), example('Gamma', 4)]

async function world(page: Page, label: string) {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, label, { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Faded ${Date.now()}`, [{ name: 'Novice topic' }, { name: 'Ahead topic' }])
  // The novice topic's examples carry the id of a concept their steps never name; the other topic's are from before concepts.
  const conceptId = await withPrisma(async (prisma) => {
    const topicId = course.topics['Novice topic']
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { projectId: true } })
    return (await prisma.concept.create({ data: { projectId: topic.projectId, topicId, name: 'Bucket chains', summary: 'Chains.', kind: 'concept', orderIndex: 0 } })).id
  })
  await addContent(course.topics['Novice topic'], { solved_examples: EXAMPLES.map((item) => ({ ...item, concept_ids: [conceptId] })) })
  await addContent(course.topics['Ahead topic'], { solved_examples: EXAMPLES })
  const url = (name: string, fade?: string) => `/courses/${course.courseId}/topics/${course.topics[name]}?view=examples${fade ? `&fade=${fade}` : ''}`
  return { email, course, url, topicId: (name: string) => course.topics[name], conceptId }
}

const openExample = async (page: Page, title: string) => {
  const heading = page.getByRole('heading', { level: 2 }).filter({ hasText: title })
  const button = heading.getByRole('button')
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
}

test('the final answer waits for the guesses the example asks for, and "I don\'t know" counts as one', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { url } = await world(page, 'fade-answer')
  await page.goto(url('Novice topic'))
  await streamedPartsArrived(page)
  const answerPanel = page.getByRole('region', { name: 'Answer: Alpha' })
  const whys = page.getByRole('group', { name: 'Why this step? Write your guess' })
  await expect(whys).toHaveCount(3)
  // Every step is shown, but the whys are owed: the answer is not, and a line says when it opens.
  await expect(answerPanel).toHaveCount(0)
  await expect(page.getByText('The answer opens once you have written your guesses.')).toBeVisible()
  await whys.first().getByLabel('Your guess').fill('Because the key landed in a used bucket.')
  await whys.first().getByRole('button', { name: 'Show why' }).click()
  await expect(whys).toHaveCount(2)
  await expect(answerPanel).toHaveCount(0)
  await whys.first().getByRole('button', { name: "I don't know" }).click()
  await expect(answerPanel).toHaveCount(0)
  await whys.first().getByRole('button', { name: "I don't know" }).click()
  await expect(answerPanel).toBeVisible()
  await expect(page.getByText('The answer opens once you have written your guesses.')).toHaveCount(0)
})

test('a novice sees the first example worked with the whys waiting for a guess', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, url, conceptId } = await world(page, 'fade-novice')
  await page.goto(url('Novice topic'))
  await streamedPartsArrived(page)

  // Example 1 (open by default): every step is there, no explanation until the student guesses.
  // (The solution below repeats the step's words once its own copy has loaded, so the first match is the one looked at.)
  await expect(page.getByText('Alpha step 3: apply the rule to the next key').first()).toBeVisible()
  // In the step itself: the solution below repeats the work, and may be on the page too.
  await expect(page.getByRole('listitem').filter({ hasText: 'Alpha step 3: apply the rule to the next key' }).getByText('Work for Alpha step 3.')).toBeVisible()
  await expect(page.getByText('Reason for Alpha step 1.')).toHaveCount(0)
  await expect(page.getByText('Every step is shown. Write your guess for why before you read it.')).toBeVisible()
  const whys = page.getByRole('group', { name: 'Why this step? Write your guess' })
  await expect(whys).toHaveCount(3)

  // A guess is needed before the reason shows.
  const first = whys.first()
  await expect(first.getByRole('button', { name: 'Show why' })).toBeDisabled()
  await first.getByLabel('Your guess').fill('Because the key landed in a used bucket.')
  await screenshotIfAsked(page, 'e6-faded-novice-1440x900')
  await expectNoAxeViolations(page, 'faded examples novice, 1440')
  await first.getByRole('button', { name: 'Show why' }).click()
  await expect(page.getByText('Reason for Alpha step 1.')).toBeVisible()
  await expect(page.getByText('Reason for Alpha step 2.')).toHaveCount(0)

  // Self-grade: level-2 example evidence, filed under the example's concept although no step names it.
  await page.getByRole('button', { name: 'Got it' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved: Got it' })).toBeVisible()
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const events = await prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'example' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ assistance: 2, gradedBy: 'self', score: 1, conceptId })
  })

  await page.setViewportSize(PHONE)
  await screenshotIfAsked(page, 'e6-faded-novice-390x844')
  await expectNoAxeViolations(page, 'faded examples novice, 390')
  await expectNoSidewaysScroll(page, page.url())
})

test('at the partial level an example hides its last step and from the third its last two', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { url } = await world(page, 'fade-late')
  await page.goto(url('Novice topic', 'partial'))
  await streamedPartsArrived(page)

  // The first example is open and hides its last step too; close it to look at the second.
  await expect(page.getByRole('group', { name: 'Predict the next step' })).toHaveCount(1)
  await page.getByRole('heading', { level: 2 }).filter({ hasText: 'Alpha' }).getByRole('button').click()
  await openExample(page, 'Beta')
  await expect(page.getByText('Beta step 2: apply the rule to the next key')).toBeVisible()
  // The last step is not on the page until it is predicted.
  await expect(page.getByText('Beta step 3: apply the rule to the next key')).toHaveCount(0)
  await expect(page.getByText('Work for Beta step 3.')).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Predict the next step' })).toHaveCount(1)
  // The final answer waits too.
  await expect(page.getByText('Final answer for Beta.')).toHaveCount(0)
  await page.getByLabel('Your prediction').fill('Put the next key in the bucket.')
  await page.getByRole('button', { name: 'Show step' }).click()
  await expect(page.getByText('Beta step 3: apply the rule to the next key')).toBeVisible()
  await expect(page.getByText('Final answer for Beta.')).toBeVisible()
  // "I don't know" reveals too, and can only be graded as missed.
  await openExample(page, 'Gamma')
  await expect(page.getByText('Gamma step 2: apply the rule to the next key')).toBeVisible()
  await expect(page.getByText('Gamma step 3: apply the rule to the next key')).toHaveCount(0)
  await page.getByRole('group', { name: 'Predict the next step' }).getByRole('button', { name: "I don't know" }).click()
  await expect(page.getByText('Gamma step 3: apply the rule to the next key')).toBeVisible()
  // The last step waits for the one before it.
  await expect(page.getByText('Gamma step 4: apply the rule to the next key')).toHaveCount(0)
  // After "I don't know" the step can only be graded as missed (Beta's ungraded step has all three).
  await expect(page.getByRole('button', { name: 'Missed' })).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Got it' })).toHaveCount(1)
})

test('at the problem-first level the student gets the problem first and predicts every step', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { url } = await world(page, 'fade-ahead')
  await page.goto(url('Ahead topic', 'problem_first'))
  await streamedPartsArrived(page)

  await expect(page.getByText('Try it first. Write your next move, then the step opens.')).toBeVisible()
  await expect(page.getByText('Insert keys into a table for Alpha.')).toBeVisible()
  await expect(page.getByText('Alpha step 1: apply the rule to the next key')).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Step 1: your next move' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Step 2: your next move' })).toHaveCount(0)
  await screenshotIfAsked(page, 'e6-faded-ahead-1440x900')
  await expectNoAxeViolations(page, 'faded examples ahead, 1440')

  // A prediction typed and not yet revealed survives closing and opening the example.
  await page.getByLabel('Your prediction').fill('Hash the key and put it in the bucket.')
  await openExample(page, 'Beta')
  await page.getByRole('heading', { level: 2 }).filter({ hasText: 'Alpha' }).getByRole('button').click()
  await expect(page.getByText('Insert keys into a table for Alpha.')).toHaveCount(0)
  await page.getByRole('heading', { level: 2 }).filter({ hasText: 'Alpha' }).getByRole('button').click()
  await expect(page.getByLabel('Your prediction').first()).toHaveValue('Hash the key and put it in the bucket.')
  await page.getByRole('button', { name: 'Show step' }).first().click()
  await expect(page.getByText('Alpha step 1: apply the rule to the next key')).toBeVisible()
  // This topic's example has no concept ids and the step names none: the grade stays on screen and says so.
  await page.getByRole('button', { name: 'Got it' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Noted, not counted: Got it' })).toBeVisible()
  // The reason is shown with the step once it is predicted (the whys are for novices).
  await expect(page.getByText('Reason for Alpha step 1.')).toBeVisible()
  // The next step asks in turn.
  await expect(page.getByRole('group', { name: 'Step 2: your next move' })).toBeVisible()
  await expect(page.getByText('Final answer for Alpha.')).toHaveCount(0)

  await page.setViewportSize(PHONE)
  await screenshotIfAsked(page, 'e6-faded-ahead-390x844')
  await expectNoAxeViolations(page, 'faded examples ahead, 390')
  await expectNoSidewaysScroll(page, page.url())
})

test('a good warm-up, sure and right, starts the topic at problem first; a guessed one does not', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, url, topicId, conceptId } = await world(page, 'fade-warmup')
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId('Novice topic') }, select: { projectId: true } })
    const items = [0, 1, 2].map((index) => ({ index, itemKey: `k${index}`, difficulty: 'medium', conceptIds: [conceptId], question: { question: `Q${index}` } }))
    const warmup = (confidence: number, level: string, completedAt: Date) =>
      prisma.itemSession.create({
        data: {
          userId: user.id,
          projectId: topic.projectId,
          kind: 'warmup',
          topicIds: [topicId('Novice topic')],
          items,
          answers: {},
          results: {
            topicId: topicId('Novice topic'),
            total: 3,
            order: [0, 1, 2],
            graded: Object.fromEntries(items.map((item) => [String(item.index), { correct: true, score: 1, confidence, confidenceLevel: level }])),
          },
          createdAt: completedAt,
          completedAt,
        },
      })
    // Right every time, but every answer marked Guessing: luck is not knowing (spec 5.1), so the topic still starts fully worked.
    await warmup(0.25, 'guess', new Date(Date.now() - 3_600_000))
  })
  await page.goto(url('Novice topic'))
  await streamedPartsArrived(page)
  await expect(page.getByText('Every step is shown. Write your guess for why before you read it.')).toBeVisible()
  await expect(page.getByText('Alpha step 1: apply the rule to the next key')).toBeVisible()

  // The same answers, sure of each: the newer warm-up counts, and the topic starts with the problem first.
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId('Novice topic') }, select: { projectId: true } })
    const items = [0, 1, 2].map((index) => ({ index, itemKey: `k${index}`, difficulty: 'medium', conceptIds: [conceptId], question: { question: `Q${index}` } }))
    await prisma.itemSession.create({
      data: {
        userId: user.id,
        projectId: topic.projectId,
        kind: 'warmup',
        topicIds: [topicId('Novice topic')],
        items,
        answers: {},
        results: {
          topicId: topicId('Novice topic'),
          total: 3,
          order: [0, 1, 2],
          graded: Object.fromEntries(items.map((item) => [String(item.index), { correct: true, score: 1, confidence: 0.75, confidenceLevel: 'fairly' }])),
        },
        completedAt: new Date(),
      },
    })
  })
  await page.goto(url('Novice topic'))
  await streamedPartsArrived(page)
  await expect(page.getByText('Try it first. Write your next move, then the step opens.')).toBeVisible()
  await expect(page.getByText('Alpha step 1: apply the rule to the next key')).toHaveCount(0)
})

test('notes marked complete stamp the date once, and a later visit does not move it', async ({ page }) => {
  const { topicId } = await world(page, 'fade-notes-date')
  const id = topicId('Novice topic')
  const mark = () => page.request.post(`/api/topics/${id}/progress`, { data: { notesCompleted: true } })
  expect((await mark()).ok()).toBeTruthy()
  const first = await withPrisma(async (prisma) => (await prisma.topicProgress.findFirstOrThrow({ where: { topicId: id } })).notesCompletedAt)
  expect(first).not.toBeNull()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect((await mark()).ok()).toBeTruthy()
  expect((await page.request.post(`/api/topics/${id}/progress`, { data: { examplesCompleted: true } })).ok()).toBeTruthy()
  const later = await withPrisma(async (prisma) => (await prisma.topicProgress.findFirstOrThrow({ where: { topicId: id } })).notesCompletedAt)
  expect(later?.toISOString()).toBe(first?.toISOString())
})

// Levels move example by example (spec §18.6): added quickly after a Missed or an "I don't know", removed slowly after two
// examples that were all Got it. The captions say how much is worked.

test('band 0 starts fully worked', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { url } = await world(page, 'fade-band0')
  await page.goto(url('Novice topic'))
  await streamedPartsArrived(page)
  await expect(page.getByText('Fully worked', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Alpha step 3: apply the rule to the next key').first()).toBeVisible()
  await expect(page.getByText('Reason for Alpha step 1.')).toHaveCount(0)
})

test('a missed prediction makes the next example more worked', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { url } = await world(page, 'fade-missed')
  await page.goto(url('Ahead topic', 'partial'))
  await streamedPartsArrived(page)
  await expect(page.getByText('One step left for you', { exact: true }).first()).toBeVisible()
  // Beta, opened before anything is graded, is still partial: its last step waits for a prediction.
  await openExample(page, 'Beta')
  await expect(page.getByText('Beta step 3: apply the rule to the next key')).toHaveCount(0)
  await page.getByRole('heading', { level: 2 }).filter({ hasText: 'Beta' }).getByRole('button').click()
  // "I don't know" on Alpha's hidden step counts as Missed at once: Beta moves a level towards fully worked.
  await page.getByRole('group', { name: 'Predict the next step' }).getByRole('button', { name: "I don't know" }).click()
  await openExample(page, 'Beta')
  await expect(page.getByText('Beta step 3: apply the rule to the next key').first()).toBeVisible()
  await expect(page.getByText('Every step is shown. Write your guess for why before you read it.')).toBeVisible()
  await expect(page.getByText('Fully worked', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Reason for Beta step 1.')).toHaveCount(0)
})

test('two all-got-it examples make the next one problem first', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { url } = await world(page, 'fade-gotit')
  await page.goto(url('Ahead topic', 'partial'))
  await streamedPartsArrived(page)
  for (const title of ['Alpha', 'Beta']) {
    await openExample(page, title)
    await page.getByLabel('Your prediction').first().fill('Put the next key in the bucket.')
    await page.getByRole('button', { name: 'Show step' }).first().click()
    await page.getByRole('button', { name: 'Got it' }).first().click()
    await expect(page.getByRole('status').filter({ hasText: 'Got it' }).last()).toBeVisible()
  }
  // One example of Got it changes nothing (Beta stayed partial); two in a row move Gamma to problem first.
  await openExample(page, 'Gamma')
  await expect(page.getByText('Your turn first', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Try it first. Write your next move, then the step opens.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Step 1: your next move' })).toBeVisible()
  await expect(page.getByText('Gamma step 1: apply the rule to the next key')).toHaveCount(0)
})
