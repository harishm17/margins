import type { Locator, Page } from '@playwright/test'
import { test, expect } from './harness/fixtures'
import { openOnWarmup, readyCourse, startStudying, takeWarmup } from './harness/course'
import { addMarginNote, preparationFinished } from './harness/files'
import { expectNone } from './harness/page-checks'
import { draftKeys, inheritedWork, missingParts, regenerated } from './harness/regenerate'

// WF8: regenerate with work in progress. A studied topic with a margin note and its reading done, a prediction typed on a
// worked example, working typed on a practice step and a quiz half answered; then notes, examples, practice and the quiz
// regenerated one after another from the topic's menu: what each dialog said, and what became of the work.

/** The student's work in progress, the same every run and general enough for any topic. */
const NOTE = 'My note: come back to this step before the exam.'
const PREDICTION = 'My guess: the next step checks the smaller case first.'
const WORKING = 'My working: first I write down what the step gives me.'

/**
 * Each kind of content the topic's menu regenerates, the job that writes it, and the options picked in its dialog. A
 * live model writes something new on every regenerate; a recorded one gives back the same answer to the same request,
 * so each regenerate asks for something other than the first preparation did (which used the defaults), as a student
 * who wants different notes or harder problems would.
 */
const KINDS = [
  { kind: 'notes', contentType: 'section_notes', options: { 'Level of detail': 'Detailed' } },
  { kind: 'examples', contentType: 'solved_examples', options: { Count: '2', Difficulty: 'Hard' } },
  // Not Hard: both hard problems recorded were dropped by the hint-leak check (finding 99), so the job failed.
  { kind: 'practice', contentType: 'interactive_examples', options: { Count: '2', Difficulty: 'Easy' } },
  { kind: 'quiz', contentType: 'topic_quiz', options: { 'Number of questions': '5', Difficulty: 'Hard' } },
] as const
type Kind = (typeof KINDS)[number]['kind']

/** An item the student had work on: what it asks (or its title) and the box the work is in. */
type Work = { item: string; box: Locator }

/** The first practice step: what it asks, and its working box, opened. */
async function practiceStep(page: Page, topicUrl: string): Promise<Work> {
  await page.goto(`${topicUrl}?view=practice`)
  const toggle = page.getByRole('button', { name: 'Your working (optional)' }).first()
  await expect(toggle).toBeVisible({ timeout: 4 * 60_000 })
  const step = page.locator('main form').filter({ has: toggle }).first()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  const item = (await step.innerText()).split('Your working (optional)')[0].replace(/\s+/g, ' ').trim()
  return { item, box: step.getByRole('textbox', { name: 'Your working (optional)' }) }
}

/**
 * The first worked example, opened: its title, and the box of its first hidden part (null when it hides none). A first
 * example shown in full asks for a guess at each step's reason; later ones hide steps and ask for a prediction.
 */
