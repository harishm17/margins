/**
 * Refreshes the product screenshots on the landing page, the sign-in and sign-up pages and in the README
 * from the real app: it seeds a showcase course (scripts/screens/seed-showcase.ts, written by hand, no model
 * output), signs in as that student, and captures each screen in light and dark as WebP.
 *
 *   cd frontend
 *   DATABASE_URL=postgresql://... PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run screens
 *
 * The stack is the one the e2e specs use (scripts/e2e-stack.sh start, on a migrated database); the AI service
 * can run on the mock LLM because nothing is generated. Only local stacks are accepted: the showcase password
 * is public.
 *
 *   npm run screens -- --only plan,ask      capture some screens (names below)
 *   npm run screens -- --no-seed            reuse the showcase account already in the database
 *   npm run screens -- --out /tmp/screens   write somewhere else (default: public/screens)
 *   npm run screens -- --raw /tmp/raw       also keep each full 3x capture (to tune a crop) and each crop at 3x
 *                                           (the reference to measure the WebP files against)
 *
 * Image quality. Every screen is captured once at 3x and written at the widths its slots need (the 1x width,
 * 2x of the largest desktop slot, 3x of a 390px phone; see WIDTHS), each a downscale of the capture, as lossless
 * WebP: thin text and 1px coloured lines come out exactly as the browser drew them. The site serves these files
 * as they are (Shot in src/features/marketing/shot.tsx, no image optimizer), so nothing encodes them a second time.
 *
 * Output: public/screens/<name>-<light|dark>-<width>.webp, src/features/marketing/screens.json (the widths and
 * sizes Shot reads) and public/screens/plan-og.png for the social card. Pages are read in the UTC time zone so
 * "Today" in the plan matches the seed, and the run fails if the plan's Today is not the capture date.
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
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
const DEFAULT_OUT = path.join(__dirname, '..', 'public', 'screens')
const OUT = path.resolve(option('out') ?? DEFAULT_OUT)
/** The list Shot reads. A run with --out elsewhere writes its own list there and leaves the site's alone. */
const MANIFEST =
  OUT === path.resolve(DEFAULT_OUT) ? path.join(__dirname, '..', 'src', 'features', 'marketing', 'screens.json') : path.join(OUT, 'screens.json')
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
        'The showcase account has a public password.'
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
  /**
   * The part of the viewport to keep, in CSS pixels, or worked out from the page. Default: all of it (a phone
   * shot: all of it above the tab bar).
   */
  crop?: Crop | ((page: Page) => Promise<Crop>)
  /**
   * Make the crop this ratio (width / height) by adding the page's background under it, when the page ends
   * before the frame does.
   */
  padTo?: number
  /** The widths to write, in pixels. Default: WIDTHS.desktop, or WIDTHS.phone for a `-mobile` shot. */
  widths?: number[]
  /** Default: both. A screen only the README shows needs only the light version. */
  themes?: Theme[]
  /** Also write the light version as a PNG of this size for the social card (next/og cannot read WebP). */
  og?: { file: string; width: number; height: number }
}

/**
 * The widths written, in pixels; the slots are measured on the landing page (CSS px, light and dark the same):
 * - desktop crops are drawn at most 959px wide (the landing page at 768-1023px, where each step shows its
 *   desktop crop full width), 741px in the hero and 679px in the How it works frame above 1280px. 960 is the
 *   1x file, 1500 is 2x of the hero and the frame, 1920 is 2x of 959;
 * - phone shots are 390px pages drawn 356-418px wide: 1x, 2x and 3x (most phones are 3x screens).
 * Shots with other slots (the sign-in page's panel, the README-only ones) list their own.
 */
const WIDTHS = { desktop: [960, 1500, 1920], phone: [390, 780, 1170] }
/**
 * The largest a lossless file may be, in bits per pixel, before it is written near-lossless instead. UI
 * screenshots are mostly flat colour and come out at 0.5-1.5 bits per pixel; one far above that is mostly
 * photo or noise, where near-lossless (lossless coding of a lightly quantised image, still no chroma
 * subsampling) costs nothing visible. Lossy WebP, which halves the colour resolution, is never used.
 */
