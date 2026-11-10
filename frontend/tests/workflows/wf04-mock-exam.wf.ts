import type { Page } from '@playwright/test'
import { test, expect } from './harness/fixtures'
import { daysPass } from './harness/clock'
import { holdJobs } from './harness/hold'
import { chooseFiles, FILES, openOnWarmup, readyCourse, signIn, startStudying, takeQuiz, takeWarmup, ZONE } from './harness/course'
import { copiedHeaders, courseTopics, differing, examQuestions, nameProblems, orderProblems, type ExamQuestion } from './harness/exams'
import { cutOffText, ESTIMATE, expectNone, unrendered } from './harness/page-checks'
import { notStartedTopics, readSurfaces, stateChanges, type Reading } from './harness/surfaces'

// WF4: a mock exam. One topic studied and a past exam added, then an exam over that topic and two the student never
// opened: the form, the wait while it is written, taking it (a flag, a reload, a second browser), submitting with the
// unopened topics' questions left blank, the results, and what the blanks did to those topics that day and the next.

/** A duration as the app writes one: "1 hr", "45 min", "1 hr 30 min", "60 minutes". */
const DURATION = /\d+ hr(?: \d+ min)?|\d+ min(?:utes)?/
const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('WF4 mock exam: the form, the wait, taking it, results with blanks', async ({ page, checks, browser }, testInfo) => {
  // A first recording reads a past exam and writes an exam with the real model: minutes more than a replay.
  test.setTimeout(30 * 60_000)
  const { courseUrl, courseId, email } = await readyCourse(page, 'WF4')
  await startStudying(page, courseUrl)
  const topicUrl = new URL(page.url()).pathname
  const studiedId = topicUrl.split('/').pop() ?? ''
  const main = page.locator('main')

  await test.step('a studied topic: warm-up, reading, a quiz', async () => {
    await openOnWarmup(page, topicUrl)
    await takeWarmup(page)
    await page.goto(`${topicUrl}?view=read`)
    await page.getByRole('button', { name: "I've read it" }).click()
    await expect(page.getByText("You've read this topic.")).toBeVisible()
    await takeQuiz(page, topicUrl)
  })

  const topics = await courseTopics(courseId)
  const studied = topics.find((topic) => topic.id === studiedId)?.name ?? ''
  const neverOpened = await notStartedTopics(page, courseUrl)

  await test.step('a past exam added', async () => {
    // After the quiz: the topic's own questions were written before the past exam's style existed, as in WF2 and WF3.
    await page.goto(`${courseUrl}/materials`)
    await chooseFiles(page, [FILES.pastExam], 'Past exams')
    await expect(main.getByText('Ready', { exact: true })).toHaveCount(3, { timeout: 5 * 60_000 })
  })

  const tileOf = (name: string) => main.locator('label').filter({ has: page.getByText(name, { exact: true }) })
  /** The never-opened topics the exam covers: their questions are left blank. */
  const chosen: string[] = []
  const durations: { surface: string; value: string }[] = []
  const form = { questions: '10', time: '1 hr' }

  await test.step('the form', async () => {
    await page.goto(`${courseUrl}/exams/new`)
    // A job reads the past exam's style after the upload; once it is done the form's summary says the exam follows it.
    const styled = page.getByTestId('exam-preset').filter({ hasText: 'in the style of your past exams' })
    await expect
      .poll(
        async () => {
          if (await styled.isVisible()) return true
          await page.reload()
          await page.waitForLoadState('networkidle')
          return styled.isVisible()
        },
        { timeout: 5 * 60_000, intervals: [5_000] }
      )
      .toBe(true)
    const cut = await cutOffText(main)
    await checks.check('WF4.form-names-whole', 'the form shows every topic name whole (SW6)', () => expectNone(cut, 'cut off'))

    await main.getByRole('button', { name: 'Clear', exact: true }).click()
    await tileOf(studied).getByRole('checkbox').click()
    for (const name of neverOpened) {
      if (chosen.length === 2) break
      const tile = tileOf(name)
      if (!(await tile.count()) || (await tile.getByText('Add source pages').count())) continue
      await tile.getByRole('checkbox').click()
      chosen.push(name)
    }
    expect(chosen.length, 'two topics the student never opened, with source pages').toBe(2)

    await main.getByRole('button', { name: 'Change settings' }).click()
    await main.getByRole('radio', { name: form.questions, exact: true }).click()
    await main.getByRole('radio', { name: form.time, exact: true }).click()
    await expect(main.getByRole('checkbox', { name: /Match my past exams/ })).toBeChecked()
    const text = await main.innerText()
    await checks.check('WF4.form-up-to', 'the form says the exam has up to the number of questions asked (U10)', () =>
      expect(text).toMatch(new RegExp(`up to ${form.questions} questions`, 'i'))
    )
    await checks.check('WF4.form-plain-words', 'the form\'s help has no jargon such as "task verbs" (C4)', () => expect(text).not.toMatch(/task verbs/i))
    durations.push({ surface: 'form control', value: form.time })
    durations.push({ surface: 'form summary', value: (await page.getByTestId('exam-preset').innerText()).match(DURATION)?.[0] ?? '(none)' })
  })

  let examId = ''
  await test.step('the wait while the exam is written', async () => {
    const letGo = await holdJobs('generate_exam')
    await main.getByRole('button', { name: 'Create exam' }).click()
    await expect(main.getByText('Writing your exam')).toBeVisible({ timeout: 60_000 })
    const waitText = await main.innerText()
    await checks.check('WF4.build-header', 'while the exam is written the page says so, not "Choose what to cover" (SW7)', () =>
      expect(waitText).not.toMatch(/Choose what to cover/)
    )
    await checks.check('WF4.build-wait-estimate', 'the wait for the exam says about how long it takes (SW7)', () => expect(waitText).toMatch(ESTIMATE))
    await letGo()
    await expect(page).toHaveURL(/\/exams\/[0-9a-f-]{36}$/, { timeout: 10 * 60_000 })
    examId = new URL(page.url()).pathname.split('/').pop() ?? ''
  })

  const questions = await examQuestions(examId)
  expect(questions.some((question) => question.topicId === studiedId), 'a question on the studied topic').toBe(true)
  await checks.check('WF4.exam-order', 'the exam goes topic by topic in course order, choice questions first, not opening on its hardest (U8)', () =>
    expectNone(
      orderProblems(
        questions,
        topics.map((topic) => topic.id)
      ),
      'out of order'
    )
  )
  await checks.check('WF4.no-copied-headers', "no question keeps a past exam's problem number or points (27)", () =>
    expectNone(copiedHeaders(questions.map((question) => question.text)), 'copied headers')
  )

  /** The exam's name as each surface shows it (U7). */
  const names: { surface: string; text: string }[] = []
  let short = ''
  await test.step('the lobby', async () => {
    short = squash((await main.getByRole('heading', { level: 1 }).textContent()) ?? '')
    names.push({ surface: 'lobby heading', text: short }, { surface: 'lobby page title', text: await page.title() })
    durations.push({ surface: 'lobby', value: squash(await main.locator('dt', { hasText: 'Time limit' }).locator('xpath=following-sibling::dd[1]').innerText()) })
  })

  // The never-opened topics as every surface shows them before the exam (the topic page is left out: opening it changes it).
  const before = new Map<string, Reading[]>()
  for (const topic of chosen) before.set(topic, await readSurfaces(page, { courseUrl, topic }))

  const total = questions.length
  const exam = examScreen(page)
  await test.step('taking it: the studied topic answered, a flag, a reload, a second browser', async () => {
    await page.goto(`${courseUrl}/exams/${examId}`)
    await main.getByRole('button', { name: /^(Start exam|Resume)/ }).click()
    await expect(exam.at(1, total)).toBeVisible({ timeout: 60_000 })
    names.push({ surface: 'exam bar', text: await exam.barTitle() }, { surface: 'exam page title', text: await page.title() })
    for (let n = 1; n <= total; n++) {
      await expect(exam.at(n, total)).toBeVisible()
      if (n === 3) {
        // Everything so far saved first, so the reload loses nothing.
        await expect(page.locator('header').getByText(/^(Not saved yet|Saving\.\.\.)$/)).toHaveCount(0, { timeout: 30_000 })
        await page.reload()
        await checks.check('WF4.position-after-reload', 'a reload keeps the question the student was on (SW10)', () =>
          expect(exam.at(3, total)).toBeVisible({ timeout: 30_000 })
        )
        await checks.check('WF4.flag-after-reload', 'a reload keeps the flag the student set (SW10)', () =>
          expect(exam.navigator.getByRole('button', { name: /^Question 2,.*flagged/ })).toBeVisible({ timeout: 10_000 })
        )
        const second = await browser.newContext({ baseURL: testInfo.project.use.baseURL, timezoneId: ZONE, viewport: { width: 1440, height: 900 } })
        const other = await second.newPage()
        await signIn(other, email)
        await other.goto(`${courseUrl}/exams/${examId}/take`)
        const elsewhere = examScreen(other)
        await expect(elsewhere.heading).toBeVisible({ timeout: 60_000 })
        await checks.check('WF4.flag-second-browser', 'a second browser shows the flag the student set (SW10)', () =>
          expect(elsewhere.navigator.getByRole('button', { name: /^Question 2,.*flagged/ })).toBeVisible({ timeout: 10_000 })
        )
        await checks.check('WF4.position-second-browser', 'a second browser opens the exam on the question the student was on (SW10)', () =>
          expect(elsewhere.at(3, total)).toBeVisible({ timeout: 10_000 })
        )
        await second.close()
        // Wherever the reload left the exam, it goes on from question 3.
        await exam.navigator.getByRole('button', { name: /^Question 3,/ }).click()
        await expect(exam.at(3, total)).toBeVisible()
      }
      if (questions[n - 1].topicId === studiedId) await answer(page, questions[n - 1])
      if (n === 2) await page.getByRole('button', { name: 'Flag', exact: true }).click()
      if (n < total) await page.getByRole('button', { name: 'Next', exact: true }).click()
    }
    const labels = (await page.getByRole('button', { name: /submit/i }).allInnerTexts()).map(squash)
    await checks.check('WF4.submit-one-label', 'every button that hands the exam in says "Submit exam" (16)', () =>
      expectNone([...new Set(labels)].filter((label) => label !== 'Submit exam'), 'other labels')
    )
    await page.getByRole('button', { name: 'Submit exam', exact: true }).first().click()
    await page.getByRole('dialog', { name: 'Submit your exam?' }).getByRole('button', { name: 'Submit exam', exact: true }).click()
    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}$/, { timeout: 60_000 })
  })

  /** The exam's score as each surface shows it (SW4). */
  const scores: { surface: string; value: string }[] = []
  const blanks = questions.filter((question) => question.topicId !== studiedId).length
  await test.step('the results', async () => {
    await expect(main.getByRole('region', { name: 'Your score' })).toBeVisible({ timeout: 5 * 60_000 })
    scores.push({ surface: 'results', value: ((await main.getByLabel(/^Score /).first().getAttribute('aria-label')) ?? '').replace(/^Score /, '') })
    names.push({ surface: 'results heading', text: squash((await main.getByRole('heading', { level: 1 }).textContent()) ?? '') })
    names.push({ surface: 'results page title', text: await page.title() })
    const crumbs = page.getByRole('navigation', { name: /breadcrumb/i })
    if (await crumbs.count()) names.push({ surface: 'results breadcrumbs', text: squash((await crumbs.first().textContent()) ?? '') })

    const filters = (await main.getByRole('radiogroup', { name: 'Show questions' }).getByRole('radio').allInnerTexts()).map(squash)
    const lost = Number(filters.find((filter) => filter.startsWith('Lost points'))?.match(/\d+/)?.[0] ?? Number.NaN)
    await checks.check('WF4.blank-not-missed', 'a blank question is "Not answered", not counted with the answers that lost points (33, 34)', () => {
      expect(filters).toContain(`Not answered ${blanks}`)
      expect(lost).toBeLessThanOrEqual(total - blanks)
    })
    const focusRows = await main.getByRole('region', { name: 'Where to focus' }).getByRole('listitem').allInnerTexts()
    await checks.check('WF4.unstudied-folded', 'topics the student never studied share one line under "Where to focus" (SW16)', () =>
      expect(focusRows.filter((row) => chosen.some((topic) => row.includes(topic))).length).toBeLessThanOrEqual(1)
    )
    const jump = /^Next (missed|not answered)/i
    await checks.check('WF4.jump-to-missed', 'the results offer a jump to the next missed or blank question (U9)', () =>
      expect(main.getByRole('link', { name: jump }).or(main.getByRole('button', { name: jump })).first()).toBeVisible({ timeout: 1000 })
    )
    const expand = main.getByRole('button', { name: 'Expand all' })
    if (await expand.isVisible()) await expand.click()
    const raw = await unrendered(page)
    await checks.check('WF4.results-rendered', 'the results show no raw markdown or LaTeX (SW2)', () => expectNone(raw, 'unrendered'))
    const lines = (await main.innerText()).split('\n').map(squash)
    await checks.check('WF4.results-whole-sentences', 'no line of the results is a fragment such as "Then, to check it stuck." (35)', () =>
      expectNone(
        lines.filter((line) => /^Then, to\b/.test(line)),
        'fragments'
      )
    )
  })

  let full = ''
  await test.step('the exam on the other pages', async () => {
    await page.goto(`${courseUrl}/exams`)
    const row = main.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 2 }) }).first()
    names.push({ surface: 'exam list', text: squash(await row.getByRole('heading', { level: 2 }).innerText()) })
    const rowText = squash(await row.innerText())
    scores.push({ surface: 'exam list', value: rowText.match(/Best score (\d+(?:\.\d+)?%)/)?.[1] ?? '(none)' })
    durations.push({ surface: 'exam list', value: rowText.match(DURATION)?.[0] ?? '(none)' })

    await page.goto(`${courseUrl}/exams/${examId}`)
    scores.push({ surface: 'lobby', value: squash(await main.innerText()).match(/\d+(?:\.\d+)?%/)?.[0] ?? '(none)' })

    await page.goto(courseUrl)
    await page.waitForLoadState('networkidle')
    const recent = main.getByRole('region', { name: 'Recent mock exams' }).getByRole('listitem').first()
    const recentLines = (await recent.innerText()).split('\n').map(squash).filter(Boolean)
    full = recentLines[0] ?? ''
    names.push({ surface: 'course overview', text: full })
    scores.push({ surface: 'course overview', value: recentLines.find((line) => /^\d+(?:\.\d+)?%$/.test(line)) ?? '(none)' })

    await page.goto(`${courseUrl}/plan`)
    await page.waitForLoadState('networkidle')
    const day = short.split(' · ')[1] ?? short
    const planLine = (await main.innerText()).split('\n').map(squash).find((line) => /mock exam/i.test(line) && line.includes(day))
    names.push({ surface: 'plan', text: planLine ?? '(no line names the exam)' })

    await checks.check('WF4.one-exam-name', 'every page names the exam by its one short or full name (U7)', () => {
      expect(full, 'the overview names the exam with its date').toContain(day)
      expectNone(nameProblems(names, short, full), 'other names')
    })
    await checks.check('WF4.one-score-format', "the exam's score reads the same on the results, lobby, exam list and overview (SW4)", () =>
      expectNone(differing(scores), 'scores')
    )
    await checks.check('WF4.one-duration-format', 'the time limit reads the same on the form, lobby and exam list (SW4)', () =>
      expectNone(differing(durations), 'durations')
    )
  })

  await test.step('the blank topics, the same day', async () => {
    // The course page starts the conversion of the exam's answers into topic evidence: it is visited first.
    await page.goto(courseUrl)
    await page.waitForLoadState('networkidle')
    const changes: string[] = []
    for (const topic of chosen) {
      const after = await readSurfaces(page, { courseUrl, topic })
      changes.push(...stateChanges(before.get(topic) ?? [], after).map((change) => `${topic}, ${change}`))
    }
    await checks.check('WF4.blanks-change-nothing', "blank answers change no topic's mastery or next step on any surface (SW11)", () =>
      expectNone(changes, 'changed')
    )
  })

  await test.step('the blank topics, the next day', async () => {
    await daysPass(email)
    await page.goto(`${courseUrl}/review`)
    await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
    const due = main.getByRole('region', { name: /^Due for review/ })
    const dueNames = (await due.count()) ? await due.getByRole('listitem').getByRole('heading').allInnerTexts() : []
    await checks.check('WF4.never-opened-not-due', 'no topic the student never opened is due for review after the blank exam (G1)', () =>
      expectNone(
        chosen.filter((topic) => dueNames.includes(topic)),
        'never-opened topics due'
      )
    )
    const fix = main.getByRole('button', { name: new RegExp(`^Fix it now for (${chosen.map(escape).join('|')})$`) })
    const offered = (await fix.count()) > 0
    // Since #78 a blank answer gives no evidence, so no never-opened topic is due and none offers "Fix it now": the check
    // has nothing to click. It runs (and G6 is checked) when a change makes one due again.
    if (!offered) console.log('note: Review offers "Fix it now" on no never-opened topic, so there is nothing to start')

    await page.goto(`${courseUrl}/exams/new`)
    const tiles: string[] = []
    for (const topic of chosen) {
      const text = squash(await tileOf(topic).innerText())
      if (!/Not started/.test(text)) tiles.push(text)
    }
    await checks.check('WF4.form-not-started-after', 'after the blank exam the form still shows the never-opened topics as "Not started" (SW11)', () =>
      expectNone(tiles, 'tiles')
    )

    // Last, as opening a topic changes it. Its jobs are held and never let go: the run ends before they would be written.
    await page.goto(`${courseUrl}/review`)
    if (offered) await holdJobs('generate_content')
    await checks.check('WF4.fix-it-now-warm-up', '"Fix it now" on a topic the student never opened starts it at its warm-up (G6)', async () => {
      if (!offered) return
      await fix.first().click()
      await expect(page).toHaveURL(/\/topics\/[0-9a-f-]{36}/, { timeout: 30_000 })
      expect(page.url()).not.toMatch(/view=quiz/)
    })
  })
})

/** What a student reads while taking the exam. */
function examScreen(page: Page) {
  return {
    heading: page.getByRole('heading', { level: 1, name: /^Question \d+ of \d+$/ }),
    at: (n: number, of: number) => page.getByRole('heading', { level: 1, name: `Question ${n} of ${of}` }),
    navigator: page.getByRole('complementary', { name: 'Question navigator' }),
    /** The name in the exam's top bar: the line after "Exit". */
    barTitle: async () => {
      const lines = (await page.locator('header').first().innerText()).split('\n').map(squash).filter(Boolean)
      return lines[lines.indexOf('Exit') + 1] ?? ''
    },
  }
}

/** An answer, the same every run: the first option, 2 for a number, or one generic sentence. */
async function answer(page: Page, question: ExamQuestion) {
  const shown = page.locator('[data-question]')
  if (question.type === 'multiple_choice' || question.type === 'true_false') await shown.getByRole('radiogroup').first().getByRole('radio').first().click()
  else if (question.type === 'numerical') await shown.getByLabel('Your answer').fill('2')
  else await shown.getByLabel('Your answer').fill('It is correct for every input because each step keeps the invariant, shown by induction on the input size.')
}
