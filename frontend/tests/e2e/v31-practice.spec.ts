import { expect, test, type Page } from '@playwright/test'
import { openMoreHelp, workingBox } from './helpers/practice'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { addContent, createCourse, practiceProblem, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { streamedPartsArrived } from './helpers/settle'
import { expectNoSidewaysScroll } from './helpers/overflow'

// Help after an attempt in practice and worked examples (spec §18.3, §18.4, §18.6, v3.1 workstream Q): the hint gate,
// "I don't know", the help that stays in view after a miss, the draft of the answer and the working, the next problem that
// follows how the last one went, and a worked example that was viewed in full. The AI service is the mock.
// Set SCREENS_DIR to keep screenshots at both sizes.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const problem = (title: string, difficulty: 'easy' | 'medium' | 'hard', conceptId?: string) => {
  const base = practiceProblem(title)
  return {
    ...base,
    difficulty,
    ...(conceptId ? { concept_ids: [conceptId] } : {}),
    steps: base.steps.map((step) => ({
      ...step,
      hints: ['Look at the number.', 'Squaring is repeated product.', 'n times n.'],
      ...(conceptId ? { concept_ids: [conceptId] } : {}),
    })),
  }
}

const answerBox = (page: Page) => page.getByLabel('Your answer').locator('visible=true')
const check = async (page: Page, value: string) => {
  await answerBox(page).fill(value)
  await page.getByRole('button', { name: 'Check', exact: true }).click()
}
const visible = (page: Page, text: string | RegExp) => page.getByText(text).locator('visible=true')
const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name }).locator('visible=true')

async function open(page: Page, label: string, problems: ReturnType<typeof problem>[] = [problem('Squares', 'medium')], withConcept = false) {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, label, { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `${label} course`, [{ name: 'Squares' }])
  const topicId = course.topics.Squares
  const conceptId = withConcept
    ? await withPrisma(async (prisma) =>
        (await prisma.concept.create({ data: { projectId: course.courseId, topicId, name: 'Squares', summary: 'Multiplying a number by itself.', kind: 'concept', orderIndex: 0 } })).id
      )
    : undefined
  await addContent(topicId, {
    interactive_examples: conceptId ? problems.map((item) => ({ ...item, concept_ids: [conceptId], steps: item.steps.map((step) => ({ ...step, concept_ids: [conceptId] })) })) : problems,
  })
  const url = `/courses/${course.courseId}/topics/${topicId}?view=practice`
  await page.goto(url)
  await expect(button(page, 'Check')).toBeVisible()
  return { email, course, topicId, conceptId, url }
}

const contentIdOf = (topicId: string) =>
  withPrisma(async (prisma) => (await prisma.topicContent.findUniqueOrThrow({ where: { topicId_contentType: { topicId, contentType: 'interactive_examples' } }, select: { id: true } })).id)

