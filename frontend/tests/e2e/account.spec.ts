import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { signIn } from './helpers/loop'
import { FIXTURE_PDF } from './helpers/seed-demo'

// Settings and self-serve account deletion, end to end: a fresh account with a course, an uploaded
// file (stored in the stack's local upload folder) and a spend row is deleted from Settings. The
// account's rows and files go, the spend row stays unlinked, and a second browser that shared the
// session is signed out too.

/** Where scripts/e2e-stack.sh keeps uploads (E2E_RUN_DIR, or .e2e in the repo). */
const UPLOADS = path.join(process.env.E2E_RUN_DIR || path.join(__dirname, '..', '..', '..', '.e2e'), 'uploads')

async function newAccount(page: Page) {
  const email = `delete-me-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
  const password = 'delete-me-password'
  const signup = await page.request.post('/api/auth/signup', { data: { email, password, name: 'Leaving Student' } })
  expect(signup.status()).toBe(201)
  await signIn(page, email, password)
  return email
}

test('settings shows the account and allowance; deleting the account removes its data and files and signs out every session', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000)
  const email = await newAccount(page)
  const userId = await withPrisma(async (prisma) => (await prisma.user.findUniqueOrThrow({ where: { email } })).id)

  // A course with an uploaded file.
  const created = await page.request.post('/api/projects', { data: { name: 'Course to delete' } })
  expect(created.ok()).toBeTruthy()
  const courseId = (await created.json()).project.id as string
  const upload = await page.request.post(`/api/projects/${courseId}/materials?category=lecture_notes&filename=algorithms.pdf`, {
    data: readFileSync(FIXTURE_PDF),
    headers: { 'content-type': 'application/pdf' },
  })
  expect(upload.ok()).toBeTruthy()
  const material = await withPrisma((prisma) => prisma.material.findFirstOrThrow({ where: { projectId: courseId } }))
  const storedFile = path.join(UPLOADS, material.gcsPath.replace(/^gs:\/\/[^/]+\//, ''))
  expect(existsSync(storedFile)).toBe(true)
  // Something the account spent today, which must keep counting toward the global cap.
  const ledgerId = `e2e-ledger-${Date.now()}`
  await withPrisma((prisma) =>
    prisma.llmUsageEvent.create({
      data: { id: ledgerId, userId, projectId: courseId, source: 'job', sourceId: 'job-1', costUsd: '0.123456' },
    })
  )

  // A second device signed in to the same account.
  const otherDevice = await browser.newContext({ storageState: await page.context().storageState() })
  const otherPage = await otherDevice.newPage()
  await otherPage.goto('/home')
  await expect(otherPage).toHaveURL(/\/home$/)

  // Settings, from the account menu.
  await page.goto('/home')
  await page.getByRole('button', { name: /account menu/ }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(page.getByTestId('account-email')).toHaveText(email)
  await expect(page.getByRole('heading', { name: "Today's AI allowance" })).toBeVisible()
  await expect(page.getByText('Available', { exact: true })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: "Today's AI allowance used" })).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible()

  // Deleting needs the confirmation word.
  await page.getByRole('button', { name: 'Delete account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
  await expect(dialog).toContainText(email)
  const confirm = dialog.getByRole('button', { name: 'Delete account' })
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('Type "DELETE"').fill('delete')
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('Type "DELETE"').fill('DELETE')
  await confirm.click()
  await expect(page).toHaveURL(/\/account-deleted$/, { timeout: 60_000 })
  await expect(page.getByRole('heading', { level: 1, name: 'Your account is deleted' })).toBeVisible()

  // The account, its course, file row, jobs and stored file are gone; the spend row stays, unlinked.
  await withPrisma(async (prisma) => {
    expect(await prisma.user.count({ where: { id: userId } })).toBe(0)
    expect(await prisma.project.count({ where: { userId } })).toBe(0)
    expect(await prisma.material.count({ where: { id: material.id } })).toBe(0)
    expect(await prisma.processingJob.count({ where: { userId } })).toBe(0)
    const ledger = await prisma.llmUsageEvent.findUniqueOrThrow({ where: { id: ledgerId } })
    expect(ledger.userId).toBeNull()
    expect(ledger.projectId).toBeNull()
    expect(ledger.sourceId).toBe('')
    expect(ledger.costUsd.toString()).toBe('0.123456')
    await prisma.llmUsageEvent.delete({ where: { id: ledgerId } })
  })
  expect(existsSync(storedFile)).toBe(false)
  expect(existsSync(path.join(UPLOADS, userId))).toBe(false)

  // This browser is signed out.
  await page.goto('/home')
  await expect(page).toHaveURL(/\/login/)

  // So is the other device, whose session cookie was never cleared.
  const refused = await otherPage.request.get(`/api/projects/${courseId}`)
  expect(refused.status()).toBe(401)
  await otherPage.goto('/settings')
  await expect(otherPage).toHaveURL(/\/login/)
  await otherDevice.close()

  // The account can't sign in with its old password any more.
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('delete-me-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/login/)
})
