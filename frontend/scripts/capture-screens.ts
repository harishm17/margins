/**
 * Refreshes the product screenshots on the landing page, the sign-in page and in the README
 * from the real app: it seeds a showcase course (scripts/screens/seed-showcase.ts, written by hand, no model
 * output), signs in as that student, and captures each screen in light and dark as WebP.
 *
 *   cd frontend
 *   DATABASE_URL=postgresql://... PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run screens
 *
 * The stack is the one the e2e specs use (scripts/e2e-stack.sh start, on a migrated database); the AI service
 * can run on the mock LLM because nothing is generated. It signs in with the local-only test sign-in
 * (ENABLE_TEST_LOGIN=true, which scripts/e2e-stack.sh sets), so only local stacks are accepted.
 *
 *   npm run screens -- --only plan,ask      capture some screens (names below)
 *   npm run screens -- --no-seed            reuse the showcase account already in the database
 *   npm run screens -- --out /tmp/screens   write somewhere else (default: public/screens)
 *   npm run screens -- --raw /tmp/raw       also keep the full 2x PNGs, to tune a crop
 *
 * Output is public/screens/<name>-light.webp and <name>-dark.webp, plus plan-light.png for the social card.
 * Pages are read in the UTC time zone so "Today" in the plan matches the seed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import { clearExamAttempt, seedShowcase, startExamAttempt, type ShowcaseIds } from './screens/seed-showcase'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const option = (name: string) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const BASE = (process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const OUT = path.resolve(option('out') ?? path.join(__dirname, '..', 'public', 'screens'))
const RAW = option('raw') ? path.resolve(option('raw') as string) : null
const ONLY = option('only')?.split(',')

const LOCAL = new Set(['localhost', '127.0.0.1', '::1'])
function assertLocal() {
  const baseHost = new URL(BASE).hostname.replace(/^\[|\]$/g, '')
  let dbHost = ''
  try {
    dbHost = new URL(process.env.DATABASE_URL ?? '').hostname
  } catch {}
  if (!LOCAL.has(baseHost) || !LOCAL.has(dbHost)) {
    console.error(
      `Refusing to run: the web app (${baseHost || 'unset'}) and the database (${dbHost || 'unset'}) must both be local. ` +
        'It signs in with the local-only test sign-in.'
    )
    process.exit(1)
  }
}

type Theme = 'light' | 'dark'
type Crop = [x: number, y: number, width: number, height: number]

type Shot = {
  name: string
  /** CSS pixels. */
  viewport: { width: number; height: number }
  /** Where to go, from the ids. */
  url: (ids: ShowcaseIds) => string
  /** Anything to do once the page has loaded: open a card, scroll, click. */
  prepare?: (page: Page, ids: ShowcaseIds) => Promise<void>
  /** The part of the viewport to keep, in CSS pixels (or worked out from the page). Default: all of it. */
  crop?: Crop | ((page: Page) => Promise<Crop>)
  /** Width of the written image in pixels. Default: the crop width at 2x. */
  width?: number
  /** Also write a PNG (the social card cannot read WebP). */
  png?: number
}

const SIDEBAR = 248
/** A phone: the whole page is kept, so the top bar and the bottom tab bar of a course show. */
const PHONE = { width: 390, height: 700 }
const course = (ids: ShowcaseIds) => `/courses/${ids.courseId}`
const topic = (ids: ShowcaseIds) => `${course(ids)}/topics/${ids.graphTopicId}`

/** Scrolls the page's main scroller so that `locator` sits `top` CSS pixels from the top of the viewport. */
async function scrollTo(locator: import('@playwright/test').Locator, top: number) {
  await locator.evaluate((element, target) => {
    const scrollers = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(
      (node) => node.scrollHeight > node.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)
    )
    const main = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    const delta = element.getBoundingClientRect().top - target
    if (main) main.scrollTop += delta
    else window.scrollBy(0, delta)
  }, top)
  await locator.page().waitForTimeout(400)
}

/** Opens the chat thread "BFS or DFS" (its link is in the DOM on a phone too, inside the thread picker). */
async function openThread(page: Page) {
  const href = await page.locator('a[href*="thread="]', { hasText: 'BFS or DFS' }).first().getAttribute('href')
  if (!href) throw new Error('the showcase chat thread is missing')
  await page.goto(`${BASE}${href}`)
  await settle(page)
}

/** Opens the plan's folded days whose line carries one of these labels (the final review and exam day by default). */
async function openLastDays(page: Page, labels = ['Final review', 'Exam day']) {
  for (const label of labels) {
    await page.locator('main details > summary', { hasText: label }).first().click()
  }
  // Park the pointer in a corner, so no row is drawn in its hover state.
  await page.mouse.move(2, 2)
  await page.waitForTimeout(300)
}

