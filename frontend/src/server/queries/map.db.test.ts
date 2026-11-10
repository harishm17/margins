/**
 * The unit map's data (spec §9, D15), against a real, migrated Postgres (DATABASE_URL).
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let map: typeof import('./map')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  map = await import('./map')
  available = await prisma.$queryRaw`SELECT 1 FROM concept_edges LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (!prisma) return
  if (available && userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

const dbTest = (name: string, run: () => Promise<void>) =>
  test(name, async (t) => {
    if (!available) return t.skip('no migrated test database')
    await run()
  })

const NOW = new Date('2026-11-10T20:00:00Z')

async function world() {
  const user = await prisma.user.create({ data: { email: `map-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const unit = await prisma.unit.create({ data: { projectId: project.id, title: 'U', orderIndex: 0 } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, unitId: unit.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  let index = 0
  const concept = (name: string, topicId = topic.id) =>
    prisma.concept.create({ data: { projectId: project.id, topicId, name, summary: 's', kind: 'concept', orderIndex: index++ } })
  const link = (sourceId: string, targetId: string, type: string, status: string, confidence: number) =>
    prisma.conceptEdge.create({ data: { projectId: project.id, sourceId, targetId, type, weight: 1, confidence, status } })
  return { user, project, unit, topic, concept, link }
}

dbTest('someone else, or another course, gets an empty map', async () => {
  const w = await world()
  await w.concept('A')
  const other = await world()
  assert.deepEqual(await map.getUnitMap(other.user.id, w.project.id, w.unit.id, NOW), { nodes: [], edges: [] })
  assert.deepEqual(await map.getUnitMap(w.user.id, other.project.id, w.unit.id, NOW), { nodes: [], edges: [] })
})

dbTest('edges show when confirmed or proposed at 0.6 or more, and a rejected edge never shows', async () => {
  const w = await world()
  const [a, b, c, d, e] = [await w.concept('A'), await w.concept('B'), await w.concept('C'), await w.concept('D'), await w.concept('E')]
  const confirmedLow = await w.link(a.id, b.id, 'prerequisite', 'confirmed', 0.1)
  const proposedAt = await w.link(b.id, c.id, 'prerequisite', 'proposed', 0.6)
  await w.link(c.id, d.id, 'prerequisite', 'proposed', 0.59)
  await w.link(d.id, e.id, 'prerequisite', 'rejected', 0.99)
  const twin = await w.link(a.id, e.id, 'confusable', 'proposed', 0.8)

  const result = await map.getUnitMap(w.user.id, w.project.id, w.unit.id, NOW)
  assert.deepEqual(result.edges.map((x) => x.id).sort(), [confirmedLow.id, proposedAt.id, twin.id].sort())
  assert.deepEqual(result.nodes.map((n) => n.name), ['A', 'B', 'C', 'D', 'E'])
})

dbTest('edges to concepts outside the unit are not returned', async () => {
  const w = await world()
  const otherUnit = await prisma.unit.create({ data: { projectId: w.project.id, title: 'V', orderIndex: 1 } })
  const otherTopic = await prisma.topic.create({ data: { projectId: w.project.id, unitId: otherUnit.id, name: 'T2', orderIndex: 1, userConfirmed: true } })
  const a = await w.concept('A')
  const outside = await w.concept('Z', otherTopic.id)
  await w.link(outside.id, a.id, 'prerequisite', 'confirmed', 1)
  const result = await map.getUnitMap(w.user.id, w.project.id, w.unit.id, NOW)
  assert.deepEqual(result.nodes.map((n) => n.id), [a.id])
  assert.deepEqual(result.edges, [])
  // The earlier unit's prerequisite is untouched (retrievability 0), so A is not on the frontier yet.
  assert.equal(result.nodes[0].frontier, false)
})

dbTest('the frontier follows the prerequisite retrievability the rest of the app computes', async () => {
  const { createEmptyCard, fsrs, generatorParameters, Rating } = await import('ts-fsrs')
  const { FSRS_PARAMS } = await import('@/lib/learning/memory')
  const scheduler = fsrs(generatorParameters(FSRS_PARAMS))
  const w = await world()
  const a = await w.concept('A')
  const b = await w.concept('B')
  await w.link(a.id, b.id, 'prerequisite', 'confirmed', 1)
  const reviewedAt = new Date('2026-11-09T20:00:00Z')
  const card = scheduler.next(createEmptyCard(reviewedAt), reviewedAt, Rating.Good).card
  await prisma.conceptMemory.create({
    data: {
      userId: w.user.id,
      projectId: w.project.id,
      topicId: w.topic.id,
      conceptId: a.id,
      card: JSON.parse(JSON.stringify(card)),
      dueAt: card.due,
      stability: card.stability,
      lastReviewAt: reviewedAt,
      nUnassisted: 1,
      lastEvidenceAt: reviewedAt,
      derived: { level0Scores: [{ score: 1, at: reviewedAt.toISOString() }] },
    },
  })
  const fresh = await map.getUnitMap(w.user.id, w.project.id, w.unit.id, NOW)
  const nodeA = fresh.nodes.find((n) => n.id === a.id)!
  assert.ok(nodeA.retrievability > 0.8 && nodeA.retrievability <= 1)
  assert.equal(nodeA.dueAt, card.due.toISOString())
  assert.equal(nodeA.frontier, true) // one rating: capped, never solid
  assert.equal(fresh.nodes.find((n) => n.id === b.id)?.frontier, true)

  const later = await map.getUnitMap(w.user.id, w.project.id, w.unit.id, new Date('2027-03-01T00:00:00Z'))
  assert.ok(later.nodes.find((n) => n.id === a.id)!.retrievability < 0.8)
  assert.equal(later.nodes.find((n) => n.id === b.id)?.frontier, false)
})

dbTest('topics without a unit are a unit of their own, and units list only where there are concepts', async () => {
  const w = await world()
  await w.concept('A')
  const bare = await prisma.unit.create({ data: { projectId: w.project.id, title: 'Bare', orderIndex: 1 } })
  await prisma.topic.create({ data: { projectId: w.project.id, unitId: bare.id, name: 'Empty', orderIndex: 1, userConfirmed: true } })
  const loose = await prisma.topic.create({ data: { projectId: w.project.id, name: 'Loose', orderIndex: 2, userConfirmed: true } })
  const c = await w.concept('C', loose.id)
  assert.deepEqual(await map.listMapUnits(w.user.id, w.project.id), [
    { id: w.unit.id, title: 'U', weekLabel: null, conceptCount: 1 },
    { id: null, title: 'Other topics', weekLabel: null, conceptCount: 1 },
  ])
  const looseMap = await map.getUnitMap(w.user.id, w.project.id, null, NOW)
  assert.deepEqual(looseMap.nodes.map((n) => n.id), [c.id])
  assert.equal(looseMap.nodes[0].topicName, 'Loose')
  assert.deepEqual(await map.listMapUnits('someone-else', w.project.id), [])
})

dbTest('the panel has the summary, claims, state, last five events and the links of a concept', async () => {
  const w = await world()
  const a = await w.concept('A')
  const b = await w.concept('B')
  const c = await w.concept('C')
  const material = await prisma.material.create({ data: { projectId: w.project.id, category: 'lecture_notes', filename: 'notes.pdf', gcsPath: 'x', sizeBytes: 1 } })
  await prisma.conceptClaim.create({ data: { conceptId: a.id, text: 'A is true', quote: 'A is true.', materialId: material.id, pageStart: 3, pageEnd: 4, orderIndex: 0 } })
  const needed = await w.link(b.id, a.id, 'prerequisite', 'proposed', 0.8)
  const covers = await w.link(a.id, c.id, 'encompasses', 'confirmed', 1)
  await w.link(b.id, c.id, 'prerequisite', 'proposed', 0.3) // not shown, and not A's
  for (let i = 0; i < 7; i++) {
    await prisma.evidenceEvent.create({
      data: {
        userId: w.user.id,
        projectId: w.project.id,
        topicId: w.topic.id,
        conceptId: a.id,
        itemKey: 'k' + i,
        source: i === 6 ? 'drill' : 'quiz',
        score: i / 10,
        assistance: i === 6 ? 2 : 0,
        weight: 1,
        role: 'primary',
        gradedBy: 'rule',
        sessionKey: 's' + i,
        createdAt: new Date(NOW.getTime() - (10 - i) * 60_000),
      },
    })
  }
  const panel = await map.getConceptPanel(w.user.id, w.project.id, a.id, NOW)
  assert.ok(panel)
  assert.equal(panel.name, 'A')
  assert.equal(panel.summary, 's')
  assert.equal(panel.topicName, 'T')
  assert.equal(panel.unitId, w.unit.id)
  assert.equal(panel.label, 'not_started')
  assert.deepEqual(panel.claims.map((x) => [x.text, x.filename, x.pageStart, x.pageEnd]), [['A is true', 'notes.pdf', 3, 4]])
  assert.equal(panel.events.length, 5)
  assert.deepEqual(panel.events.map((e) => e.source), ['drill', 'quiz', 'quiz', 'quiz', 'quiz'])
  assert.deepEqual([panel.events[0].assisted, panel.events[1].assisted], [true, false])
  assert.deepEqual(
    panel.links.map((l) => [l.edgeId, l.kind, l.status, l.otherName]).sort(),
    [
      [covers.id, 'covers', 'confirmed', 'C'],
      [needed.id, 'needs', 'proposed', 'B'],
    ].sort()
  )
})

dbTest("the panel is empty for someone else's concept or a removed one", async () => {
  const w = await world()
  const a = await w.concept('A')
  const other = await world()
  assert.equal(await map.getConceptPanel(other.user.id, w.project.id, a.id, NOW), null)
  await prisma.concept.update({ where: { id: a.id }, data: { status: 'removed' } })
  assert.equal(await map.getConceptPanel(w.user.id, w.project.id, a.id, NOW), null)
})

// ------------------------------------------------------------------------------------------ read first after a miss (spec 18.5)

async function failed(w: Awaited<ReturnType<typeof world>>, conceptId: string, at: Date) {
  const { recordEvidence } = await import('@/lib/learning/evidence')
  await recordEvidence(
    [{ userId: w.user.id, projectId: w.project.id, topicId: w.topic.id, itemKey: `quiz:f${at.getTime()}:0`, conceptIds: [conceptId], source: 'quiz', score: 0, assistance: 0, gradedBy: 'rule', sessionKey: `f${at.getTime()}`, at }],
    { timeZone: 'UTC' }
  )
}

dbTest('map node needing instruction leads with reading', async () => {
  const w = await world()
  const a = await w.concept('A')
  const b = await w.concept('B')
  const material = await prisma.material.create({ data: { projectId: w.project.id, category: 'lecture_notes', filename: 'notes.pdf', gcsPath: 'x', sizeBytes: 1 } })
  const chunk = await prisma.materialChunk.create({ data: { materialId: material.id, chunkText: 'text', chunkIndex: 0, pageStart: 7, pageEnd: 7 } })
  await prisma.conceptClaim.create({ data: { conceptId: a.id, text: 'A is true', quote: 'A is true.', materialId: material.id, chunkId: chunk.id, pageStart: 7, pageEnd: 7, orderIndex: 0 } })
  await prisma.conceptClaim.create({ data: { conceptId: a.id, text: 'A again', quote: 'A again.', materialId: material.id, pageStart: 9, pageEnd: 9, orderIndex: 1 } })
  await failed(w, a.id, new Date(NOW.getTime() - 3_600_000))

  const unit = await map.getUnitMap(w.user.id, w.project.id, w.unit.id, NOW)
  const nodeA = unit.nodes.find((n) => n.id === a.id)
  const nodeB = unit.nodes.find((n) => n.id === b.id)
  assert.equal(nodeA?.needsInstruction, true)
  assert.equal(nodeA?.pointer?.page, 7)
  assert.equal(nodeA?.pointer?.href, `/courses/${w.project.id}/topics/${w.topic.id}?view=read&focus=${a.id}#chunk-${chunk.id}`)
  assert.equal(nodeB?.needsInstruction, false)
  assert.equal(nodeB?.pointer, null)

  const panel = await map.getConceptPanel(w.user.id, w.project.id, a.id, NOW)
  assert.equal(panel?.needsInstruction, true)
  assert.equal(panel?.pointer?.page, 7)
  assert.equal(panel?.pointer?.href, nodeA?.pointer?.href)
  assert.equal((await map.getConceptPanel(w.user.id, w.project.id, b.id, NOW))?.needsInstruction, false)

  // Opening the pointer is the instruction: the panel no longer leads with reading, and its events never list the instruction row.
  const { recordInstruction } = await import('@/lib/learning/instruction-server')
  assert.equal((await recordInstruction(prisma, { userId: w.user.id, topicId: w.topic.id, kind: 'pointer', conceptIds: [a.id], ref: a.id, timeZone: 'UTC', at: new Date(NOW.getTime() - 60_000) })).status, 'recorded')
  const after = await map.getConceptPanel(w.user.id, w.project.id, a.id, NOW)
  assert.equal(after?.needsInstruction, false)
  assert.equal(after?.pointer, null)
  assert.ok(after?.events.length)
  assert.ok(after?.events.every((e) => e.source !== 'instruction'))
  assert.equal((await map.getUnitMap(w.user.id, w.project.id, w.unit.id, NOW)).nodes.find((n) => n.id === a.id)?.needsInstruction, false)
})

dbTest('merged and removed concepts are not nodes; an unstarted concept has no due date', async () => {
  const w = await world()
  const a = await w.concept('A')
  const gone = await w.concept('Gone')
  await prisma.concept.update({ where: { id: gone.id }, data: { status: 'merged', mergedIntoId: a.id } })
  const result = await map.getUnitMap(w.user.id, w.project.id, w.unit.id, NOW)
  assert.equal(result.nodes.length, 1)
  assert.deepEqual(result.nodes[0], { id: a.id, name: 'A', topicId: w.topic.id, topicName: 'T', label: 'not_started', retrievability: 0, dueAt: null, frontier: true, needsInstruction: false, pointer: null })
})

dbTest('a rejected prerequisite does not hold the frontier back', async () => {
  const w = await world()
  const a = await w.concept('A')
  const b = await w.concept('B')
  const edge = await w.link(a.id, b.id, 'prerequisite', 'proposed', 0.9)
  let nodes = (await map.getUnitMap(w.user.id, w.project.id, w.unit.id, NOW)).nodes
  assert.equal(nodes.find((n) => n.id === b.id)?.frontier, false)
  await prisma.conceptEdge.update({ where: { id: edge.id }, data: { status: 'rejected', origin: 'student' } })
  nodes = (await map.getUnitMap(w.user.id, w.project.id, w.unit.id, NOW)).nodes
  assert.equal(nodes.find((n) => n.id === b.id)?.frontier, true)
})
