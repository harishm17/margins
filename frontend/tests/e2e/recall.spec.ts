import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { markAiAvailable, markAiUnavailable, withPrisma } from './helpers/db'
import { addContent, createCourse, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { expectClearOfTabBar, expectNoSidewaysScroll } from './helpers/overflow'

// Recall (spec §5.3): close the book, write what you remember, get it graded claim by claim against the student's own
// pages. The AI service runs on the mock provider: the first claim of a prompt is covered, the second missing, the third
// incorrect, and an answer holding "xyzzy" is one it cannot read. Set SCREENS_DIR to keep screenshots at both sizes.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const ANSWER = 'A hash table sends each key to a bucket and keeps a list in the bucket when two keys land together, which is how it avoids losing a key.'
const PROMPT_0 = 'Explain how a hash table handles keys that share a bucket.'

/**
 * Concepts with claims and recall prompts, written straight into the database.
 * Objective 0: Hash function (one claim), Collision (two claims). Objective 1: Load factor (one claim).
 */
async function seedConcepts(email: string, topicId: string, options: { claims?: boolean; prompts?: boolean; recallAt?: boolean } = {}) {
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { projectId: true } })
    const material = await prisma.material.findFirstOrThrow({ where: { projectId: topic.projectId }, select: { id: true } })
    const specs = [
      { name: 'Hash function', objectives: [0], claims: ['A hash function maps a key to a bucket index.'] },
      { name: 'Collision', objectives: [0], claims: ['A collision is two keys that land in one bucket.', 'Chaining keeps a list of entries per bucket.'] },
      { name: 'Load factor', objectives: [1], claims: ['The load factor is entries divided by buckets.'] },
    ]
    for (const [orderIndex, spec] of specs.entries()) {
      const concept = await prisma.concept.create({
        data: { projectId: topic.projectId, topicId, name: spec.name, summary: `${spec.name}.`, kind: 'concept', orderIndex, objectiveIndexes: spec.objectives },
      })
      if (options.claims === false) continue
      for (const [n, text] of spec.claims.entries()) {
        await prisma.conceptClaim.create({ data: { conceptId: concept.id, text, quote: `Page text for: ${text}`, materialId: material.id, orderIndex: n, pageStart: 4 + orderIndex } })
      }
    }
    await prisma.topic.update({ where: { id: topicId }, data: { evidenceBackfilledAt: new Date() } })
    if (options.prompts !== false) {
      await prisma.topicContent.create({
        data: {
          topicId,
          contentType: 'concept_prompts',
          contentData: {
            focus_questions: [],
            recall_prompts: [
              { objective_index: 0, prompt: PROMPT_0 },
              { objective_index: 1, prompt: 'Explain what the load factor tells you.' },
            ],
          },
        },
      })
    }
    const at = new Date(Date.now() - 3_600_000)
    await prisma.topicProgress.upsert({
      where: { topicId_userId: { topicId, userId: user.id } },
      create: { topicId, userId: user.id, warmupAt: at, readAt: at, ...(options.recallAt ? { recallAt: at } : {}) },
      update: { warmupAt: at, readAt: at, ...(options.recallAt ? { recallAt: at } : {}) },
    })
  })
}

