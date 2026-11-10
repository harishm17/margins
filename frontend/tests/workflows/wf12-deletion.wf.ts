import path from 'node:path'
import { test, expect } from './harness/fixtures'
import { withPrisma } from '../e2e/helpers/db'
import { askScreen } from './harness/ask'
import { COURSE_NAME, FILES, chooseFiles, createCourse, openOnWarmup, readyCourse, startStudying, takeWarmup } from './harness/course'
import { INSTRUCTIONS, aiServiceQuiet, allText, courseIds, filesLeft, pathsNaming, plantPageImage, rowsNaming, spendToday, timesSaid, uploadsDir } from './harness/deletion'
import { preparationFinished } from './harness/files'
import { holdJobs, waitForHeld } from './harness/hold'
import { expectNone } from './harness/page-checks'

// WF12: deleting. A studied course (the warm-up, a question in Ask, the practice tutor, a recall answer) is deleted from
// its settings; then a second course is made and, while its file is still waiting to be read, the account is deleted from
// another tab, and the waiting job is let go afterwards. Each time nothing may be left in storage (a page image is put where
// B8 will store them, so they are checked before B8 writes any), no row may name what was deleted except by its rule (the
// spend ledger keeps a deleted course's rows, and unlinks a deleted account's), the day's spend may not fall, and the
// dialog must give its instruction once.

/** What the student writes: neutral, so no course text is kept here (the same as WF11's, so the recordings are shared). */
const TYPED = {
  ask: 'What should I understand first in this topic, in two sentences?',
  recall: 'It is about stating clearly what a correct answer must satisfy for every input, and checking it step by step.',
} as const