async function scrollMainTo(page: Page, where: 'bottom' | number) {
  await page.evaluate((target) => {
    const scrollers = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(
      (element) => element.scrollHeight > element.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(element).overflowY)
    )
    const main = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? document.scrollingElement
    if (main) main.scrollTop = target === 'bottom' ? main.scrollHeight : target
    window.scrollTo(0, target === 'bottom' ? document.body.scrollHeight : target)
  }, where)
  await page.waitForTimeout(400)
}

const SHOTS: Shot[] = [
  // The hero: the plan to the exam, with Today on top. Desktop keeps the sidebar, mobile keeps the top of the page.
  { name: 'plan', viewport: { width: 1024, height: 700 }, url: (ids) => `${course(ids)}/plan`, width: 1400, png: 1200 },
  {
    name: 'plan-mobile',
    viewport: PHONE,
    url: (ids) => `${course(ids)}/plan`,
  },
  {
    name: 'plan-exam-day',
    viewport: { width: 1180, height: 1000 },
    url: (ids) => `${course(ids)}/plan`,
    // The last week before the exam, with exam day opened.
    prepare: async (page) => {
      await openLastDays(page, ['Exam day'])
      await scrollMainTo(page, 'bottom')
    },
    crop: async (page) => {
      const heading = await page.getByRole('heading', { name: / to / }).last().boundingBox()
      const exam = await page.locator('main details', { hasText: 'Exam day' }).last().boundingBox()
      if (!heading || !exam) throw new Error('the plan has no last week')
      const top = Math.max(Math.round(heading.y - 16), 60)
      return [SIDEBAR, top, 1180 - SIDEBAR, Math.min(Math.round(exam.y + exam.height + 20) - top, 700)]
    },
    width: 1200,
  },
  {
    name: 'materials',
    viewport: { width: 1180, height: 760 },
    url: (ids) => `${course(ids)}/materials`,
    crop: [SIDEBAR, 0, 1180 - SIDEBAR, 700],
    width: 1200,
  },
  {
    name: 'topics-edit',
    viewport: { width: 1180, height: 760 },
    url: (ids) => `${course(ids)}/topics?edit=1`,
    crop: [SIDEBAR, 0, 1180 - SIDEBAR, 700],
    width: 1200,
  },
  // The part of the notes with code, the outline and the sources.
  {
    name: 'notes-detail',
    viewport: { width: 1440, height: 900 },
    url: (ids) => `${topic(ids)}?view=notes`,
    prepare: async (page) => {
      await page.getByRole('heading', { name: 'Breadth-first search', level: 3 }).evaluate((element) => {
        const top = element.getBoundingClientRect().top
        const scrollers = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(
          (node) => node.scrollHeight > node.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)
        )
        const main = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
        if (main) main.scrollTop += top - 150
        else window.scrollBy(0, top - 150)
      })
      await page.waitForTimeout(500)
    },
    crop: [300, 100, 1000, 750],
    width: 1200,
  },
  {
    name: 'exam-new',
    viewport: { width: 1180, height: 860 },
    url: (ids) => `${course(ids)}/exams/new`,
    // From "Questions" to the Create exam button: the options, and the Match my past exams choice.
    prepare: async (page) => {
      const heading = page.getByRole('heading', { name: 'Questions', exact: true })
      await heading.evaluate((element) => {
        const scrollers = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(
          (node) => node.scrollHeight > node.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)
        )
        const main = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
        const delta = element.getBoundingClientRect().top - 120
        if (main) main.scrollTop += delta
        else window.scrollBy(0, delta)
      })
      await page.waitForTimeout(400)
    },
    crop: async (page) => {
      const heading = await page.getByRole('heading', { name: 'Questions', exact: true }).boundingBox()
      const create = await page.getByRole('button', { name: 'Create exam' }).boundingBox()
      if (!heading || !create) throw new Error('the new exam form is not on the page')
      // From just above "Questions" to just under the Create exam button (the page may not scroll any further).
      const top = Math.round(heading.y - 24)
      return [SIDEBAR, top, 1180 - SIDEBAR, Math.min(Math.round(create.y + create.height + 28) - top, 700)]
    },
    width: 1200,
  },
  {
    name: 'quiz-results',
    viewport: { width: 1180, height: 860 },
    url: (ids) => `${topic(ids)}?view=quiz`,
    prepare: async (page) => {
      await page.locator('main').getByRole('button', { name: 'Review' }).first().click()
      const missed = page.getByText('During a depth-first search')
      await missed.waitFor()
      await missed.evaluate((element) => {
        const scrollers = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(
          (node) => node.scrollHeight > node.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)
        )
        const main = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
        const delta = element.getBoundingClientRect().top - 124
        if (main) main.scrollTop += delta
        else window.scrollBy(0, delta)
      })
      await page.waitForTimeout(500)
    },
    crop: [SIDEBAR, 100, 1180 - SIDEBAR, 700],
    width: 1200,
  },
  {
    name: 'practice',
    viewport: { width: 1180, height: 760 },
    url: (ids) => `${topic(ids)}?view=practice`,
    prepare: async (page) => {
      await page.getByRole('radio', { name: /Breadth-first search/ }).click()
      await page.getByRole('button', { name: 'Check' }).click()
      await page.getByRole('button', { name: 'Next step' }).click()
      await page.getByLabel('Your answer').fill('a queue')
      await page.getByRole('button', { name: 'Check' }).click()
      await page.getByRole('button', { name: 'Next step' }).click()
      await page.getByRole('button', { name: 'Hint' }).click()
      await page.getByLabel('Your answer').fill('2')
    },
    crop: [SIDEBAR, 0, 1180 - SIDEBAR, 760],
    width: 1200,
  },
  {
    name: 'ask',
    viewport: { width: 1180, height: 820 },
    url: (ids) => `${course(ids)}/ask`,
    prepare: async (page) => {
      await openThread(page)
      await page.getByText('Both take').waitFor()
      await page.getByRole('button', { name: /Source 1/ }).first().hover()
      await page.getByText('Open page').first().waitFor()
      await page.waitForTimeout(400)
    },
    crop: [SIDEBAR + 247, 40, 1180 - SIDEBAR - 247, 700],
    width: 1000,
  },

  // Phone versions of the same screens: a 390 px page, kept at its real size so the text stays readable.
  {
    name: 'materials-mobile',
    viewport: PHONE,
    url: (ids) => `${course(ids)}/materials`,
    prepare: (page) => scrollTo(page.getByText('Drop files here'), 100),
  },
  {
    name: 'topics-edit-mobile',
    viewport: PHONE,
    url: (ids) => `${course(ids)}/topics?edit=1`,
  },
  {
    name: 'plan-exam-day-mobile',
    viewport: PHONE,
    url: (ids) => `${course(ids)}/plan`,
    prepare: async (page) => {
      await openLastDays(page, ['Exam day'])
      await scrollMainTo(page, 'bottom')
    },
  },
  {
    name: 'notes-detail-mobile',
    viewport: PHONE,
    url: (ids) => `${topic(ids)}?view=notes`,
    prepare: async (page) => {
      await scrollTo(page.getByRole('heading', { name: 'How it works', level: 2 }).first(), 140)
    },
  },
  {
    name: 'exam-new-mobile',
    viewport: PHONE,
    url: (ids) => `${course(ids)}/exams/new`,
    prepare: async (page) => {
      await scrollTo(page.getByRole('heading', { name: 'Style', exact: true }), 120)
    },
  },
  {
    name: 'quiz-results-mobile',
    viewport: PHONE,
    url: (ids) => `${topic(ids)}?view=quiz`,
    prepare: async (page) => {
      await page.locator('main').getByRole('button', { name: 'Review' }).first().click()
      const missed = page.getByText('During a depth-first search')
      await missed.waitFor()
      await scrollTo(missed, 176)
    },
  },
  {
    name: 'ask-mobile',
    viewport: PHONE,
    url: (ids) => `${course(ids)}/ask`,
    prepare: async (page) => {
      await openThread(page)
      await page.getByText('Both take').waitFor()
      // Scroll the answer up, so the citation card opens above the tab bar and not over it.
      await scrollTo(page.getByRole('button', { name: /Source 1/ }).first(), 250)
      await page.getByRole('button', { name: /Source 1/ }).first().click()
      await page.getByText('Open page').first().waitFor()
      await page.waitForTimeout(400)
    },
  },
  // Last: it needs an exam attempt in progress.
  {
    name: 'exam',
    viewport: { width: 1440, height: 900 },
    url: (ids) => `${course(ids)}/exams/${ids.examId}/take`,
    prepare: async (page) => {
      await page.getByRole('button', { name: /^Question 7/ }).first().click()
      await page.waitForTimeout(300)
    },
    crop: [0, 0, 1440, 740],
    width: 1400,
  },
]

