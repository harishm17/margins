import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { createEmptyCourse, signUpAndIn } from './helpers/loop'
import { FIXTURE_DOCX, FIXTURE_PDF } from './helpers/seed-demo'

test.setTimeout(240_000)

// Materials: a course whose topics wait for the student ("We found N topics") gets another file. The
// alert used to unmount while the file was read (the page jumped up 90px) and mount again when it was
// ready (down 90px, a layout shift with no input behind it).
test('uploading a file keeps the "new topics" alert in place: no layout shift, the alert never leaves', async ({ page }) => {
  await signUpAndIn(page, 'upload-shift')
  const courseId = await createEmptyCourse(page, 'Upload shift')
  const first = await page.request.post(`/api/projects/${courseId}/materials?category=lecture_notes&filename=algorithms.pdf`, {
    data: readFileSync(FIXTURE_PDF),
    headers: { 'content-type': 'application/pdf' },
  })
  expect(first.ok()).toBeTruthy()
  await expect
    .poll(async () => (await (await page.request.get(`/api/projects/${courseId}/topics`)).json()).topics.length, { timeout: 120_000 })
    .toBeGreaterThan(0)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/courses/${courseId}/materials`, { waitUntil: 'networkidle' })
  const alert = page.getByRole('status').filter({ hasText: /We found .* in your files/ })
  await expect(alert).toBeVisible()
  await expect(alert.getByRole('link')).toBeVisible()

  await page.evaluate(() => {
    const w = window as unknown as { __shift: number; __gaps: number; __stop: boolean }
    w.__shift = 0
    w.__gaps = 0
    w.__stop = false
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!entry.hadRecentInput) w.__shift += entry.value
      }
    }).observe({ type: 'layout-shift', buffered: true })
    // Every frame: is the alert there?
    const tick = () => {
      const found = [...document.querySelectorAll('main [role="status"]')].some((el) => /We found .* in your files/.test(el.textContent ?? ''))
      if (!found) w.__gaps += 1
      if (!w.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await page.getByLabel('Choose files to upload').setInputFiles(FIXTURE_DOCX)
  await expect
    .poll(async () => (await (await page.request.get(`/api/projects/${courseId}/materials`)).json()).materials.map((m: { validationStatus: string }) => m.validationStatus).join(), { timeout: 120_000 })
    .toBe('valid,valid')
  await page.waitForTimeout(3000)

  const { shift, gaps } = await page.evaluate(() => {
    const w = window as unknown as { __shift: number; __gaps: number; __stop: boolean }
    w.__stop = true
    return { shift: w.__shift, gaps: w.__gaps }
  })
  expect(gaps, 'frames without the alert while the file was read').toBe(0)
  expect(shift, 'layout shift without recent input').toBeLessThan(0.001)
  await expect(alert.getByRole('link')).toBeVisible()
})
