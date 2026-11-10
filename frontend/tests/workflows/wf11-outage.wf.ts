import type { Locator, Page } from '@playwright/test'
import { test, expect } from './harness/fixtures'
import { withPrisma } from '../e2e/helpers/db'
import { askScreen } from './harness/ask'
import { openOnWarmup, readyCourse, startStudying, takeWarmup } from './harness/course'
import { preparationFinished } from './harness/files'
import { endOutage, errorStateGaps, showsSharedMessage, stageOutage, statusRecovered, type FaultCode } from './harness/outage'
import { expectNone } from './harness/page-checks'
import { voiceScreen } from './harness/voice'

// WF11: an AI outage. One studied topic; then the provider fails (overloaded, after its own retries) while the student
// asks a question, asks the practice tutor, has a recall answer checked, answers in voice practice and opens a new
// topic. Each surface must show the shared message (lib/ai/messages.ts) with a way to try again, and keep what the
// student typed. Then the outage ends and each surface's retry must work. The outage is staged through the replay
// provider's fault file; nothing else about the app changes.

const CODE: FaultCode = 'LLM_UNAVAILABLE'

/** What the student writes on each surface: neutral, so no course text is kept here. */
const TYPED = {
  ask: 'What should I understand first in this topic, in two sentences?',
  tutor: 'I would start from the definition and check each case in turn.',
  recall: 'It is about stating clearly what a correct answer must satisfy for every input, and checking it step by step.',
  voice: 'I think it depends on the size of the input, but I am not sure how.',
} as const

const RETRY = /^(Try again|Retry)\b/i

type Seen = { surface: string; gaps: string[]; recovered: string | null }

/** Whether a control is on screen and can be used. */
async function usable(control: Locator): Promise<boolean> {
  return (await control.count()) > 0 && (await control.first().isVisible()) && (await control.first().isEnabled())
}

/**
 * One surface through the outage: the student acts while the provider fails, then the outage ends and the student
 * tries again. `area` holds the surface's message and its retry; `draft` reads what the student typed, if anything;
 * `answered` waits for the AI's answer once it works again.
 *
 * A way to try again is one of: a "Try again" button; the action's own control (`again`), still usable with the draft
 * kept beside it, so one click asks again (the tutor's and recall's buttons stay where they were); or, for work that
 * waits for the AI (`resumes`), the page moving on by itself once the AI is back, with nothing done and no reload.
 */
async function throughOutage(
  page: Page,
  surface: string,
  {
    area,
    act,
    again,
    resumes = false,
    draft,
    typed,
    answered,
  }: { area: Locator; act: () => Promise<void>; again?: Locator; resumes?: boolean; draft?: () => Promise<string>; typed?: string; answered: () => Promise<void> }
): Promise<Seen> {
  stageOutage(CODE)
  await act()
  const shown = await expect
    .poll(async () => showsSharedMessage(await area.innerText(), CODE), { timeout: 3 * 60_000, intervals: [2000] })
    .toBe(true)
    .then(
      () => true,
      () => false
    )
  const text = (await area.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`${surface}, during the outage${shown ? '' : ' (no shared message after 3 min)'}: "${text.slice(-300)}"`)
  const retry = area.getByRole('button', { name: RETRY })
  const way = (await usable(retry)) ? 'its Try again' : again && (await usable(again)) ? 'its own button' : resumes ? 'carrying on by itself' : null
  const kept = typed === undefined || (await draft?.()) === typed || text.includes(typed)
  const gaps = errorStateGaps({ text, retryShown: way !== null, draftKept: kept }, CODE)

  endOutage()
  await statusRecovered(page)
  let recovered: string | null = null
  try {
    if (way === 'its Try again') await retry.first().click()
    else if (way === 'its own button') await again!.first().click()
    else if (way === null) await act()
    await answered()
  } catch (error) {
    recovered = `${way ?? 'doing it again'}: ${String(error).split('\n')[0].slice(0, 160)}`
  }
  console.log(`${surface}, after the outage: ${way ?? 'doing it again'}, ${recovered ? 'no answer' : 'answered'}`)
  return { surface, gaps, recovered }
}

