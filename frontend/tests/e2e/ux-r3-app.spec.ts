import { expect, test } from '@playwright/test'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { createCourse, createEmptyCourse, setZoneCookie, signIn, signUpAndIn } from './helpers/loop'
import { smallTargets } from './helpers/targets'
import { withPrisma } from './helpers/db'

// The third round of the design review, for the screens outside the study views: the public pages, setup, the topic editor,
// materials, Ask, the review entry, the map's phone sheet, the account and course forms and the menus.

const { course, setupCourse } = demoIds()
const base = `/courses/${course}`

test.describe('public pages', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the legal pages have jump links to labelled sections', async ({ page }) => {
    await page.goto('/privacy')
    const contents = page.getByRole('navigation', { name: 'On this page' })
    await expect(contents.getByRole('link')).toHaveText(['What we store', "How it's used", 'Services we use', 'Your choices', 'Contact'])
    await contents.getByRole('link', { name: 'Services we use' }).click()
    await expect(page).toHaveURL(/#services$/)
    await expect(page.getByRole('heading', { level: 2, name: 'Services we use' })).toBeInViewport()
    // "What we store" is a list of three labelled lines, not one run of text.
    await expect(page.locator('#store li')).toHaveCount(3)

    await page.goto('/terms')
    await expect(page.getByRole('navigation', { name: 'On this page' }).getByRole('link')).toHaveCount(6)
    await expect(page.getByRole('heading', { level: 2, name: 'Acceptable use' })).toBeVisible()
  })

  test('the sign-in page links the AI allowance to what happens at the limit', async ({ page }) => {
    await page.goto('/login')
    const link = page.getByRole('link', { name: 'daily AI allowance' })
    await expect(link).toHaveAttribute('href', '/#faq')
    await link.click()
    await expect(page.getByRole('heading', { name: 'Common questions' })).toBeInViewport()
    await expect(page.getByText('When one is used up, anything that needs the AI')).toBeVisible()
  })

  test('the evaluation page says in a line what each retrieval measure is', async ({ page }) => {
    await page.goto('/evaluation')
    const definitions = page.locator('#retrieval ~ dl, dl:has(dt:text("MRR"))').first()
    await expect(definitions.getByText('How high the first right chunk ranks. 1 means it is first.')).toBeVisible()
    await expect(definitions.getByText('Whether at least one right chunk is in the first five.')).toBeVisible()
  })

  test('the account-deleted page has a one-line footer and no sign-in links', async ({ page, context }) => {
    await context.clearCookies()
    await page.goto('/account-deleted')
    const footer = page.getByRole('contentinfo')
    await expect(footer.getByRole('link')).toHaveCount(2)
    await expect(footer.getByRole('link', { name: 'Sign in' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })

  test('the not-found page says where it leads: your courses when signed in', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto('/no-such-page')
    await expect(page.getByRole('link', { name: 'Go to your courses' })).toHaveAttribute('href', '/home')
  })
})

test.describe('Home and quick practice', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('one name and one duration statement for the quick practice, on Home and on Review', async ({ page, context }) => {
    await setZoneCookie(context)
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${base}/review`)
    const card = page.getByTestId('short-session').locator('visible=true')
    await expect(card.getByRole('heading', { name: 'Quick practice' })).toBeVisible()
    await expect(card).toContainText(/About \d+ minutes · (up to )?\d+ (questions|reviews)/)
    await expect(page.getByText('Have 10 minutes?')).toHaveCount(0)
    // With nothing due, the extras are "Optional focus", after "Nothing is due".
    const order = await page.locator('main h2, main h3').allTextContents()
    expect(order.indexOf('Nothing is due')).toBeGreaterThan(-1)
    if (order.includes('Optional focus')) expect(order.indexOf('Optional focus')).toBeGreaterThan(order.indexOf('Nothing is due'))
  })

  test('a review session with nothing due offers quick practice', async ({ page, context }) => {
    await setZoneCookie(context)
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${base}/review/session`)
    await expect(page.getByRole('heading', { name: 'Nothing is due' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try quick practice instead' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to Review' })).toBeVisible()
  })
})

