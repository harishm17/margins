import { animationsSettled } from './helpers/settle'
import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { addQuizSet, createCourse, reviewItem, seedDueConcept, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// The knowledge map (spec §9, D15): one unit at a time as an SVG, a list view that says the same in words, the node
// panel with its four actions, and suggested links asked as "Needs X?". The AI service is the mock provider.
// Set SCREENS_DIR to keep screenshots at both sizes.

test.use({ timezoneId: ZONE })

const SIZES = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
]

type World = {
  email: string
  courseId: string
  topics: Record<string, string>
  units: Record<string, string>
  concepts: Record<string, string>
}

async function link(courseId: string, source: string, target: string, type: string, status = 'confirmed', confidence = 0.9, weight = 1) {
  return withPrisma((prisma) => prisma.conceptEdge.create({ data: { projectId: courseId, sourceId: source, targetId: target, type, weight, confidence, status } }))
}

/**
 * Unit "Hashing" with Hash function (answered three weeks ago), Collisions (needs Hash function) and Chaining
 * (not started, easy to mix up with Open addressing), and unit "Graphs" with one idea.
 */
async function world(page: Page, label: string): Promise<World> {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, label, { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Map ${Date.now()}`, [
    { name: 'Hash tables', unit: 'Hashing' },
    { name: 'Probing', unit: 'Hashing' },
    { name: 'Traversal', unit: 'Graphs' },
  ])
  const concepts: Record<string, string> = {}
  concepts['Hash function'] = await seedDueConcept(email, course.topics['Hash tables'], 'Hash function', { orderIndex: 0 })
  const add = (topic: string, name: string, orderIndex: number) =>
    withPrisma(async (prisma) => {
      const created = await prisma.concept.create({
        data: { projectId: course.courseId, topicId: course.topics[topic], name, summary: `${name} in one sentence.`, kind: 'concept', orderIndex, objectiveIndexes: [] },
      })
      return created.id
    })
  concepts.Collisions = await add('Hash tables', 'Collisions', 1)
  concepts.Chaining = await add('Hash tables', 'Chaining', 2)
  concepts['Open addressing'] = await add('Probing', 'Open addressing', 0)
  concepts['Breadth first search'] = await add('Traversal', 'Breadth first search', 0)
  // The seeded memory has no events behind it, so the topics are marked converted: the history backfill would rebuild it from nothing.
  await withPrisma((prisma) => prisma.topic.updateMany({ where: { projectId: course.courseId }, data: { evidenceBackfilledAt: new Date() } }))
  await link(course.courseId, concepts['Hash function'], concepts.Collisions, 'prerequisite')
  await link(course.courseId, concepts.Chaining, concepts['Open addressing'], 'confusable', 'confirmed')
  return { email, ...course, concepts }
}

const mapUrl = (w: World, query = '') => `/courses/${w.courseId}/map${query}`
/** Opens a page and waits for the streamed content to settle: until then a copy of it waits, hidden, in the document. */
async function open(page: Page, url: string) {
  await page.goto(url)
  await settled(page)
}
/** Streamed content has arrived: until then a hidden copy of the page waits in the document (and duplicates what a locator finds). */
const settled = (page: Page) => page.waitForFunction(() => document.querySelector('[id^="S:"]') === null)
const nodeLink = (page: Page, name: string) => page.getByRole('link', { name: new RegExp(`^${name} (Not started|Inferred|Shaky|Fading|Getting there|Solid)`) })

test.describe('knowledge map', () => {
  test('map shows current unit with states as text', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-show')
    await open(page, mapUrl(w))

    await expect(page.getByRole('heading', { level: 1, name: 'Idea map' })).toBeVisible()
    // Today's plan starts in the first unit, so it is the one shown.
    await expect(page.getByRole('combobox', { name: 'Unit' })).toHaveText(/Hashing/)
    const unit = page.getByRole('group', { name: /^Hashing: 4 ideas$/ })
    await expect(unit).toBeVisible()
    // Every idea in the unit is a link with its state in words; ideas of the other unit are not here.
    await expect(nodeLink(page, 'Hash function')).toHaveAccessibleName(/^Hash function (Shaky|Fading|Getting there|Solid)/)
    await expect(nodeLink(page, 'Collisions')).toHaveAccessibleName('Collisions Not started')
    await expect(nodeLink(page, 'Open addressing')).toHaveAccessibleName(/^Open addressing Not started/)
    await expect(page.getByRole('link', { name: /^Breadth first search/ })).toHaveCount(0)
    // The state is also text drawn in the node, not only the link's name.
    await expect(unit.locator('text', { hasText: 'Not started' }).first()).toBeVisible()

    // "Next up": Chaining and Open addressing have nothing to wait for. Collisions waits for a Hash function
    // that is no longer fresh, so it does not carry the ring.
    await expect(nodeLink(page, 'Chaining')).toHaveAccessibleName('Chaining Not started Next up')
    await expect(nodeLink(page, 'Collisions')).not.toHaveAccessibleName(/Next up/)
    // The links between ideas are drawn, with a title for each.
    await expect(unit.locator('path > title')).toHaveCount(1)
    await expect(unit.locator('path > title', { hasText: 'Collisions needs Hash function' })).toHaveCount(1)
    // "Easy to mix up" is not an arrow: a dotted line with a round "≈" badge, titled for its two ideas.
    await expect(unit.locator('g > title', { hasText: 'Chaining and Open addressing are easy to mix up' })).toHaveCount(1)
    await expect(unit.locator('g[data-mix-badge]')).toHaveCount(1)
    // The badge is big enough to read and sits clear of both boxes, not over the gap's edge.
    const badge = await unit.locator('g[data-mix-badge]').evaluate((group: SVGGElement) => {
      const circle = group.querySelector('circle')!.getBoundingClientRect()
      const waves = group.querySelector('path')!.getBoundingClientRect()
      const nodes = [...group.ownerSVGElement!.querySelectorAll('a[data-node-link] rect')].map((rect) => rect.getBoundingClientRect())
      const overlaps = nodes.filter((node) => circle.left < node.right && circle.right > node.left && circle.top < node.bottom && circle.bottom > node.top).length
      return { diameter: circle.width, glyph: waves.width, overlaps }
    })
    expect(badge.overlaps, 'boxes the badge covers').toBe(0)
    expect(badge.diameter, 'badge across, in pixels').toBeGreaterThanOrEqual(22)
    expect(badge.glyph, 'the "≈", across in pixels').toBeGreaterThanOrEqual(16)
    await expect(unit.locator('path[stroke-dasharray="5 4"]')).toHaveCount(0)
    // Three ideas are next up: the first in list order says where to start, the others stay "Next up".
    await expect(nodeLink(page, 'Hash function')).toHaveAccessibleName(/^Hash function (Shaky|Fading|Getting there|Solid) Start here$/)
    await expect(nodeLink(page, 'Chaining')).toHaveAccessibleName('Chaining Not started Next up')
    await expect(nodeLink(page, 'Open addressing')).toHaveAccessibleName('Open addressing Not started Next up')

    // The key opens by itself the first time this browser sees a map, and is folded away after that.
    const key = page.locator('details').filter({ has: page.getByText('Key', { exact: true }) })
    await expect(key.getByText('Leads to')).toBeVisible()
    await page.reload()
    await expect(key.getByText('Key', { exact: true }).locator('visible=true').first()).toBeVisible()
    await expect(key.getByText('Leads to').first()).toBeHidden()
    // It lists only what this unit shows.
    await key.getByText('Key', { exact: true }).click()
    await expect(key.getByRole('list', { name: 'States' }).getByRole('listitem')).toHaveText(['Not started', /^(Shaky|Fading|Getting there)$/])
    await expect(key.getByText('Leads to')).toBeVisible()
    await expect(key.getByText('Easy to mix up')).toBeVisible()
    await expect(key.getByText(/^Next up: ready to study. You answered what it builds on well recently/)).toContainText('The ring marks Start here, the first of them')
    await expect(key.getByText('Suggested, not confirmed')).toHaveCount(0)
    await expect(key.getByText('Inferred means')).toHaveCount(0)
    await screenshotIfAsked(page, 'final-map-key-1440x900')

    // The other unit by choice.
    await page.getByRole('combobox', { name: 'Unit' }).click()
    await page.getByRole('option', { name: 'Graphs' }).click()
    await expect(page).toHaveURL(/unit=/)
    await expect(page.getByRole('group', { name: /^Graphs: 1 idea$/ })).toBeVisible()
    await expect(nodeLink(page, 'Breadth first search')).toBeVisible()

    // The nav item and the topic page's way in.
    await expect(page.getByRole('link', { name: 'Map', exact: true }).first()).toHaveAttribute('href', `/courses/${w.courseId}/map`)
  })

  test('on a desktop the map fits its frame beside the panel, and a map too wide for it scrolls with a visible edge', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await world(page, 'map-fit')
    await page.setViewportSize({ width: 1440, height: 900 })
    // With the panel open the frame is about 560px wide: the unit's picture is scaled down to it and no idea is cut off.
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts.Collisions}&view=map`))
    const frame = page.getByRole('region', { name: /^Hashing: 4 ideas, scrolls sideways$/ })
    await expect(frame).toBeVisible()
    const inside = async () => {
      const outer = await frame.boundingBox()
      const boxes = await Promise.all(['Hash function', 'Collisions', 'Chaining', 'Open addressing'].map((name) => nodeLink(page, name).boundingBox()))
      return outer !== null && boxes.every((box) => box !== null && box.x >= outer.x - 1 && box.x + box.width <= outer.x + outer.width + 1)
    }
    expect(await inside(), 'every idea lies inside the frame').toBe(true)
    expect(await frame.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'the frame does not scroll').toBe(true)
    await screenshotIfAsked(page, 'map-fits-frame-1440x900')

    // Ten ideas side by side are wider than the frame at any scale worth reading: it scrolls, with a soft edge on the side that has more.
    await withPrisma(async (prisma) => {
      for (let index = 0; index < 8; index += 1) {
        await prisma.concept.create({
          data: { projectId: w.courseId, topicId: w.topics['Hash tables'], name: `Extra idea ${index + 1}`, summary: 'x', kind: 'concept', orderIndex: 10 + index, objectiveIndexes: [] },
        })
      }
    })
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&view=map`))
    const wide = page.getByRole('region', { name: /^Hashing: 12 ideas, scrolls sideways$/ })
    await expect(wide).toBeVisible()
    expect(await wide.evaluate((element) => element.scrollWidth > element.clientWidth + 1), 'the wide map scrolls').toBe(true)
    expect(await wide.evaluate((element) => getComputedStyle(element).backgroundImage.match(/linear-gradient/g)?.length), 'edge cues are drawn').toBe(4)
    await screenshotIfAsked(page, 'map-wide-scrolls-1440x900')
    await wide.evaluate((element) => element.scrollTo({ left: element.scrollWidth }))
    await expect.poll(() => wide.evaluate((element) => Math.round(element.scrollLeft + element.clientWidth) >= element.scrollWidth - 1)).toBe(true)
    const last = await nodeLink(page, 'Extra idea 8').boundingBox()
    const outer = await wide.boundingBox()
    expect(last !== null && outer !== null && last.x + last.width <= outer.x + outer.width + 1, 'the last idea can be scrolled fully into view').toBe(true)
    await expectNoAxeViolations(page, 'map: wide, scrolling')
  })

  test('the topic page links its concepts to the map at that topic', async ({ page }) => {
    const w = await world(page, 'map-topic')
    await withPrisma((prisma) => prisma.topic.update({ where: { id: w.topics['Probing'] }, data: { evidenceBackfilledAt: new Date() } }))
    await open(page, `/courses/${w.courseId}/topics/${w.topics.Probing}`)
    // What the topic covers, the map link among it, is behind "Details".
    await page.getByRole('button', { name: /Details/ }).click()
    await page.getByRole('link', { name: 'Show on the map' }).locator('visible=true').click()
    await expect(page).toHaveURL(new RegExp(`/map\\?unit=${w.units.Hashing}&topic=${w.topics.Probing}`))
    // The topic's first idea is open in the panel.
    await expect(page.getByTestId('node-panel').getByRole('heading', { level: 2, name: 'Open addressing' })).toBeVisible()
  })

  test('node panel shows the idea, its pages, state and last answers', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-panel')
    await withPrisma(async (prisma) => {
      const material = await prisma.material.findFirstOrThrow({ where: { projectId: w.courseId }, select: { id: true } })
      await prisma.conceptClaim.create({
        data: { conceptId: w.concepts['Hash function'], text: 'A hash function maps a key to a bucket index.', quote: 'x', materialId: material.id, pageStart: 4, pageEnd: 4, orderIndex: 0 },
      })
      const user = await prisma.user.findUniqueOrThrow({ where: { email: w.email }, select: { id: true } })
      await prisma.evidenceEvent.createMany({
        data: Array.from({ length: 7 }, (_, n) => ({
          userId: user.id,
          projectId: w.courseId,
          topicId: w.topics['Hash tables'],
          conceptId: w.concepts['Hash function'],
          itemKey: `quiz:panel:${n}`,
          source: n === 6 ? 'drill' : 'quiz',
          score: n === 6 ? 0.5 : 1,
          assistance: n === 6 ? 2 : 0,
          weight: 1,
          role: 'primary',
          gradedBy: 'rule',
          sessionKey: `panel-${n}`,
          createdAt: new Date(Date.now() - (10 - n) * 3_600_000),
        })),
      })
    })
    await open(page, mapUrl(w))
    await nodeLink(page, 'Hash function').click()
    await expect(page).toHaveURL(new RegExp(`node=${w.concepts['Hash function']}`))
    const panel = page.getByTestId('node-panel')
    // On a wide screen the panel is already in view, so focus stays on the node; "Back to the map" returns to it from the panel.
    await expect(nodeLink(page, 'Hash function')).toBeFocused()
    await panel.getByRole('button', { name: 'Back to the map' }).click()
    await expect(nodeLink(page, 'Hash function')).toBeFocused()
    await expect(panel.getByText('Hash function.', { exact: true })).toBeVisible()
    await expect(panel.getByText(/^(Shaky|Fading|Getting there|Solid)( · .*)?$/)).toBeVisible()
    // The claim, with a link to its page.
    await expect(panel.getByText('A hash function maps a key to a bucket index.')).toBeVisible()
    await expect(panel.getByRole('link', { name: 'notes.pdf, p. 4' })).toHaveAttribute('href', /\/file#page=4$/)
    // The last five answers, newest first, with whether help was used.
    const answers = panel.getByRole('heading', { level: 3, name: 'Your last answers' }).locator('xpath=following-sibling::ul[1]/li')
    await expect(answers).toHaveCount(5)
    await expect(answers.nth(0)).toContainText('Drill · 50% · with help')
    await expect(answers.nth(1)).toContainText('Quiz · 100%')
    await expect(panel.getByText('Needed by Collisions').or(panel.getByText('Collisions needs this'))).toBeVisible()
    // Out loud goes to the voice lobby for this idea (one of the other ways to study, behind one button).
    await panel.getByRole('button', { name: 'Other ways to study' }).click()
    await expect(panel.getByTestId('do-it-out-loud')).toHaveAttribute('href', new RegExp(`view=voice&style=teach_back&concept=${w.concepts['Hash function']}`))
    // Ask about this carries the idea.
    await expect(panel.getByRole('link', { name: 'Ask about this' })).toHaveAttribute('href', `/courses/${w.courseId}/ask?concept=${w.concepts['Hash function']}`)
  })

  test('map node needing instruction leads with reading', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-read-first')
    const conceptId = w.concepts['Hash function']
    const failedAt = new Date(Date.now() - 3_600_000)
    const chunkId = await withPrisma(async (prisma) => {
      const material = await prisma.material.findFirstOrThrow({ where: { projectId: w.courseId }, select: { id: true } })
      const chunk = await prisma.materialChunk.create({ data: { materialId: material.id, chunkText: 'A hash function maps a key to a bucket index.', chunkIndex: 0, pageStart: 4, pageEnd: 4 } })
      await prisma.conceptClaim.create({
        data: { conceptId, text: 'A hash function maps a key to a bucket index.', quote: 'x', materialId: material.id, chunkId: chunk.id, pageStart: 4, pageEnd: 4, orderIndex: 0 },
      })
      const user = await prisma.user.findUniqueOrThrow({ where: { email: w.email }, select: { id: true } })
      // The latest retrieval failed (an Again group), and nothing has shown the idea since.
      await prisma.evidenceEvent.create({
        data: { userId: user.id, projectId: w.courseId, topicId: w.topics['Hash tables'], conceptId, itemKey: 'quiz:fail:0', source: 'quiz', score: 0, assistance: 0, weight: 1, role: 'primary', gradedBy: 'rule', sessionKey: 'fail-0', createdAt: failedAt },
      })
      const memory = await prisma.conceptMemory.findFirstOrThrow({ where: { conceptId } })
      await prisma.conceptMemory.update({ where: { id: memory.id }, data: { derived: { ...(memory.derived as object), lastFailAt: failedAt.toISOString() } } })
      return chunk.id
    })
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${conceptId}`))
    const panel = page.getByTestId('node-panel')
    await expect(panel.getByText('Missed last time: p. 4')).toBeVisible()
    // Reading comes first, practice second; the other idea's panel is unchanged.
    // Reading is the one recommended move; practice is one of the other ways to study.
    const actions = panel.getByRole('link', { name: /^(Read about it first|Practice this)$/ })
    await expect(actions).toHaveText(['Read about it first'])
    await panel.getByRole('button', { name: 'Other ways to study' }).click()
    await expect(actions).toHaveText(['Read about it first', 'Practice this'])
    await expect(panel.getByTestId('read-first')).toHaveAttribute('href', new RegExp(`view=read&focus=${conceptId}#chunk-${chunkId}$`))
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height })
      await expectNoAxeViolations(page, `node panel that leads with reading, ${size.name}`)
      await screenshotIfAsked(page, `v31r-map-read-first-${size.name}`)
    }
    await page.setViewportSize({ width: 1440, height: 900 })

    // Opening the pointer is the instruction: back on the map the panel leads with practice.
    await panel.getByTestId('read-first').click()
    await expect(page).toHaveURL(/view=read/)
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${conceptId}`))
    await expect(page.getByTestId('node-panel').getByText('Missed last time')).toHaveCount(0)
    await expect(page.getByTestId('node-panel').getByRole('link', { name: 'Read about it first' })).toHaveCount(0)
    // The instruction is not an answer: the panel's last answers do not list it.
    await expect(page.getByTestId('node-panel').getByText(/instruction/i)).toHaveCount(0)
    await withPrisma(async (prisma) => {
      expect(await prisma.evidenceEvent.count({ where: { conceptId, source: 'instruction' } })).toBe(1)
    })

    // Another idea in the same unit never missed anything: no reading first.
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts.Collisions}`))
    await expect(page.getByTestId('node-panel').getByRole('link', { name: 'Read about it first' })).toHaveCount(0)
  })

  test('node panel practice starts drill', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await world(page, 'map-practice')
    const topic = w.topics['Hash tables']
    await addQuizSet(topic, [
      reviewItem(w.concepts['Hash function'], 'A hash function maps keys to bucket indexes.', 'easy'),
      reviewItem(w.concepts['Hash function'], 'A good hash function spreads keys evenly.', 'easy'),
      reviewItem(w.concepts['Hash function'], 'The same key always hashes to the same index.', 'medium'),
      reviewItem(w.concepts['Hash function'], 'A hash function must be reversible.', 'medium'),
    ])
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts['Hash function']}`))
    await page.getByTestId('node-panel').getByRole('link', { name: 'Practice this' }).click()
    await expect(page).toHaveURL(new RegExp(`/review/session\\?concept=${w.concepts['Hash function']}`))
    await expect(page.getByRole('heading', { level: 1, name: /^Question 1 of \d/ })).toBeVisible({ timeout: 30_000 })
    const sessions = await withPrisma((prisma) => prisma.itemSession.findMany({ where: { user: { email: w.email } }, select: { kind: true } }))
    expect(sessions.map((s) => s.kind)).toEqual(['drill'])
  })

  test('node panel explain it posts a teach-back for the concept', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-explain')
    await withPrisma(async (prisma) => {
      const material = await prisma.material.findFirstOrThrow({ where: { projectId: w.courseId }, select: { id: true } })
      await prisma.conceptClaim.create({
        data: { conceptId: w.concepts['Hash function'], text: 'A hash function maps a key to a bucket index.', quote: 'x', materialId: material.id, pageStart: 4, orderIndex: 0 },
      })
      await prisma.topic.update({ where: { id: w.topics['Hash tables'] }, data: { evidenceBackfilledAt: new Date() } })
    })
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts['Hash function']}`))
    const panel = page.getByTestId('node-panel')
    await panel.getByRole('button', { name: 'Other ways to study' }).click()
    await panel.getByRole('button', { name: 'Explain it' }).click()
    const prompt = 'Explain "Hash function" in your own words, as if you were teaching it to a classmate.'
    await panel.getByRole('textbox', { name: prompt }).fill('A hash function turns a key into a number that picks the bucket the key is stored in.')
    await panel.getByRole('button', { name: 'Check my answer' }).click()
    await expect(panel.getByRole('region', { name: 'Feedback on your answer' })).toBeVisible({ timeout: 30_000 })
    const events = await withPrisma((prisma) =>
      prisma.evidenceEvent.findMany({ where: { user: { email: w.email }, source: 'teach_back' }, select: { conceptId: true } })
    )
    expect(events.map((e) => e.conceptId)).toEqual([w.concepts['Hash function']])
  })

  test('node panel do it out loud opens the voice lobby with Teach it back chosen for that idea', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-voice')
    await withPrisma(async (prisma) => {
      const material = await prisma.material.findFirstOrThrow({ where: { projectId: w.courseId }, select: { id: true } })
      await prisma.conceptClaim.create({
        data: { conceptId: w.concepts['Hash function'], text: 'A hash function maps a key to a bucket index.', quote: 'x', materialId: material.id, pageStart: 4, orderIndex: 0 },
      })
    })
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts['Hash function']}`))
    await page.getByTestId('node-panel').getByRole('button', { name: 'Other ways to study' }).click()
    await page.getByTestId('node-panel').getByRole('link', { name: 'Do it out loud' }).click()
    // The voice page of the topic, not written recall: its lobby, with Teach it back chosen and the idea carried along.
    await expect(page).toHaveURL(new RegExp(`/topics/${w.topics['Hash tables']}\\?view=voice&style=teach_back&concept=${w.concepts['Hash function']}$`))
    await expect(page.getByTestId('voice-lobby')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('heading', { level: 2, name: 'Voice practice' })).toBeVisible()
    await expect(page.getByRole('radio', { name: /Teach it back/ })).toHaveAttribute('aria-checked', 'true')

    // An idea with no claims from the pages cannot be taught back, though another idea of the topic has some: the lobby starts on Quiz me and says the idea is the one missing them.
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts['Open addressing']}`))
    await page.getByTestId('node-panel').getByRole('button', { name: 'Other ways to study' }).click()
    await page.getByTestId('node-panel').getByRole('link', { name: 'Do it out loud' }).click()
    await expect(page.getByTestId('voice-lobby')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('radio', { name: /Quiz me/ })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText("This idea isn't read from your pages yet")).toBeVisible()
    await expect(page.getByText("Your pages aren't read into ideas yet")).toHaveCount(0)
    // This topic has no quiz either, so Quiz me cannot begin: that is said too, and the claims line does not promise it works.
    await expect(page.getByTestId('voice-quiz-missing')).toBeVisible()
    await expect(page.getByText('Quiz me still works.')).toHaveCount(0)
  })

  test('on a phone the teach-back card opened from the panel ends above the tab bar', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-phone-explain')
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts['Hash function']}&view=list`))
    const panel = page.getByTestId('node-panel')
    await panel.getByRole('button', { name: 'Other ways to study' }).click()
    await panel.getByRole('button', { name: 'Explain it' }).click()
    const check = panel.getByRole('button', { name: 'Check my answer' })
    await expect(check).toBeVisible()
    // On a phone the details are a bottom sheet over the tab bar: the card was brought into view inside the screen.
    await expect
      .poll(
        async () => {
          const box = await check.boundingBox()
          return box !== null && box.y >= 0 && box.y + box.height <= 844
        },
        { timeout: 5_000, message: 'Check my answer is inside the screen' }
      )
      .toBe(true)
    await animationsSettled(page)
    await screenshotIfAsked(page, 'map-teach-back-in-view-390x844')
  })

  test('ask about this starts a conversation about the concept', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-ask')
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts.Collisions}`))
    await page.getByTestId('node-panel').getByRole('button', { name: 'Other ways to study' }).click()
    await page.getByTestId('node-panel').getByRole('link', { name: 'Ask about this' }).click()
    await expect(page).toHaveURL(new RegExp(`/ask\\?concept=${w.concepts.Collisions}`))
    await expect(page.getByText('Your next question is about Collisions.')).toBeVisible()
    await page.getByLabel('Ask about your materials').fill('Why do collisions happen?')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/[?&]thread=/, { timeout: 30_000 })
    const threadId = new URL(page.url()).searchParams.get('thread')!
    const state = await withPrisma((prisma) => prisma.tutorState.findFirstOrThrow({ where: { user: { email: w.email }, scope: 'ask', scopeKey: threadId } }))
    expect(state.conceptIds).toContain(w.concepts.Collisions)
    // Someone else's or an unknown concept is ignored, not an error.
    await page.goto(`/courses/${w.courseId}/ask?concept=not-a-concept`)
    await expect(page.getByRole('heading', { level: 2, name: 'Ask your materials' })).toBeVisible()
    await expect(page.getByText(/Your next question is about/)).toHaveCount(0)
  })

  test('rejecting edge removes its implicit credit', async ({ page }) => {
    test.setTimeout(120_000)
    const w = await world(page, 'map-reject')
    const advanced = w.concepts.Collisions
    const basic = w.concepts.Chaining
    // Collisions covers Chaining, as a suggestion at 0.8. Chaining was started, Collisions was answered, and the
    // answer gave Chaining implicit credit along the suggested link.
    const edge = await link(w.courseId, advanced, basic, 'encompasses', 'proposed', 0.8)
    await withPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email: w.email }, select: { id: true } })
      const topicId = w.topics['Hash tables']
      const base = { userId: user.id, projectId: w.courseId, topicId, weight: 1, assistance: 0, gradedBy: 'rule' }
      await prisma.evidenceEvent.create({ data: { ...base, conceptId: advanced, itemKey: 'quiz:r:1', source: 'quiz', score: 1, role: 'primary', sessionKey: 'r-1' } })
      await prisma.evidenceEvent.create({
        data: { ...base, conceptId: basic, itemKey: 'quiz:r:1', source: 'implicit', score: 1, role: 'secondary', sessionKey: 'r-1', metadata: { direction: 'credit', pathWeight: 1, edgeId: edge.id } },
      })
    })
    const implicitCount = () => withPrisma((prisma) => prisma.evidenceEvent.count({ where: { conceptId: basic, source: 'implicit' } }))
    expect(await implicitCount()).toBe(1)

    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${advanced}`))
    const panel = page.getByTestId('node-panel')
    // A suggestion is a question, kept under "Edit connections" away from the study actions, and the buttons say what they do.
    await expect(panel.getByTestId('practice-this').or(panel.getByTestId('read-first'))).toBeVisible()
    await expect(panel.getByText('Does Collisions cover Chaining?')).toBeHidden()
    await panel.getByText('Edit connections').click()
    await expect(panel.getByText('Does Collisions cover Chaining?')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Yes, keep link' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'No, remove link' })).toBeVisible()
    await screenshotIfAsked(page, 'map-edge-question-1440x900')
    await panel.getByRole('button', { name: 'No, remove link' }).click()
    await expect(panel.getByText('Does Collisions cover Chaining?')).toHaveCount(0)

    expect(await implicitCount()).toBe(0)
    const row = await withPrisma((prisma) => prisma.conceptEdge.findUniqueOrThrow({ where: { id: edge.id } }))
    expect([row.status, row.origin]).toEqual(['rejected', 'student'])
    // Chaining's own memory no longer holds any evidence at all.
    const memory = await withPrisma((prisma) => prisma.conceptMemory.findFirst({ where: { conceptId: basic, user: { email: w.email } } }))
    expect(memory?.lastEvidenceAt ?? null).toBeNull()
    // The advanced concept's own answer stays.
    expect(await withPrisma((prisma) => prisma.evidenceEvent.count({ where: { conceptId: advanced, source: 'quiz' } }))).toBe(1)
    // The link is gone from the map.
    await open(page, page.url())
    await expect(page.locator('svg path > title', { hasText: 'Collisions covers Chaining' })).toHaveCount(0)
  })

  test('confirming a suggested link keeps it as the student\'s own', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-confirm')
    const edge = await link(w.courseId, w.concepts['Open addressing'], w.concepts.Chaining, 'prerequisite', 'proposed', 0.8)
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts.Chaining}`))
    const panel = page.getByTestId('node-panel')
    await panel.getByText('Edit connections').click()
    await expect(panel.getByText('Does Chaining require Open addressing first?')).toBeVisible()
    await panel.getByRole('button', { name: 'Yes, keep link' }).click()
    await expect(panel.getByText('Needs Open addressing', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: /^(Yes|No), (keep|remove) link$/ })).toHaveCount(0)
    const row = await withPrisma((prisma) => prisma.conceptEdge.findUniqueOrThrow({ where: { id: edge.id } }))
    expect([row.status, row.origin]).toEqual(['confirmed', 'student'])
  })

  test("someone else's link cannot be answered", async ({ page, browser }) => {
    const w = await world(page, 'map-owner')
    const edge = await link(w.courseId, w.concepts.Collisions, w.concepts.Chaining, 'encompasses', 'proposed', 0.8)
    const other = await browser.newContext()
    const otherPage = await other.newPage()
    await signUpAndIn(otherPage, 'map-stranger', { own: true })
    const response = await otherPage.request.patch(`/api/concept-edges/${edge.id}`, { data: { status: 'rejected' } })
    expect(response.status()).toBe(404)
    expect((await withPrisma((prisma) => prisma.conceptEdge.findUniqueOrThrow({ where: { id: edge.id } }))).status).toBe('proposed')
    const invalid = await page.request.patch(`/api/concept-edges/${edge.id}`, { data: { status: 'maybe' } })
    expect(invalid.status()).toBe(400)
    await other.close()
  })

  test('list view is keyboard navigable', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-list')
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}`))
    // The order the keyboard moves through the map's nodes...
    const mapOrder = await page.locator('svg a[data-node-link]').evaluateAll((links) => links.map((a) => a.querySelector('text')!.textContent))
    expect(mapOrder).toEqual(['Hash function', 'Collisions', 'Chaining', 'Open addressing'])

    await page.getByRole('radio', { name: 'List view' }).click()
    await expect(page).toHaveURL(/view=list/)
    // ...is the order of the list, grouped by topic.
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(['Hash tables', 'Probing'])
    const items = page.getByRole('list').filter({ has: page.getByRole('link', { name: /Hash function/ }) }).first().getByRole('listitem')
    await expect(items.first()).toContainText('Hash function')
    await expect(items.first()).toContainText(/Shaky|Fading|Getting there|Solid/)
    await expect(page.getByRole('link', { name: /^Collisions/ })).toContainText('Needs: Hash function')
    await expect(page.getByRole('link', { name: /^Chaining/ })).toContainText('Easy to mix up with: Open addressing')
    await expect(page.getByRole('link', { name: /^Chaining/ })).toContainText('Next up')

    // Tab walks the ideas in list order, and Enter opens the panel and moves focus to it.
    await page.getByRole('link', { name: /^Hash function/ }).focus()
    const seen: string[] = []
    for (let n = 0; n < 3; n++) {
      await page.keyboard.press('Tab')
      seen.push(await page.evaluate(() => (document.activeElement as HTMLElement).textContent!.split(/Not started|Shaky|Fading|Getting|Solid|Inferred/)[0].trim()))
    }
    expect(seen).toEqual(['Collisions', 'Chaining', 'Open addressing'])
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`node=${w.concepts['Open addressing']}.*view=list|view=list.*node=${w.concepts['Open addressing']}`))
    await expect(page.getByTestId('node-panel').getByRole('heading', { level: 2, name: 'Open addressing' })).toBeVisible()
    await expect(page.getByRole('link', { name: /^Open addressing/ })).toBeFocused()
    await page.getByTestId('node-panel').getByRole('button', { name: 'Back to the list' }).click()
    await expect(page.getByRole('link', { name: /^Open addressing/ })).toBeFocused()
    await expect(page.getByRole('link', { name: /^Open addressing/ })).toHaveAttribute('aria-current', 'true')
  })

  test('map view is keyboard navigable: ideas in order, relations in words, a skip link to the details', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-keys')
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&view=map`))
    // No idea is chosen yet: there are no details to skip to.
    await expect(page.getByRole('link', { name: /^Skip to the details/ })).toHaveCount(0)

    // The lines are drawn for the eye: each idea says how it connects in its description.
    await expect(nodeLink(page, 'Collisions')).toHaveAccessibleDescription(/^Needs Hash function\. In Hash tables\.?$/)
    await expect(nodeLink(page, 'Hash function')).toHaveAccessibleDescription(/^Needed by Collisions\. In Hash tables\.?$/)
    await expect(nodeLink(page, 'Chaining')).toHaveAccessibleDescription(/^Easy to mix up with Open addressing\. In Hash tables\.?$/)

    // Tab reaches the ideas in the order of the list, and Enter chooses one without taking focus from it.
    await nodeLink(page, 'Hash function').focus()
    const seen: string[] = []
    for (let n = 0; n < 3; n++) {
      await page.keyboard.press('Tab')
      seen.push(await page.evaluate(() => (document.activeElement as SVGAElement).querySelector('text')!.textContent as string))
    }
    expect(seen).toEqual(['Collisions', 'Chaining', 'Open addressing'])
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('node-panel').getByRole('heading', { level: 2, name: 'Open addressing' })).toBeVisible()
    await expect(nodeLink(page, 'Open addressing')).toBeFocused()

    // With an idea chosen, a skip link is the first stop in the section and lands on the details.
    const skip = page.getByRole('link', { name: 'Skip to the details of Open addressing' })
    await expect(skip).toHaveCount(1)
    await skip.focus()
    await expect(skip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('node-panel').getByRole('heading', { level: 2, name: 'Open addressing' })).toBeFocused()
  })

  test('an empty course says what is needed, and a unit without ideas shows none', async ({ page }) => {
    await setZoneCookie(page.context())
    await signUpAndIn(page, 'map-empty', { own: true })
    const course = await createCourse(page, `Empty map ${Date.now()}`, [{ name: 'Hash tables', unit: 'Hashing' }])
    await open(page, `/courses/${course.courseId}/map`)
    await expect(page.getByRole('heading', { level: 2, name: 'No map yet' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to topics' })).toBeVisible()
    await expectNoAxeViolations(page, 'map: empty')
    // Another person's or an unknown idea in the address is ignored.
    const missing = await page.goto(`/courses/${course.courseId}/map?node=nothing&unit=nothing`)
    expect(missing?.status()).toBe(200)
  })

  test('axe has no violations on map, list and panel at both sizes, with screenshots on request', async ({ page }) => {
    test.setTimeout(180_000)
    const w = await world(page, 'map-axe')
    await link(w.courseId, w.concepts['Open addressing'], w.concepts.Chaining, 'prerequisite', 'proposed', 0.8)
    await withPrisma(async (prisma) => {
      const material = await prisma.material.findFirstOrThrow({ where: { projectId: w.courseId }, select: { id: true } })
      await prisma.conceptClaim.create({
        data: { conceptId: w.concepts.Chaining, text: 'Chaining keeps a list of entries in each bucket.', quote: 'x', materialId: material.id, pageStart: 5, orderIndex: 0 },
      })
    })
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height })
      await open(page, mapUrl(w, `?unit=${w.units.Hashing}&view=map`))
      await expect(page.getByRole('group', { name: /^Hashing: 4 ideas$/ })).toBeVisible()
      await expectNoAxeViolations(page, `map ${size.name}`)
      await screenshotIfAsked(page, `map-${size.name}`)

      await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts.Chaining}&view=map`))
      await expect(page.getByTestId('node-panel')).toBeVisible()
      await expectNoAxeViolations(page, `map with panel ${size.name}`)
      await screenshotIfAsked(page, `map-panel-${size.name}`)

      await open(page, mapUrl(w, `?unit=${w.units.Hashing}&view=list`))
      await expect(page.getByRole('heading', { level: 3, name: 'Hash tables' })).toBeVisible()
      await expectNoAxeViolations(page, `list ${size.name}`)
      await screenshotIfAsked(page, `map-list-${size.name}`)

      await open(page, mapUrl(w, `?unit=${w.units.Hashing}&view=list&node=${w.concepts.Chaining}`))
      await page.getByTestId('node-panel').getByRole('button', { name: 'Other ways to study' }).click()
      await page.getByTestId('node-panel').getByRole('button', { name: 'Explain it' }).click()
      await expect(page.getByRole('textbox', { name: /Explain "Chaining"/ })).toBeVisible()
      await expectNoAxeViolations(page, `list with panel and teach-back ${size.name}`)
      await screenshotIfAsked(page, `map-list-panel-${size.name}`)

      // No sideways scroll on the page itself: the picture scrolls inside its own frame.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    }
  })
})

test.describe('knowledge map on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the list is chosen on the server, so the map is never drawn first, and the topic in the address is kept', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-phone-server')
    // The browser has told the server its width by now (it does on every page of the app).
    await open(page, `/courses/${w.courseId}`)
    await expect.poll(async () => (await page.context().cookies()).find((cookie) => cookie.name === 'margins_narrow')?.value).toBe('1')
    const response = await page.goto(mapUrl(w, `?topic=${w.topics.Probing}`))
    const html = (await response?.text()) ?? ''
    expect(html, 'the first HTML holds the list').toContain('Open addressing')
    expect(html, 'and no picture').not.toContain('scrolls sideways')
    await settled(page)
    // No redirect: the address stays as it was, with its topic, and the idea of that topic is open.
    expect(new URL(page.url()).searchParams.get('topic')).toBe(w.topics.Probing)
    expect(new URL(page.url()).searchParams.get('view')).toBeNull()
    // The idea of the topic is open in the phone's bottom sheet; the list is behind it.
    await expect(page.getByRole('radio', { name: 'List view', includeHidden: true })).toBeChecked()
    await expect(page.getByTestId('node-panel').getByRole('heading', { level: 2, name: 'Open addressing' })).toBeVisible()
    await page.getByRole('dialog').getByRole('link', { name: 'Back to the list' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('radio', { name: 'Map', exact: true }).click()
    await expect(page).toHaveURL(/view=map/)
    // A wide window gets the map without a view in the address.
    await page.setViewportSize({ width: 1024, height: 800 })
    await expect.poll(async () => (await page.context().cookies()).find((cookie) => cookie.name === 'margins_narrow')?.value).toBe('0')
    const wide = await page.goto(mapUrl(w, `?topic=${w.topics.Probing}`))
    expect((await wide?.text()) ?? '').toContain('scrolls sideways')
  })

  test('a first visit (no width cookie yet) holds both views and the window picks the list, so the map is never seen', async ({ page, context }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-phone-first')
    // A browser that has never told the server its width: the cookie is gone before the page is asked for.
    await context.clearCookies({ name: 'margins_narrow' })
    const response = await page.goto(mapUrl(w, `?unit=${w.units.Hashing}`), { waitUntil: 'commit' })
    const html = (await response?.text()) ?? ''
    expect(html, 'both views are in the first HTML').toContain('scrolls sideways')
    expect(html).toContain('Hash tables')
    // The picture is hidden by the window's width from the first paint; the list is what shows.
    await expect(page.getByRole('heading', { level: 3, name: 'Hash tables' })).toBeVisible()
    await expect(page.locator('svg [data-node-link], svg a[data-node-link]').first()).toBeHidden()
    // Once the browser has told the server, the page is read again with the list chosen on the server.
    await expect.poll(async () => (await context.cookies()).find((cookie) => cookie.name === 'margins_narrow')?.value).toBe('1')
    await expect(page.getByRole('radio', { name: 'List view' })).toBeChecked()
    await expect(page.locator('svg [data-node-link]')).toHaveCount(0)
  })

  test('opens on the list, keeps a chosen map labelled and scrollable, and moves focus to the panel', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-phone')
    // No view in the address: under 480px the list comes first (a first-ever visit, before the cookie, is put right by the page itself).
    await page.goto(mapUrl(w, `?unit=${w.units.Hashing}`))
    await expect(page.getByRole('radio', { name: 'List view' })).toBeChecked()
    await expect(page.getByRole('heading', { level: 3, name: 'Hash tables' })).toBeVisible()

    // The map is one choice away, and it stays: the picture says how to move it and is a focusable region.
    await page.getByRole('radio', { name: 'Map', exact: true }).click()
    await expect(page).toHaveURL(/view=map/)
    await settled(page)
    await expect(page.getByText('Scroll sideways, or use List view.')).toBeVisible()
    const frame = page.getByRole('region', { name: /^Hashing: 4 ideas, scrolls sideways$/ })
    await expect(frame).toHaveAttribute('tabindex', '0')
    await expect(page.locator('svg g[aria-hidden="true"]')).toHaveCount(1)

    // The panel is below the fold on a phone, so activating a node moves focus to it.
    await nodeLink(page, 'Collisions').click()
    await expect(page.getByTestId('node-panel').getByRole('heading', { level: 2, name: 'Collisions' })).toBeFocused()
    await expectNoAxeViolations(page, 'map on a phone with panel')
  })
})

test.describe('knowledge map on a wide window with a phone-width cookie left over', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('opens on the map and puts the cookie right', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-stale-narrow')
    const cookie = async () => (await page.context().cookies()).find((entry) => entry.name === 'margins_narrow')?.value
    // The window was phone width when the cookie was written, so the server's first answer is the list.
    await page.context().addCookies([{ name: 'margins_narrow', value: '1', url: new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000').origin }])
    const response = await page.goto(mapUrl(w, `?unit=${w.units.Hashing}`))
    expect((await response?.text()) ?? '', 'the server went by the cookie').not.toContain('scrolls sideways')
    await expect(page.getByRole('radio', { name: 'Map', exact: true })).toBeChecked()
    await settled(page)
    await expect.poll(cookie).toBe('0')
    // Put right without choosing anything: the address names no view.
    expect(new URL(page.url()).searchParams.get('view')).toBeNull()
    expect(new URL(page.url()).searchParams.get('unit')).toBe(w.units.Hashing)
  })
})

test.describe('round 4: edges, repeated names, one status per row', () => {
  test('a suggested link is dashed at full contrast, a confirmed one solid; the key shows both', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-dashed')
    await link(w.courseId, w.concepts['Open addressing'], w.concepts.Chaining, 'prerequisite', 'proposed', 0.8)
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&view=map`))
    const unit = page.getByRole('group', { name: /^Hashing: 4 ideas$/ })
    const suggested = unit.locator('path', { has: page.locator('title', { hasText: '(suggested)' }) })
    await expect(suggested).toHaveAttribute('stroke-dasharray', '6 4')
    await expect(suggested).toHaveClass(/stroke-edge-suggested/)
    const confirmed = unit.locator('path', { has: page.locator('title', { hasText: 'Collisions needs Hash function' }) })
    await expect(confirmed).not.toHaveAttribute('stroke-dasharray', /./)
    await expect(confirmed).toHaveClass(/stroke-edge-confirmed/)
    const key = page.locator('details').filter({ has: page.getByText('Key', { exact: true }) })
    if (!(await key.evaluate((element) => (element as HTMLDetailsElement).open))) await key.getByText('Key', { exact: true }).click()
    await expect(key.getByText('Dashed: suggested, not confirmed')).toBeVisible()
    await expect(key.getByText(/Two different things/)).toBeVisible()
  })

  test('an idea name that occurs in two topics names its topic in the picture', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-dupe')
    await withPrisma((prisma) =>
      prisma.concept.create({
        data: { projectId: w.courseId, topicId: w.topics.Probing, name: 'Collisions', summary: 'Collisions again.', kind: 'concept', orderIndex: 1, objectiveIndexes: [] },
      })
    )
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&view=map`))
    const unit = page.getByRole('group', { name: /^Hashing: 5 ideas$/ })
    // Only the repeated name names its topic (once in each topic); the other ideas stay as they were.
    await expect(unit.locator('text', { hasText: 'Hash tables' })).toHaveCount(1)
    await expect(unit.locator('text', { hasText: 'Probing' })).toHaveCount(1)
  })

  test('the panel says why an idea is ready, and a list row carries one status', async ({ page }) => {
    test.setTimeout(90_000)
    const w = await world(page, 'map-reason')
    await link(w.courseId, w.concepts['Open addressing'], w.concepts.Chaining, 'prerequisite', 'proposed', 0.8)
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts.Chaining}&view=list`))
    const panel = page.getByTestId('node-panel')
    await expect(panel).toContainText('Builds on Open addressing (suggested connection, not confirmed)')
    await open(page, mapUrl(w, `?unit=${w.units.Hashing}&node=${w.concepts['Open addressing']}&view=list`))
    await expect(page.getByTestId('node-panel')).toContainText('No prerequisites: start here')
  })
})