test('WF11 outage: the AI fails during Ask, the tutor, grading, voice and generation, then comes back', async ({ page, checks }) => {
  test.setTimeout(30 * 60_000)
  const { courseUrl, courseId } = await readyCourse(page, 'WF11')
  await startStudying(page, courseUrl)
  const topicUrl = new URL(page.url()).pathname
  const topicId = topicUrl.split('/').pop()!

  await test.step('a studied topic, prepared to its end', async () => {
    await openOnWarmup(page, topicUrl)
    await takeWarmup(page)
    await preparationFinished(topicId)
  })

  const seen: Seen[] = []
  try {
    await test.step('Ask', async () => {
      await page.goto(`${courseUrl}/ask`)
      const ask = askScreen(page)
      const box = page.locator('form[data-ask-composer] textarea')
      await expect(box).toBeVisible({ timeout: 60_000 })
      const main = page.locator('main')
      seen.push(
        await throughOutage(page, 'Ask', {
          area: main,
          act: () => ask.send(TYPED.ask),
          draft: () => box.inputValue(),
          typed: TYPED.ask,
          answered: async () => {
            await expect(main.locator('article:not([aria-busy])')).not.toHaveCount(0, { timeout: 4 * 60_000 })
            await expect(main.locator('article[aria-busy]')).toHaveCount(0, { timeout: 4 * 60_000 })
            await expect(main.getByRole('button', { name: RETRY })).toHaveCount(0)
          },
        })
      )
    })

    await test.step('the practice tutor', async () => {
      await page.goto(`${topicUrl}?view=practice`)
      const step = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^(Get help|More help)$/ }) }).first()
      await expect(step).toBeVisible({ timeout: 4 * 60_000 })
      const toggle = step.getByRole('button', { name: 'Your working (optional)' })
      if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
      const working = step.getByRole('textbox', { name: 'Your working (optional)' })
      await working.fill(TYPED.tutor)
      const help = step.getByRole('button', { name: /^(Get help|More help)$/ })
      if ((await help.getAttribute('aria-expanded')) !== 'true') await help.click()
      seen.push(
        await throughOutage(page, 'the practice tutor', {
          area: step,
          act: () => step.getByRole('button', { name: 'What is this asking?' }).click(),
          again: step.getByRole('button', { name: 'What is this asking?' }),
          draft: () => working.inputValue(),
          typed: TYPED.tutor,
          answered: () => expect(step.getByRole('log', { name: 'Tutor conversation' }).getByText('Tutor', { exact: true }).first()).toBeVisible({ timeout: 2 * 60_000 }),
        })
      )
    })

    await test.step('recall: an answer checked', async () => {
      await page.goto(`${topicUrl}?view=recall`)
      const prompt = page.getByRole('region', { name: 'Close the book and say what you remember' }).getByRole('list').first().locator(':scope > li').first()
      const box = prompt.getByRole('textbox')
      await expect(box).toBeVisible({ timeout: 4 * 60_000 })
      await box.fill(TYPED.recall)
      seen.push(
        await throughOutage(page, 'recall grading', {
          area: prompt,
          act: () => prompt.getByRole('button', { name: 'Check my answer' }).click(),
          again: prompt.getByRole('button', { name: 'Check my answer' }),
          draft: () => box.inputValue(),
          typed: TYPED.recall,
          answered: () => expect(prompt.getByRole('region', { name: 'Feedback on your answer' })).toBeVisible({ timeout: 2 * 60_000 }),
        })
      )
    })

    await test.step('voice practice: a typed answer', async () => {
      const voice = voiceScreen(page)
      await page.goto(`${topicUrl}?view=voice`)
      await voice.chooseTypedQuiz()
      await voice.start.click()
      await expect(voice.question).toBeVisible({ timeout: 2 * 60_000 })
      await voice.ready()
      const box = page.getByLabel('Type your answer')
      const coachTurns = page.getByTestId('voice-coach-turn')
      const before = await coachTurns.count()
      seen.push(
        await throughOutage(page, 'voice practice', {
          area: voice.session,
          act: async () => {
            await box.fill(TYPED.voice)
            await voice.session.getByRole('button', { name: 'Send', exact: true }).click()
          },
          draft: () => box.inputValue(),
          typed: TYPED.voice,
          answered: () => expect(coachTurns).toHaveCount(before + 1, { timeout: 2 * 60_000 }),
        })
      )
      await voice.end().catch(() => {})
    })

    await test.step('a new topic prepared during the outage', async () => {
      const next = await withPrisma(async (prisma) =>
        prisma.topic.findFirstOrThrow({ where: { projectId: courseId, userConfirmed: true, NOT: { id: topicId } }, orderBy: { orderIndex: 'asc' }, select: { id: true } })
      )
      const main = page.locator('main')
      seen.push(
        await throughOutage(page, 'a new topic', {
          area: main,
          act: async () => {
            await page.goto(`${courseUrl}/topics/${next.id}`)
            await expect(main).toBeVisible({ timeout: 60_000 })
          },
          // Its preparation waits for the AI and carries on by itself: the open page must then open the warm-up, unreloaded,
          // and every part of the topic's preparation must finish (which also leaves no request unrecorded behind the run).
          resumes: true,
          answered: async () => {
            await expect(page.getByRole('button', { name: 'Start warm-up' })).toBeVisible({ timeout: 4 * 60_000 })
            await preparationFinished(next.id)
          },
        })
      )
    })
  } finally {
    endOutage()
  }

  for (const { surface, gaps, recovered } of seen) {
    console.log(`${surface}: ${gaps.length ? 'missing ' + gaps.join(', ') : 'the shared error state'}; after the outage: ${recovered ?? 'worked'}`)
  }
  const typedKept = 'shows the shared message with a way to try again, and keeps what the student typed (SW10)'
  const surfaceCheck = (id: string, surface: string, description: string) =>
    checks.check(id, description, () => expectNone(seen.find((item) => item.surface === surface)?.gaps ?? ['not reached'], surface))
  await surfaceCheck('WF11.ask-error-state', 'Ask', `Ask, when the answer fails, ${typedKept}`)
  await surfaceCheck('WF11.tutor-error-state', 'the practice tutor', `The practice tutor, when its reply fails, ${typedKept}`)
  await surfaceCheck('WF11.grading-error-state', 'recall grading', `Recall, when the check fails, ${typedKept}`)
  await surfaceCheck('WF11.voice-error-state', 'voice practice', `Voice practice, when the coach's turn fails, ${typedKept}`)
  await surfaceCheck('WF11.generation-error-state', 'a new topic', 'A new topic, when its preparation fails, shows the shared message (that it carries on by itself is WF11.retry-works)')
  await checks.check('WF11.retry-works', 'once the outage ends, each surface\'s retry (or doing it again) gets the answer', () =>
    expectNone(
      seen.flatMap(({ surface, recovered }) => (recovered ? [`${surface}: ${recovered}`] : [])),
      'not recovered'
    )
  )
})
