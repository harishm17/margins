import { defineConfig, devices } from '@playwright/test'

// Runs against a live stack (the web app, the AI service with LLM_PROVIDER=mock, and the database
// in DATABASE_URL). global-setup.ts seeds the demo course the specs share. Set PLAYWRIGHT_BASE_URL
// to the app's address.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000'

export default defineConfig({
  // The e2e specs only: the workflow tests in tests/workflows are node:test files, which run as soon as they are loaded.
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
