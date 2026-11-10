import { expect, type Page } from '@playwright/test'
import { withPrisma } from './db'

/** Helpers of tests/e2e/v31-tutors.spec.ts: Ask on the demo course, with concepts of its own that the other specs never see. */

export const composer = (page: Page) => page.getByLabel('Ask about your materials')
export const lastReply = (page: Page) => page.locator('article:not([aria-busy])').last()
export const settled = (page: Page) => expect(page.locator('article[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 })

// Ask allows ten questions a minute per student and these specs share one, so each message waits for room.
const sentAt: number[] = []
export async function say(page: Page, message: string) {
  await expect
    .poll(
      () => {
        const now = Date.now()
        while (sentAt.length > 0 && now - sentAt[0] > 60_000) sentAt.shift()
        return sentAt.length < 6
      },
      { intervals: [2_000], timeout: 120_000, message: 'room for another message under the per-minute limit' }
    )
    .toBe(true)
  sentAt.push(Date.now())
  await composer(page).fill(message)
  await page.keyboard.press('Enter')
}

// ---------------------------------------------------------------------------------------------------------
// The reader: a topic of its own with one PDF of four passages and a concept with a claim on the third.

const SHARED_1 = 'Two keys that land in the same bucket collide, and the table must decide where the second one goes.'
const SHARED_2 = 'Chaining keeps every colliding entry in a list that hangs off the bucket, so a lookup walks that list.'

export async function seedTutorReading(topicId: string) {
  return withPrisma(async (prisma) => {
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { projectId: true } })
    const material = await prisma.material.create({
      data: { projectId: topic.projectId, category: 'lecture_notes', filename: 'hashing.pdf', gcsPath: `e2e/${topicId}/hashing.pdf`, sizeBytes: BigInt(10), validationStatus: 'valid' },
    })
    const texts = [
      `# Hashing\n\nA hash function maps a key to a bucket index. ${SHARED_1}`,
      `${SHARED_1} Open addressing probes for the next free bucket.`,
      `## Chaining\n\n${SHARED_2} The load factor is the number of entries over the number of buckets.`,
      '## Resizing\n\nWhen the load factor grows, the table is rebuilt with more buckets.',
    ]
    const headings = ['Hashing', 'Hashing', 'Chaining', 'Resizing']
    const chunkIds: string[] = []
    for (const [index, chunkText] of texts.entries()) {
      const chunk = await prisma.materialChunk.create({
        data: { materialId: material.id, chunkText, chunkIndex: index, pageStart: index < 2 ? 3 : 4 + index, pageEnd: index < 2 ? 3 : 4 + index, sectionHierarchy: headings[index] },
        select: { id: true },
      })
      chunkIds.push(chunk.id)
    }
    await prisma.topicSource.create({ data: { topicId, materialId: material.id, chunkIndexStart: 0, chunkIndexEnd: 3, role: 'primary' } })
    const concept = await prisma.concept.create({
      data: { projectId: topic.projectId, topicId, name: 'Chaining', summary: 'Chaining.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] },
      select: { id: true },
    })
    await prisma.conceptClaim.create({
      data: { conceptId: concept.id, text: 'Chaining claim.', quote: SHARED_2, materialId: material.id, chunkId: chunkIds[2], pageStart: 6, orderIndex: 0 },
    })
    await prisma.topic.update({ where: { id: topicId }, data: { evidenceBackfilledAt: new Date() } })
    return { chunkIds, conceptId: concept.id }
  })
}
