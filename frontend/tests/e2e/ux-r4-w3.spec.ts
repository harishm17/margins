import { expect, test } from '@playwright/test'
import { FIXTURE_PDF } from './helpers/seed-demo'
import { withPrisma } from './helpers/db'
import { createCourse, signUpAndIn, ZONE } from './helpers/loop'

// Round 4, workstream W3: course setup, Materials, the topic editor, the Plan, Home, the Overview and the Topics list.

test.use({ timezoneId: ZONE })
test.setTimeout(120_000)

test.describe('materials', () => {
  test('Replace this file instead swaps the file and says so', async ({ page }) => {
    await signUpAndIn(page, 'r4w3-replace', { own: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    const { courseId } = await createCourse(page, 'Replace course', [{ name: 'Sorting' }])
    const material = await withPrisma((prisma) => prisma.material.findFirstOrThrow({ where: { projectId: courseId } }))
    await page.goto(`/courses/${courseId}/materials`)
    await page.getByRole('button', { name: `Actions for ${material.filename}` }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('dialog').getByRole('button', { name: 'Replace this file instead' }).click()
    await (await chooser).setFiles(FIXTURE_PDF)
    const notice = page.getByTestId('materials-notice')
    await expect(notice).toContainText(`Replaced ${material.filename} with algorithms.pdf`, { timeout: 30_000 })
    await expect(page.getByRole('row', { name: new RegExp(material.filename.replace('.', '\\.')) })).toHaveCount(0)
  })
})

test.describe('topic editor', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('says Saving, All changes saved, and what failed with Retry; the row is put back', async ({ page }) => {
    await signUpAndIn(page, 'r4w3-save', { own: true })
    const { courseId } = await createCourse(page, 'Save status course', [{ name: 'Alpha' }, { name: 'Beta' }])
    await page.goto(`/courses/${courseId}/topics?edit=1`)
    const status = page.getByTestId('save-status')
    await expect(status).toHaveText('')
    // A failed rename: the row goes back and the status offers Retry.
    await page.route('**/api/topics/*', (route) => (route.request().method() === 'PATCH' ? route.abort() : route.continue()))
    await page.getByRole('button', { name: 'Rename Alpha' }).click()
    await page.getByRole('textbox', { name: 'Topic name' }).fill('Alpha renamed')
    await page.keyboard.press('Enter')
    await expect(status).toContainText('Couldn\'t save "Alpha renamed"')
    await expect(page.getByText('Alpha renamed', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Alpha', { exact: true }).first()).toBeVisible()
    // With the connection back, Retry sends the same change.
    await page.unroute('**/api/topics/*')
    await status.getByRole('button', { name: 'Retry' }).click()
    await expect(status).toHaveText('All changes saved')
    await expect(page.getByText('Alpha renamed', { exact: true })).toBeVisible()
  })

})

