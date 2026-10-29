import { expect, test } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { signIn } from './helpers/auth'
import { addContent, createCourse, dayIn, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'

// A mixed practice block of the plan is 15 to 30 minutes. Its link opens the new mock exam form with the
// block's length and a matching number of questions already chosen; the student can still change them.

test.use({ timezoneId: ZONE })
test.setTimeout(180_000)

test('a 20-minute mixed block opens the exam form with 20 minutes and 5 questions', async ({ page, context }) => {
  await setZoneCookie(context)
  const { email } = await signUpAndIn(page, 'mixed-length')
  // Two learned topics, an exam in two weeks and 20 minutes a day: the free time is one mixed block of 20.
  const course = await createCourse(
    page,
    'Short mixed practice',
    [
      { name: 'Graphs', minutes: 20 },
      { name: 'Trees', minutes: 20 },
    ],
    { examDate: dayIn(ZONE, 14), dailyMinutes: 20 }
  )
  for (const id of Object.values(course.topics)) await addContent(id, { section_notes: '# Notes\n\nText.' })
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    for (const topicId of Object.values(course.topics)) {
      await prisma.topicProgress.create({ data: { userId: user.id, topicId, notesCompleted: true, examplesCompleted: true } })
    }
  })

  await page.goto(`/courses/${course.courseId}/plan`)
  const mixed = page.getByRole('link', { name: /Mixed practice/, includeHidden: true }).first()
  await expect(mixed).toHaveAttribute('href', /minutes=20&questions=5/)

  await mixed.dispatchEvent('click')
  await expect(page).toHaveURL(/\/exams\/new\?/)
  await expect(page.getByRole('heading', { level: 1, name: 'New mock exam' })).toBeVisible()
  await expect(page.getByRole('radio', { name: '20 min', checked: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: '5', exact: true, checked: true })).toBeVisible()

  // Both stay changeable.
  await page.getByRole('radio', { name: '60 min' }).click()
  await expect(page.getByRole('radio', { name: '60 min', checked: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: '20 min', checked: true })).toHaveCount(0)
})

test('the form reads minutes and questions from the link, clamps them and ignores junk', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'mixed-length')
  const course = await createCourse(page, 'Exam defaults', [{ name: 'Graphs', minutes: 20 }])
  const form = `/courses/${course.courseId}/exams/new`
  const time = (label: string) => page.getByRole('radio', { name: label, checked: true })
  const count = (label: string) => page.getByRole('radio', { name: label, exact: true, checked: true })

  await page.goto(`${form}?minutes=15`)
  await expect(time('15 min')).toBeVisible()
  await expect(count('5')).toBeVisible()

  await page.goto(`${form}?minutes=25&questions=10`)
  await expect(time('20 min')).toBeVisible()
  await expect(count('10')).toBeVisible()

  await page.goto(`${form}?minutes=100000&questions=-3`)
  await expect(time('60 min')).toBeVisible()
  await expect(count('20')).toBeVisible()

  await page.goto(`${form}?minutes=abc`)
  await expect(time('60 min')).toBeVisible()
  await expect(count('20')).toBeVisible()

  await page.goto(form)
  await expect(time('60 min')).toBeVisible()
  await expect(count('20')).toBeVisible()
})

test('a 15-minute exam is written, shown with its limit and starts with a 15-minute deadline', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, DEMO_EMAIL)
  const course = `/courses/${demoIds().course}`
  await page.goto(`${course}/exams/new?minutes=15`)
  await expect(page.getByRole('radio', { name: '15 min', checked: true })).toBeVisible()
  await page.getByRole('button', { name: 'Create exam' }).click()
  await expect(page).toHaveURL(/\/exams\/[0-9a-f-]{36}$/, { timeout: 180_000 })
  await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible()
  await expect(page.getByText('15 min', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: /^(Start exam|Resume)/ }).click()
  await expect(page).toHaveURL(/\/take$/)
  await expect(page.getByRole('timer')).toBeVisible()
  const examId = page.url().match(/\/exams\/([0-9a-f-]{36})\//)?.[1] as string
  await withPrisma(async (prisma) => {
    const exam = await prisma.sampleExam.findUniqueOrThrow({ where: { id: examId } })
    expect(exam.durationMinutes).toBe(15)
    const attempt = await prisma.examSubmission.findFirstOrThrow({ where: { sampleExamId: examId } })
    expect((attempt.deadlineAt as Date).getTime() - (attempt.startedAt as Date).getTime()).toBe(15 * 60_000)
  })
  // The demo course is shared: other specs read its newest exam, so leave it as it was.
  await withPrisma((prisma) => prisma.sampleExam.delete({ where: { id: examId } }))
})