const BITS_PER_PIXEL_BUDGET = 2.5

const SIDEBAR = 248
/**
 * The main column of a 1180px page, for crops: from 2px right of the sidebar (whose border is its last pixel, and
 * would show as a sliver at some densities) to 2px from the right edge. 928 is a multiple of 4, so 4:3 is exact.
 */
const MAIN = { left: SIDEBAR + 2, width: 928 }
/** A phone page. The course tab bar under it is cut off: in a picture on the landing page it looks tappable. */
const PHONE_CONTENT = 700
/** h-14 and its 1px top border. */
const TAB_BAR = 57
const PHONE = { width: 390, height: PHONE_CONTENT + TAB_BAR }
/**
 * The top bar turns translucent once the page scrolls (bg-canvas/80 with a blur). In a still picture what shows
 * through it reads as a smudge, so the captures draw it opaque, as it looks before the page scrolls.
 */
const STILL_CSS = 'header[data-scrolled] { background-color: var(--canvas) !important; backdrop-filter: none !important; }'
/** The landing page's How it works and Sources frames are 4:3: the crops for them are exactly 4:3, so nothing is cut. */
const FRAME = 4 / 3
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

/**
 * The plan's Today must be the capture date (UTC, like the seed), or the hero shows a day that has already gone.
 * Fails the run instead of writing a stale picture.
 */
async function assertToday(page: Page) {
  const today = new Date().toISOString().slice(0, 10)
  const id = await page.locator('li[aria-current="date"] h3').first().getAttribute('id')
  if (id !== `day-${today}`) throw new Error(`the plan's Today is ${id ?? 'missing'}, not day-${today}: check the seed and the time zone`)
}

/**
 * Nudges the page's scroller so no line of text is cut by the top of what scrolls (under the top bar, a sticky
 * tab row, or the top of a scrolling panel): cut lines go up under the bar, or, at the end of the page, down
 * below it. One direction throughout, so it cannot swing back and forth.
 */
async function clearTopEdge(page: Page) {
  let direction: 'up' | 'down' | null = null
  let last = ''
  for (let attempt = 0; attempt < 8; attempt++) {
    const moved: { way: 'up' | 'down'; text: string } | null = await page.evaluate((way: 'up' | 'down' | null) => {
      const scrollers = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(
        (node) => node.scrollHeight > node.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)
      )
      const main = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
      let edge = main ? Math.max(0, main.getBoundingClientRect().top) : 0
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        if (!['sticky', 'fixed'].includes(getComputedStyle(element).position)) continue
        const rect = element.getBoundingClientRect()
        if (rect.height > 0 && rect.height < 200 && rect.top <= edge + 1 && rect.bottom > edge) edge = rect.bottom
      }
      const walker = document.createTreeWalker(main ?? document.body, NodeFilter.SHOW_TEXT)
      let cut: { rect: DOMRect; text: string } | null = null
      while (!cut && walker.nextNode()) {
        const node = walker.currentNode
        const parent = node.parentElement
        // Text that scrolls and can be seen: not hidden, not in a pinned bar, not visually hidden (sr-only is 1px).
        // (checkVisibility is false inside a closed <details>, whose text still has boxes.)
        if (!node.textContent?.trim() || !parent || !parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
        let ancestor: Element | null = parent
        while (ancestor && ancestor !== main && !['sticky', 'fixed'].includes(getComputedStyle(ancestor).position)) ancestor = ancestor.parentElement
        if (ancestor && ancestor !== main) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = Array.from(range.getClientRects()).find((box) => box.height > 4 && box.width > 2 && box.top < edge - 0.5 && box.bottom > edge + 0.5)
        if (rect) cut = { rect, text: `${node.textContent.trim().slice(0, 40)} (${Math.round(rect.top)}-${Math.round(rect.bottom)} across ${Math.round(edge)}, in ${main ? main.tagName + '.' + main.className.slice(0, 40) : 'the page'})` }
      }
      if (!cut) return null
      const scroller = main ?? document.scrollingElement!
      const before = scroller.scrollTop
      if (way !== 'down') {
        scroller.scrollTop += Math.ceil(cut.rect.bottom - edge) + 1
        // At the end of the page it cannot go up (scrollTop may still move a fraction of a pixel).
        if (scroller.scrollTop - before >= 1) return { way: 'up' as const, text: cut.text }
        scroller.scrollTop = before
      }
      scroller.scrollTop -= Math.ceil(edge - cut.rect.top) + 1
      return { way: 'down' as const, text: cut.text }
    }, direction)
    if (!moved) return
    direction = moved.way
    last = moved.text
    await page.waitForTimeout(150)
  }
  throw new Error(`"${last}" is still cut at the top of the page`)
}