async function firstExample(page: Page, topicUrl: string): Promise<Work | null> {
  await page.goto(`${topicUrl}?view=examples`)
  const header = page.locator('main h2 > button[aria-expanded]').first()
  await expect(header).toBeVisible({ timeout: 4 * 60_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  const box = header.locator('xpath=ancestor::h2/..').getByLabel(/^Your (prediction|guess)$/).first()
  if (!(await box.count())) return null
  return { item: (await header.innerText()).replace(/\s+/g, ' ').trim(), box }
}

/** Polls until the student has a saved draft on `surface` (drafts save a moment after typing stops). */
async function draftsSaved(email: string, surface: string): Promise<string[]> {
  for (const giveUpAt = Date.now() + 20_000; ; ) {
    const keys = await draftKeys(email, surface)
    if (keys.length > 0 || Date.now() > giveUpAt) return keys
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

test('WF8 regenerate: notes, examples, practice and the quiz with work in progress', async ({ page, checks }) => {
  test.setTimeout(25 * 60_000)
  const { courseUrl, email } = await readyCourse(page, 'WF8')
  await startStudying(page, courseUrl)
  const topicUrl = new URL(page.url()).pathname
  const topicId = topicUrl.split('/').pop()!
  const main = page.locator('main')

  await test.step('a studied topic: the warm-up, a margin note, the reading done', async () => {
    await openOnWarmup(page, topicUrl)
    await takeWarmup(page)
    // Everything is regenerated from a topic whose preparation has run to its end.
    await preparationFinished(topicId)
    await page.goto(`${topicUrl}?view=read`)
    await addMarginNote(main, NOTE)
    await page.getByRole('button', { name: "I've read it" }).click()
    await expect(page.getByText("You've read this topic.")).toBeVisible()
  })

  const before: { practice?: { item: string; work: string }; example?: { item: string; work: string }; quizDrafts: string[] } = { quizDrafts: [] }
  await test.step('work in progress: a prediction, some working, a quiz half answered', async () => {
    const example = await firstExample(page, topicUrl)
    if (example) {
      await example.box.fill(PREDICTION)
      await draftsSaved(email, 'worked_example')
      before.example = { item: example.item, work: PREDICTION }
    } else console.log('note: the first worked example hides nothing, so there is no guess to type')

    const step = await practiceStep(page, topicUrl)
    await step.box.fill(WORKING)
    await draftsSaved(email, 'practice')
    before.practice = { item: step.item, work: WORKING }

    await page.goto(`${topicUrl}?view=quiz`)
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await expect(page.getByRole('heading', { level: 2, name: /^Question 1 of \d+$/ })).toBeVisible()
    const options = page.getByRole('radiogroup', { name: /^(Answer options|True or false)$/ })
    const answer = page.getByRole('textbox', { name: 'Your answer' })
    if (await options.isVisible()) await options.getByRole('radio').nth(1).click()
    else if ((await answer.getAttribute('inputmode')) === 'decimal') await answer.fill('2')
    else await answer.fill('It works on smaller parts first and then combines them.')
    before.quizDrafts = await draftsSaved(email, 'quiz')
  })

  const said = {} as Record<Kind, string>
  await test.step('regenerate notes, examples, practice and the quiz from the topic menu', async () => {
    for (const { kind, contentType, options } of KINDS) {
      await page.goto(`${topicUrl}?view=read`)
      // The job's time is the database's; a few seconds' slack covers the two clocks.
      const since = new Date(Date.now() - 5000)
      await page.getByRole('button', { name: 'More actions' }).click()
      await page.getByRole('menuitem', { name: `Regenerate ${kind}` }).click()
      const dialog = page.getByRole('dialog', { name: `Regenerate ${kind}` })
      said[kind] = (await dialog.innerText()).replace(/\s+/g, ' ').trim()
      for (const [group, option] of Object.entries(options)) {
        await dialog.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option, exact: true }).click()
      }
      await dialog.getByRole('button', { name: `Regenerate ${kind}`, exact: true }).click()
      await regenerated(topicId, contentType, since)
    }
  })

  await checks.check('WF8.dialogs-say-kept', 'each regenerate dialog says what is kept, not only what is replaced (SW8, 66)', () =>
    expectNone(KINDS.filter(({ kind }) => missingParts(said[kind]).includes('what is kept')).map(({ kind }) => `${kind}: "${said[kind]}"`), 'dialogs')
  )
  await checks.check('WF8.dialogs-say-time-and-share', "each regenerate dialog says about how long it takes and its share of today's allowance (D1, X4, 65)", () =>
    expectNone(
      KINDS.flatMap(({ kind }) => missingParts(said[kind]).filter((part) => part !== 'what is kept').map((part) => `${kind}: no ${part}`)),
      'dialogs'
    )
  )
  await checks.check('WF8.notes-dialog-says-reading', 'the notes dialog says whether margin notes and the reading done are kept (D1, 66)', () => {
    expect(said.notes).toMatch(/margin notes?/i)
    expect(said.notes).toMatch(/\bread(ing)?\b/i)
  })
  await checks.check('WF8.dialogs-say-which-drafts-go', "the examples and practice dialogs say what becomes of the student's unsent work (SW10, 66)", () =>
    expectNone(
      (['examples', 'practice'] as const).filter((kind) => !/\b(drafts?|unsent|your (working|predictions?|answers?))\b/i.test(said[kind])).map((kind) => `${kind}: "${said[kind]}"`),
      'dialogs'
    )
  )

  await test.step('what became of the work', async () => {
    const step = await practiceStep(page, topicUrl)
    const after = { item: step.item, work: await step.box.inputValue() }
    console.log(`practice step 1: ${after.item === before.practice!.item ? 'the same step' : 'a new step'}, its working box "${after.work}"`)
    await checks.check('WF8.practice-draft-rule', 'working typed on a practice step stays with that step, or goes with it; it never shows under a new one (SW10, 66)', () =>
      expect(inheritedWork(before.practice!, after), `"${after.work}" under a step that changed`).toBe(false)
    )

    if (before.example) {
      const example = await firstExample(page, topicUrl)
      const afterExample = { item: example?.item ?? '', work: example ? await example.box.inputValue() : '' }
      console.log(`worked example 1: ${afterExample.item === before.example.item ? 'the same example' : 'a new example'}, its box "${afterExample.work}"`)
      await checks.check('WF8.examples-draft-rule', 'a prediction stays with its worked example, or goes with it; it never shows under a new one (SW10, 66)', () =>
        expect(inheritedWork(before.example!, afterExample), `"${afterExample.work}" under an example that changed`).toBe(false)
      )
    }

    const quizDrafts = await draftKeys(email, 'quiz')
    await checks.check('WF8.quiz-draft-kept', 'a new quiz set leaves the answers already given on the earlier set, which stays (SW10, 66)', () => {
      expect(before.quizDrafts.length, 'a quiz draft before').toBeGreaterThan(0)
      expectNone(before.quizDrafts.filter((key) => !quizDrafts.includes(key)), 'quiz drafts gone')
    })

    await page.goto(`${topicUrl}?view=read`)
    const noteShown = await main.getByText(NOTE, { exact: true }).count()
    const readShown = await page.getByText("You've read this topic.").count()
    await checks.check('WF8.margin-note-kept', 'new notes leave the margin note on its passage (F2, 78)', () => expect(noteShown).toBeGreaterThan(0))
    await checks.check('WF8.reading-kept', 'new notes leave the reading done (D1, 66)', () => expect(readShown).toBeGreaterThan(0))
  })
})