test.describe('practice: help after an attempt', () => {
  test('I don\'t know opens help, counts as the first check, and the missing-is-expected line shows once', async ({ page }) => {
    test.setTimeout(120_000)
    const { email, topicId } = await open(page, 'q-idk', [problem('Squares', 'medium')], true)
    await page.setViewportSize(DESKTOP)
    await button(page, "I don't know").click()
    await expect(visible(page, "Here's what to learn")).toBeVisible()
    await expect(visible(page, 'Missing a step is part of practice. The next try, or a hint, is where it sticks.')).toBeVisible()
    await expect(button(page, /Show where to look/)).toBeEnabled()
    await openMoreHelp(page)
    await expect(button(page, 'Show answer')).toBeEnabled()
    await expect(button(page, "I don't know")).toHaveCount(0)
    await screenshotIfAsked(page, 'q-practice-idk-1440x900')
    await expectNoAxeViolations(page, 'practice after I do not know, 1440')

    // The server's record: one check, wrong, flagged as an IDK; the step is a failed first try at once (level 1, score 0).
    const contentId = await contentIdOf(topicId)
    await expect
      .poll(async () =>
        withPrisma(async (prisma) => {
          const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
          const state = await prisma.tutorState.findFirst({ where: { userId: user.id, scopeKey: `${contentId}:0:0` } })
          return state ? [state.checks, state.wrongChecks, state.dontKnowAt !== null] : null
        })
      )
      .toEqual([1, 1, true])
    await expect
      .poll(async () =>
        withPrisma(async (prisma) => {
          const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
          const rows = await prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'practice', itemKey: `practice:${contentId}:0:0` } })
          return rows.map((row) => [row.assistance, row.score, (row.metadata as { idk?: boolean }).idk])
        })
      )
      .toEqual([[1, 0, true]])

    // Try again, then a second miss: the line does not come back the same day.
    await button(page, 'Try again').click()
    await check(page, '5')
    await expect(visible(page, 'Not quite')).toBeVisible()
    await expect(page.getByText('Missing a step is part of practice.')).toHaveCount(0)
  })

  test('Show answer after a miss writes the surrender once, flagged as a reveal', async ({ page }) => {
    test.setTimeout(120_000)
    const { email, topicId } = await open(page, 'q-reveal', [problem('Squares', 'medium')], true)
    await check(page, '5')
    await expect(visible(page, 'Not quite')).toBeVisible()
    await openMoreHelp(page)
    await button(page, 'Show answer').click()
    await expect(visible(page, "The answer is shown, so this step won't count as solved.")).toBeVisible()
    await expect
      .poll(async () =>
        withPrisma(async (prisma) => {
          const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
          const rows = await prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'practice', topicId, assistance: 3 } })
          return rows.map((row) => [(row.metadata as { surrendered?: boolean }).surrendered, (row.metadata as { reveal?: boolean }).reveal])
        })
      )
      .toEqual([[true, true]])
  })

  test('typed working survives a reload in a new context', async ({ page, browser }) => {
    test.setTimeout(120_000)
    const { topicId, url } = await open(page, 'q-draft')
    await answerBox(page).fill('4.0 maybe')
    await (await workingBox(page)).fill('Two times two, so I think four.')
    const contentId = await contentIdOf(topicId)
    await expect
      .poll(async () => (await (await page.request.get(`/api/drafts?surface=practice&key=${contentId}:0:0`)).json()).draft?.payload ?? null, { timeout: 20_000 })
      .toEqual({ answer: '4.0 maybe', working: 'Two times two, so I think four.' })
    await expect(visible(page, 'Saved')).toBeVisible()

    // Another browser context with the same sign-in has no sessionStorage cache: the text comes from the server.
    const other = await browser.newContext({ storageState: await page.context().storageState(), timezoneId: ZONE })
    try {
      const second = await other.newPage()
      await setZoneCookie(other)
      await second.goto(url)
      await expect(answerBox(second)).toHaveValue('4.0 maybe')
      await expect(second.getByLabel('Your working (optional)').locator('visible=true')).toHaveValue('Two times two, so I think four.')
      // A right answer ends the draft.
      await answerBox(second).fill('4')
      await second.getByRole('button', { name: 'Check', exact: true }).click()
      await expect(second.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
    } finally {
      await other.close()
    }
    await expect.poll(async () => (await (await page.request.get(`/api/drafts?surface=practice&key=${contentId}:0:0`)).json()).draft, { timeout: 20_000 }).toBeNull()
  })

  test('next problem is easier after a worked example, and says why', async ({ page }) => {
    test.setTimeout(150_000)
    await open(page, 'q-next', [problem('Medium squares', 'medium'), problem('Hard squares', 'hard'), problem('Easy squares', 'easy')], true)
    await page.setViewportSize(DESKTOP)
    // Step one needs the worked example (the mock tutor delivers it), then the student finishes the step.
    await check(page, '5')
    await expect(visible(page, 'Not quite')).toBeVisible()
    await openMoreHelp(page)
    await button(page, /Show me a worked example/).click()
    await expect(page.getByRole('log', { name: 'Tutor conversation' }).locator('visible=true')).toContainText('Worked example')
    await button(page, 'Try again').click()
    await check(page, '4')
    await expect(page.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
    await button(page, 'Next step').click()
    await check(page, '9')
    await button(page, 'Finish').click()
    await expect(visible(page, 'Problem complete')).toBeVisible()
    await expect(visible(page, 'You solved 2 of 2 steps. The next problem is an easier one.')).toBeVisible()
    await screenshotIfAsked(page, 'q-practice-complete-easier-1440x900')
    await expectNoAxeViolations(page, 'practice complete, 1440')
    // The hard problem is next in order, but the easier one comes first.
    await page.getByRole('status').filter({ hasText: 'Problem complete' }).getByRole('button', { name: 'Next problem' }).click()
    await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: 'Problem 3 of 3' })).toContainText('Easy squares')
  })

  test('a clean sweep offers a harder one, and a problem with nothing solved says so with a pointer', async ({ page }) => {
    test.setTimeout(150_000)
    const { course, topicId } = await open(page, 'q-sweep', [problem('Easy squares', 'easy'), problem('Medium squares', 'medium'), problem('Hard squares', 'hard')], true)
    await page.setViewportSize(DESKTOP)
    await check(page, '4')
    await button(page, 'Next step').click()
    await check(page, '9')
    await button(page, 'Finish').click()
    await expect(visible(page, 'Problem complete')).toBeVisible()
    await expect(button(page, 'A harder one')).toBeVisible()
    await button(page, 'A harder one').click()
    await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: 'Problem 2 of 3' })).toContainText('Medium squares')

    // The second problem: nothing solved, both answers shown after a miss.
    for (let step = 0; step < 2; step += 1) {
      await button(page, "I don't know").click()
      await openMoreHelp(page)
      await button(page, 'Show answer').click()
      await button(page, step === 0 ? 'Next step' : 'Finish').click()
    }
    await expect(visible(page, 'You solved 0 of 2 steps.')).toBeVisible()
    await expect(visible(page, /None of these came easily, which is common the first time\./)).toBeVisible()
    // The pointer is a link to the reader at the concept.
    const pointer = page.getByRole('link', { name: /Re-read Squares/ }).locator('visible=true')
    await expect(pointer).toBeVisible()
    expect(await pointer.getAttribute('href')).toContain(`/courses/${course.courseId}/topics/${topicId}?view=read&focus=`)
    await screenshotIfAsked(page, 'q-practice-none-solved-1440x900')
    await expectNoAxeViolations(page, 'practice complete, nothing solved, 1440')
    await page.setViewportSize(PHONE)
    await screenshotIfAsked(page, 'q-practice-none-solved-390x844')
    await expectNoAxeViolations(page, 'practice complete, nothing solved, 390')
    await expectNoSidewaysScroll(page, page.url())
  })
})