async function box(page: Page, locator: import('@playwright/test').Locator, what: string) {
  const found = await locator.boundingBox()
  if (!found) throw new Error(`${what} is not on the page`)
  return found
}

type Bounds = { top: number; bottom: number; left: number; right: number }

/**
 * The smallest crop of `ratio` (width / height) that holds `content`. It grows evenly on both sides of the
 * short dimension, shifted to stay inside `bounds` (the viewport by default; pass the space between the
 * neighbouring elements so no heading or row is cut in half), or the run fails. Widths are a multiple of 4, so
 * 4:3 comes out exact.
 */
function fitRatio(page: Page, content: Crop, ratio: number, limits: Partial<Bounds> = {}): Crop {
  const viewport = page.viewportSize()!
  const bounds: Bounds = { top: 0, left: 0, bottom: viewport.height, right: viewport.width, ...limits }
  let [x, y, width, height] = content.map(Math.round) as Crop
  width = Math.ceil(width / 4) * 4
  const place = (start: number, size: number, extra: number, low: number, high: number) =>
    Math.max(low, Math.min(Math.round(start - extra / 2), high - size - extra))
  if (width / height > ratio) {
    const taller = Math.round(width / ratio)
    y = place(y, height, taller - height, bounds.top, bounds.bottom)
    height = taller
  } else {
    const wider = Math.ceil((height * ratio) / 4) * 4
    x = place(x, width, wider - width, bounds.left, bounds.right)
    width = wider
    height = Math.round(width / ratio)
  }
  if (x < bounds.left || y < bounds.top || x + width > bounds.right || y + height > bounds.bottom) {
    throw new Error(`a ${ratio.toFixed(3)} crop around [${content.map(Math.round).join(', ')}] does not fit in ${JSON.stringify(bounds)}`)
  }
  return [x, y, width, height]
}

/** The bottom of the element just before `locator`'s element, in CSS px: where the space above it starts. */
async function previousBottom(locator: import('@playwright/test').Locator) {
  return locator.evaluate((element) => {
    let node = element.previousElementSibling ?? element.parentElement?.previousElementSibling
    while (node && node.getBoundingClientRect().height === 0) node = node.previousElementSibling
    return node ? node.getBoundingClientRect().bottom : 0
  })
}