test.describe('course forms', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('new course: the name is marked required, the plan comes next and the description is put away', async ({ page }) => {
    await signUpAndIn(page, 'r3-forms', { own: true })
    await page.goto('/courses/new')
    await expect(page.getByLabel(/Course name/)).toBeVisible()
    await expect(page.getByText('(required)')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Study plan' })).toBeVisible()
    await expect(page.getByLabel('Description')).toHaveCount(0)
    const order = await page.locator('form label, form legend, form button').allTextContents()
    expect(order.findIndex((text) => /Study plan/.test(text))).toBeLessThan(order.findIndex((text) => /Add a description/.test(text)))
    await page.getByRole('button', { name: 'Add a description' }).click()
    await expect(page.getByLabel(/Description/)).toBeFocused()
    // The validation message still names the field and focuses it.
    await page.getByRole('button', { name: 'Create course' }).click()
    await expect(page.getByText('Give the course a name.')).toBeVisible()
    await expect(page.getByLabel(/Course name/)).toBeFocused()
  })

  test('course settings: study plan first, description behind a button unless the course has one; the delete dialog names the course in full', async ({ page }) => {
    await signUpAndIn(page, 'r3-settings', { own: true })
    const longName = 'A very long course name that has to be read in full in the confirmation dialog 2026'
    const created = await page.request.post('/api/projects', { data: { name: longName } })
    const id = (await created.json()).project.id as string
    await page.goto(`/courses/${id}/settings`)
    await expect(page.getByRole('group', { name: 'Study plan' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add a description' })).toBeVisible()
    await page.getByRole('button', { name: 'Delete course' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(longName).first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })
})

test.describe('account', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('allowance explanation and a lower-case confirmation word', async ({ page }) => {
    await signUpAndIn(page, 'r3-account', { own: true })
    await page.goto('/settings')
    await expect(page.getByTestId('allowance-explainer')).toContainText('not a count of questions left')
    await expect(page.getByRole('link', { name: 'What happens at the limit' })).toHaveAttribute('href', '/#faq')
    await page.getByRole('button', { name: 'Delete account' }).click()
    const dialog = page.getByRole('dialog')
    const confirm = dialog.getByRole('button', { name: 'Delete account' })
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('textbox').fill('delete')
    await expect(confirm).toBeEnabled()
    await dialog.getByRole('textbox').fill('delet')
    await expect(confirm).toBeDisabled()
  })
})

test.describe('setup', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a course with no files says so under its name; the later steps are closed help; the navigation is the setup one', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'r3-setup', { own: true })
    const id = await createEmptyCourse(page, 'Setup status')
    await page.goto(`/courses/${id}`)
    await expect(page.getByText("You haven't added any files yet.")).toBeVisible()
    await expect(page.getByText('Margins finds the topics in your files. Rename, merge')).toBeHidden()
    await page.getByText('What the next steps involve').click()
    await expect(page.getByText('Every topic has five steps')).toBeVisible()
    await expect(page.getByTestId('setup-progress')).toContainText('Add your materials')
  })

  test('the ready state has a summary and the first topic named as a warm-up', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'r3-ready', { own: true })
    const { courseId } = await createCourse(page, 'Ready course', [{ name: 'Bayes rule' }])
    await page.goto(`/courses/${courseId}`)
    await expect(page.getByText('Set an exam date, then start your first topic.')).toBeVisible()
    await page.getByRole('button', { name: 'Skip for now' }).click()
    await expect(page.getByText('Your course is ready. Start with your first topic.')).toBeVisible()
    const start = page.getByRole('link', { name: 'Start the warm-up: Bayes rule' })
    await expect(start).toHaveAttribute('href', /\/topics\//)
    await expect(page.getByText('Set your exam date and daily time')).toBeHidden()
  })
})

test.describe('topic editor', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('Rename and Move are on each row, merging is a mode, and Find topics again is a course action', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'r3-editor', { own: true })
    const { courseId } = await createCourse(page, 'Editor course', [{ name: 'Alpha', unit: 'Unit one' }, { name: 'Beta', unit: 'Unit one' }, { name: 'Gamma', unit: 'Unit two' }])
    await page.goto(`/courses/${courseId}/topics?edit=1`)
    const alpha = page.getByRole('listitem').filter({ hasText: 'Alpha' }).first()
    await expect(alpha.getByRole('button', { name: 'Rename Alpha' })).toBeVisible()
    await expect(alpha.getByRole('button', { name: 'Move Alpha' })).toBeVisible()
    await alpha.getByRole('button', { name: 'Move Alpha' }).click()
    await expect(page.getByRole('menuitem', { name: 'Move to unit...' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeDisabled()
    await page.keyboard.press('Escape')

    // "Find topics again" is not in the header: it is in the course actions.
    await expect(page.getByRole('button', { name: 'Find topics again' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Course actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'Find topics again' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Add unit' })).toBeVisible()
    await page.keyboard.press('Escape')

    // Select-to-merge: tick two, choose which stays, merge.
    await page.getByRole('button', { name: 'Merge topics' }).click()
    await expect(page.getByText('Tick two or more topics to merge into one.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Rename Alpha' })).toHaveCount(0)
    await page.getByRole('checkbox', { name: 'Select Alpha to merge' }).click()
    await page.getByRole('checkbox', { name: 'Select Beta to merge' }).click()
    await expect(page.getByText('2 topics picked.')).toBeVisible()
    await page.getByRole('button', { name: 'Merge 2 topics' }).click()
    await expect(page.getByRole('dialog')).toContainText('Merge 2 topics into Alpha?')
    await page.getByRole('dialog').getByRole('button', { name: 'Merge topics' }).click()
    await expect(page.getByRole('button', { name: 'Rename Beta' })).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByRole('button', { name: 'Rename Alpha' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Merge topics' })).toBeVisible()
  })
})

test.describe('materials', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the upload category says it is for the next upload; deleting a file offers its affected topics', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${base}/materials`)
    await expect(page.getByRole('radiogroup', { name: 'For the next upload:' })).toBeVisible()
    await expect(page.getByText('Use these as:')).toHaveCount(0)
    await page.getByRole('button', { name: /^Actions for / }).first().click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/View affected topics \(\d+\)/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })
})

test.describe('materials banner', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('new topics whose file was deleted say so and the button reviews them', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'r3-orphans', { own: true })
    const { courseId } = await createCourse(page, 'Orphans course', [{ name: 'Kept topic' }])
    // Topics found after the list was confirmed wait for review; with their file deleted they have no source left.
    await withPrisma(async (prisma) => {
      for (const [index, name] of ['Lost one', 'Lost two'].entries()) {
        await prisma.topic.create({ data: { projectId: courseId, name, orderIndex: 10 + index, userConfirmed: false } })
      }
    })
    await page.goto(`/courses/${courseId}/materials`)
    await expect(page.getByText('2 new topics are waiting, and the file they came from was deleted.')).toBeVisible()
    await expect(page.getByText('Review them to keep the ones you want, or remove them in the topic editor.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Review new topics' })).toHaveAttribute('href', `/courses/${courseId}/topics?edit=1`)
    await expect(page.getByRole('link', { name: 'Start studying' })).toHaveCount(0)
    // The overview says the same words on its own banner.
    await page.goto(`/courses/${courseId}`)
    await expect(page.getByRole('link', { name: 'Review new topics' })).toBeVisible()
  })
})

