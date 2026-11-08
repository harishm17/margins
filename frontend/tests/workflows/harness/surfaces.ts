import type { Locator, Page } from '@playwright/test'

/**
 * What each surface says about one topic: its next step (SW9), its topic progress (SW11) and its minutes (G5).
 * The plan wants these the same everywhere; a reading leaves out what a surface does not show. The map shows
 * ideas, not topics, so it has no reading here. `said` keeps the surface's own words for its next step.
 */
export type Reading = { surface: string; next?: string; mastery?: string; minutes?: number; said?: string }

const STEPS: [RegExp, string][] = [
  [/warm-?up/i, 'Warm-up'],
  [/\brecall/i, 'Recall'],
  [/\bpracti[cs]/i, 'Practice'],
  [/\bquiz/i, 'Quiz'],
  [/\bread(ing)?\b/i, 'Read'],
]

/** The study step a phrase points to ("Start reading" is Read), or undefined when it names none. */
export function stepOf(text: string): string | undefined {
  return STEPS.find(([pattern]) => pattern.test(text))?.[1]
}

const BANDS = ['Not started', 'Just started', 'Getting there', 'Learning', 'Strong']

/** Topic progress as shown: its band and its percent ("Learning 0%"), or whichever of the two is there. */
export function masteryOf(text: string): string | undefined {
  const band = BANDS.find((word) => text.includes(word))
  const percent = text.match(/(\d+)%/)?.[0]
  const shown = [band, percent].filter(Boolean).join(' ')
  return shown || undefined
}

/** The minutes a surface gives ("About 20 min", "Part 1 of 2, 15 min", "20 of 45 min" is 20). */
export function minutesOf(text: string): number | undefined {
  const match = text.match(/(\d+)(?: of \d+)? min\b/)
  return match ? Number(match[1]) : undefined
}

const bandOf = (mastery: string) => BANDS.find((word) => mastery.startsWith(word))
const percentOf = (mastery: string) => mastery.match(/\d+%/)?.[0]

/**
 * One line when surfaces differ on `field`, naming each surface that shows it with what it shows. For topic
 * progress, a surface may show only the band or only the percent: they differ when two bands or two percents do.
 */
export function disagreements(readings: Reading[], field: 'next' | 'mastery' | 'minutes'): string[] {
  const shown = readings.filter((reading) => reading[field] !== undefined)
  const differ = (values: unknown[]) => new Set(values.filter((value) => value !== undefined)).size > 1
  const conflict =
    field === 'mastery'
      ? differ(shown.map((reading) => bandOf(reading.mastery!))) || differ(shown.map((reading) => percentOf(reading.mastery!)))
      : differ(shown.map((reading) => reading[field]))
  const quote = (reading: Reading) => (field === 'next' && reading.said ? ` ("${reading.said}")` : '')
  return conflict ? [shown.map((reading) => `${reading.surface}: ${reading[field]}${quote(reading)}`).join('; ')] : []
}

