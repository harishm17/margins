import { expect, test } from '@playwright/test'
import { submitTestLogin } from './helpers/auth'
import { withPrisma } from './helpers/db'

// Sign-in is Google only. A test cannot finish a Google sign-in, so these check the page, the
// redirect to Google and the routes that went away; the Google decision logic has unit tests
// (src/lib/auth/google-link.test.ts). The stack runs with a made-up Google client
// (scripts/e2e-stack.sh) so the button is there, and with the local-only test sign-in.

test('the sign-in page offers Google for new and returning students, and no password', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Margins' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
  await expect(page.getByText('Made your account with a password?')).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await expect(page.getByLabel('Password')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
})

test('/signup goes to /login and keeps where the student was going', async ({ page }) => {
  await page.goto('/signup')
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/signup?next=%2Fcourses%2Fnew')
  await expect(page).toHaveURL(/\/login\?next=%2Fcourses%2Fnew$/)
})

test('the password routes are gone', async ({ request }) => {
  // /api/auth/signup is gone: NextAuth's catch-all answers it as an unknown action, and makes no account.
  const email = `gone-${Date.now()}@example.com`
  const signup = await request.post('/api/auth/signup', { data: { email, password: 'long-enough-password' } })
  expect([400, 404]).toContain(signup.status())
  expect(await withPrisma((prisma) => prisma.user.count({ where: { email } }))).toBe(0)
  const providers = (await (await request.get('/api/auth/providers')).json()) as Record<string, unknown>
  expect(Object.keys(providers).sort()).toEqual(['google', 'test-login'])
})

test('Continue with Google goes to Google with this site as the callback', async ({ page, baseURL }) => {
  await page.goto('/login?next=%2Fhome')
  let googleUrl = ''
  await page.route('https://accounts.google.com/**', async (route) => {
    googleUrl = route.request().url()
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Google</p>' })
  })
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await expect.poll(() => googleUrl).not.toBe('')
  const url = new URL(googleUrl)
  expect(url.pathname).toBe('/o/oauth2/v2/auth')
  expect(url.searchParams.get('client_id')).toMatch(/\.apps\.googleusercontent\.com$/)
  expect(url.searchParams.get('redirect_uri')).toBe(`${baseURL}/api/auth/callback/google`)
})

test('a Google refusal is explained on the sign-in page', async ({ page }) => {
  await page.goto('/login?error=GoogleAccountMismatch')
  const alert = page.locator('#main').getByRole('alert')
  await expect(alert).toContainText('already connected to a different Google account')
  await expect(alert).not.toContainText(/password/i)
})

test('the test sign-in only takes @example.com addresses', async ({ page }) => {
  await page.goto('/login')
  await submitTestLogin(page, 'someone@gmail.com')
  await expect(page.getByRole('form', { name: 'Test sign-in' }).getByRole('alert')).toHaveText('Use an @example.com address.')
  await expect(page).toHaveURL(/\/login$/)
})
