import type { Page } from '@playwright/test'
import { test, expect } from './harness/fixtures'
import { daysPass } from './harness/clock'
import { openOnWarmup, readyCourse, startStudying, takeQuiz, takeWarmup } from './harness/course'
import { buttonLikeActions, expectNone } from './harness/page-checks'
import { crashTab, statedRoundSize, storedSession, usedVoiceSeconds, voiceScreen } from './harness/voice'

// WF6: voice. A drill on a studied topic (the first question, a typed answer, the next question, the end and its
// summary); a session left open in a tab that dies, then the quick round started from Review in another tab; and Quiz
// me after a "Fix it now" set.

/** The student's typed answer, the same every run: general enough for any question, and not quite right. */
const ANSWER = 'It splits the input into smaller parts, solves each part and combines the results.'
/** How long the open session sits with no turn before the minutes are read again: past a minute, under the 90 s that
 * makes a session stale (lib/voice/usage.ts), so the wall clock and the active time differ by a whole minute. */
const IDLE_MS = 75_000

test('WF6 voice: a drill, a session left open, the quick round, Quiz me after Fix it now', async ({ page, checks }) => {
  test.setTimeout(20 * 60_000)
  const { courseUrl, courseId, email } = await readyCourse(page, 'WF6')
  await startStudying(page, courseUrl)
  const topicUrl = new URL(page.url()).pathname
  const context = page.context()

  await test.step('a studied topic: warm-up, reading, a low quiz', async () => {
    await openOnWarmup(page, topicUrl)
    await takeWarmup(page)
    await page.goto(`${topicUrl}?view=read`)
    await page.getByRole('button', { name: "I've read it" }).click()
    await expect(page.getByText("You've read this topic.")).toBeVisible()
    await takeQuiz(page, topicUrl)
  })

  let drillSize = 0
  await test.step('a drill: the first question, a typed answer, the next question, the end', async () => {
    const voice = voiceScreen(page)
    await page.goto(`${topicUrl}?view=voice`)
    await voice.chooseTypedQuiz()
    const started = Date.now()
    await voice.start.click()
    await expect(voice.question).toBeVisible({ timeout: 60_000 })
    const firstQuestionMs = Date.now() - started
    await checks.check('WF6.first-question-fast', `the first question shows in under 2 s (67; ${firstQuestionMs} ms)`, () =>
      expect(firstQuestionMs).toBeLessThan(2000)
    )
    drillSize = (await voice.place()).of
    await voice.ready()

    const reply = await voice.send(ANSWER)
    const verdict = voice.session.getByTestId('voice-evaluation').first()
    if (await verdict.isVisible()) {
      // The chip comes first in the row; anything after it is a second telling of what the coach just said.
      const besideChip = await verdict.evaluate((row) => [...row.children].slice(1).map((child) => (child.textContent ?? '').trim()).filter(Boolean))
      await checks.check('WF6.one-verdict', "the verdict is said once: the coach's words and the chip, with no line repeating them (V2)", () =>
        expectNone(besideChip, 'beside the chip')
      )
    } else console.log(`note: the reply to the answer has no verdict: "${(await reply.innerText()).slice(0, 120)}"`)

    const next = voice.session.getByRole('button', { name: 'Next question', exact: true })
    if ((await voice.place()).at === 1) {
      const offered = await next.isVisible()
      await checks.check('WF6.next-button', 'after the feedback a Next question button moves on, with no "yes" to type (V1)', () =>
        expect(offered).toBe(true)
      )
      // Today the coach asks whether the student is ready, and only a typed "yes" moves on (finding 68).
      if (offered) await next.click()
      else await voice.send('yes')
    } else console.log('note: the coach moved to the next question in its reply, so there was no Next to look for')
    await expect(voice.progress).toHaveText(/^Question 2 of \d+/, { timeout: 2 * 60_000 })

    await voice.ready()
    await voice.end()
    const summary = voice.summary
    const actions = await buttonLikeActions(summary)
    await checks.check('WF6.summary-one-action', 'the voice summary has one main action; the rest are links (R1)', () =>
      expect(actions).toEqual({ filled: [expect.any(String)], outlined: [] })
    )
    const nextStep = summary.getByTestId('voice-next-step')
    const nextStepText = (await nextStep.count()) ? await nextStep.innerText() : ''
    const pagesListed = await summary.getByText(/^Look again at /).count()
    await checks.check('WF6.next-step-matches', 'the next step names pages only when the summary lists some (R1, 84)', () =>
      expect(/\bpages?\b/i.test(nextStepText) ? pagesListed : 1, `"${nextStepText.replace(/\s+/g, ' ')}" with ${pagesListed} pages listed`).toBeGreaterThan(0)
    )
    const revisit = summary.getByTestId('voice-revisit').getByRole('listitem')
    if (await revisit.count()) {
      const first = revisit.first()
      const opener = first.locator('summary, button')
      if (await opener.count()) await opener.first().click()
      const text = await first.innerText()
      await checks.check('WF6.revisit-in-full', 'a question to revisit opens in full, with its answer (R1, 84)', () => {
        expect(text).not.toMatch(/…$/m)
        expect(text).toMatch(/answer/i)
      })
    } else console.log('note: the summary lists nothing to revisit')
  })

  // The tab the student carries on in once the first one dies.
  let other: Page = page
  await test.step('a session left open in a tab that dies, then voice from Review in another tab', async () => {
    const voice = voiceScreen(page)
    await page.goto(`${topicUrl}?view=voice`)
    await voice.chooseTypedQuiz()
    const created = page.waitForResponse((response) => response.url().endsWith('/api/voice/session') && response.request().method() === 'POST')
    await voice.start.click()
    const { sessionId } = (await (await created).json()) as { sessionId: string }
    await voice.place()
    await voice.ready()
    await voice.send(ANSWER)

    // The student stops answering and leaves the tab open: its heartbeat keeps the session live.
    const before = await usedVoiceSeconds(page)
    await page.waitForTimeout(IDLE_MS)
    const idleCounted = (await usedVoiceSeconds(page)) - before
    await checks.check('WF6.idle-not-counted', `${IDLE_MS / 1000} s with no turn adds no voice time (V4; ${idleCounted} s were counted)`, () =>
      expect(idleCounted).toBeLessThan(30)
    )
    await crashTab(page)

    other = await context.newPage()
    const round = voiceScreen(other)
    const main = other.locator('main')
    await other.goto(`${courseUrl}/review`)
    await expect(main.getByRole('heading', { level: 2, name: /^Due for review/ })).toBeVisible()
    // With nothing due, the extras are folded under "Keep studying (optional)".
    const keepStudying = main.getByText('Keep studying (optional)')
    if (await keepStudying.isVisible()) await keepStudying.click()
    await main.getByRole('region', { name: 'Voice practice' }).getByRole('link', { name: 'Start voice practice' }).click()
    await expect(other).toHaveURL(/\/review\/voice/)
    await round.settled()
    await round.chooseTyping()
    // The dead tab's session still looks open (its last heartbeat is under 90 s old): the lobby offers to take over.
    const offered = await round.lobby.getByRole('button', { name: 'Start here instead' }).isVisible()
    await checks.check('WF6.start-here-instead', 'a session left open elsewhere is offered as "Start here instead", which ends it (V4)', () =>
      expect(offered).toBe(true)
    )
    // V5: the lobby states the count the round has, which the drill-pack route gives.
    const stated = statedRoundSize(await round.lobby.getByTestId('voice-sprint-size').innerText())
    const pack = await other.request.get(`/api/voice/drill-pack?mode=sprint&projectId=${courseId}`)
    const { questionCount } = (await pack.json()) as { questionCount: number }
    await checks.check('WF6.round-size-stated', `the quick round's lobby states the size it has (V5; it says ${stated}, it has ${questionCount})`, () =>
      expect(stated).toBe(questionCount)
    )
    const quizMissing = await round.lobby.getByTestId('voice-quiz-missing').isVisible()
    await checks.check('WF6.round-can-start', "after a quiz, the quick round offered on Review can start: it asks from topics the student studied (G1, 83)", () =>
      expect(quizMissing).toBe(false)
    )
    if (quizMissing) {
      console.log('note: the quick round cannot start (its topics have no quiz), so the student starts Quiz me on the studied topic instead')
      await other.goto(`${topicUrl}?view=voice`)
      await round.chooseTypedQuiz()
      await round.settled()
    }

    // One click starts here: it ends the session the dead tab left open, or finds it gone quiet and closes it. The
    // student is never sent back to the start screen to wait for the other session to clear (128).
    await round.start.click()
    await expect(round.question).toBeVisible({ timeout: 2 * 60_000 })
    const left = await storedSession(sessionId)
    await checks.check('WF6.unended-closed', 'the session the dead tab never ended is closed once the next one starts (V5)', () =>
      expect(left.status).not.toBe('active')
    )
    await round.place()
    await round.ready()
    await round.end()
  })

  await test.step('Quiz me after a "Fix it now" set', async () => {
    const voice = voiceScreen(other)
    await daysPass(email)
    await other.goto(`${courseUrl}/review`)
    await other.locator('main').getByRole('button', { name: /^Fix it now for / }).first().click()
    await expect(other).toHaveURL(/view=quiz/)
    await expect(other.getByRole('button', { name: 'Start quiz' })).toBeVisible({ timeout: 4 * 60_000 })
    await other.goto(`${new URL(other.url()).pathname}?view=voice`)
    await voice.chooseTypedQuiz()
    await voice.start.click()
    const size = (await voice.place()).of
    await checks.check('WF6.drill-keeps-set', `Quiz me after a "Fix it now" set keeps the topic's whole set (V5; ${drillSize} before, ${size} after)`, () =>
      expect(size).toBeGreaterThanOrEqual(drillSize)
    )
    await voice.ready()
    await voice.end()
  })
})
