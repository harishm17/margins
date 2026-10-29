import path from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

test('chat spend recorded while the account is being deleted still counts toward the global total', async () => {
  // The chat route's storage (src/server/chat-storage.ts) against the stack's database. The answer
  // finishes after the account (and so its conversation) was deleted: the message cannot be saved,
  // but the billed cost must reach the ledger, unlinked. The same for a billed failure.
  const { createChatStorage } = await import('../../src/server/chat-storage')
  await withPrisma(async (prisma) => {
    const user = await prisma.user.create({ data: { email: `chat-gone-${Date.now()}@example.com` } })
    const project = await prisma.project.create({ data: { userId: user.id, name: 'Chat course' } })
    const thread = await prisma.chatThread.create({ data: { userId: user.id, projectId: project.id } })
    const question = await prisma.chatMessage.create({ data: { threadId: thread.id, role: 'user', content: 'Q?' } })
    const storage = createChatStorage(prisma, {
      userId: user.id,
      projectId: project.id,
      threadId: thread.id,
      userMessageId: question.id,
      isNewThread: true,
      log: () => {},
    })
    await prisma.$queryRaw`SELECT delete_user_account(${user.id})`

    const answerCost = 0.004321
    const failureCost = 0.001234
    await expect(
      storage.saveAnswer({ text: 'A.', sources: [], marks: [], usage: { model: 'm', inputTokens: 10, outputTokens: 5, costUsd: answerCost } })
    ).rejects.toThrow()
    await storage.recordFailure('LLM_ERROR', { model: 'm', inputTokens: 10, outputTokens: 5, costUsd: failureCost })

    const rows = await prisma.llmUsageEvent.findMany({
      where: { costUsd: { in: [answerCost.toFixed(6), failureCost.toFixed(6)] }, createdAt: { gte: user.createdAt } },
    })
    expect(rows.map((row) => row.costUsd.toString()).sort()).toEqual([failureCost.toFixed(6), answerCost.toFixed(6)].sort())
    for (const row of rows) {
      expect(row.userId).toBeNull()
      expect(row.projectId).toBeNull()
      expect(row.sourceId).toBe('')
    }
    await prisma.llmUsageEvent.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })
  })
})

test('an upload whose database record fails leaves no stored file behind', async ({ page }) => {
  // The same leak as an upload finishing while its account is deleted: the file is written, then the
  // material row is refused. A test-only trigger refuses this one filename.
  const filename = `refused-by-test-${Date.now()}.pdf`
  await withPrisma(async (prisma) => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION e2e_refuse_material() RETURNS trigger AS $$
      BEGIN
        IF NEW.filename LIKE 'refused-by-test-%' THEN RAISE EXCEPTION 'refused by the e2e test'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe(
      'CREATE OR REPLACE TRIGGER e2e_refuse_material BEFORE INSERT ON materials FOR EACH ROW EXECUTE FUNCTION e2e_refuse_material()'
    )
  })
  try {
    const email = await newAccount(page)
    const userId = await withPrisma(async (prisma) => (await prisma.user.findUniqueOrThrow({ where: { email } })).id)
    const created = await page.request.post('/api/projects', { data: { name: 'Refused upload' } })
    const courseId = (await created.json()).project.id as string

    const upload = await page.request.post(`/api/projects/${courseId}/materials?category=lecture_notes&filename=${filename}`, {
      data: readFileSync(FIXTURE_PDF),
      headers: { 'content-type': 'application/pdf' },
    })
    expect(upload.status()).toBe(500)
    const folder = path.join(UPLOADS, userId, courseId, 'materials')
    const left = existsSync(folder) ? readdirSync(folder, { recursive: true }).filter((entry) => String(entry).endsWith('.pdf')) : []
    expect(left).toEqual([])
    expect(await withPrisma((prisma) => prisma.processingJob.count({ where: { projectId: courseId } }))).toBe(0)
  } finally {
    await withPrisma(async (prisma) => {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS e2e_refuse_material ON materials')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS e2e_refuse_material()')
    })
  }
})
