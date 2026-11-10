import { test, expect } from './harness/fixtures'
import { withPrisma } from '../e2e/helpers/db'
import { readyCourse, startStudying, openOnWarmup, takeWarmup, takeQuiz } from './harness/course'
import { daysPass } from './harness/clock'
import { addMarginNote, preparationFinished } from './harness/files'

// WF13: editing topics after studying them. The first topic is studied (a margin note, a recall answer, a quiz) and a day
// passes so it is due; the second topic is untouched; the third gets a margin note of its own (written straight to the
// table, as the reader writes it: the topic's reading is not prepared for the third topic in this run). Then the first topic
// is merged into the second and the third is deleted, from the topic editor. The notes must be kept (merged, or listed under
// "Notes from removed topics" and deletable there), the mastery words and review due date must be the merged topic's, and
// the plan and the voice quick round must not name a topic that is gone.
//
// Not checked here: the quick round's lobby does not list the topics it will use, so its order is not read. The workflow checks
// what the ranking (server/queries/voice-rank.ts) reads instead: the merged topic carries the studied topic's finished quiz.
// The plan's minutes are checked as the stored estimate of the merged topic (the two added), not as the plan page's total.

/** What the student writes: neutral, so no course text is kept here (the same as WF12's, so the recordings are shared). */
const RECALL = 'It is about stating clearly what a correct answer must satisfy for every input, and checking it step by step.'
const NOTE_ON_FIRST = 'My note: this is the step I get wrong.'
const NOTE_ON_THIRD = 'My note: ask about this in office hours.'