async function world(page: Page, label: string, names = ['Hash tables']) {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, label, { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Recall ${Date.now()}`, names.map((name) => ({ name })))
  for (const id of Object.values(course.topics)) await addContent(id, { section_notes: '# Notes\n\nSome notes to read.\n\n## Part\n\nMore.' })
  const topicUrl = (name: string) => `/courses/${course.courseId}/topics/${course.topics[name]}`
  return { email, course, topicUrl, topicId: (name: string) => course.topics[name] }
}

const card = (page: Page, prompt = PROMPT_0) => page.getByRole('region', { name: prompt })
const box = (page: Page, prompt = PROMPT_0) => page.getByRole('textbox', { name: prompt })

async function answer(page: Page, text = ANSWER, prompt = PROMPT_0) {
  await box(page, prompt).fill(text)
  await card(page, prompt).getByRole('button', { name: 'Check my answer' }).click()
}

test('recall waits for claims', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, course, topicUrl, topicId } = await world(page, 'rc-waits', ['Extracting topic', 'Claimless topic'])

  // Concepts are being extracted: the step says so and offers no text box.
  await seedConcepts(email, topicId('Claimless topic'), { claims: false })
  const jobId = await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const job = await prisma.processingJob.create({
      data: { userId: user.id, projectId: course.courseId, jobType: 'generate_content', status: 'processing', leaseUntil: new Date(Date.now() + 3_600_000), inputData: { topicId: topicId('Extracting topic'), contentType: 'concepts' } },
    })
    return job.id
  })
  await page.goto(`${topicUrl('Extracting topic')}?view=recall`)
  await expect(page.getByRole('heading', { name: 'Getting this topic ready' })).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await screenshotIfAsked(page, 'e4-recall-preparing-1440x900')
  await expectNoAxeViolations(page, 'recall preparing, 1440')
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Getting this topic ready' })).toBeVisible()
  await screenshotIfAsked(page, 'e4-recall-preparing-390x844')
  await expectNoAxeViolations(page, 'recall preparing, 390')

  // The extraction failed and the topic has no concepts: Recall is not offered and its address goes on to practice.
  await withPrisma((prisma) => prisma.processingJob.update({ where: { id: jobId }, data: { status: 'failed' } }))
  await page.goto(`${topicUrl('Extracting topic')}?view=recall`)
  await expect(page).toHaveURL(/view=practice/)

  // Concepts but no claims to grade against: nothing to write an answer to yet.
  await page.goto(`${topicUrl('Claimless topic')}?view=recall`)
  await expect(page.getByRole('heading', { name: "Recall isn't ready yet" })).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
})

test.describe('AI down', () => {
  test.afterEach(markAiAvailable)

test('when grading fails because AI is down, the shared status learns of it and the answer is kept', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'rc-ai-down')
  await seedConcepts(email, topicId('Hash tables'))
  await page.route(/\/api\/topics\/[0-9a-f-]{36}\/recall$/, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'AI features are paused right now. Your files and progress are safe. Try again later.', details: { code: 'LLM_CREDIT_EXHAUSTED' } } }) }))
  await page.goto(`${topicUrl('Hash tables')}?view=recall`)
  await expect(box(page)).toBeVisible()
  // AI goes down while the student is writing: the failure is what tells the page.
  await markAiUnavailable()
  await answer(page)
  // The banner and the button agree with the failure, and what was written is still there.
  await expect(page.getByRole('status').filter({ hasText: 'AI features are paused' })).toBeVisible()
  await expect(card(page).getByRole('button', { name: 'Check my answer' })).toBeDisabled()
  await expect(box(page)).toHaveValue(ANSWER)
})
})

test('a recall answer is graded against the claims, with the student quoted first', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'rc-graded')
  await seedConcepts(email, topicId('Hash tables'))
  await page.goto(`${topicUrl('Hash tables')}?view=recall`)

  await expect(page.getByRole('heading', { name: 'Close the book and say what you remember' })).toBeVisible()
  // Nothing is graded yet: the instructions are in full, and no card repeats the next step above the work.
  await expect(page.getByText('Write what you can remember of each idea, without looking back.')).toBeVisible()
  await expect(page.getByRole('button', { name: /instructions/ })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Next on this topic' })).toHaveCount(0)
  // One prompt is open (the first); each of the others is one labelled row, not another box and another Check button.
  await expect(card(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check my answer' })).toHaveCount(1)
  for (const prompt of ['Explain what the load factor tells you.', 'Explain this topic in your own words: its main ideas and how they fit together.']) {
    await expect(card(page, prompt)).toHaveCount(0)
    const row = page.getByRole('button', { name: new RegExp(prompt.slice(0, 30)) })
    await expect(row).toContainText('Not answered yet')
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  // The pages are closed: no reader on the step.
  await expect(page.getByRole('region', { name: 'Reading' })).toHaveCount(0)
  await screenshotIfAsked(page, 'e4-recall-prompt-1440x900')
  await expectNoAxeViolations(page, 'recall prompt, 1440')

  await answer(page)
  const feedback = card(page).getByRole('region', { name: 'Feedback on your answer' })
  await expect(feedback).toBeVisible()
  // The text box is gone: a keyboard student lands on the feedback, not on the page.
  await expect(feedback).toBeFocused()
  // In order: what they got (their own words), what is not right (the source's words and page), what they missed.
  await expect(feedback.getByRole('heading')).toHaveText(['What you got', 'What is not right', 'What you missed'])
  await expect(feedback.getByText('“A hash table sends each key”')).toBeVisible()
  await expect(feedback.getByText('Page text for: Chaining keeps a list of entries per bucket.').locator('visible=true')).toBeVisible()
  await expect(feedback.getByText('(p. 5)').locator('visible=true')).toBeVisible()
  // What was missed is a pointer, never the claim itself.
  await expect(feedback.getByText(/Look again at p\. 5/).locator('visible=true')).toBeVisible()
  await expect(page.getByText('A collision is two keys that land in one bucket.')).toHaveCount(0)
  // Results first: the instructions fold into one line, and open again on a tap.
  const instructions = page.getByRole('button', { name: 'Show instructions' })
  await expect(instructions).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('Write what you can remember of each idea, without looking back.')).toBeHidden()
  await instructions.click()
  await expect(page.getByText('Write what you can remember of each idea, without looking back.')).toBeVisible()
  await page.getByRole('button', { name: 'Hide instructions' }).click()
  await expect(page.getByText('Write what you can remember of each idea, without looking back.')).toBeHidden()
  // One clear next step: the topic's next activity is the primary button, and "Show me what I missed" is the quiet choice.
  // The answer held a wrong idea and failed the concept, so the topic's next activity is to read about it first (spec 18.5); the
  // drill that pairs it with its confusable comes after the instruction.
  // The first answer counts the topic as recalled, but the step is not finished: the page says how far it is and keeps
  // the other prompts as the thing to do, with moving on as the quiet choice (not the primary button).
  await expect(page.getByTestId('recall-progress').locator('visible=true')).toHaveText(/^1 of \d+ prompts answered\. Answer the rest, or move on\.$/)
  await expect(page.getByRole('link', { name: 'Go to Practice' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Read that part again' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Next on this topic' })).toHaveCount(0)
  // The feedback ends in one primary step, the next prompt; answering this one again is the quiet link beside it, and the
  // way on to Practice is the secondary button until every prompt has an answer.
  await expect(feedback.getByRole('button', { name: 'Answer the next prompt' })).toBeVisible()
  await expect(feedback.getByRole('button', { name: 'Answer again' })).toBeVisible()
  await feedback.getByRole('button', { name: 'Answer the next prompt' }).click()
  await expect(box(page, 'Explain what the load factor tells you.')).toBeFocused()
  await expect(page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Recall/ }).getByRole('img', { name: 'Completed' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Recall/ })).toContainText(/1\/\d+/)
  await screenshotIfAsked(page, 'e4-recall-graded-1440x900')
  await expectNoAxeViolations(page, 'recall graded, 1440')

  // The step is done: the path ticks Recall, and the answer is stored with level-0 model evidence.
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const progress = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: topicId('Hash tables'), userId: user.id } } })
    expect(progress.recallAt).not.toBeNull()
    const events = await prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'recall' } })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.assistance === 0 && e.gradedBy === 'model')).toBeTruthy()
  })

  // It is still there after a reload.
  await page.reload()
  await expect(card(page).getByRole('region', { name: 'Feedback on your answer' })).toBeVisible()
  await expect(page.getByTestId('recall-progress').locator('visible=true')).toHaveText(/^1 of \d+ prompts answered/)
  await expect(page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Recall/ })).toContainText(/1\/\d+/)
})

test('recall is shown finished only when every prompt has an answer', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'rc-all')
  await seedConcepts(email, topicId('Hash tables'))
  await page.goto(`${topicUrl('Hash tables')}?view=recall`)
  const prompts = ['Explain how a hash table handles keys that share a bucket.', 'Explain what the load factor tells you.', 'Explain this topic in your own words: its main ideas and how they fit together.']
  const path = page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Recall/ })
  for (const [index, prompt] of prompts.entries()) {
    await answer(page, ANSWER, prompt)
    await expect(card(page, prompt).getByRole('region', { name: 'Feedback on your answer' })).toBeVisible()
    if (index < prompts.length - 1) {
      await expect(page.getByTestId('recall-progress')).toHaveText(new RegExp(`^${index + 1} of ${prompts.length} prompts answered`))
      await expect(path.getByRole('img', { name: 'Completed' })).toHaveCount(0)
    }
  }
  // The last prompt answered: the count says so, the step ticks, and the way on is the primary button.
  await expect(page.getByTestId('recall-progress')).toHaveText(`${prompts.length} of ${prompts.length} prompts answered`)
  await expect(path.getByRole('img', { name: 'Completed' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Read the explanation of your gaps' })).toBeVisible()
})

test('show me what I missed records level 3', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'rc-reveal')
  await seedConcepts(email, topicId('Hash tables'))
  await page.goto(`${topicUrl('Hash tables')}?view=recall`)
  await answer(page)
  const feedback = card(page).getByRole('region', { name: 'Feedback on your answer' })
  await expect(feedback).toBeVisible()

  // Help on request: "Show me what I missed" is behind "More help".
  await feedback.getByRole('button', { name: 'More help' }).click()
  await feedback.getByRole('button', { name: 'Show me what I missed' }).click()
  await expect(feedback.getByRole('heading', { name: 'What your pages say' })).toBeVisible()
  await expect(feedback.getByText('Chaining keeps a list of entries per bucket.', { exact: true })).toBeVisible()
  await expect(feedback.getByRole('button', { name: 'Show me what I missed' })).toHaveCount(0)
  await screenshotIfAsked(page, 'e4-recall-revealed-1440x900')
  await expectNoAxeViolations(page, 'recall revealed, 1440')

  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const level3 = await prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'recall', assistance: 3 }, include: { concept: { select: { name: true } } } })
    // Collision (a claim missing and one wrong); Hash function was covered.
    expect(level3.map((e) => e.concept.name)).toEqual(['Collision'])
  })

  // It stays revealed after a reload, without a second record.
  await page.reload()
  await expect(card(page).getByRole('heading', { name: 'What your pages say' })).toBeVisible()
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    expect(await prisma.evidenceEvent.count({ where: { userId: user.id, source: 'recall', assistance: 3 } })).toBe(1)
  })
})

test('an unclear answer gets one question back and is not marked', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'rc-abstain')
  await seedConcepts(email, topicId('Hash tables'))
  await page.goto(`${topicUrl('Hash tables')}?view=recall`)

  // Too short to judge: the app asks without calling the model.
  await answer(page, 'buckets')
  await expect(card(page).getByText('Can you say more about what you remember, in a sentence or two?')).toBeVisible()
  await expect(box(page)).toHaveValue('buckets')

  // Words the model could not read (here, the mock's marker): its question comes back, and the text stays.
  await answer(page, 'the table xyzzy plugh the bucket maybe something')
  await expect(card(page).getByText('Which part of the topic do you mean?')).toBeVisible()
  await expect(box(page)).toHaveValue('the table xyzzy plugh the bucket maybe something')
  await expect(card(page).getByRole('region', { name: 'Feedback on your answer' })).toHaveCount(0)
  await screenshotIfAsked(page, 'e4-recall-clarify-1440x900')
  await expectNoAxeViolations(page, 'recall clarifying question, 1440')

  // Nothing was marked or stored, and Recall is not ticked.
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    expect(await prisma.recallAttempt.count({ where: { userId: user.id } })).toBe(0)
    expect(await prisma.evidenceEvent.count({ where: { userId: user.id, source: 'recall' } })).toBe(0)
    expect(await prisma.topicProgress.count({ where: { userId: user.id, recallAt: { not: null } } })).toBe(0)
  })

  // A better answer is graded.
  await answer(page)
  await expect(card(page).getByRole('region', { name: 'Feedback on your answer' })).toBeVisible()
})

test('a 503 keeps what the student wrote', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'rc-503')
  await seedConcepts(email, topicId('Hash tables'))
  await page.goto(`${topicUrl('Hash tables')}?view=recall`)

  await page.route('**/api/topics/*/recall', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: 'The AI is busy right now. Try again in a few minutes.', details: { code: 'LLM_UNAVAILABLE', retryable: true } } }) })
      : route.continue()
  )
  await answer(page)
  await expect(card(page).getByRole('alert')).toContainText('The AI is busy right now')
  await expect(box(page)).toHaveValue(ANSWER)
  await screenshotIfAsked(page, 'e4-recall-unavailable-1440x900')

  // Even a reload: the text is kept for this tab.
  await page.reload()
  await expect(box(page)).toHaveValue(ANSWER)

  await page.unroute('**/api/topics/*/recall')
  await card(page).getByRole('button', { name: 'Check my answer' }).click()
  await expect(card(page).getByRole('region', { name: 'Feedback on your answer' })).toBeVisible()
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    expect(await prisma.recallAttempt.count({ where: { userId: user.id } })).toBe(1)
  })
})

test('opening reader during recall abandons level 0', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'rc-abandon')
  await seedConcepts(email, topicId('Hash tables'))
  await page.goto(`${topicUrl('Hash tables')}?view=recall`)
  await expect(box(page)).toBeVisible()

  // Open the reading while the card is open, then come back and answer.
  await page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Read/ }).click()
  await expect(page).toHaveURL(/view=read/)
  await page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Recall/ }).click()
  await expect(page).toHaveURL(/view=recall/)
  await expect(card(page).getByText("You opened the reading while this was open, so this answer won't count toward your score.")).toBeVisible()
  await screenshotIfAsked(page, 'e4-recall-abandoned-1440x900')

  const posted = page.waitForRequest((request) => request.url().includes('/recall') && request.method() === 'POST')
  await answer(page)
  expect((await posted).postDataJSON()).toMatchObject({ kind: 'recall', objectiveIndex: 0, abandoned: true })
  await expect(card(page).getByRole('region', { name: 'Feedback on your answer' })).toBeVisible()
  await expect(card(page).getByText("This answer didn't count toward your score, because the reading was open.")).toBeVisible()

  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const events = await prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'recall' } })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.assistance === 2)).toBeTruthy()
  })
})

test('a recall answered with the book closed posts abandoned false', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'rc-closed')
  await seedConcepts(email, topicId('Hash tables'))
  // Reading first, then recall: the reading was not open while a card was.
  await page.goto(`${topicUrl('Hash tables')}?view=read`)
  await page.goto(`${topicUrl('Hash tables')}?view=recall`)
  await expect(card(page).getByText(/You opened the reading/)).toHaveCount(0)
  const posted = page.waitForRequest((request) => request.url().includes('/recall') && request.method() === 'POST')
  await answer(page)
  expect((await posted).postDataJSON().abandoned).toBe(false)
})

test('recall is limited to 10 a minute', async ({ page }) => {
  const { email, topicUrl, topicId } = await world(page, 'rc-limit')
  await seedConcepts(email, topicId('Hash tables'))
  await page.goto(`${topicUrl('Hash tables')}?view=recall`)
  const post = () => page.request.post(`/api/topics/${topicId('Hash tables')}/recall`, { data: { kind: 'recall', objectiveIndex: 0, answer: 'idk' } })
  for (let i = 0; i < 10; i += 1) expect((await post()).status()).toBe(200)
  const limited = await post()
  expect(limited.status()).toBe(429)
  expect(limited.headers()['retry-after']).toBeTruthy()
})

test('teach-back of one concept grades that concept', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'rc-teach')
  await seedConcepts(email, topicId('Hash tables'), { recallAt: true })
  const conceptId = await withPrisma(async (prisma) => (await prisma.concept.findFirstOrThrow({ where: { topicId: topicId('Hash tables'), name: 'Collision' }, select: { id: true } })).id)
  await page.goto(`${topicUrl('Hash tables')}?view=recall&mode=teach_back&concept=${conceptId}`)
  await expect(page.getByRole('heading', { name: 'Explain it in your own words' })).toBeVisible()
  const prompt = 'Explain "Collision" in your own words, as if you were teaching it to a classmate.'
  await expect(card(page, prompt)).toBeVisible()
  await screenshotIfAsked(page, 'e4-teach-back-1440x900')
  await answer(page, ANSWER, prompt)
  await expect(card(page, prompt).getByRole('region', { name: 'Feedback on your answer' })).toBeVisible()
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const events = await prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'teach_back' } })
    expect(events.map((e) => e.conceptId)).toEqual([conceptId])
    expect(events[0].assistance).toBe(0)
  })
})

test('recall on a phone', async ({ page }) => {
  await page.setViewportSize(PHONE)
  const { email, topicUrl, topicId } = await world(page, 'rc-phone')
  await seedConcepts(email, topicId('Hash tables'))
  await expectNoSidewaysScroll(page, `${topicUrl('Hash tables')}?view=recall`)
  await expect(card(page)).toBeVisible()
  await screenshotIfAsked(page, 'e4-recall-prompt-390x844')
  await expectNoAxeViolations(page, 'recall prompt, 390')
  // The submit button is never under the bottom bar, with a short answer or a long one.
  await box(page).fill(ANSWER)
  await expectClearOfTabBar(page, card(page).getByRole('button', { name: 'Check my answer' }), 'Check my answer')
  await box(page).fill(`${ANSWER} ${ANSWER} ${ANSWER} ${ANSWER}`)
  await expectClearOfTabBar(page, card(page).getByRole('button', { name: 'Check my answer' }), 'Check my answer, long answer')
  await screenshotIfAsked(page, 'e4-recall-submit-clear-390x844')

  await answer(page)
  await expect(card(page).getByRole('region', { name: 'Feedback on your answer' })).toBeVisible()
  await card(page).getByRole('button', { name: 'More help' }).click()
  await card(page).getByRole('button', { name: 'Show me what I missed' }).click()
  await expect(card(page).getByRole('heading', { name: 'What your pages say' })).toBeVisible()
  await screenshotIfAsked(page, 'e4-recall-graded-390x844')
  await expectNoAxeViolations(page, 'recall graded, 390')
  await expectNoSidewaysScroll(page, page.url())

  await page.getByRole('region', { name: 'Explain what the load factor tells you.' }).getByRole('textbox').fill('buckets')
  await page.getByRole('region', { name: 'Explain what the load factor tells you.' }).getByRole('button', { name: 'Check my answer' }).click()
  await expect(page.getByText('Can you say more about what you remember, in a sentence or two?')).toBeVisible()
  await screenshotIfAsked(page, 'e4-recall-clarify-390x844')
  await expectNoAxeViolations(page, 'recall clarifying question, 390')
})