/** SW11: surfaces that show a percent for a topic, for a state with too little evidence to give one. */
export function percentShown(readings: Reading[]): string[] {
  return readings.filter((reading) => reading.mastery && percentOf(reading.mastery)).map((reading) => `${reading.surface}: ${reading.mastery}`)
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** An element's accessible name, images' labels included (innerText leaves those out). */
async function nameOf(locator: Locator): Promise<string> {
  const first = (await locator.ariaSnapshot()).split('\n')[0]
  return first.match(/"(.*)"|'(.*)'/)?.slice(1).find(Boolean)?.replace(/\\"/g, '"') ?? first
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * A plan item's lines (its link, its reason, its minutes). A ticked "Learn" item says the topic's learning is done for
 * today: nothing is left. A ticked single step (a quiz, a review) says only that it was done, not what comes next.
 */
export function planItemReading(lines: string[], topic: string, ticked: boolean): Reading {
  const reason = lines.find((line) => !line.includes(topic) && !/min$/.test(line)) ?? ''
  const minutes = minutesOf(lines.find((line) => /min$/.test(line)) ?? '')
  const mastery = /mastery/i.test(reason) ? masteryOf(reason) : undefined
  if (!ticked) return { surface: 'plan', next: stepOf(reason), said: reason || undefined, mastery, minutes }
  return { surface: 'plan', next: /^Learn\b/.test(lines[0] ?? '') ? 'nothing' : undefined, said: `${lines[0]}, ticked done`, mastery, minutes }
}

/** Visit every surface that shows `topic` and read what it says. Leaves the page on the plan. */
export async function readSurfaces(page: Page, at: { courseUrl: string; topicUrl: string; topic: string }): Promise<Reading[]> {
  const { courseUrl, topicUrl, topic } = at
  const readings: Reading[] = []
  const without = (text: string) => squash(text.replace(topic, ' '))
  const settle = async (url: string) => {
    await page.goto(url)
    await page.waitForLoadState('networkidle')
  }

  await settle(`${courseUrl}/topics`)
  const row = page.locator('main').getByRole('link', { name: new RegExp(`^${escape(topic)} Next: `) })
  if (await row.count()) {
    const text = await nameOf(row.first())
    const said = text.match(/Next: (.*?)(?: Topic progress|$)/)?.[1] ?? ''
    readings.push({ surface: 'topics list', next: stepOf(said), said: `Next: ${said}`, mastery: masteryOf(without(text)) })
  }

  await settle(topicUrl)
  const main = squash(await page.locator('main').innerText())
  const header = main.match(/Topic progress (.*?)(?= Details|$)/)?.[0] ?? ''
  const nextUp = page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /\(next up\)/ })
  const marked = (await nextUp.count()) ? await nameOf(nextUp.first()) : ''
  readings.push({
    surface: 'topic header and path',
    next: marked ? stepOf(marked) : undefined,
    said: marked || undefined,
    mastery: masteryOf(header),
    minutes: minutesOf(header),
  })
  const side = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: new RegExp(`${escape(topic)}$`) })
  if (await side.count()) readings.push({ surface: 'sidebar', mastery: masteryOf(without(await nameOf(side.first()))) })

  await settle('/home')
  const upNext = page.locator('main').getByRole('region', { name: /^Up next/ })
  if (await upNext.count()) {
    const lines = (await upNext.first().innerText()).split('\n').map(squash)
    const about = lines.find((line) => line.includes(`: ${topic}`))
    if (about) readings.push({ surface: 'home', next: stepOf(about.split(':')[0]), said: about, minutes: minutesOf(lines.join(' ')) })
  }

  await settle(courseUrl)
  const overview = page.locator('main').getByRole('region', { name: 'Up next', exact: true })
  const reading: Reading = { surface: 'course overview' }
  if (await overview.count()) {
    const lines = (await overview.innerText()).split('\n').map(squash)
    const then = lines.indexOf('Then')
    const current = then === -1 ? lines : lines.slice(0, then)
    const about = current.find((line) => line.includes(`: ${topic}`))
    if (about) Object.assign(reading, { next: stepOf(about.split(':')[0]), said: about, minutes: minutesOf(current.find((line) => /^About \d+ min$/.test(line)) ?? '') })
  }
  const tile = page.locator('main').getByRole('region', { name: 'Topics', exact: true }).getByRole('link', { name: new RegExp(escape(topic)) })
  if (await tile.count()) reading.mastery = masteryOf(without(await nameOf(tile.first())))
  readings.push(reading)

  await settle(`${courseUrl}/plan`)
  // The topic's first item in the plan (days are list items too, so take the item closest to the link).
  const link = page.locator('main').getByRole('link', { name: new RegExp(`${escape(topic)}$`) })
  if (await link.count()) {
    const item = link.first().locator('xpath=ancestor::li[1]')
    const lines = (await item.innerText()).split('\n').map(squash).filter(Boolean)
    const ticked = (await item.getByRole('img', { name: 'Done', exact: true }).count()) > 0
    readings.push(planItemReading(lines, topic, ticked))
  }
  return readings
}