test('WF13 topic edits: merge a studied topic into another, delete a third, keep the student\'s work', async ({ page, checks }) => {
  test.setTimeout(30 * 60_000)
  const { courseUrl, courseId, email } = await readyCourse(page, 'WF13')
  const { id: userId } = await withPrisma((prisma) => prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }))
  const topics = await withPrisma((prisma) => prisma.topic.findMany({ where: { projectId: courseId }, orderBy: { orderIndex: 'asc' }, select: { id: true, name: true, estimatedMinutes: true } }))
  expect(topics.length, 'topics found').toBeGreaterThanOrEqual(3)
  const [first, second, third] = topics

  await startStudying(page, courseUrl)
  const topicUrl = new URL(page.url()).pathname
  expect(topicUrl.endsWith(first.id), 'the first topic opens').toBe(true)

  await test.step('study the first topic: a margin note, a recall answer, a quiz', async () => {
    await openOnWarmup(page, topicUrl)
    await takeWarmup(page)
    await page.goto(`${topicUrl}?view=read`)
    await addMarginNote(page.locator('main'), NOTE_ON_FIRST)
    await preparationFinished(first.id)
    await page.goto(`${topicUrl}?view=recall`)
    const prompt = page.getByRole('region', { name: 'Close the book and say what you remember' }).getByRole('list').first().locator(':scope > li').first()
    await prompt.getByRole('textbox').fill(RECALL)
    await prompt.getByRole('button', { name: 'Check my answer' }).click()
    await expect(prompt.getByRole('region', { name: 'Feedback on your answer' })).toBeVisible({ timeout: 2 * 60_000 })
    await takeQuiz(page, topicUrl)
  })
  await daysPass(email, 1)

  const before = await withPrisma(async (prisma) => {
    const schedule = await prisma.reviewSchedule.findFirstOrThrow({ where: { userId, topicId: first.id } })
    const memory = await prisma.conceptMemory.findMany({ where: { userId, topicId: first.id }, select: { conceptId: true, dueAt: true } })
    // A note on the third topic, as the reader writes it (project, topic, passage and quote).
    const chunk = await prisma.materialChunk.findFirstOrThrow({ where: { material: { projectId: courseId } }, select: { id: true, materialId: true, chunkText: true } })
    await prisma.marginNote.create({
      data: { userId, projectId: courseId, topicId: third.id, materialId: chunk.materialId, chunkId: chunk.id, quote: chunk.chunkText, kind: 'note', text: NOTE_ON_THIRD },
    })
    return { schedule, memory }
  })
  expect(before.memory.length, 'the studied topic has ideas with review dates').toBeGreaterThan(0)

  await test.step('merge the first topic into the second, delete the third', async () => {
    await page.goto(`${courseUrl}/topics?edit=1`)
    const actions = (name: string) => page.getByRole('button', { name: `Actions for ${name}`, exact: true })
    await actions(first.name).click()
    await page.getByRole('menuitem', { name: 'Merge into...' }).click()
    await page.getByRole('menuitem', { name: second.name, exact: true }).click()
    const mergeDialog = page.getByRole('dialog')
    const mergeSaid = await mergeDialog.innerText()
    await checks.check('WF13.merge-dialog-says-kept', `the merge dialog says what is kept (78; "${mergeSaid.replace(/\s+/g, ' ')}")`, () =>
      expect(mergeSaid).toMatch(/notes[\s\S]*recall[\s\S]*practice[\s\S]*mastery[\s\S]*review dates/i)
    )
    await page.getByRole('button', { name: 'Merge topics' }).click()
    await expect(actions(first.name)).toHaveCount(0)

    await actions(third.name).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const deleteDialog = page.getByRole('dialog')
    const deleteSaid = await deleteDialog.innerText()
    await checks.check('WF13.delete-dialog-says-notes-kept', `the delete dialog says the notes are kept and where (78; "${deleteSaid.replace(/\s+/g, ' ')}")`, () =>
      expect(deleteSaid).toMatch(/notes are kept[\s\S]*Notes from removed topics/i)
    )
    await deleteDialog.getByRole('button', { name: 'Delete topic' }).click()
    await expect(actions(third.name)).toHaveCount(0)
  })

  const after = await withPrisma(async (prisma) => ({
    firstGone: (await prisma.topic.count({ where: { id: { in: [first.id, third.id] } } })) === 0,
    notes: await prisma.marginNote.findMany({ where: { userId }, select: { text: true, topicId: true, projectId: true } }),
    schedule: await prisma.reviewSchedule.findFirst({ where: { userId, topicId: second.id } }),
    memory: await prisma.conceptMemory.findMany({ where: { userId, topicId: second.id }, select: { conceptId: true, dueAt: true } }),
    recall: await prisma.recallAttempt.count({ where: { userId, topicId: second.id } }),
    progress: await prisma.topicProgress.findMany({ where: { userId, topicId: second.id }, select: { quizCompleted: true, quizScore: true, notesCompleted: true, examplesCompleted: true } }),
    merged: await prisma.topic.findUniqueOrThrow({ where: { id: second.id }, select: { estimatedMinutes: true } }),
  }))

  await checks.check('WF13.notes-kept', 'the note on the merged topic is on the target, and the note on the deleted one is kept with no topic (78)', () => {
    expect(after.firstGone).toBe(true)
    expect(after.notes.find((note) => note.text === NOTE_ON_FIRST)?.topicId).toBe(second.id)
    const detached = after.notes.find((note) => note.text === NOTE_ON_THIRD)
    expect(detached?.topicId).toBeNull()
    expect(detached?.projectId).toBe(courseId)
  })
  await checks.check('WF13.mastery-and-review-carried', 'the merged topic has the studied topic\'s ideas with their review dates, and a schedule at the same due date (78, SW11)', () => {
    const dates = (rows: { conceptId: string; dueAt: Date | null }[]) => rows.map((row) => `${row.conceptId}@${row.dueAt?.toISOString()}`).sort()
    expect(dates(after.memory)).toEqual(expect.arrayContaining(dates(before.memory)))
    expect(after.schedule?.dueAt.toISOString()).toBe(before.schedule.dueAt.toISOString())
    expect(after.schedule?.mastery).toBeCloseTo(before.schedule.mastery, 5)
    expect(after.recall, 'the recall answer').toBeGreaterThan(0)
  })
  await checks.check('WF13.minutes-added', 'the merged topic\'s estimate is the two topics\' minutes added, up to 180 (G5)', () =>
    expect(after.merged.estimatedMinutes).toBe(first.estimatedMinutes === null && second.estimatedMinutes === null ? null : Math.min((first.estimatedMinutes ?? 0) + (second.estimatedMinutes ?? 0), 180))
  )
  await checks.check('WF13.voice-ranking-uses-merged-progress', "the quick round has the merged topic's finished quiz to rank by (79, 83)", () => {
    expect(after.progress[0]?.quizCompleted, 'the quiz of the studied topic carried').toBe(true)
  })

  await test.step('Notes from removed topics, on the topics page', async () => {
    await page.goto(`${courseUrl}/topics`)
    const section = page.getByRole('region', { name: 'Notes from removed topics' })
    await expect(section).toContainText(NOTE_ON_THIRD)
    await expect(section).not.toContainText(NOTE_ON_FIRST)
    await section.getByRole('button', { name: /^Delete note/ }).click()
    await expect(page.getByRole('region', { name: 'Notes from removed topics' })).toHaveCount(0)
    expect(await withPrisma((prisma) => prisma.marginNote.count({ where: { userId, text: NOTE_ON_THIRD } }))).toBe(0)
  })

  await test.step('the plan names neither topic that is gone', async () => {
    await page.goto(`${courseUrl}/plan`)
    const text = await page.locator('main').innerText()
    await checks.check('WF13.plan-names-live-topics', 'the plan names no merged or deleted topic (G5)', () => {
      expect(text).not.toContain(first.name)
      expect(text).not.toContain(third.name)
    })
  })
})