async function signIn(browser: Browser, ids: ShowcaseIds) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${BASE}/login`)
  const form = page.getByRole('form', { name: 'Test sign-in' })
  if (!(await form.count())) throw new Error('No test sign-in on /login: start the web app with ENABLE_TEST_LOGIN=true.')
  await form.getByLabel('Email').fill(ids.email)
  await form.getByRole('button', { name: 'Test sign-in' }).click()
  await page.waitForURL('**/home', { timeout: 90_000 })
  const state = await context.storageState()
  await context.close()
  return state
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.evaluate(() => document.fonts?.ready).catch(() => {})
  await page.waitForTimeout(600)
}

async function capture(context: BrowserContext, shot: Shot, ids: ShowcaseIds, theme: Theme) {
  const page = await context.newPage()
  await page.setViewportSize(shot.viewport)
  await page.goto(`${BASE}${shot.url(ids)}`)
  await settle(page)
  if (shot.prepare) await shot.prepare(page, ids)
  await page.waitForTimeout(300)
  const box = typeof shot.crop === 'function' ? await shot.crop(page) : shot.crop
  const raw = await page.screenshot()
  await page.close()

  if (RAW) {
    fs.mkdirSync(RAW, { recursive: true })
    fs.writeFileSync(path.join(RAW, `${shot.name}-${theme}.png`), raw)
  }
  const [x, y, width, height] = box ?? [0, 0, shot.viewport.width, shot.viewport.height]
  const scale = 2
  const image = sharp(raw).extract({ left: x * scale, top: y * scale, width: width * scale, height: height * scale })
  const outWidth = Math.min(shot.width ?? width * scale, width * scale)
  fs.mkdirSync(OUT, { recursive: true })
  const info = await image.clone().resize({ width: outWidth }).webp({ quality: 84, effort: 6 }).toFile(path.join(OUT, `${shot.name}-${theme}.webp`))
  if (theme === 'light' && shot.png) {
    await image.clone().resize({ width: shot.png }).png({ palette: true, quality: 90, effort: 9 }).toFile(path.join(OUT, `${shot.name}-${theme}.png`))
  }
  console.log(`${shot.name}-${theme}.webp  ${info.width}x${info.height}  ${Math.round(info.size / 1024)} KB`)
}

async function main() {
  assertLocal()
  const prisma = new PrismaClient()
  const browser = await chromium.launch()
  let ids: ShowcaseIds | null = null
  try {
    if (flag('no-seed')) {
      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'showcase@example.com' } })
      const found = await prisma.project.findFirstOrThrow({
        where: { userId: user.id, name: 'CS 161 Algorithms' },
        include: { topics: { orderBy: { orderIndex: 'asc' } }, sampleExams: true },
      })
      ids = {
        email: user.email,
        userId: user.id,
        courseId: found.id,
        topicIds: found.topics.map((item) => item.id),
        graphTopicId: found.topics.find((item) => item.name === 'Graph traversal')?.id as string,
        materialIds: {},
        examId: found.sampleExams[0].id,
        threadId: '',
      }
    } else {
      ids = await seedShowcase(prisma)
      console.log('Seeded the showcase course.')
    }
    const state = await signIn(browser, ids)
    const shots = SHOTS.filter((shot) => !ONLY || ONLY.includes(shot.name))

    for (const theme of ['light', 'dark'] as Theme[]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
        storageState: state,
      })
      await context.addInitScript((value) => {
        try {
          localStorage.setItem('theme', value)
        } catch {}
      }, theme)
      for (const shot of shots) {
        if (shot.name === 'exam') await startExamAttempt(prisma, ids)
        // Practice answers are saved as the student goes, so each pass starts from a clean slate.
        if (shot.name === 'practice') await prisma.practiceProgress.deleteMany({ where: { userId: ids.userId } })
        // The mobile shot needs touch and a phone-sized page.
        if (shot.name.endsWith('-mobile')) {
          const phone = await browser.newContext({
            viewport: shot.viewport,
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
            colorScheme: theme,
            reducedMotion: 'reduce',
            timezoneId: 'UTC',
            storageState: state,
          })
          await phone.addInitScript((value) => {
            try {
              localStorage.setItem('theme', value)
            } catch {}
          }, theme)
          await capture(phone, shot, ids, theme)
          await phone.close()
        } else {
          await capture(context, shot, ids, theme)
        }
        if (shot.name === 'exam') await clearExamAttempt(prisma, ids)
        if (shot.name === 'practice') await prisma.practiceProgress.deleteMany({ where: { userId: ids.userId } })
      }
      await context.close()
    }
  } finally {
    if (ids) await clearExamAttempt(prisma, ids).catch(() => {})
    await browser.close()
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
