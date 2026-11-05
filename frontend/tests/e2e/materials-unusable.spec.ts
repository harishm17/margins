import { expect, test } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { createEmptyCourse, signUpAndIn } from './helpers/loop'

// A file Margins refused (not study material) is never read, so changing what it is "used as" would do nothing: its menu offers a
// replacement instead, the footer says how to fix it, and the short column headings stay on one line beside the long reason.
test('a refused file offers a replacement, not a role, and the table headings stay on one line', async ({ page }) => {
  await signUpAndIn(page, 'unusable-row', { own: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  const courseId = await createEmptyCourse(page, 'Refused file course')
  await withPrisma((prisma) =>
    prisma.material.create({
      data: {
        projectId: courseId,
        category: 'lecture_notes',
        filename: 'resume.pdf',
        gcsPath: `e2e/${courseId}/resume.pdf`,
        sizeBytes: BigInt(2048),
        validationStatus: 'invalid',
        validationNotes: 'This is a personal resume for a software engineer, not something to study from.',
      },
    })
  )
  await page.goto(`/courses/${courseId}/materials`)
  const row = page.getByRole('row', { name: /resume\.pdf/ })
  await expect(row.getByText(/Not usable: This is a personal resume/)).toBeVisible()
  await expect(page.getByText('1 file needs attention. Remove it or replace it with course files.')).toBeVisible()

  for (const name of ['Used as', 'Size', 'Status']) {
    const heading = page.getByRole('columnheader', { name })
    const box = (await heading.boundingBox())!
    expect(box.height, `${name} heading on one line`).toBeLessThan(40)
  }

  await page.getByRole('button', { name: 'Actions for resume.pdf' }).click()
  await expect(page.getByRole('menuitem', { name: 'Use as' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Replace with another file' })).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: 'Replace with another file' }).click()
  expect(await chooser).toBeTruthy()
})