test('WF12 deletion: a studied course deleted, then the account while a file is still being read', async ({ page, checks }) => {
  test.setTimeout(30 * 60_000)
  const { courseUrl, courseId, email } = await readyCourse(page, 'WF12')
  const { id: userId } = await withPrisma((prisma) => prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }))
  await startStudying(page, courseUrl)
  const topicUrl = new URL(page.url()).pathname
  const topicId = topicUrl.split('/').pop()!
  const uploads = uploadsDir()

  await test.step('a studied course: the warm-up, a question, the practice tutor and a recall answer', async () => {
    await openOnWarmup(page, topicUrl)
    await takeWarmup(page)
    await preparationFinished(topicId)

    await page.goto(`${courseUrl}/ask`)
    const ask = askScreen(page)
    await ask.reply(() => ask.send(TYPED.ask))

    await page.goto(`${topicUrl}?view=practice`)
    const step = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^(Get help|More help)$/ }) }).first()
    await expect(step).toBeVisible({ timeout: 4 * 60_000 })
    const help = step.getByRole('button', { name: /^(Get help|More help)$/ })
    if ((await help.getAttribute('aria-expanded')) !== 'true') await help.click()
    await step.getByRole('button', { name: 'What is this asking?' }).click()
    await expect(step.getByRole('log', { name: 'Tutor conversation' }).getByText('Tutor', { exact: true }).first()).toBeVisible({ timeout: 2 * 60_000 })

    await page.goto(`${topicUrl}?view=recall`)
    const prompt = page.getByRole('region', { name: 'Close the book and say what you remember' }).getByRole('list').first().locator(':scope > li').first()
    await prompt.getByRole('textbox').fill(TYPED.recall)
    await prompt.getByRole('button', { name: 'Check my answer' }).click()
    await expect(prompt.getByRole('region', { name: 'Feedback on your answer' })).toBeVisible({ timeout: 2 * 60_000 })
  })

  const owned = await courseIds(courseId)
  const { id: materialId } = await withPrisma((prisma) => prisma.material.findFirstOrThrow({ where: { projectId: courseId }, select: { id: true } }))
  plantPageImage(userId, courseId, materialId)
  expect(await rowsNaming([courseId]), 'the scan sees the course before it is deleted').not.toEqual([])
  const spentBefore = await spendToday(userId)

  let courseDialog = ''
  await test.step('Delete course, from the course settings', async () => {
    await page.goto(`${courseUrl}/settings`)
    await page.getByRole('button', { name: 'Delete course' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete this course?' })
    await expect(dialog).toBeVisible()
    // Read before typing: the confirm button's reason is read out only while it is off.
    courseDialog = await allText(dialog)
    await dialog.getByRole('textbox').fill(COURSE_NAME)
    await dialog.getByRole('button', { name: 'Delete course' }).click()
    await expect(page).toHaveURL(/\/home$/, { timeout: 60_000 })
    await aiServiceQuiet()
  })

  const courseLeft = [...filesLeft(path.join(uploads, userId, courseId)), ...pathsNaming(filesLeft(path.join(uploads, userId)), owned)]
  // voice_usage keeps the seconds each voice session used, by session id and one-way key, so deleting a course does not give the minutes back.
  const courseRows = await rowsNaming(owned, ['llm_usage_events', 'voice_usage'])
  const spentAfter = await spendToday(userId)
  console.log(`course delete: ${courseLeft.length} file(s) left, rows left: ${courseRows.join(', ') || 'none'}; today's spend $${spentBefore.toFixed(4)} then $${spentAfter.toFixed(4)}`)
  await checks.check('WF12.course-files-gone', 'Deleting a course removes its whole folder in storage, page images included (B8)', () =>
    expectNone([...new Set(courseLeft)], 'left in storage')
  )
  await checks.check(
    'WF12.course-references-cleared',
    "Deleting a course leaves no row naming it or anything it owned (files, chunks, topics, content, concepts, conversations, sessions, jobs); the spend ledger keeps its rows by rule, so today's spend does not fall (SW13)",
    () => expectNone([...courseRows, ...(spentAfter + 1e-9 < spentBefore ? [`today's spend fell from $${spentBefore} to $${spentAfter}`] : [])], 'left behind')
  )
  await checks.check('WF12.course-dialog-once', 'The Delete course dialog asks for the course name once (SW15)', () =>
    expect(timesSaid(courseDialog, INSTRUCTIONS.typeTheName), `times "type the name" is said in: ${courseDialog}`).toBe(1)
  )

  const release = await holdJobs('validate_material')
  let accountDialog = ''
  let ownedNow: string[] = []
  const totalBefore = await spendToday()
  try {
    await test.step('a second course, its file still waiting to be read', async () => {
      const second = await createCourse(page, 'Second course')
      await chooseFiles(page, [FILES.lecture1])
      await waitForHeld('validate_material')
      ownedNow = await courseIds(second.courseId)
      const { id: waiting } = await withPrisma((prisma) => prisma.material.findFirstOrThrow({ where: { projectId: second.courseId }, select: { id: true } }))
      plantPageImage(userId, second.courseId, waiting)
    })

    await test.step('Delete account, from Settings in another tab', async () => {
      const settings = await page.context().newPage()
      await settings.goto('/settings')
      await settings.getByRole('button', { name: 'Delete account' }).first().click()
      const dialog = settings.getByRole('dialog', { name: 'Delete your account?' })
      await expect(dialog).toBeVisible()
      accountDialog = await allText(dialog)
      await dialog.getByRole('textbox').fill('DELETE')
      await dialog.getByRole('button', { name: 'Delete account' }).click()
      await expect(settings).toHaveURL(/\/account-deleted/, { timeout: 60_000 })
      await settings.close()
    })
  } finally {
    // The waiting job goes now, after the account is gone, as a job already on its way would.
    await release()
  }
  await aiServiceQuiet()

  const accountLeft = filesLeft(path.join(uploads, userId))
  // Two tables outlive the account by rule (privacy page, "Your choices"): the tombstone delete_user_account() writes (a random id and
  // the one-way key, so a late ledger row is still stamped) and voice_usage. Neither holds a name, an email or a course.
  const accountRows = await rowsNaming([userId, email, ...owned, ...ownedNow], ['deleted_accounts', 'voice_usage'])
  const totalAfter = await spendToday()
  console.log(`account delete: ${accountLeft.length} file(s) left, rows left: ${accountRows.join(', ') || 'none'}; today's spend (everyone) $${totalBefore.toFixed(4)} then $${totalAfter.toFixed(4)}`)
  await checks.check('WF12.account-files-gone', "Deleting the account removes its whole folder in storage, a file still waiting to be read and page images included (B8)", () =>
    expectNone(accountLeft, 'left in storage')
  )
  await checks.check(
    'WF12.account-references-cleared',
    "Deleting the account leaves no row naming it, its email or anything it owned, the spend ledger's rows included (they are unlinked), and the day's total spend does not fall (SW13)",
    () => expectNone([...accountRows, ...(totalAfter + 1e-9 < totalBefore ? [`today's total spend fell from $${totalBefore} to $${totalAfter}`] : [])], 'left behind')
  )
  await checks.check('WF12.deletion-says-what-stays', 'The Delete account dialog and the Privacy Policy say that anonymous usage records stay under a one-way key (SW14, SEC-L7)', async () => {
    expect(accountDialog, 'the Delete account dialog').toMatch(/usage records[^.]*stay[^.]*one-way key/i)
    await page.goto('/privacy')
    expect(await allText(page.locator('main')), 'the Privacy Policy').toMatch(/one-way key[\s\S]*deleting an account and\s+signing up again/i)
  })
  await checks.check('WF12.account-dialog-once', 'The Delete account dialog says "Enter DELETE" once (U4)', () =>
    expect(timesSaid(accountDialog, INSTRUCTIONS.enterDelete), `times "Enter DELETE" is said in: ${accountDialog}`).toBe(1)
  )
})
