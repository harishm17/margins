import type { Page } from '@playwright/test'
import { test, expect } from './harness/fixtures'
import { daysPass } from './harness/clock'
import { holdJobs } from './harness/hold'
import { openOnWarmup, readyCourse, signIn, startStudying, takeQuiz, takeWarmup, ZONE } from './harness/course'
import { buttonLikeActions, ESTIMATE, expectNone } from './harness/page-checks'
import { notStartedTopics } from './harness/surfaces'

// WF3: review and drill. A studied topic comes due the next day: today's review with misses, a reload and a second
// browser mid-session, the wait for fresh questions, the end screen, a drill, and "Fix it now" while the topic is due.

test('WF3 review and drill: Fix it now, a due review, a drill', async ({ page, checks, browser }, testInfo) => {
  const { courseUrl, email } = await readyCourse(page, 'WF3')
  await startStudying(page, courseUrl)
  const topicUrl = new URL(page.url()).pathname
  const main = page.locator('main')

  await test.step('a studied topic: warm-up, reading, a low quiz', async () => {
    await openOnWarmup(page, topicUrl)
    await takeWarmup(page)
    await page.goto(`${topicUrl}?view=read`)
    await page.getByRole('button', { name: "I've read it" }).click()
    await expect(page.getByText("You've read this topic.")).toBeVisible()
    await takeQuiz(page, topicUrl)
  })

  const neverOpened = await notStartedTopics(page, courseUrl)
  expect(neverOpened.length, 'topics the student never opened').toBeGreaterThan(0)

  await test.step('the next day: the review page', async () => {
    await daysPass(email)
    await page.goto(`${courseUrl}/review`)
    await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
    const due = main.getByRole('region', { name: /^Due for review/ })
    await expect(due.getByRole('listitem').first()).toBeVisible()
    const dueNames = await due.getByRole('listitem').getByRole('heading').allInnerTexts()
    await checks.check('WF3.never-opened-not-due', 'no topic the student never opened is due for review (G1)', () =>
      expectNone(neverOpened.filter((name) => dueNames.includes(name)), 'never-opened topics due')
    )
    const voice = main.getByRole('region', { name: 'Voice practice' })
    const weakest = (await voice.count()) ? await voice.innerText() : ''
    await checks.check('WF3.weakest-are-studied', 'voice practice picks its weakest topics from topics the student has studied (G1)', () =>
      expectNone(neverOpened.filter((name) => weakest.includes(name)), 'never-opened topics among the weakest')
    )
    const focus = main.getByRole('region', { name: "This week's focus" })
    const reasons = (await focus.getByRole('listitem').allInnerTexts()).map((item) => item.split('\n').find((line) => /mix-up/.test(line)) ?? '')
    await checks.check('WF3.focus-mix-ups-once', "each mix-up shows once in This week's focus (G7)", () =>
      expectNone(reasons.filter((reason, index) => reason && reasons.indexOf(reason) !== index), 'mix-ups repeated')
    )
  })

  await test.step('Fix it now on the due topic', async () => {
    // While the topic is due: after today's review nothing is, and the button is gone.
    await page.goto(`${courseUrl}/review`)
    const letGo = await holdJobs('generate_content')
    await main.getByRole('button', { name: /^Fix it now for / }).first().click()
    await expect(page).toHaveURL(/view=quiz/)
    await expect(main.getByRole('progressbar', { name: /^(Writing|Preparing)/ }).first()).toBeVisible({ timeout: 60_000 })
    const waitText = await main.innerText()
    await checks.check('WF3.fix-it-now-wait-estimate', 'the wait for a Fix it now set says about how long it takes (SW7)', () => expect(waitText).toMatch(ESTIMATE))
    await letGo()
    await expect(page.getByRole('button', { name: 'Start quiz' })).toBeVisible({ timeout: 4 * 60_000 })
  })

  /** Every question in a session offers "How sure are you?" (Q3). */
  const withoutConfidence: string[] = []
  async function noteConfidence(where: string) {
    const row = page.locator('[data-question]').getByRole('radiogroup', { name: /How sure are you/ })
    if (!(await row.isVisible())) withoutConfidence.push(where)
  }

  // The wait for fresh questions is read the first time a session shows one: a review whose questions are not written
  // yet, or a drill that writes more. Until then the jobs that write them are held, so the wait stays on screen.
  let waitRead = false
  let release: (() => Promise<void>) | null = null
  async function letJobsGo() {
    await release?.()
    release = null
  }

  /** Answers a session wrong to its end; `onMiss` runs on each miss's feedback. Returns the size each question showed. */
  async function answerSession(kind: 'review' | 'drill', onMiss?: (at: number, of: number) => Promise<void>): Promise<number[]> {
    const session = sessionScreen(page)
    const sizes: number[] = []
    for (;;) {
      await expect(session.heading.or(session.done).or(session.wait).first()).toBeVisible({ timeout: 4 * 60_000 })
      if (await session.wait.isVisible()) {
        if (release) {
          const waitText = await main.innerText()
          await checks.check('WF3.follow-up-wait-estimate', 'the wait for fresh questions says about how long it takes (SW7)', () =>
            expect(waitText).toMatch(ESTIMATE)
          )
          waitRead = true
          await letJobsGo()
        }
        await expect(session.wait).toBeHidden({ timeout: 4 * 60_000 })
        continue
      }
      if (!(await session.heading.isVisible())) break
      const { at, of } = await session.place()
      sizes.push(of)
      await noteConfidence(`${kind} question ${at}`)
      await answerWrong(page)
      await page.getByRole('button', { name: 'Check answer' }).click()
      if ((await session.afterCheck(at)) === 'moved') continue
      await onMiss?.(at, of)
      await session.next.click()
      await session.leaves(at)
    }
    await letJobsGo()
    return sizes
  }

  await test.step("today's review: misses, a reload, a second browser", async () => {
    await page.goto(`${courseUrl}/review`)
    release = await holdJobs('generate_review_items')
    await page.getByRole('link', { name: "Start today's review" }).click()
    const heading = sessionScreen(page).heading
    let announced = 0
    let resumeChecked = false
    await answerSession('review', async (at, of) => {
      announced = Math.max(announced, Number((await heading.innerText()).match(/\(\+(\d+) to retest\)/)?.[1] ?? 0))
      if (resumeChecked || at < 2 || at === of) return
      resumeChecked = true
      await page.reload()
      await checks.check('WF3.position-after-reload', 'a reload keeps the feedback the student was reading (SW10)', () =>
        expect(sessionScreen(page).feedback(at)).toBeVisible({ timeout: 30_000 })
      )
      const second = await browser.newContext({ baseURL: testInfo.project.use.baseURL, timezoneId: ZONE, viewport: { width: 1440, height: 900 } })
      const other = await second.newPage()
      await signIn(other, email)
      await other.goto(`${courseUrl}/review`)
      await other.getByRole('link', { name: /^Resume today's review/ }).click()
      await checks.check('WF3.position-second-browser', 'a second browser opens the session on the feedback the student was reading (SW10)', () =>
        expect(sessionScreen(other).feedback(at)).toBeVisible({ timeout: 30_000 })
      )
      await second.close()
    })
    expect(resumeChecked, 'the review had a miss to come back to').toBe(true)

    const served = Number((await main.innerText()).match(/of (\d+) fresh retests? right/)?.[1] ?? 0)
    await checks.check('WF3.retests-as-announced', 'the retests the header announces are the retests that come (S4)', () => expect(served).toBe(announced))
    const actions = await buttonLikeActions(main)
    await checks.check('WF3.review-end-one-action', 'the review end screen has one main action; the rest are links (R1)', () =>
      expect(actions).toEqual({ filled: [expect.any(String)], outlined: [] })
    )
  })

  await test.step("a drill from the topic's next step", async () => {
    // Missed twice in a row, an idea's next step is a drill on it ("Practise the gap") or on what it builds on.
    await page.goto(topicUrl)
    await page.waitForLoadState('networkidle')
    if (!waitRead) release = await holdJobs('generate_review_items')
    const nextStep = main.getByRole('link', { name: /^Practise the (gap|basics)/ })
    if (await nextStep.count()) await nextStep.first().click()
    else {
      console.log("note: the topic's next step is not a drill, so the drill starts from This week's focus")
      await page.goto(`${courseUrl}/review`)
      // With nothing due, the focus is folded under "Keep studying (optional)".
      const keepStudying = main.getByText('Keep studying (optional)')
      if (await keepStudying.isVisible()) await keepStudying.click()
      await main.getByRole('link', { name: /^Practice this: / }).first().click()
    }
    const sizes = await answerSession('drill')
    expect(waitRead, 'the review or the drill wrote fresh questions, and its wait was read').toBe(true)
    await checks.check('WF3.drill-size-known', 'a drill says its whole size at the start (S4)', () => expect(Math.max(...sizes)).toBe(sizes[0]))
    const actions = await buttonLikeActions(main)
    await checks.check('WF3.drill-end-one-action', 'the drill end screen has one main action; the rest are links (R1)', () =>
      expect(actions).toEqual({ filled: [expect.any(String)], outlined: [] })
    )
    await checks.check('WF3.confidence-every-question', 'every review and drill question offers "How sure are you?" (Q3)', () =>
      expectNone(withoutConfidence, 'questions without a confidence row')
    )
  })

  await test.step('practice: a step with answer options', async () => {
    await page.goto(`${topicUrl}?view=practice`)
    await expect(main.getByRole('radiogroup', { name: /^(Answer options|True or false)$/ }).first()).toBeVisible({ timeout: 4 * 60_000 })
    await checks.check('WF3.practice-confidence', 'a practice step with answer options offers "How sure are you?" (Q3)', () =>
      expect(main.getByRole('radiogroup', { name: /How sure are you/ }).first()).toBeVisible({ timeout: 1000 })
    )
  })
})

/** What a student reads in a review or drill session. */
function sessionScreen(page: Page) {
  const heading = page.getByRole('heading', { level: 1, name: /^Question \d+ of \d+/ })
  const done = page.getByRole('heading', { level: 1, name: /^(Review|Drill) done$/ })
  // "Writing a fresh question on what you missed" or "Writing your questions", in a status.
  const wait = page.locator('main').getByRole('status').filter({ hasText: /^Writing / })
  const next = page.getByRole('button', { name: /^(Next question|Continue|See session summary)$/ })
  const feedback = (at: number) => page.getByText(new RegExp(`Feedback for question ${at}\\.$`))
  /** The question on screen ("Question 3 of 4"), or null when none is. */
  const shown = async () => {
    const text = (await heading.count()) ? await heading.first().textContent() : null
    const match = text?.match(/^Question (\d+) of (\d+)/)
    return match ? { at: Number(match[1]), of: Number(match[2]) } : null
  }
  /** The question has gone: the next one, the wait for fresh ones, or the end. */
  const gone = async (at: number) => (await done.isVisible()) || (await wait.isVisible()) || ((await shown())?.at ?? at) !== at
  /** After "Check answer": feedback on a miss, or "moved" when a right answer went straight on. */
  const outcome = async (at: number) => ((await feedback(at).isVisible()) ? 'feedback' : (await gone(at)) ? 'moved' : null)
  return {
    heading,
    done,
    wait,
    next,
    feedback,
    place: async () => (await shown()) ?? { at: 0, of: 0 },
    afterCheck: async (at: number) => {
      await expect.poll(() => outcome(at), { timeout: 2 * 60_000 }).not.toBeNull()
      return outcome(at)
    },
    leaves: async (at: number) => expect.poll(() => gone(at), { timeout: 4 * 60_000 }).toBe(true),
  }
}

/** A wrong answer, the same every run: the first option, or a sentence that misses the point. */
async function answerWrong(page: Page) {
  const question = page.locator('[data-question]')
  const options = question.getByRole('radiogroup', { name: /^(Answer options|True or false)$/ })
  if (await options.isVisible()) await options.getByRole('radio').first().click()
  else await question.getByRole('textbox').first().fill('It keeps the invariant at every step.')
}
