import { expect, type Page } from '@playwright/test'
import { screenshotIfAsked } from './axe'
import { withPrisma } from './db'
import { addContent, createCourse, setZoneCookie, signUpAndIn } from './loop'

/** Helpers for the sessions specs (v3.1 workstream S): quiz drafts, results, review, short sessions, triage. */

export type Seeded = { email: string; courseId: string; topics: Record<string, string>; concepts: Record<string, string> }

/** A true/false question (the key is true) that tests the given concepts. */
export const trueFalse = (text: string, conceptIds: string[], extra: Record<string, unknown> = {}) => ({
  question_type: 'true_false',
  question_text: text,
  correct_answer: true,
  explanation: `${text} It is true.`,
  points: 1,
  difficulty: 'medium',
  concepts_tested: [],
  concept_ids: conceptIds,
  ...extra,
})

/** A multiple-choice question with a known key (A) and a wrong option that names its wrong idea. */
export const choice = (text: string, conceptIds: string[]) => ({
  question_type: 'multiple_choice',
  question_text: text,
  options: [
    { id: 'A', text: 'The right one' },
    { id: 'B', text: 'A plausible one', misconception: 'thinking B is right' },
    { id: 'C', text: 'Another one' },
    { id: 'D', text: 'The last one' },
  ],
  correct_answer: 'A',
  explanation: `${text} It is A.`,
  points: 1,
  difficulty: 'medium',
  concept_ids: conceptIds,
})

/** A short-answer question (graded by the model). */
export const shortAnswer = (text: string, conceptIds: string[]) => ({
  question_type: 'short_answer',
  question_text: text,
  sample_answer: 'The sample answer.',
  key_points: ['the sample answer'],
  points: 2,
  difficulty: 'medium',
  concept_ids: conceptIds,
})

/**
 * Concepts for a topic, with the first claim of each on a chunk so a pointer has a page. A topic uses its
 * concepts once its history is converted, so the switch is set too.
 */
export async function seedConcepts(topicId: string, names: string[], options: { pages?: boolean } = {}): Promise<Record<string, string>> {
  return withPrisma(async (prisma) => {
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { projectId: true } })
    const ids: Record<string, string> = {}
    for (const [index, name] of names.entries()) {
      const concept = await prisma.concept.create({
        data: { projectId: topic.projectId, topicId, name, summary: `${name}.`, kind: 'concept', orderIndex: index, objectiveIndexes: [] },
      })
      ids[name] = concept.id
      if (options.pages !== false) {
        const material = await prisma.material.findFirstOrThrow({ where: { projectId: topic.projectId }, select: { id: true } })
        await prisma.conceptClaim.create({
          data: {
            conceptId: concept.id,
            text: `${name} is explained here.`,
            quote: `${name} is explained here.`,
            materialId: material.id,
            chunkId: `chunk-${concept.id.slice(0, 8)}`,
            pageStart: 10 + index,
            pageEnd: 10 + index,
            orderIndex: 0,
          },
        })
      }
    }
    await prisma.topic.update({ where: { id: topicId }, data: { evidenceBackfilledAt: new Date() } })
    return ids
  })
}

/** Sets topic progress fields (read, recall, warm-up, tested-out, triage) for a user. */
export async function setProgress(
  email: string,
  topicId: string,
  data: { warmupAt?: Date; readAt?: Date; recallAt?: Date; testedOutAt?: Date; triage?: string; quizScore?: number }
) {
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    await prisma.topicProgress.upsert({
      where: { topicId_userId: { topicId, userId: user.id } },
      create: { topicId, userId: user.id, ...data },
      update: data,
    })
  })
}

/**
 * A fresh account with one course whose topics have notes, a standard quiz set of the given questions, and the
 * given concepts. Returns the quiz set id of each topic.
 */
export async function world(
  page: Page,
  label: string,
  topics: { name: string; concepts?: string[]; quiz?: object[] }[],
  options: { own?: boolean } = {}
): Promise<Seeded & { sets: Record<string, string> }> {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, label, { own: options.own ?? true })
  const course = await createCourse(page, `Sessions ${label} ${Date.now()}`, topics.map((topic) => ({ name: topic.name })))
  const concepts: Record<string, string> = {}
  const sets: Record<string, string> = {}
  for (const topic of topics) {
    const topicId = course.topics[topic.name]
    await addContent(topicId, { section_notes: '# Notes\n\nSome notes to read.\n\n## Part\n\nMore.' })
    if (topic.concepts?.length) Object.assign(concepts, await seedConcepts(topicId, topic.concepts))
    if (topic.quiz) {
      sets[topic.name] = await withPrisma(async (prisma) => (await prisma.topicQuiz.create({ data: { topicId, questions: topic.quiz as object[] } })).id)
    }
  }
  return { email, courseId: course.courseId, topics: course.topics, concepts, sets }
}

/** The number of questions in the quiz that show "answered". */
export async function answeredChips(page: Page): Promise<number> {
  return page.getByRole('button', { name: /^Question \d+, answered$/ }).count()
}

/** Answers question `index` (1-based, already on screen) with the option and moves on. */
export async function pick(page: Page, name: string | RegExp) {
  await page.getByRole('radio', { name }).first().click()
}

export async function expectNoLeftoverDialog(page: Page) {
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** A claim on a page for a concept, so a pointer to it names the page. */
export async function addClaim(conceptId: string, projectId: string, page: number) {
  await withPrisma(async (prisma) => {
    const material = await prisma.material.findFirstOrThrow({ where: { projectId }, select: { id: true } })
    await prisma.conceptClaim.create({
      data: {
        conceptId,
        text: 'It is explained here.',
        quote: 'It is explained here.',
        materialId: material.id,
        chunkId: `chunk-${conceptId.slice(0, 8)}`,
        pageStart: page,
        pageEnd: page,
        orderIndex: 0,
      },
    })
  })
}

/**
 * Screenshots at a chosen size: SCREENS_SIZE=1440x900 (or 390x844) sets the viewport before each test, and `shot` names the
 * file with it. Without SCREENS_SIZE the specs run at the default size and `shot` names the file 'default'.
 */
export async function applyScreenSize(page: Page) {
  const size = process.env.SCREENS_SIZE
  if (!size) return
  const [width, height] = size.split('x').map(Number)
  await page.setViewportSize({ width, height })
}

export async function shot(page: Page, name: string) {
  await screenshotIfAsked(page, `${name}-${process.env.SCREENS_SIZE ?? 'default'}`)
}
