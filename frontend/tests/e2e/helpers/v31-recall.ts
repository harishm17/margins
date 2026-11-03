import type { Page } from '@playwright/test'
import { withPrisma } from './db'
import { addContent, createCourse, setZoneCookie, signUpAndIn } from './loop'

// Shared by tests/e2e/v31-recall.spec.ts: a student whose topic is read from a file of four chunks, with three
// concepts (a claim each, tied to a chunk and a page), recall prompts for two objectives, and a warm-up bank.

export const PROMPT_0 = 'Explain how a hash table handles keys that share a bucket.'
export const PROMPT_1 = 'Explain what the load factor tells you.'
export const ANSWER = 'A hash table sends each key to a bucket and keeps a list in the bucket when two keys land together, which is how it avoids losing a key.'

const SHARED_1 = 'Two keys that hash to the same bucket are said to collide.'
const SHARED_2 = 'Chaining keeps a list of entries in each bucket so that colliding keys are both kept.'

/** Enough lines that the later passages and sections are below the fold, so a scroll to them can be seen. */
const FILLER = Array.from({ length: 14 }, (_, n) => `Paragraph ${n + 1} of the discussion goes on about tables, keys and the way a program looks a value up again.`).join('\n\n')
const LONG_NOTES = ['Hash function', 'Collision', 'Load factor'].map((name) => `## ${name}\n\n${FILLER}`).join('\n\n')

/** Pages the three concepts' claims sit on (Hash function, Collision, Load factor). */
export const CLAIM_PAGES = [3, 5, 6]

export type RecallWorld = Awaited<ReturnType<typeof recallWorld>>

/** A signed-in student with a course whose one topic is read from a file, with concepts, claims, recall prompts and a warm-up bank. */
export async function recallWorld(page: Page, label: string, options: { recallAt?: boolean; warmup?: boolean; readAt?: boolean } = {}) {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, label, { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Recall v31 ${Date.now()}`, [{ name: 'Hash tables' }])
  const topicId = course.topics['Hash tables']
  await addContent(topicId, { section_notes: `# Notes\n\nSome notes to read.\n\n${LONG_NOTES}` })
  const seeded = await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const material = await prisma.material.create({
      data: { projectId: course.courseId, category: 'lecture_notes', filename: 'hashing.pdf', gcsPath: `e2e/${topicId}/hashing.pdf`, sizeBytes: BigInt(10), validationStatus: 'valid' },
    })
    const texts = [
      `# Hashing\n\nA hash function maps a key to a bucket index. ${SHARED_1}\n\n${FILLER}`,
      `## Collisions\n\nOpen addressing probes for the next free bucket.\n\n${FILLER}`,
      `## Chaining\n\n${SHARED_2}\n\n${FILLER}`,
      '## Resizing\n\nThe load factor is the number of entries over the number of buckets. When it grows, the table is rebuilt with more buckets.',
    ]
    const chunkIds: string[] = []
    for (const [index, chunkText] of texts.entries()) {
      const chunk = await prisma.materialChunk.create({
        data: { materialId: material.id, chunkText, chunkIndex: index, pageStart: [3, 4, 5, 6][index], pageEnd: [3, 4, 5, 6][index], sectionHierarchy: ['Hashing', 'Collisions', 'Chaining', 'Resizing'][index] },
        select: { id: true },
      })
      chunkIds.push(chunk.id)
    }
    await prisma.topicSource.create({ data: { topicId, materialId: material.id, chunkIndexStart: 0, chunkIndexEnd: 3, role: 'primary' } })
    // Objective 0: Hash function (one claim), Collision (two). Objective 1: Load factor (one).
    const specs = [
      { name: 'Hash function', objectives: [0], claims: [{ text: 'A hash function maps a key to a bucket index.', chunk: 0 }] },
      { name: 'Collision', objectives: [0], claims: [{ text: 'A collision is two keys that land in one bucket.', chunk: 1 }, { text: 'Chaining keeps a list of entries per bucket.', chunk: 2 }] },
      { name: 'Load factor', objectives: [1], claims: [{ text: 'The load factor is entries divided by buckets.', chunk: 3 }] },
    ]
    const conceptIds: string[] = []
    for (const [orderIndex, spec] of specs.entries()) {
      const concept = await prisma.concept.create({
        data: { projectId: course.courseId, topicId, name: spec.name, summary: `${spec.name}.`, kind: 'concept', orderIndex, objectiveIndexes: spec.objectives },
        select: { id: true },
      })
      conceptIds.push(concept.id)
      for (const [n, claim] of spec.claims.entries()) {
        await prisma.conceptClaim.create({
          data: { conceptId: concept.id, text: claim.text, quote: `Page text for: ${claim.text}`, materialId: material.id, chunkId: chunkIds[claim.chunk], orderIndex: n, pageStart: CLAIM_PAGES[orderIndex] },
        })
      }
    }
    await prisma.topic.update({ where: { id: topicId }, data: { evidenceBackfilledAt: new Date() } })
    await prisma.topicContent.create({
      data: {
        topicId,
        contentType: 'concept_prompts',
        contentData: {
          focus_questions: [],
          recall_prompts: [
            { objective_index: 0, prompt: PROMPT_0 },
            { objective_index: 1, prompt: PROMPT_1 },
          ],
        },
      },
    })
    if (options.warmup) {
      const levels = ['easy', 'easy', 'medium', 'medium', 'hard']
      await prisma.topicQuiz.create({
        data: {
          topicId,
          kind: 'warmup',
          questions: levels.map((difficulty, n) => ({
            question_type: 'multiple_choice',
            question_text: `Warm-up question ${n + 1} (${difficulty}): which statement about hashing is true?`,
            options: ['A', 'B', 'C', 'D'].map((id) => ({ id, text: `Option ${id} for question ${n + 1}`, ...(id === 'B' ? {} : { misconception: `Wrong idea ${id}` }) })),
            correct_answer: 'B',
            explanation: 'This explanation must not be shown before reading.',
            points: 1,
            difficulty,
            mode: 'recall',
            concept_ids: [conceptIds[n % 3]],
            sources: [{ material_id: material.id, filename: 'hashing.pdf', page_start: 3, page_end: 3 }],
          })),
        },
      })
    }
    const at = new Date(Date.now() - 3_600_000)
    const progress = { ...(options.warmup ? {} : { warmupAt: at }), ...(options.readAt === false ? {} : { readAt: at }), ...(options.recallAt ? { recallAt: at } : {}) }
    await prisma.topicProgress.upsert({ where: { topicId_userId: { topicId, userId: user.id } }, create: { topicId, userId: user.id, ...progress }, update: progress })
    return { userId: user.id, materialId: material.id, chunkIds, conceptIds }
  })
  const topicUrl = `/courses/${course.courseId}/topics/${topicId}`
  return { email, course, topicId, topicUrl, ...seeded }
}