const SHOTS: Shot[] = [
  // The hero: the plan to the exam, with Today on top. Desktop keeps the sidebar, mobile keeps the top of the page.
  // Its largest slot is the sign-in page's panel, drawn at 100vw - 626px above 1280px: 1294px on a 1920px screen,
  // so 2592 is 2x of it there (and a little under 2x on wider screens).
  {
    name: 'plan',
    viewport: { width: 1024, height: 700 },
    url: (ids) => `${course(ids)}/plan`,
    prepare: assertToday,
    widths: [960, 1500, 1920, 2592],
    // The social card draws it at 900x615 (app/opengraph-image.tsx): written at that size, nothing rescales it.
    og: { file: 'plan-og.png', width: 900, height: 615 },
  },
  {
    name: 'plan-mobile',
    viewport: PHONE,
    url: (ids) => `${course(ids)}/plan`,
    prepare: assertToday,
  },
  {
    name: 'plan-exam-day',
    viewport: { width: 1180, height: 1000 },
    url: (ids) => `${course(ids)}/plan`,
    // The last week before the exam, with exam day opened. The page ends under exam day, so the crop is
    // shorter than 4:3 and `padTo` fills the rest with the page's own background.
    prepare: async (page) => {
      await openLastDays(page, ['Exam day'])
      await scrollMainTo(page, 'bottom')
    },
    crop: async (page) => {
      const heading = await box(page, page.getByRole('heading', { name: / to / }).last(), 'the last week of the plan')
      const exam = await box(page, page.locator('main details', { hasText: 'Exam day' }).last(), 'exam day')
      const top = Math.round(heading.y - 24)
      const height = Math.round(exam.y + exam.height + 24) - top
      if (height > MAIN.width / FRAME) throw new Error('the last week no longer fits in 4:3')
      return [MAIN.left, top, MAIN.width, height]
    },
    padTo: FRAME,
  },
  {
    name: 'materials',
    viewport: { width: 1180, height: 760 },
    url: (ids) => `${course(ids)}/materials`,
    // From the top of the page down to the bottom of the last whole file row.
    crop: async (page) => {
      const height = Math.round(MAIN.width / FRAME)
      const rows = await page.locator('main tbody tr').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().bottom))
      const bottom = Math.round(Math.max(...rows.filter((value) => value <= height + 24)))
      return fitRatio(page, [MAIN.left, Math.max(0, bottom - height), MAIN.width, Math.min(height, bottom)], FRAME, { bottom })
    },
  },
  {
    name: 'topics-edit',
    viewport: { width: 1180, height: 760 },
    url: (ids) => `${course(ids)}/topics?edit=1`,
    crop: async (page) => fitRatio(page, [MAIN.left, 0, MAIN.width, 600], FRAME),
  },
  // The part of the notes with code, the outline and the sources: from "How it works" to the end of the
  // breadth-first search section, so no heading is cut in half.
  {
    name: 'notes-detail',
    viewport: { width: 1440, height: 1000 },
    url: (ids) => `${topic(ids)}?view=notes`,
    prepare: async (page) => {
      // Just under the outline, which sticks 120px from the top: the outline marks "How it works" as the
      // section being read, and the crop fits between the sticky topic tabs and the next heading.
      await scrollTo(page.getByRole('heading', { name: 'How it works', level: 2 }).first(), 130)
    },
    crop: async (page) => {
      const heading = page.getByRole('heading', { name: 'How it works', level: 2 }).first()
      const section = await box(page, heading, '"How it works"')
      const next = await box(page, page.getByRole('heading', { name: 'Depth-first search', level: 3 }).first(), '"Depth-first search"')
      const outline = await box(page, page.getByText('On this page', { exact: true }), 'the outline')
      const tabs = await box(page, page.getByLabel('Study path').first(), 'the topic tabs')
      // From above both "How it works" and the outline beside it, to just above the next heading.
      const top = Math.round(Math.min(section.y, outline.y) - 12)
      return fitRatio(page, [300, top, 1000, next.y - 8 - top], FRAME, {
        top: Math.max(tabs.y + tabs.height, await previousBottom(heading)) + 4,
        bottom: next.y - 4,
      })
    },
  },
  {
    name: 'exam-new',
    viewport: { width: 1180, height: 860 },
    url: (ids) => `${course(ids)}/exams/new`,
    // From "Questions" to the Create exam button: the options, and the Match my past exams choice. The form is
    // centred in the crop (a crop from the sidebar edge left an empty gutter on the left).
    prepare: async (page) => {
      await scrollTo(page.getByRole('heading', { name: 'Questions', exact: true }), 120)
    },
    crop: async (page) => {
      const label = page.getByRole('heading', { name: 'Questions', exact: true })
      const heading = await box(page, label, 'the new exam form')
      const create = await box(page, page.getByRole('button', { name: 'Create exam' }), 'the Create exam button')
      const style = await box(page, page.getByText('Match my past exams').locator('xpath=ancestor::label[1]'), 'the Match my past exams option')
      // Below the topic list above "Questions", so no sliver of it shows.
      const above = (await previousBottom(label.locator('xpath=ancestor::section[1]'))) + 4
      const left = heading.x - 32
      const top = Math.max(heading.y - 32, above)
      return fitRatio(page, [left, top, style.x + style.width + 32 - left, create.y + create.height + 32 - top], FRAME, { left: MAIN.left, top: above })
    },
  },
  {
    name: 'quiz-results',
    viewport: { width: 1180, height: 860 },
    url: (ids) => `${topic(ids)}?view=quiz`,
    prepare: async (page) => {
      await page.locator('main').getByRole('button', { name: 'Review' }).first().click()
      const missed = page.getByText('During a depth-first search')
      await missed.waitFor()
      await scrollTo(missed, 124)
    },
    crop: async (page) => fitRatio(page, [MAIN.left, 100, MAIN.width, 600], FRAME),
  },
  // Only in the README.
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
    crop: [MAIN.left, 0, MAIN.width, 760],
    widths: [960, 1920],
    themes: ['light'],
  },
  {
    name: 'ask',
    // A little wider than the other pages: at 1180px the answer and its sources are taller than 4:3 of the
    // conversation column.
    viewport: { width: 1240, height: 820 },
    url: (ids) => `${course(ids)}/ask`,
    prepare: async (page) => {
      await openThread(page)
      await page.getByText('Both take').waitFor()
      await page.getByRole('button', { name: /Source 1/ }).first().hover()
      await page.getByText('Open page').first().waitFor()
      await page.waitForTimeout(400)
    },
    // The answer with its citation card open, down to the last source row, at 4:3 for the Sources frame on the
    // landing page, inside the conversation column (right of the thread list). The question above the answer
    // does not fit in 4:3 with the sources, so it is left out.
    crop: async (page) => {
      const label = await box(page, page.locator('main').getByText('Margins', { exact: true }).last(), 'the answer')
      const sources = page.locator('main').getByText(/^(week4-graph-traversal|clrs-ch22-graph-algorithms)\.pdf, pp?\. /)
      const last = await box(page, sources.last(), 'the last source row')
      const threads = await box(page, page.locator('main aside').first(), 'the thread list')
      const left = Math.ceil(threads.x + threads.width) + 2
      const right = page.viewportSize()!.width - 2
      const top = Math.round(label.y - 16)
      return fitRatio(page, [left, top, right - left, last.y + last.height + 16 - top], FRAME, { left, right, top: top - 24 })
    },
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
  // Only in the README. Last: it needs an exam attempt in progress.
  {
    name: 'exam',
    viewport: { width: 1440, height: 900 },
    url: (ids) => `${course(ids)}/exams/${ids.examId}/take`,
    prepare: async (page) => {
      await page.getByRole('button', { name: /^Question 7/ }).first().click()
      await page.waitForTimeout(300)
    },
    crop: [0, 0, 1440, 740],
    widths: [960, 1920],
    themes: ['light'],
  },
]

