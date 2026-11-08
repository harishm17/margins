import { test, expect } from './harness/fixtures'
import { openOnWarmup, readyCourse, startStudying } from './harness/course'
import { expectNone, ideaNames, textProblems, watchBusyButtons } from './harness/page-checks'
import { disagreements, percentShown, readSurfaces } from './harness/surfaces'

// WF2: the first topic. Open a new topic, wait for it, warm-up, read with a quick check and a margin note, recall,
// practice with help, a wrong try and a worked example, the examples page, quiz, results.

test('WF2 first topic: warm-up, reading, recall, practice, quiz', async ({ page, checks }) => {
  const blankBusy = await watchBusyButtons(page)
  const { courseUrl } = await readyCourse(page, 'WF2')
  await startStudying(page, courseUrl)
  const topicUrl = new URL(page.url()).pathname
  const topic = (await page.getByRole('heading', { level: 1 }).innerText()).trim()

  /** After a step: every surface that shows the topic says the same next step, progress and minutes. */
  async function sameEverywhere(stage: string, { enoughEvidence }: { enoughEvidence: boolean }) {
    const readings = await readSurfaces(page, { courseUrl, topicUrl, topic })
    console.log(stage, JSON.stringify(readings))
    await checks.check(`WF2.${stage}.same-next-step`, `after the ${stage}, every surface names the same next step (SW9)`, () =>
      expectNone(disagreements(readings, 'next'), 'next step')
    )
    await checks.check(`WF2.${stage}.same-progress`, `after the ${stage}, every surface shows the same topic progress (SW11)`, () =>
      expectNone(disagreements(readings, 'mastery'), 'topic progress')
    )
    if (!enoughEvidence) {
      await checks.check(`WF2.${stage}.no-percent-yet`, `after the ${stage}, too few answers count for a percent: "Just started" (SW11)`, () =>
        expectNone(percentShown(readings), 'a percent shown')
      )
    }
    await checks.check(`WF2.${stage}.same-minutes`, `after the ${stage}, every surface gives the same minutes for the topic (G5)`, () =>
      expectNone(disagreements(readings, 'minutes'), 'minutes')
    )
  }

  // SW2 and SW3 are judged on every screen the student reads; the checks run once, at the end.
  let ideas: string[] = []
  const unrendered = new Set<string>()
  const misused = new Set<string>()
  async function look(where: string) {
    const found = await textProblems(page, where, ideas)
    found.unrendered.forEach((problem) => unrendered.add(problem))
    found.concepts.forEach((problem) => misused.add(problem))
  }

  await test.step('warm-up', async () => {
    await openOnWarmup(page, topicUrl)
    await page.getByRole('button', { name: 'Start warm-up' }).click()
    for (let question = 1; question <= 3; question++) {
      await expect(page.getByText(`Warm-up question ${question} of 3`)).toBeVisible()
      await look(`warm-up question ${question}`)
      // One right with confidence, one "I don't know" (it moves on by itself), one wrong.
      if (question === 2) {
        await page.getByRole('button', { name: "I don't know" }).click()
        continue
      }
      await page.getByRole('radiogroup', { name: /Answer options|True or false/ }).getByRole('radio').nth(question === 1 ? 2 : 0).click()
      if (question === 1) await page.getByRole('radio', { name: 'Fairly sure' }).click()
      await page.getByRole('button', { name: /Next question|See answers/ }).click()
    }
    await expect(page.getByRole('region', { name: 'Ready to read' })).toBeVisible()
    ideas = await (async () => {
      const results = page.url()
      await look('warm-up results')
      const names = await ideaNames(page, courseUrl)
      await page.goto(results)
      return names
    })()
    await look('warm-up results')
  })
  await sameEverywhere('warm-up', { enoughEvidence: false })

  await test.step('reading: a quick check and a margin note', async () => {
    await page.goto(`${topicUrl}?view=read`)
    await expect(page.getByRole('button', { name: "I've read it" })).toBeVisible({ timeout: 4 * 60_000 })
    const check = page.getByRole('group', { name: 'Quick check (optional)' }).first()
    await check.getByRole('textbox').fill('Each input has a set of acceptable answers, and a rule can test an answer without writing the whole set out.')
    await check.getByRole('button', { name: 'Show the source' }).click()
    await check.getByRole('group', { name: 'How did you do?' }).getByRole('button', { name: 'Got it' }).click()
    await page.getByRole('button', { name: 'Add a note on passage 2' }).click()
    await page.getByRole('textbox', { name: 'Your note on passage 2' }).fill('Come back to this part before the quiz.')
    await page.getByRole('button', { name: 'Save note' }).click()
    await look('reading')
    await page.reload()
    // The note is still there after a reload.
    await expect(page.getByText('Come back to this part before the quiz.').filter({ visible: true }).first()).toBeVisible()
    await page.getByRole('button', { name: "I've read it" }).click()
    await expect(page.getByText("You've read this topic.")).toBeVisible()
  })
  await sameEverywhere('reading', { enoughEvidence: false })

  await test.step('recall: one written answer, one "I don\'t remember"', async () => {
    await page.goto(`${topicUrl}?view=recall`)
    // The prompts are the list's own items (feedback has lists of its own).
    const prompts = page.getByRole('region', { name: 'Close the book and say what you remember' }).getByRole('list').first().locator(':scope > li')
    await expect(prompts.first().getByRole('textbox')).toBeVisible({ timeout: 4 * 60_000 })
    await prompts.first().getByRole('textbox').fill(
      'A problem says which answers are acceptable for each input, usually by a rule the answers must meet rather than a full list. A general problem allows inputs of any size, not just one small case.'
    )
    await prompts.first().getByRole('button', { name: 'Check my answer' }).click()
    await expect(prompts.first().getByRole('region', { name: 'Feedback on your answer' })).toBeVisible({ timeout: 2 * 60_000 })
    await look('recall feedback')
    // A check opens the next prompt.
    await prompts.nth(1).getByRole('button', { name: "I don't remember" }).click()
    await expect(prompts.nth(1).getByRole('region', { name: 'Feedback on your answer' })).toBeVisible({ timeout: 2 * 60_000 })
    await look('recall feedback')
  })
  await sameEverywhere('recall', { enoughEvidence: false })

  await test.step('practice: help, a wrong try, then a worked example', async () => {
    await page.goto(`${topicUrl}?view=practice`)
    const step = page.getByRole('listitem').filter({ has: page.getByRole('radiogroup', { name: 'Answer options' }) }).first()
    await expect(step).toBeVisible({ timeout: 4 * 60_000 })
    await look('practice')
    await step.getByRole('button', { name: 'Get help' }).click()
    await step.getByRole('button', { name: /^Show where to look/ }).click()
    await look('practice hint')
    await step.getByRole('radio').nth(1).click()
    await step.getByRole('button', { name: 'Check' }).click()
    await expect(step.getByRole('alert')).toContainText('Not quite')
    await step.getByRole('button', { name: /^Show me a worked example/ }).click()
    await expect(step.getByText('Worked example', { exact: true })).toBeVisible({ timeout: 2 * 60_000 })
    await look('practice worked example')
  })

  await test.step('the examples page', async () => {
    await page.goto(`${topicUrl}?view=examples`)
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible({ timeout: 4 * 60_000 })
    await look('examples')
  })

  await test.step('quiz: every question type, one "I don\'t know", then the results', async () => {
    await page.goto(`${topicUrl}?view=quiz`)
    await page.getByRole('button', { name: 'Start quiz' }).click()
    const heading = page.getByRole('heading', { level: 2, name: /^Question \d+ of \d+$/ })
    await expect(heading).toBeVisible()
    const total = Number((await heading.innerText()).match(/of (\d+)/)![1])
    const answer = page.getByRole('textbox', { name: 'Your answer' })
    for (let question = 1; question <= total; question++) {
      await expect(page.getByRole('heading', { level: 2, name: `Question ${question} of ${total}` })).toBeVisible()
      await look(`quiz question ${question}`)
      const options = page.getByRole('radiogroup', { name: /^(Answer options|True or false)$/ })
      if (question === 2) await page.getByRole('button', { name: "I don't know" }).click()
      else if (await options.isVisible()) await options.getByRole('radio').nth(question % 2).click()
      else if ((await answer.getAttribute('inputmode')) === 'decimal') await answer.fill('2')
      else await answer.fill('It is correct for every input because each step keeps the invariant, shown by induction on the input size.')
      if (question < total) await page.getByRole('button', { name: 'Next', exact: true }).click()
    }
    // Every question has an answer or an "I don't know", so submitting goes straight to grading, with no dialog.
    await page.getByRole('button', { name: 'Submit quiz' }).last().click()
    await expect(page.getByLabel(/^Score /)).toBeVisible({ timeout: 3 * 60_000 })
    await look('quiz results')
  })
  await sameEverywhere('quiz', { enoughEvidence: true })

  await checks.check('WF2.maths-renders', 'model-written text renders on every screen: no raw maths, markdown or run-together lists (SW2)', () =>
    expectNone([...unrendered], 'unrendered')
  )
  await checks.check('WF2.concept-sentences', 'idea names read right in every sentence (SW3)', () => expectNone([...misused], 'idea names'))
  await checks.check('WF2.no-blank-busy-button', 'no button went blank while busy, anywhere in the workflow (SW1)', () =>
    expectNone(blankBusy(), 'blank busy buttons')
  )
})
