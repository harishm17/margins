import { expect, test, type Page } from '@playwright/test'
import { addContent, createCourse, createEmptyCourse, addMaterial, makeDue, quizQuestions, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// Wayfinding: the next step is one thing everywhere, a course has its own navigation on a phone, the
// heading order starts with the page's h1, and the Review page has one main button.

test.use({ timezoneId: ZONE })

async function dueCourse(page: Page, label: string, due: number, options: { own?: boolean } = {}) {
  const user = await signUpAndIn(page, label, options)
  const emptyId = await createEmptyCourse(page, 'Wayfinding course')
  await addMaterial(page, emptyId)
  const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].slice(0, Math.max(due, 2))
  const course = await createCourse(page, 'Wayfinding course', names.map((name) => ({ name, minutes: 30 })), { existingCourseId: emptyId })
  for (const name of names) await addContent(course.topics[name], { section_notes: `# ${name}\n\nNotes.`, topic_quiz: quizQuestions(2) })
  for (const name of names.slice(0, due)) await makeDue(course.topics[name], user.email, { mastery: 0.4, daysAgo: 2 })
  return { user, course }
}

test.describe('one next step', () => {
  test('Home, the overview, the sidebar and the Review page name the same number of due reviews', async ({ page, context }) => {
    test.setTimeout(240_000)
    await setZoneCookie(context)
    // Its own account: Home counts and orders every course an account has, which other specs change.
    const { course } = await dueCourse(page, 'agree', 3, { own: true })
    const base = `/courses/${course.courseId}`

    await page.goto(base)
    await expect(page.getByText(/3 due for review/).first()).toBeVisible()
    // The sidebar badge, on a wide screen.
    await expect(page.getByRole('navigation', { name: 'Course' }).getByText('3 due for review').first()).toBeAttached()
    const upNext = page.getByRole('region', { name: 'Up next' })
    await expect(upNext).toContainText('Review ')
    await expect(upNext).not.toContainText("You're done for today")

    await page.goto('/home')
    // The account has this course only, so Home counts exactly its three.
    await expect(page.getByRole('heading', { level: 2, name: /Due for review/ })).toContainText('(3)')
    await expect(page.getByRole('region', { name: /Up next/ })).toContainText('Review ')

    await page.goto(`${base}/review`)
    await expect(page.getByRole('heading', { level: 2, name: /Due for review/ })).toContainText('(3)')
  })

})