async function signIn(browser: Browser, ids: ShowcaseIds) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Email').fill(ids.email)
  await page.getByLabel('Password', { exact: true }).fill(ids.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
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

type Written = { widths: number[]; width: number; height: number }

/**
 * One file as lossless WebP. Over BITS_PER_PIXEL_BUDGET, near-lossless at decreasing levels until it fits; the
 * smallest is kept and reported if none does. Returns the bytes and how they were encoded.
 */
async function encode(pixels: Buffer, width: number, height: number) {
  const budget = Math.round((width * height * BITS_PER_PIXEL_BUDGET) / 8)
  let best: { data: Buffer; mode: string } | null = null
  for (const [mode, nearLossless] of [
    ['lossless', 100],
    ['near-lossless 80', 80],
    ['near-lossless 60', 60],
  ] as [string, number][]) {
    // For lossless WebP, `quality` is how hard the encoder works (100: smallest file), not a loss of detail.
    const options = nearLossless === 100 ? { lossless: true, quality: 100, effort: 6 } : { nearLossless: true, quality: nearLossless, effort: 6 }
    const data = await sharp(pixels).webp(options).toBuffer()
    if (!best || data.length < best.data.length) best = { data, mode }
    if (data.length <= budget) return { ...best, budget, over: false }
  }
  return { ...(best as { data: Buffer; mode: string }), budget, over: true }
}

/** Deletes files of this screen that the run no longer writes: other widths, the old unsized names, a dropped theme. */
function removeStale(name: string, themes: Theme[], widths: number[]) {
  if (!fs.existsSync(OUT)) return
  for (const file of fs.readdirSync(OUT)) {
    const match = new RegExp(`^${name}-(light|dark)(?:-(\\d+))?\\.(webp|png)$`).exec(file)
    if (!match) continue
    const [, theme, width] = match
    const keep = themes.includes(theme as Theme) && width !== undefined && widths.includes(Number(width))
    if (!keep) fs.rmSync(path.join(OUT, file))
  }
}

type Session = { browser: Browser; state: Awaited<ReturnType<typeof signIn>>; prisma: PrismaClient; ids: ShowcaseIds }

/** Puts the database back the way a capture of `shot` expects it, before every page load. */
async function resetFor(shot: Shot, { prisma, ids }: Session) {
  if (shot.name === 'exam') await startExamAttempt(prisma, ids)
  // Practice answers are saved as the student goes, so each load starts from a clean slate.
  if (shot.name === 'practice') await prisma.practiceProgress.deleteMany({ where: { userId: ids.userId } })
}

/** Loads `shot` in `theme` at `scale` device pixels per CSS pixel, ready to capture, and works out its crop. */
async function load(session: Session, shot: Shot, theme: Theme, scale: number) {
  const phone = shot.name.endsWith('-mobile')
  await resetFor(shot, session)
  const context = await session.browser.newContext({
    viewport: shot.viewport,
    deviceScaleFactor: scale,
    // A phone page needs touch and the mobile viewport.
    isMobile: phone,
    hasTouch: phone,
    colorScheme: theme,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    storageState: session.state,
  })
  await context.addInitScript((value) => {
    try {
      localStorage.setItem('theme', value)
    } catch {}
  }, theme)
  const page = await context.newPage()
  await page.goto(`${BASE}${shot.url(session.ids)}`)
  await settle(page)
  await page.addStyleTag({ content: STILL_CSS })
  if (shot.prepare) await shot.prepare(page, session.ids)
  if (phone) await clearTopEdge(page)
  await page.waitForTimeout(300)
  let crop: Crop | undefined = typeof shot.crop === 'function' ? await shot.crop(page) : shot.crop
  if (!crop && phone) {
    // Everything above the course tab bar, which has to be where PHONE puts it.
    const bar = await box(page, page.getByRole('navigation', { name: 'Course tabs' }), 'the course tab bar')
    if (Math.round(bar.y) !== PHONE_CONTENT) throw new Error(`${shot.name}: the tab bar starts at ${bar.y}px, not ${PHONE_CONTENT}px`)
    crop = [0, 0, PHONE.width, PHONE_CONTENT]
  }
  return { context, page, crop: (crop ?? [0, 0, shot.viewport.width, shot.viewport.height]).map(Math.round) as Crop }
}

/**
 * Captures one screen in one theme at each of its widths. The page is drawn by the browser at each width's own
 * density (1920px of a 932px crop is 2.06 device pixels per CSS pixel), so no file is resampled: text and 1px
 * lines are as sharp as the browser makes them, and the lossless files stay small. Only the social card, smaller
 * than 1x, is scaled down (Lanczos) from the largest capture.
 */
async function capture(session: Session, shot: Shot, theme: Theme): Promise<Written> {
  const phone = shot.name.endsWith('-mobile')
  const widths = [...(shot.widths ?? (phone ? WIDTHS.phone : WIDTHS.desktop))].sort((a, b) => a - b)
  // The crop is worked out from the layout, which is the same at every density; a first load at 1x finds it.
  const probe = await load(session, shot, theme, 1)
  const crop = probe.crop
  await probe.context.close()
  const [x, y, width, height] = crop

  fs.mkdirSync(OUT, { recursive: true })
  let size = { width: 0, height: 0 }
  let largest: Buffer | null = null
  for (const target of widths) {
    const scale = target / width
    const { context, page, crop: again } = await load(session, shot, theme, scale)
    if (again.join() !== crop.join()) throw new Error(`${shot.name}: the crop moved from [${crop.join(', ')}] to [${again.join(', ')}] at ${scale.toFixed(3)}x`)
    let png = await sharp(await page.screenshot({ clip: { x, y, width, height } }))
      .removeAlpha()
      .png()
      .toBuffer()
    await context.close()
    if (shot.padTo) {
      // The page ends inside the frame: add more of its background, the colour of the crop's bottom-left corner.
      const meta = await sharp(png).metadata()
      const missing = Math.round(target / shot.padTo) - (meta.height as number)
      if (missing < 0) throw new Error(`${shot.name}: the crop is already taller than ${shot.padTo.toFixed(3)}`)
      const corner = await sharp(png)
        .extract({ left: 2, top: (meta.height as number) - 2, width: 1, height: 1 })
        .raw()
        .toBuffer()
      png = await sharp(png)
        .extend({ bottom: missing, background: { r: corner[0], g: corner[1], b: corner[2] } })
        .png()
        .toBuffer()
    }
    const meta = await sharp(png).metadata()
    if (meta.width !== target) throw new Error(`${shot.name}: asked for ${target}px, the browser drew ${meta.width}px`)
    if (RAW) {
      fs.mkdirSync(RAW, { recursive: true })
      fs.writeFileSync(path.join(RAW, `${shot.name}-${theme}-${target}.png`), png)
    }
    const result = await encode(png, target, meta.height as number)
    fs.writeFileSync(path.join(OUT, `${shot.name}-${theme}-${target}.webp`), result.data)
    size = { width: target, height: meta.height as number }
    largest = png
    const bpp = ((result.data.length * 8) / (target * (meta.height as number))).toFixed(2)
    const over = result.over ? `  OVER BUDGET (${Math.round(result.budget / 1024)} KB)` : ''
    console.log(`${shot.name}-${theme}-${target}.webp  ${target}x${meta.height}  ${Math.round(result.data.length / 1024)} KB  ${bpp} bpp  ${result.mode}${over}`)
  }
  if (theme === 'light' && shot.og && largest) {
    const { file, width: ogWidth, height: ogHeight } = shot.og
    await sharp(largest)
      .resize({ width: ogWidth, height: ogHeight, fit: 'cover', position: 'top', kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toFile(path.join(OUT, file))
    console.log(`${file}  ${ogWidth}x${ogHeight}`)
  }
  return { widths, ...size }
}

/** Adds what this run wrote to the list Shot reads (a run with --only keeps the other screens). */
function writeManifest(written: Record<string, Written>) {
  const current = fs.existsSync(MANIFEST) ? (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Record<string, Written>) : {}
  const next = { ...current, ...written }
  const sorted = Object.fromEntries(
    Object.keys(next)
      .sort()
      .map((key) => [key, next[key]])
  )
  fs.writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`)
  console.log(`Wrote ${path.relative(process.cwd(), MANIFEST)}`)
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
        password: 'showcase-demo-pass',
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
    const session: Session = { browser, prisma, ids, state: await signIn(browser, ids) }
    const shots = SHOTS.filter((shot) => !ONLY || ONLY.includes(shot.name))
    const written: Record<string, Written> = {}
    for (const shot of shots) {
      const phone = shot.name.endsWith('-mobile')
      const themes = shot.themes ?? ['light', 'dark']
      removeStale(shot.name, themes, shot.widths ?? (phone ? WIDTHS.phone : WIDTHS.desktop))
      for (const theme of themes) {
        const result = await capture(session, shot, theme)
        const other = written[shot.name]
        // Shot draws both themes in one box, so they must be the same size (a crop worked out from the page can differ).
        if (other && (other.width !== result.width || other.height !== result.height)) {
          throw new Error(`${shot.name}: light is ${other.width}x${other.height} but ${theme} is ${result.width}x${result.height}`)
        }
        written[shot.name] = result
      }
      if (shot.name === 'exam') await clearExamAttempt(prisma, ids)
      if (shot.name === 'practice') await prisma.practiceProgress.deleteMany({ where: { userId: ids.userId } })
    }
    writeManifest(written)
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