test.describe('worked examples: a full example viewed with a focus concept is instruction', () => {
  // These look at the whole example at once: the "See the steps" view (the default is "Try each step", one step at a time).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('margins.examplesStepMode', 'all'))
  })

  const example = (title: string) => ({
    title,
    difficulty: 'medium',
    problem_statement: `Square the numbers in ${title}.`,
    solution_steps: [1, 2, 3].map((n) => ({ step_number: n, description: `${title} step ${n}: multiply`, work: `Work ${n}.`, explanation: `Reason ${n}.` })),
    final_answer: `Final answer for ${title}.`,
    key_concepts: ['Squares'],
  })

  async function exampleCourse(page: Page, label: string) {
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, label, { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `${label} course`, [{ name: 'Squares' }])
    const topicId = course.topics.Squares
    const conceptId = await withPrisma(async (prisma) =>
      (await prisma.concept.create({ data: { projectId: course.courseId, topicId, name: 'Squares', summary: 'Multiplying a number by itself.', kind: 'concept', orderIndex: 0 } })).id
    )
    await addContent(topicId, { solved_examples: [example('Alpha'), example('Beta')].map((item) => ({ ...item, concept_ids: [conceptId] })) })
    const url = (query: string) => `/courses/${course.courseId}/topics/${topicId}?view=examples${query}`
    const events = () =>
      withPrisma(async (prisma) => {
        const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
        return prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'instruction' }, orderBy: { createdAt: 'asc' } })
      })
    return { url, events, conceptId }
  }

  test('a worked example shown in full writes a worked_example instruction event once a day', async ({ page }) => {
    test.setTimeout(120_000)
    const { url, events, conceptId } = await exampleCourse(page, 'q-instruct')
    await page.goto(url(`&fade=full&focus=${conceptId}`))
    await streamedPartsArrived(page)
    await expect(page.getByText('Alpha step 3: multiply').first()).toBeVisible()
    await expect.poll(async () => (await events()).map((row) => [row.itemKey.split(':').slice(0, 2).join(':'), row.assistance, row.weight])).toEqual([['instruction:worked_example', 3, 0]])
    // Seen again the same day: still one.
    await page.reload()
    await streamedPartsArrived(page)
    await expect(page.getByText('Alpha step 3: multiply').first()).toBeVisible()
    await page.waitForTimeout(500)
    expect(await events()).toHaveLength(1)
  })

  test('a partial example, or a full one with no focus concept, is not recorded as instruction', async ({ page }) => {
    test.setTimeout(120_000)
    const { url, events, conceptId } = await exampleCourse(page, 'q-noinstruct')
    await page.goto(url(`&fade=partial&focus=${conceptId}`))
    await streamedPartsArrived(page)
    await expect(page.getByRole('group', { name: 'Predict the next step' })).toHaveCount(1)
    await page.goto(url('&fade=full'))
    await streamedPartsArrived(page)
    await expect(page.getByText('Alpha step 3: multiply').first()).toBeVisible()
    await page.waitForTimeout(800)
    expect(await events()).toHaveLength(0)
  })

})
