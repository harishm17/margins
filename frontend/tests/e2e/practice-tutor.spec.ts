import { expect, test, type Page } from '@playwright/test'
import { openMoreHelp, workingBox } from './helpers/practice'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { addContent, createCourse, practiceProblem, signUpAndIn } from './helpers/loop'
import { expectClearOfTabBar } from './helpers/overflow'

// "Ask about my working" in practice (spec §5.6, §6.2): the tutor panel under a step, the one-time offer
// after two wrong checks, "What is this asking?", and the worked example. The AI service is the mock,
// whose tutor always answers with one question, so nothing here costs anything.

const tutoredProblem = (title: string, conceptId?: string) => {
  const problem = practiceProblem(title)
  return {
    ...problem,
    steps: problem.steps.map((step) => ({
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
const tryAgain = (page: Page) => page.getByRole('button', { name: 'Try again' }).locator('visible=true').click()
const workedButton = (page: Page) => page.getByRole('button', { name: /Show me a worked example/ }).locator('visible=true')
const askButton = (page: Page) => page.getByRole('button', { name: 'Ask about my working' }).locator('visible=true')
const clarifyButton = (page: Page) => page.getByRole('button', { name: 'What is this asking?' }).locator('visible=true')
// Before a first try the helps sit behind one "Get help" button; after a miss they are in view.
const openHelp = async (page: Page) => {
  const toggle = page.getByRole('button', { name: 'Get help' }).locator('visible=true')
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
}
const offer = (page: Page) => page.getByText('Want to talk it through?').locator('visible=true')
const thread = (page: Page) => page.getByRole('log', { name: 'Tutor conversation' }).locator('visible=true')

async function open(
  page: Page,
  label: string,
  conceptOf?: (projectId: string, topicId: string) => Promise<string>,
  options: { own?: boolean } = {}
) {
  await signUpAndIn(page, label, options)
  const course = await createCourse(page, `${label} course`, [{ name: 'Squares' }])
  const topicId = course.topics.Squares
  const conceptId = conceptOf ? await conceptOf(course.courseId, topicId) : undefined
  await addContent(topicId, { interactive_examples: [tutoredProblem('Squares', conceptId)] })
  await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=practice`)
  // Before a first try the help is one button, "Get help", under Check; these specs use it, so it is opened here.
  await expect(page.getByRole('button', { name: 'Check', exact: true })).toBeVisible()
  await openHelp(page)
  await expect(clarifyButton(page)).toBeVisible()
  return { course, topicId }
}

// The spec file shares one account, so rows are looked up by the topic's practice content.
const tutorRows = (userEmail: string, topicId: string) =>
  withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: userEmail }, select: { id: true } })
    const content = await prisma.topicContent.findUniqueOrThrow({
      where: { topicId_contentType: { topicId, contentType: 'interactive_examples' } },
      select: { id: true },
    })
    return prisma.tutorState.findMany({ where: { userId: user.id, scope: 'practice', scopeKey: { startsWith: `${content.id}:` } } })
  })

const accountEmail = async (page: Page) => (await (await page.request.get('/api/auth/session')).json()).user.email as string

test.describe('the practice tutor', () => {
  test('after a miss the help stays in view: hints fold to a line, Try again stays primary', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-dense')
    const hint = (name: string) => page.getByRole('button', { name: `Hint: ${name}` }).locator('visible=true')
    const getHelp = page.getByRole('button', { name: 'Get help' }).locator('visible=true')

    // Before a first try the help is one button (open here by `open`): one hint ladder, with the next hint only.
    await expect(getHelp).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('group', { name: 'Hints' }).locator('visible=true').getByRole('button')).toHaveCount(1)
    await page.getByRole('button', { name: /Next hint: Locate/ }).click()
    await expect(hint('Locate')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Look at the number.').locator('visible=true')).toBeVisible()
    // The next hint waits for an attempt and says so; it is not a second button of costs.
    await expect(page.getByRole('button', { name: /Next hint: Connect/ }).locator('visible=true')).toBeDisabled()
    await expect(page.getByRole('button', { name: /Next hint: Connect/ }).locator('visible=true')).toContainText('Opens after your first try')
    // Connect waits for an attempt (spec 18.4): a wrong check opens it.
    await check(page, '5')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    // After a miss the helps are open, not behind "Get help" (spec 18.4).
    await expect(getHelp).toHaveCount(0)
    await tryAgain(page)
    // The next hint stays beside Check for a step that has been missed.
    await expect(page.getByRole('button', { name: /Next hint: Connect/ }).locator('visible=true')).toBeVisible()
    await page.getByRole('button', { name: /Next hint: Connect/ }).click()
    // The newest hint is open, the one before it is a line that opens on a tap.
    await expect(hint('Connect')).toHaveAttribute('aria-expanded', 'true')
    await expect(hint('Locate')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('Look at the number.').locator('visible=true')).toHaveCount(0)
    await hint('Locate').click()
    await expect(page.getByText('Look at the number.').locator('visible=true')).toBeVisible()
    await hint('Locate').click()
    await expect(page.getByText('Look at the number.').locator('visible=true')).toHaveCount(0)

    // A miss: the authored feedback stays, nothing leaks the answer, Try again is the one primary button.
    await check(page, '5')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await expect(page.getByText('Not that one.').locator('visible=true')).toBeVisible()
    await expect(page.getByText('Check your units').locator('visible=true')).toHaveCount(0)
    await expect(getHelp).toHaveCount(0)
    await expect(clarifyButton(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' }).locator('visible=true')).toBeVisible()
    for (const [name, size] of [
      ['1440x900', { width: 1440, height: 900 }],
      ['390x844', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(size)
      await screenshotIfAsked(page, `practice-folded-after-miss-${name}`)
      await expectNoAxeViolations(page, `${name}, practice after a miss, helps folded`)
      if (size.width < 500) await expectClearOfTabBar(page, page.getByRole('button', { name: 'Try again' }).locator('visible=true'), 'Try again')
    }

    // A wrong number, even a power of ten off, gets no note (it would confirm the digits); only a non-number is told so.
    await tryAgain(page)
    await check(page, '40')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await expect(page.getByText('Check your units').locator('visible=true')).toHaveCount(0)
    await expect(page.getByText('Your answer should be a number').locator('visible=true')).toHaveCount(0)
    await tryAgain(page)
    await check(page, 'four')
    await expect(page.getByText('Your answer should be a number. A unit after it is fine.').locator('visible=true')).toBeVisible()
  })

  test('worked example button disabled before an attempt', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-worked')
    // Not a disabled button: it is not there until the first try. One sentence says what opens, and when.
    await expect(workedButton(page)).toHaveCount(0)
    await expect(page.getByText("Check an answer first, or say you don't know, to open the later hints, a worked example and questions about your working.").locator('visible=true')).toBeVisible()
    // A wrong check is an attempt.
    await check(page, '5')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await openHelp(page)
    await expect(workedButton(page)).toBeEnabled()
    // What it costs is on the button once it can be used.
    await expect(page.getByText('This step will count as a miss, and comes back later').locator('visible=true')).toBeVisible()
  })

  test('tutor offers to talk after two wrong checks and never interrupts before', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-offer')
    // Nothing before any check, and nothing after the first wrong one.
    await expect(offer(page)).toHaveCount(0)
    await check(page, '5')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await expect(offer(page)).toHaveCount(0)
    await expect(thread(page)).toHaveCount(0)
    await tryAgain(page)
    await check(page, '6')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await expect(offer(page)).toBeVisible()
    // The student decides: not now. It does not come back for this step.
    await page.getByRole('button', { name: 'Not now' }).locator('visible=true').click()
    await expect(offer(page)).toHaveCount(0)
    await tryAgain(page)
    await check(page, '7')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await expect(offer(page)).toHaveCount(0)
    // The third failed attempt is the one time the worked example is mentioned (spec 6.2); no reply is written.
    const mention = page.getByText('you can ask for a worked example of a similar problem').locator('visible=true')
    await expect(mention).toHaveCount(1)
    await expect(thread(page).getByText('(mock)')).toHaveCount(0)
    await tryAgain(page)
    await check(page, '8')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await expect(offer(page)).toHaveCount(0)
    await expect(mention).toHaveCount(1)
  })

  test('accepting the offer opens a conversation that starts by asking what they tried', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-accept')
    await check(page, '5')
    await tryAgain(page)
    await check(page, '6')
    await expect(offer(page)).toBeVisible()
    await page.getByRole('button', { name: 'Yes, talk it through' }).locator('visible=true').click()
    await expect(thread(page)).toContainText('Tutor')
    await expect(thread(page)).toContainText('?')
    await expect(offer(page)).toHaveCount(0)
  })

  test('tutor replies with one question', async ({ page }) => {
    test.setTimeout(120_000)
    const { topicId } = await open(page, 'tutor-reply')
    const email = await accountEmail(page)
    await check(page, '5')
    await openHelp(page)
    await expect(askButton(page)).toBeDisabled()
    await (await workingBox(page)).fill('I multiplied 2 by 3 because I thought squaring adds one.')
    await expect(askButton(page)).toBeEnabled()
    await askButton(page).click()
    await expect(thread(page)).toContainText('You')
    await expect(thread(page)).toContainText('I multiplied 2 by 3')
    const reply = thread(page).getByText(/\?/).last()
    await expect(reply).toBeVisible()
    const text = (await thread(page).innerText()).split('Tutor').pop() ?? ''
    expect((text.match(/\?/g) ?? []).length).toBe(1)
    // The working box is empty again for the next turn.
    await expect(await workingBox(page)).toHaveValue('')
    // One wrong check and one piece of reasoning: two attempts on the step's ladder, keyed by content, problem and step.
    await expect.poll(async () => (await tutorRows(email, topicId)).map((row) => [row.attempts, row.scopeKey.split(':').slice(1).join(':')])).toEqual([[2, '0:0']])
  })

  test('"What is this asking?" is free: no rung, no attempt, no mark on the step', async ({ page }) => {
    test.setTimeout(120_000)
    const { topicId } = await open(page, 'tutor-clarify')
    const email = await accountEmail(page)
    await clarifyButton(page).click()
    await expect(thread(page)).toContainText('Tutor')
    await expect.poll(async () => (await tutorRows(email, topicId)).map((row) => [row.rung, row.attempts, row.lowEffortTurns])).toEqual([[0, 0, 0]])
    // The step has no hint or rung on it, so Show answer is still waiting for an attempt (it is not offered before one).
    await expect(page.getByRole('button', { name: 'Show answer' }).locator('visible=true')).toHaveCount(0)
  })

  test('the worked example surrenders the step: level 3, flagged, and the problem stays open', async ({ page }) => {
    test.setTimeout(120_000)
    const { topicId } = await open(page, 'tutor-surrender', async (projectId, topic) => {
      const concept = await withPrisma((prisma) =>
        prisma.concept.create({ data: { projectId, topicId: topic, name: 'Squares', summary: 'Multiplying a number by itself.', kind: 'concept', orderIndex: 0 } })
      )
      return concept.id
    })
    const email = await accountEmail(page)
    await check(page, '5')
    await openHelp(page)
    await workedButton(page).click()
    await expect(thread(page)).toContainText('Worked example')
    // Recorded once, at level 3, flagged for the closing retest.
    const events = () =>
      withPrisma(async (prisma) => {
        const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
        return prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'practice', topicId } })
      })
    await expect.poll(async () => (await events()).map((row) => [row.assistance, (row.metadata as { surrendered?: boolean }).surrendered])).toEqual([[3, true]])
    await expect
      .poll(async () => (await (await page.request.get(`/api/topics/${topicId}/practice-progress`)).json()).problems[0]?.maxRungs)
      .toEqual({ '0': 5 })
    // The problem stays open: the student can still finish the step.
    await tryAgain(page)
    await check(page, '4')
    await expect(page.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
  })

  test('practice evidence follows what the tutor recorded: a locate hint after a miss and one before a first try both score level 0 at 0.6 (spec 18.4)', async ({ page }) => {
    test.setTimeout(120_000)
    const { topicId } = await open(page, 'tutor-evidence', (projectId, topic) =>
      withPrisma(async (prisma) => {
        const concept = await prisma.concept.create({ data: { projectId, topicId: topic, name: 'Squares', summary: 'Multiplying a number by itself.', kind: 'concept', orderIndex: 0 } })
        return concept.id
      }),
      // Its own account: the tutor allows 20 calls a minute to one student, and the specs of this file share one.
      { own: true }
    )
    const email = await accountEmail(page)
    // Step one: a wrong check at no help, then the locate hint, then the right answer.
    await check(page, '5')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await tryAgain(page)
    await page.getByRole('button', { name: /Locate/ }).click()
    await check(page, '4')
    await expect(page.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
    await page.getByRole('button', { name: 'Next step' }).locator('visible=true').click()
    // Step two: the locate hint first, then the right answer on the first try.
    await openHelp(page)
    await page.getByRole('button', { name: /Next hint: Locate/ }).click()
    await check(page, '9')
    await expect(page.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()

    // The server's own record of each step is what the evidence was written from (the page sends only which steps are done).
    const states = (await tutorRows(email, topicId)).map((row) => ({ step: Number(row.scopeKey.split(':').pop()), helpRung: row.helpRung, firstMissRung: row.firstMissRung, wrongChecks: row.wrongChecks, checkedAnswer: row.checkedAnswer }))
    expect(states.sort((a, b) => a.step - b.step)).toEqual([
      { step: 0, helpRung: 1, firstMissRung: 0, wrongChecks: 1, checkedAnswer: '4' },
      { step: 1, helpRung: 1, firstMissRung: null, wrongChecks: 0, checkedAnswer: '9' },
    ])
    const rows = () =>
      withPrisma(async (prisma) => {
        const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
        return prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'practice', topicId }, orderBy: { itemKey: 'asc' } })
      })
    await expect.poll(async () => (await rows()).length, { timeout: 30_000 }).toBe(2)
    const [first, second] = await rows()
    expect([first.assistance, first.score]).toEqual([0, 0.6])
    expect([second.assistance, second.score]).toEqual([0, 0.6])
  })

  test('a tutor that fails shows a message and practice stays usable', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-fail')
    await page.route('**/api/topics/*/practice-tutor', async (route) => {
      if (route.request().postDataJSON()?.event === 'clarify') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: 'x', details: { code: 'LLM_UNAVAILABLE', retryable: true } } }),
        })
      } else await route.continue()
    })
    await clarifyButton(page).click()
    await expect(page.getByText('AI is busy', { exact: true }).locator('visible=true')).toBeVisible()
    // Checking an answer still works.
    await check(page, '4')
    await expect(page.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
  })

  test('a rate limited tutor says to wait', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-limit')
    await page.route('**/api/topics/*/practice-tutor', async (route) => {
      if (route.request().postDataJSON()?.event === 'clarify') {
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'retry-after': '30' },
          body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'You are asking quickly. Wait a moment, then try again.', details: { code: 'RATE_LIMITED', retryable: true } } }),
        })
      } else await route.continue()
    })
    await clarifyButton(page).click()
    await expect(page.getByText('You are asking quickly').locator('visible=true')).toBeVisible()
  })

  test('the server allows 20 tutor calls a minute and then asks to wait', async ({ page }) => {
    test.setTimeout(120_000)
    const { topicId } = await open(page, 'tutor-rate', undefined, { own: true })
    const statuses: number[] = []
    for (let i = 0; i < 22; i++) {
      const response = await page.request.post(`/api/topics/${topicId}/practice-tutor`, {
        data: { problemIndex: 0, problemTitle: 'Squares', stepIndex: 0, event: 'clarify' },
      })
      statuses.push(response.status())
    }
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBeTruthy()
    expect(statuses.slice(20)).toEqual([429, 429])
  })

  test('while AI is unavailable the tutor controls are hidden and the hints still work', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-off')
    const now = new Date()
    const row = { state: 'unavailable', reason: 'LLM_CREDIT_EXHAUSTED', since: now, checkedAt: now, detail: 'e2e' }
    await withPrisma((prisma) => prisma.aiStatus.upsert({ where: { id: 'global' }, create: { id: 'global', ...row }, update: row }))
    try {
      await page.reload()
      await openHelp(page)
      await expect(await workingBox(page)).toBeVisible()
      await expect(clarifyButton(page)).toHaveCount(0)
      await expect(askButton(page)).toHaveCount(0)
      await expect(workedButton(page)).toHaveCount(0)
      await expect(page.getByText('AI features are paused right now. Your files and progress are safe. Try again later.').locator('visible=true').first()).toBeVisible()
      await page.getByRole('button', { name: /Locate/ }).click()
      await expect(page.getByText('Look at the number.').locator('visible=true')).toBeVisible()
    } finally {
      await withPrisma((prisma) => prisma.aiStatus.deleteMany({}))
    }
  })

  test('ask about my working waits for a checked answer', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-effort')
    const working = await workingBox(page)
    await working.fill('I think the square is the number times itself.')
    // Text alone is not enough: effort first, one checked answer opens it (right or wrong). Before it the button is not drawn.
    await openHelp(page)
    await expect(askButton(page)).toHaveCount(0)
    await expect(page.getByText("Check an answer first, or say you don't know, to open the later hints, a worked example and questions about your working.").locator('visible=true')).toBeVisible()
    await check(page, '5')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await openHelp(page)
    await expect(askButton(page)).toBeEnabled()
  })

  test("the tutor's events reach the server in the order the student made them: a check is recorded before the question after it", async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-order')
    const seen: string[] = []
    let releaseCheck!: () => void
    const held = new Promise<void>((resolve) => (releaseCheck = resolve))
    await page.route('**/api/topics/*/practice-tutor', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const event = (route.request().postDataJSON() as { event: string }).event
      seen.push(`start:${event}`)
      // The check's answer is slow; the student asks while it is on its way.
      if (event === 'check') await held
      const response = await route.fetch()
      seen.push(`done:${event}`)
      await route.fulfill({ response })
    })
    const working = await workingBox(page)
    await working.fill('I think the square is the number times itself.')
    await check(page, '5')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await openHelp(page)
    await expect(askButton(page)).toBeEnabled()
    await askButton(page).click()
    await expect(page.getByText('Thinking…').locator('visible=true')).toBeVisible()
    releaseCheck()
    await expect(thread(page).getByText('Tutor', { exact: true })).toBeVisible({ timeout: 30_000 })
    expect(seen).toEqual(['start:check', 'done:check', 'start:ask', 'done:ask'])
  })

  test('a reload keeps what the server saw: the offer and the worked example are still there', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-reload')
    await check(page, '5')
    await tryAgain(page)
    // The server holds the count of wrong checks; the page goes away only once it has answered the second one.
    const recorded = page.waitForResponse((response) => response.url().includes('/practice-tutor') && response.request().method() === 'POST')
    await check(page, '6')
    await expect(offer(page)).toBeVisible()
    await recorded
    await page.reload()
    // The server's count of two wrong checks is what shows the offer again: the page itself starts from nothing.
    await openMoreHelp(page)
    await expect(workedButton(page)).toBeEnabled()
    await expect(offer(page)).toBeVisible()
    // Not now is remembered across a reload too.
    await page.getByRole('button', { name: 'Not now' }).locator('visible=true').click()
    await page.reload()
    await openMoreHelp(page)
    await expect(workedButton(page)).toBeEnabled()
    await expect(offer(page)).toHaveCount(0)
  })

  test('check my understanding: one transfer question after a step solved with help, then a reply to the answer', async ({ page }) => {
    test.setTimeout(120_000)
    const { topicId } = await open(page, 'tutor-confirm')
    // No help taken: nothing to confirm.
    await check(page, '4')
    await expect(page.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check my understanding' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Next step' }).locator('visible=true').click()
    // Step two: a hint, then the right answer.
    await openHelp(page)
    await page.getByRole('button', { name: /Next hint: Locate/ }).click()
    await check(page, '9')
    await expect(page.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
    const confirm = page.getByRole('button', { name: 'Check my understanding' }).locator('visible=true')
    await expect(confirm).toBeVisible()
    await confirm.click()
    await expect(thread(page)).toContainText('Tutor')
    await expect(thread(page).getByText('(mock)')).toHaveCount(1)
    // They answer it; the tutor replies, and the thread holds both.
    await page.getByLabel('Your answer to the question').locator('visible=true').fill('It would still work: any number times itself.')
    await page.getByRole('button', { name: 'Send answer' }).locator('visible=true').click()
    await expect(thread(page)).toContainText('any number times itself')
    await expect(thread(page).getByText('(mock)')).toHaveCount(2)
    for (const [name, size] of [
      ['1440x900', { width: 1440, height: 900 }],
      ['390x844', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(size)
      await screenshotIfAsked(page, `tutor-${name}-confirm`)
      await expectNoAxeViolations(page, `${name}, check my understanding`)
    }
    // Nothing is recorded beyond the step (these steps have no concept, so no evidence at all).
    expect(await withPrisma((prisma) => prisma.evidenceEvent.count({ where: { topicId } }))).toBe(0)
    // The server's record: the right answer was given, so a reply may confirm it (final_allowed).
    const state = await (await page.request.get(`/api/topics/${topicId}/practice-tutor?problemIndex=0&problemTitle=Squares&stepIndex=1`)).json()
    expect(state.state).toMatchObject({ checks: 1, wrongChecks: 0, checkedCorrect: true })
  })

  test('with AI unavailable the third failed attempt does not mention a button that is not there', async ({ page }) => {
    test.setTimeout(120_000)
    await signUpAndIn(page, 'tutor-nomention')
    const course = await createCourse(page, 'No mention course', [{ name: 'Squares' }])
    await addContent(course.topics.Squares, { interactive_examples: [tutoredProblem('Squares')] })
    const now = new Date()
    const row = { state: 'unavailable', reason: 'LLM_CREDIT_EXHAUSTED', since: now, checkedAt: now, detail: 'e2e' }
    await withPrisma((prisma) => prisma.aiStatus.upsert({ where: { id: 'global' }, create: { id: 'global', ...row }, update: row }))
    try {
      await page.goto(`/courses/${course.courseId}/topics/${course.topics.Squares}?view=practice`)
      for (const value of ['5', '6', '7']) {
        await check(page, value)
        await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
        await tryAgain(page)
      }
      await page.waitForLoadState('networkidle')
      await expect(page.getByText('you can ask for a worked example')).toHaveCount(0)
      await expect(thread(page)).toHaveCount(0)
      await expect(offer(page)).toHaveCount(0)
    } finally {
      await withPrisma((prisma) => prisma.aiStatus.deleteMany({}))
    }
  })

  test('failures are told apart: a stale practice and a refused request are plain messages, and a later check clears one', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'tutor-kinds')
    let refused = false
    await page.route('**/api/topics/*/practice-tutor', async (route) => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON()?.event !== 'clarify') return route.continue()
      await route.fulfill({
        status: refused ? 422 : 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'X', message: 'x', details: { code: refused ? 'TUTOR_REJECTED' : 'STALE_PRACTICE' } } }),
      })
    })
    await clarifyButton(page).click()
    await expect(page.getByText('This practice changed', { exact: true }).locator('visible=true')).toBeVisible()
    await expect(page.getByText('AI is busy', { exact: true })).toHaveCount(0)
    refused = true
    await clarifyButton(page).click()
    await expect(page.getByText('The tutor could not take that', { exact: true }).locator('visible=true')).toBeVisible()
    await expect(page.getByText('AI is busy', { exact: true })).toHaveCount(0)
    // A later successful check clears the message.
    await check(page, '5')
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await expect(page.getByText('The tutor could not take that', { exact: true })).toHaveCount(0)
  })

  test('the tutor panel: no axe violations at desktop and phone width, screenshots on request', async ({ page }) => {
    test.setTimeout(180_000)
    await open(page, 'tutor-axe')
    for (const [name, size] of [
      ['1440x900', { width: 1440, height: 900 }],
      ['390x844', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(size)
      await page.evaluate(() => localStorage.clear())
      await page.request.post(`/api/topics/${await topicIdOf(page)}/practice-progress`, {
        data: { problemIndex: 0, problemTitle: 'Squares', solvedSteps: [], revealedSteps: [], hintedSteps: [], attemptedSteps: [], firstTrySteps: [], maxRungs: {}, missRungs: {} },
      })
      await page.reload()
      await openHelp(page)
      await expect(clarifyButton(page)).toBeVisible()
      await screenshotIfAsked(page, `tutor-${name}-start`)
      await expectNoAxeViolations(page, `${name}, start`)

      await check(page, '5')
      await tryAgain(page)
      await check(page, '6')
      await expect(offer(page)).toBeVisible()
      await screenshotIfAsked(page, `tutor-${name}-offer`)
      await expectNoAxeViolations(page, `${name}, offer`)

      await page.getByRole('button', { name: 'Yes, talk it through' }).locator('visible=true').click()
      await expect(thread(page)).toBeVisible()
      await openHelp(page)
      await (await workingBox(page)).fill('I squared by adding the number to itself.')
      await askButton(page).click()
      await expect(thread(page)).toContainText('I squared by adding')
      await workedButton(page).click()
      await expect(thread(page)).toContainText('Worked example')
      await screenshotIfAsked(page, `tutor-${name}-thread`)
      await expectNoAxeViolations(page, `${name}, conversation`)

      await page.route('**/api/topics/*/practice-tutor', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: 'x', details: { code: 'LLM_UNAVAILABLE', retryable: true } } }),
        })
      )
      await clarifyButton(page).click()
      await expect(page.getByText('AI is busy', { exact: true }).locator('visible=true')).toBeVisible()
      await screenshotIfAsked(page, `tutor-${name}-failure`)
      await expectNoAxeViolations(page, `${name}, failure`)
      await page.unroute('**/api/topics/*/practice-tutor')
    }
  })
})

/** The topic id from the page address. */
async function topicIdOf(page: Page): Promise<string> {
  const match = /\/topics\/([^/?]+)/.exec(page.url())
  if (!match) throw new Error('not on a topic page')
  return match[1]
}