test.describe('Ask', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the scope has a visible "Ask about" label, and a long source can use two lines', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${base}/ask`)
    await expect(page.locator('form[data-ask-composer]').getByText('Ask about', { exact: true }).first()).toBeVisible()
  })
})

test.describe('map', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('on a phone the list is first, an idea opens in a sheet with Back, and the other ways to study are behind one button', async ({ page, context }) => {
    await setZoneCookie(context)
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${base}/map`)
    await expect(page.getByRole('radio', { name: 'List view' })).toBeChecked()
    await page.locator('[data-node-link]').first().click()
    const sheet = page.getByRole('dialog')
    await expect(sheet.getByTestId('node-panel')).toBeVisible()
    // One recommended move; the rest are one tap away.
    await expect(sheet.getByRole('link', { name: /^(Read about it first|Practice this)$/ })).toHaveCount(1)
    await expect(sheet.getByRole('link', { name: 'Ask about this' })).toHaveCount(0)
    await sheet.getByRole('button', { name: 'Other ways to study' }).click()
    await expect(sheet.getByRole('link', { name: 'Ask about this' })).toBeVisible()
    await expect(sheet.getByTestId('do-it-out-loud')).toBeVisible()
    // Back closes the sheet and leaves the list where it was.
    await sheet.getByRole('link', { name: 'Back to the list' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page).not.toHaveURL(/node=/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })

  test('"What these mean" is on the map and the overview with the app\'s own words', async ({ page, context }) => {
    await setZoneCookie(context)
    await signIn(page, DEMO_EMAIL)
    for (const url of [`${base}/map`, base]) {
      await page.goto(url)
      const guide = page.getByTestId('status-guide').locator('visible=true')
      await guide.getByText('What these mean').click()
      await expect(guide).toContainText('Not started')
      await expect(guide).toContainText('Getting there')
    }
    await page.goto(`${base}/map`)
    await expect(page.getByTestId('status-guide').locator('visible=true')).toContainText('Shaky')
  })
})

test.describe('menus', () => {
  test('the account menu wraps a long address; the phone search placeholder fits; the More sheet says what it does', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const email = `a-very-long-address-for-a-student-with-two-accounts-${Date.now()}@example.com`
    await signIn(page, email)
    await page.goto('/home')
    await page.keyboard.press('Control+k')
    await expect(page.getByPlaceholder('Search your courses')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /Open (the )?menu|Menu/i }).first().click()
    await page.getByRole('button', { name: new RegExp('account menu') }).click()
    const label = page.getByRole('menu').getByText(email)
    await expect(label).toBeVisible()
    const box = await label.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  })

  test('the phone More sheet names its way to the full menu', async ({ page, context }) => {
    await setZoneCookie(context)
    await page.setViewportSize({ width: 390, height: 844 })
    await signIn(page, DEMO_EMAIL)
    await page.goto(base)
    await page.getByRole('button', { name: 'More' }).click()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Switch course or browse topics' })).toBeVisible()
  })

  test('the course actions button is named for what it is', async ({ page, context }) => {
    await setZoneCookie(context)
    await page.setViewportSize({ width: 1440, height: 900 })
    await signIn(page, DEMO_EMAIL)
    await page.goto(base)
    await page.getByRole('button', { name: 'Course actions' }).hover()
    await expect(page.getByRole('tooltip', { name: 'Course actions' })).toBeVisible()
  })
})

test.describe('touch areas on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the Ask sources and the Map list rows are at least 44px', async ({ page, context }) => {
    await setZoneCookie(context)
    await signIn(page, DEMO_EMAIL)
    for (const url of [`${base}/map`, `${base}/review`, `${base}/materials`]) {
      await page.goto(url)
      await page.waitForLoadState('networkidle')
      expect(await smallTargets(page), url).toEqual([])
    }
  })
})
