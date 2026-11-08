import { defineConfig, devices } from '@playwright/test'

// The workflow suite (tests/workflows): whole student journeys on real course files, against a stack whose AI
// service replays recorded model answers. Run it with scripts/workflows.sh, which starts that stack on a fresh
// database; tests/workflows/README.md says what each workflow covers. Not part of `playwright test`: the
// default config's specs run on the mock model in CI, and these files end in .wf.ts.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3460'

export default defineConfig({
  testDir: './tests/workflows',
  testMatch: '**/*.wf.ts',
  outputDir: './test-results/workflow-runs',
  // A workflow is a whole journey: a course built from uploads, then several study sessions.
  timeout: 15 * 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: './test-results/workflow-report' }]],
  use: {
    baseURL,
    timezoneId: 'America/Los_Angeles',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
})
