import { readFileSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { markAiAvailable, markAiUnavailable, withPrisma } from './helpers/db'
import { addContent, createCourse, quizQuestions, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { streamedPartsArrived } from './helpers/settle'
import { chooseConfidence } from './helpers/confidence'
import { signIn } from './helpers/auth'
import { FIXTURE_PDF } from './helpers/seed-demo'

// The topic path (spec §5): Warm-up, Read, Recall, Practice, Quiz as a stepper, the tools beside it (in one
// menu on a phone), the topic opening on its next activity, the concept chips and the one-time card.
// Set SCREENS_DIR to keep screenshots at both sizes.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }

/** Concepts, a warm-up bank and progress, written straight into the database. */
async function seed(
  email: string,
  topicId: string,
  options: { concepts?: string[]; warmup?: boolean; warmupAt?: boolean; readAt?: boolean; recallAt?: boolean } = {}
) {
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { projectId: true } })
    for (const [index, name] of (options.concepts ?? []).entries()) {
      await prisma.concept.create({
        data: { projectId: topic.projectId, topicId, name, summary: `${name}.`, kind: 'concept', orderIndex: index, objectiveIndexes: [] },
      })
    }
    // A topic uses its concepts once its history is converted (the same switch mastery uses).
    if ((options.concepts ?? []).length > 0) await prisma.topic.update({ where: { id: topicId }, data: { evidenceBackfilledAt: new Date() } })
    if (options.warmup) {
      await prisma.topicQuiz.create({ data: { topicId, kind: 'warmup', questions: quizQuestions(5) } })
    }
    const at = new Date(Date.now() - 3_600_000)
    const data = {
      ...(options.warmupAt ? { warmupAt: at } : {}),
      ...(options.readAt ? { readAt: at } : {}),
      ...(options.recallAt ? { recallAt: at } : {}),
    }
    if (Object.keys(data).length > 0) {
      await prisma.topicProgress.upsert({
        where: { topicId_userId: { topicId, userId: user.id } },
        create: { topicId, userId: user.id, ...data },
        update: data,
      })
    }
  })
}

async function markIntroSeen(email: string) {
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
}

/** A course with the topics the specs need, notes written for each. */
async function world(page: Page, label: string, options: { ownAccount?: boolean; introSeen?: boolean } = {}) {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, label, { own: options.ownAccount ?? true })
  if (options.introSeen !== false) await markIntroSeen(email)
  const course = await createCourse(page, `Path ${Date.now()}`, [
    { name: 'Fresh topic' },
    { name: 'No warm-up topic' },
    { name: 'Legacy topic' },
    { name: 'Midway topic' },
  ])
  for (const id of Object.values(course.topics)) await addContent(id, { section_notes: '# Notes\n\nSome notes to read.\n\n## Part\n\nMore.' })
  await seed(email, course.topics['Fresh topic'], { concepts: ['Hash function', 'Collision'], warmup: true })
  await seed(email, course.topics['No warm-up topic'], { concepts: ['Queue'] })
  await seed(email, course.topics['Midway topic'], { concepts: ['Stack', 'Heap', 'Tree'], warmup: true, warmupAt: true, readAt: true })
  const topicUrl = (name: string) => `/courses/${course.courseId}/topics/${course.topics[name]}`
  return { email, course, topicUrl }
}

const pathNav = (page: Page) => page.getByRole('navigation', { name: 'Topic path' })

test('new topic opens on warm-up when ready else read', async ({ page }) => {
  const { topicUrl } = await world(page, 'tp-open')

  // Concepts and a warm-up bank: the warm-up first.
  await page.goto(topicUrl('Fresh topic'))
  await expect(page).toHaveURL(/\?view=warmup$/)
  await expect(pathNav(page).getByRole('link', { name: /Warm-up/ })).toHaveAttribute('aria-current', 'page')

  // Concepts but no bank (it failed, or has not run): straight to reading.
  await page.goto(topicUrl('No warm-up topic'))
  await expect(page).toHaveURL(/\?view=read$/)

  // A topic from before concepts keeps the old path: the notes first.
  await page.goto(topicUrl('Legacy topic'))
  await expect(page).toHaveURL(/\?view=read$/)
  await expect(page.getByRole('heading', { name: 'Part' })).toBeVisible()

  // "notes" was the first view before the path: old links and bookmarks land on Read.
  await page.goto(`${topicUrl('Legacy topic')}?view=notes`)
  await expect(pathNav(page).getByRole('link', { name: /Read/ })).toHaveAttribute('aria-current', 'page')
})

test('onboarding card shows once', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl } = await world(page, 'tp-intro', { introSeen: false })
  const card = page.getByRole('region', { name: 'Margins asks you to try before it helps.' })

  await page.goto(topicUrl('No warm-up topic'))
  await expect(card).toBeVisible()
  await screenshotIfAsked(page, 'topic-path-intro-1440x900')
  await expectNoAxeViolations(page, 'topic path with the one-time card')

  await card.getByRole('button', { name: 'Got it' }).click()
  await expect(card).toHaveCount(0)
  await expect
    .poll(() => withPrisma(async (prisma) => (await prisma.user.findUniqueOrThrow({ where: { email }, select: { seenEffortIntroAt: true } })).seenEffortIntroAt !== null))
    .toBe(true)

  // Closed for good: not on a reload, not on another topic.
  await page.reload()
  await expect(card).toHaveCount(0)
  await page.goto(topicUrl('Legacy topic'))
  await expect(page.getByRole('heading', { level: 1, name: 'Legacy topic' })).toBeVisible()
  await expect(card).toHaveCount(0)
})

test('a topic without concepts has no warm-up and no recall: Read, Practice, Quiz', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { topicUrl } = await world(page, 'tp-legacy')
  await page.goto(`${topicUrl('Legacy topic')}?view=read`)
  const nav = pathNav(page)
  await expect(nav.getByRole('link')).toHaveText([/Read/, /Practice/, /Quiz/, /Examples/, /Explainer/, /Voice/])
  await expect(page.getByRole('list', { name: 'Ideas in this topic' })).toHaveCount(0)
  // The addresses of the hidden steps still work, and go on to a step that does.
  await page.goto(`${topicUrl('Legacy topic')}?view=recall`)
  await expect(page).toHaveURL(/view=practice/)
  await page.goto(`${topicUrl('Legacy topic')}?view=warmup`)
  await expect(page).toHaveURL(/view=read/)
  // Number keys follow what is shown: 2 is Practice here.
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('2')
  await expect(page).toHaveURL(/view=practice/)
  await screenshotIfAsked(page, 'topic-path-legacy-1440x900')
  await expectNoAxeViolations(page, 'topic path, topic without concepts')

  // Concepts but no warm-up bank: Warm-up is not offered, Recall is.
  await page.goto(`${topicUrl('No warm-up topic')}?view=read`)
  await expect(nav.getByRole('link', { name: /Warm-up/ })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: /Recall/ })).toBeVisible()
})

// ---------------------------------------------------------------------------------------------------------
// The warm-up and the source reader (spec §5.1, §5.2).

const SHARED_1 = 'Two keys that land in the same bucket collide, and the table must decide where the second one goes.'
const SHARED_2 = 'Chaining keeps every colliding entry in a list that hangs off the bucket, so a lookup walks that list.'

/**
 * A topic read from one PDF of four chunks (chunks 0 and 1 overlap by a sentence, as the chunker makes them),
 * three concepts with a claim each, a focus question, and a warm-up bank of five multiple-choice questions
 * (the right answer is always the second option). `concepts: false` is a topic from before concepts.
 */
async function seedReading(topicId: string, options: { concepts?: boolean; warmup?: boolean } = {}) {
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

    const conceptIds: string[] = []
    if (options.concepts !== false) {
      for (const [orderIndex, spec] of [
        { name: 'Hash function', chunk: 0 },
        { name: 'Collision', chunk: 2 },
        { name: 'Resizing', chunk: 3 },
      ].entries()) {
        const concept = await prisma.concept.create({
          data: { projectId: topic.projectId, topicId, name: spec.name, summary: `${spec.name}.`, kind: 'concept', orderIndex, objectiveIndexes: [] },
          select: { id: true },
        })
        conceptIds.push(concept.id)
        await prisma.conceptClaim.create({
          data: { conceptId: concept.id, text: `${spec.name} claim.`, quote: [`A hash function maps a key to a bucket index.`, SHARED_2, 'the table is rebuilt with more buckets'][orderIndex], materialId: material.id, chunkId: chunkIds[spec.chunk], pageStart: 3, orderIndex: 0 },
        })
      }
      await prisma.topic.update({ where: { id: topicId }, data: { evidenceBackfilledAt: new Date() } })
      await prisma.topicContent.create({
        data: {
          topicId,
          contentType: 'concept_prompts',
          contentData: { focus_questions: [{ objective_index: 0, question: 'How are two keys in one bucket handled?', chunk_id: chunkIds[2] }], recall_prompts: [] },
        },
      })
    }
    if (options.warmup !== false && conceptIds.length > 0) {
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
    return { materialId: material.id, chunkIds, conceptIds }
  })
}

/** A signed-in student with a course whose topics are read from a file. */
async function readerWorld(page: Page, label: string, options: { concepts?: boolean; warmup?: boolean; topicName?: string } = {}) {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, label, { own: true })
  await markIntroSeen(email)
  const name = options.topicName ?? 'Hash tables'
  const course = await createCourse(page, `Reader ${Date.now()}`, [{ name }])
  const topicId = course.topics[name]
  const seeded = await seedReading(topicId, options)
  const topicUrl = `/courses/${course.courseId}/topics/${topicId}`
  return { email, course, topicId, topicUrl, ...seeded }
}

/** Answers the warm-up question on screen: the option at `choice` (0 is A) and a confidence word, then waits for the next screen. */
async function answerWarmup(page: Page, choice: number, confidence: string | null) {
  const title = (await page.getByRole('heading', { name: /^Warm-up question \d of 3$/ }).textContent()) ?? ''
  const number = Number(/(\d) of 3/.exec(title)?.[1])
  await page.getByRole('radio').nth(choice).click()
  if (confidence) await chooseConfidence(page, confidence)
  await page.getByRole('button', { name: /Next question|See answers/ }).click()
  // The next question (or the answers) replaces this one once the server has answered.
  if (number < 3) await expect(page.getByRole('heading', { name: `Warm-up question ${number + 1} of 3` })).toBeVisible()
  else await expect(page.getByRole('heading', { name: 'Ready to read' })).toBeVisible()
}

/** Opens the reader and waits for the passages' text (the markdown loads as its own chunk, behind a skeleton). */
async function openReader(page: Page, url: string) {
  await page.goto(url)
  // Until the streamed parts have arrived a hidden copy of each waits in the document, and the passages count twice.
  await streamedPartsArrived(page)
  await expect(page.locator('[data-passage]').first()).toBeVisible()
  await expect(page.locator('[data-passage] .md').first()).toBeVisible()
  const passages = await page.locator('[data-passage]').count()
  await expect(page.locator('[data-passage] .md')).toHaveCount(passages)
}

test.describe('the warm-up', () => {
  test('warm-up asks one question at a time with no feedback, then shows the answers and where to find them', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl } = await readerWorld(page, 'wu-flow')
    await page.goto(`${topicUrl}?view=warmup`)

    // Intro: skipping is allowed and sets nothing.
    await expect(page.getByRole('heading', { name: 'Try a few questions first' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Try a few questions first' }).getByRole('link', { name: 'Start reading' })).toHaveAttribute('href', /view=read$/)
    await screenshotIfAsked(page, 'e3-warmup-intro-1440x900')
    await page.getByRole('button', { name: 'Start warm-up' }).click()

    // The first question is medium; there is no hint and no feedback, and the key is not in the page.
    await expect(page.getByText(/\(medium\)/)).toBeVisible()
    await expect(page.getByText('Answers come at the end')).toBeVisible()
    await expect(page.getByText('This explanation must not be shown before reading.')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Next question' })).toBeDisabled()
    // Nothing is chosen until the student taps: no option and no confidence level is preselected.
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(0)
    await screenshotIfAsked(page, 'e3-warmup-untouched-1440x900')
    // The confidence is optional: an answer alone is enough to go on, and rating it still works.
    await page.getByRole('radio').nth(0).click()
    await expect(page.getByRole('button', { name: 'Next question' })).toBeEnabled()
    await chooseConfidence(page, 'Certain')
    await expect(page.getByRole('button', { name: 'Next question' })).toBeEnabled()
    await screenshotIfAsked(page, 'e3-warmup-question-1440x900')
    await expectNoAxeViolations(page, 'warm-up question, 1440')
    await page.getByRole('button', { name: 'Next question' }).click()

    // Wrong and sure: the next one is easy. Nothing said whether the first was right.
    await expect(page.getByRole('heading', { name: 'Warm-up question 2 of 3' })).toBeVisible()
    await expect(page.getByText(/\(easy\)/)).toBeVisible()
    await expect(page.getByText(/Not quite|Right/)).toHaveCount(0)
    await answerWarmup(page, 1, 'Unsure')
    await expect(page.getByRole('heading', { name: 'Warm-up question 3 of 3' })).toBeVisible()
    await answerWarmup(page, 1, 'Unsure')

    // The answers: what was right and wrong, the page to read, no explanation.
    await expect(page.getByRole('heading', { name: 'Ready to read' })).toBeVisible()
    // The last question is gone: the student lands on the results.
    await expect(page.getByRole('heading', { name: 'Ready to read' })).toBeFocused()
    // One way on, not two: the next-activity card does not repeat the button under the results.
    await expect(page.getByRole('region', { name: 'Next on this topic' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Start reading' })).toHaveCount(1)
    // A miss on a pretest is not drawn in the red of a failed test.
    await expect(page.locator('section[aria-labelledby="warmup-done-heading"] ol .text-danger')).toHaveCount(0)
    // A toast from the notes being written fades in and out; axe reads it mid-fade.
    await expect(page.getByText('Notes are ready')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText('2 of 3 questions right.')).toBeVisible()
    await expect(page.getByText('Not quite')).toHaveCount(1)
    await expect(page.getByText(/\. Right$/)).toHaveCount(2)
    await expect(page.getByText(/You'll find this on/).first()).toContainText('hashing.pdf, p. 3')
    await expect(page.getByText('This explanation must not be shown before reading.')).toHaveCount(0)
    await expect(page.getByText('Wrong idea A')).toHaveCount(0)
    // One concept was missed with confidence: its passage is marked in the reading, and the screen says how many.
    await expect(page.getByText(/passage in the reading is marked Focus here/)).toBeVisible()
    await screenshotIfAsked(page, 'e3-warmup-result-1440x900')
    await expectNoAxeViolations(page, 'warm-up result, 1440')

    // The path ticks the warm-up; a reload shows the same finished warm-up, and it is not taken twice.
    await expect(pathNav(page).getByRole('link', { name: /Warm-up/ }).getByRole('img', { name: 'Completed' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Ready to read' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start warm-up' })).toHaveCount(0)
  })

  test('a warm-up left half way picks up where it was', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl } = await readerWorld(page, 'wu-resume')
    await page.goto(`${topicUrl}?view=warmup`)
    await page.getByRole('button', { name: 'Start warm-up' }).click()
    await answerWarmup(page, 1, 'Fairly sure')
    await expect(page.getByRole('heading', { name: 'Warm-up question 2 of 3' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Warm-up question 2 of 3' })).toBeVisible()
    // It was medium, right and sure: the second is the hard one.
    await expect(page.getByText(/\(hard\)/)).toBeVisible()
  })

  test('test all correct and confident offers test-out', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl } = await readerWorld(page, 'wu-testout')
    await page.goto(`${topicUrl}?view=warmup`)
    await page.getByRole('button', { name: 'Start warm-up' }).click()
    for (let i = 0; i < 3; i++) await answerWarmup(page, 1, 'Certain')
    await expect(page.getByRole('heading', { name: 'Ready to read' })).toBeVisible()
    const offer = page.getByRole('status').filter({ hasText: 'You may know this already' })
    await expect(offer).toBeVisible()
    await expect(offer.getByRole('link', { name: 'Take the quiz now' })).toHaveAttribute('href', /view=quiz$/)
    await expect(page.getByText(/marked Focus here/)).toHaveCount(0)
  })

})

test.describe('the reader', () => {
  test.afterEach(markAiAvailable)

  test('missed warm-up concepts mark their passages Focus here and hide nothing', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl } = await readerWorld(page, 'rd-focus')
    await page.goto(`${topicUrl}?view=warmup`)
    await page.getByRole('button', { name: 'Start warm-up' }).click()
    // Wrong on the first (medium) question, which tests Resizing; the passage with its claim is marked.
    await answerWarmup(page, 0, 'Certain')
    await answerWarmup(page, 1, 'Certain')
    await answerWarmup(page, 1, 'Certain')
    await expect(page.getByRole('heading', { name: 'Ready to read' })).toBeVisible()
    await page.getByRole('region', { name: 'Ready to read' }).getByRole('link', { name: 'Start reading' }).click()
    await expect(page).toHaveURL(/view=read$/)

    const focus = page.locator('[data-focus]')
    await expect(focus).toHaveCount(1)
    await expect(focus).toContainText('Focus here')
    await expect(focus).toContainText('the table is rebuilt with more buckets')
    // Nothing is hidden: all four passages and the closing sentences are on the page.
    await expect(page.locator('[data-passage]')).toHaveCount(4)
    for (const text of ['Open addressing probes', 'Chaining keeps every colliding entry', 'the table is rebuilt with more buckets']) await expect(page.getByText(text)).toBeVisible()
    await expect(page.getByText(/One passage is marked Focus here/)).toBeVisible()
  })

  test('reader joins chunks without repeating the overlap, with page dividers and the original', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { materialId, topicUrl } = await readerWorld(page, 'rd-text')
    await openReader(page, `${topicUrl}?view=read`)

    // The sentence the second chunk repeats is printed once.
    await expect(page.getByText(SHARED_1)).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 2, name: 'hashing.pdf' })).toBeVisible()
    // A PDF always links to the original: one link on the file header, one at each page change.
    const original = page.getByRole('link', { name: /Open the original at p\. 3/ })
    await expect(original).toHaveAttribute('href', `/api/materials/${materialId}/file#page=3`)
    await expect(page.getByRole('link', { name: /Open the original at p\. 6/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /Open the original at p\. 7/ })).toBeVisible()
    await expect(page.getByText(/Text from a PDF can lose its layout and maths/)).toBeVisible()
    // Read to answer: the focus question links to its passage.
    const question = page.getByRole('region', { name: 'Read to answer' })
    await expect(question).toContainText('How are two keys in one bucket handled?')
    await question.getByRole('link').click()
    await expect(page).toHaveURL(/#passage-/)
  })

  test('one before-you-go-on check per section with a claim, skippable, self-graded level 2', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { email, topicUrl } = await readerWorld(page, 'rd-checks')
    await openReader(page, `${topicUrl}?view=read`)

    // Three sections hold a claim (Hashing, Chaining, Resizing): three checks, one each.
    const checks = page.locator('[data-check]')
    await expect(checks).toHaveCount(3)
    await expect(checks.nth(0)).toContainText('Quick check, from memory: Hash function.')
    await expect(checks.nth(1)).toContainText('How are two keys in one bucket handled?')
    await expect(checks.nth(2)).toContainText('Quick check, from memory: Resizing.')

    // The source sentence is not on the check until the student has answered or said they don't know.
    const first = checks.nth(0)
    await expect(first.getByText('In your file')).toHaveCount(0)
    await expect(first.getByRole('button', { name: 'Show the source' })).toBeDisabled()
    // Why it is disabled is on the page, and the button points at it.
    const why = first.getByText('Write an answer first, or tap "I don\'t know".')
    await expect(why).toBeVisible()
    await expect(first.getByRole('button', { name: 'Show the source' })).toHaveAccessibleDescription(/Write an answer first/)
    await first.getByRole('textbox').fill('It sends a key to a bucket.')
    await expect(why).toHaveCount(0)
    await screenshotIfAsked(page, 'e3-reader-check-1440x900')
    await first.getByRole('button', { name: 'Show the source' }).click()
    await expect(first).toContainText('A hash function maps a key to a bucket index.')
    await expect(first).toContainText('Your answer')
    // The buttons that were pressed are gone: focus goes to the source, then to the saved line.
    await expect(first.locator('.border-l-2')).toBeFocused()
    await first.getByRole('button', { name: 'Partly' }).click()
    await expect(first.getByText('Saved: Partly')).toBeVisible()
    await expect(first.getByText('Saved: Partly')).toBeFocused()

    // "I don't know" reveals too; Skip removes the check, and it stays gone after a reload.
    const second = checks.nth(1)
    await second.getByRole('button', { name: "I don't know" }).click()
    await expect(second).toContainText("I don't know")
    await second.getByRole('button', { name: 'Missed' }).click()
    await expect(second.getByText('Saved: Missed')).toBeVisible()
    await checks.nth(2).getByRole('button', { name: 'Continue reading' }).click()
    await expect(checks).toHaveCount(2)
    // The check left the page: focus did not fall back to it.
    await expect(page.locator('body')).not.toBeFocused()
    await page.reload()
    await expect(page.locator('[data-check]')).toHaveCount(2)

    // Level 2, graded by the student, for display: recorded once, and no memory review.
    await expect
      .poll(() =>
        withPrisma(async (prisma) => {
          const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
          const events = await prisma.evidenceEvent.findMany({ where: { userId: user.id }, orderBy: { score: 'desc' } })
          return events.map((e) => [e.source, e.assistance, e.gradedBy, e.score])
        })
      )
      .toEqual([
        ['reader', 2, 'self', 0.5],
        ['reader', 2, 'self', 0],
      ])
  })

  test('a check answer survives a reload, and a grade survives a new browser session', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl } = await readerWorld(page, 'rd-check-keep')
    await openReader(page, `${topicUrl}?view=read`)
    const checks = page.locator('[data-check]')
    // Written, not yet shown: a reload keeps it.
    await checks.nth(0).getByRole('textbox').fill('It sends a key to a bucket.')
    await page.reload()
    await expect(page.locator('[data-check]').nth(0).getByRole('textbox')).toHaveValue('It sends a key to a bucket.')
    // Graded: the server has the grade, so it shows in a session that has nothing stored.
    await page.locator('[data-check]').nth(0).getByRole('button', { name: 'Show the source' }).click()
    await page.locator('[data-check]').nth(0).getByRole('button', { name: 'Partly' }).click()
    await expect(page.locator('[data-check]').nth(0).getByText('Saved: Partly')).toBeVisible()
    await page.evaluate(() => window.sessionStorage.clear())
    await page.reload()
    await expect(page.locator('[data-passage] .md').first()).toBeVisible()
    await expect(page.locator('[data-check]').nth(0).getByText('Saved: Partly')).toBeVisible()
    await expect(page.locator('[data-check]').nth(1).getByRole('textbox')).toHaveValue('')
  })

  test('explain this: a failure because AI is down turns the tutor buttons off everywhere', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl } = await readerWorld(page, 'rd-ai-down')
    await openReader(page, `${topicUrl}?view=read`)
    await page.route(/\/api\/topics\/[0-9a-f-]{36}\/reader-explain$/, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'AI features are paused right now. Your files and progress are safe. Try again later.', details: { code: 'LLM_CREDIT_EXHAUSTED' } } }) }))
    const passage = page.locator('[data-passage]').nth(2)
    await passage.getByRole('button', { name: /Explain this passage: passage 3/ }).click()
    await passage.getByRole('textbox').fill('The passage says the table is rebuilt.')
    await markAiUnavailable()
    await passage.getByRole('button', { name: 'Ask the tutor' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'AI features are paused' })).toBeVisible()
    await expect(passage.getByRole('button', { name: 'Ask the tutor' })).toBeDisabled()
    await expect(passage.getByRole('button', { name: /parse/i })).toBeDisabled()
  })

  test('explain this requires a take first', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { email, topicId, chunkIds, topicUrl } = await readerWorld(page, 'rd-explain')
    await openReader(page, `${topicUrl}?view=read`)
    const passage = page.locator('[data-passage]').nth(2)
    await passage.getByRole('button', { name: /Explain this passage: passage 3/ }).click()

    // Nothing is sent until there are eight characters of the student's own words, or the one-tap answer.
    const ask = passage.getByRole('button', { name: 'Ask the tutor' })
    const field = passage.getByRole('textbox')
    await expect(ask).toBeDisabled()
    await field.fill('seven c')
    await expect(ask).toBeDisabled()
    await field.fill('eight ch')
    await expect(ask).toBeEnabled()
    await field.fill('It says the table keeps a list in each bucket for keys that collide.')
    await screenshotIfAsked(page, 'e3-reader-explain-take-1440x900')
    await ask.click()

    // The exchange is a margin note: the student's take, the tutor's words, one check question.
    const note = passage.locator('[data-note="question"]')
    await expect(note).toContainText('You wrote')
    await expect(note).toContainText('It says the table keeps a list in each bucket')
    await expect(note.getByText('Tutor', { exact: true })).toBeVisible()
    await expect(note.getByText('Check yourself')).toBeVisible()
    await expect(note).toContainText('?')
    await screenshotIfAsked(page, 'e3-reader-explain-1440x900')
    await expectNoAxeViolations(page, 'reader, explained passage, 1440')

    // The one-tap answer counts as an attempt too.
    await passage.getByRole('button', { name: /Explain this passage: passage 3/ }).click()
    await expect(passage.getByRole('button', { name: "I can't parse any of it" })).toBeEnabled()
    await passage.getByRole('button', { name: "I can't parse any of it" }).click()
    await expect(passage.locator('[data-note="question"]')).toHaveCount(2)
    await expect(passage.locator('[data-note="question"]').nth(1)).toContainText("I can't parse any of it")

    // Level 3 for the passage's concept (the AI carried it), and no server record without a take.
    await expect
      .poll(() =>
        withPrisma(async (prisma) => {
          const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
          const events = await prisma.evidenceEvent.findMany({ where: { userId: user.id } })
          return events.map((e) => [e.source, e.assistance, e.score])
        })
      )
      .toEqual([
        ['reader', 3, 0],
        ['reader', 3, 0],
      ])
    // The server holds the same line: a short take is refused whatever the page does.
    const refused = await page.request.post(`/api/topics/${topicId}/reader-explain`, { data: { chunkId: chunkIds[2], take: 'short' } })
    expect(refused.status()).toBe(400)
  })

  test('explain this is limited to ten a minute', async ({ page }) => {
    const { topicId, chunkIds } = await readerWorld(page, 'rd-limit')
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      // Four passages, so that no passage reaches its four replies a day (v3.1) before the minute's ten are used.
      const response = await page.request.post(`/api/topics/${topicId}/reader-explain`, { data: { chunkId: chunkIds[i % 4], cantParse: true } })
      statuses.push(response.status())
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true)
    expect(statuses[10]).toBe(429)
  })

  test('margin notes persist across reload', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl } = await readerWorld(page, 'rd-notes')
    await openReader(page, `${topicUrl}?view=read`)
    const passage = page.locator('[data-passage]').nth(1)
    await passage.getByRole('button', { name: /Add a note on passage 2/ }).click()
    await passage.getByRole('textbox').fill('Probe order matters for lookups.')
    await passage.getByRole('button', { name: 'Save note' }).click()
    await expect(passage.locator('[data-note="note"]')).toContainText('Probe order matters for lookups.')
    // The form is gone: focus is on the note it made.
    await expect(passage.locator('[data-note="note"]')).toBeFocused()
    await screenshotIfAsked(page, 'e3-reader-note-1440x900')

    await page.reload()
    await expect(page.locator('[data-passage]').nth(1).locator('[data-note="note"]')).toContainText('Probe order matters for lookups.')
    await expect(page.locator('[data-passage]').nth(0).locator('[data-note]')).toHaveCount(0)

    // Delete removes it for good.
    await page.locator('[data-passage]').nth(1).getByRole('button', { name: /Delete note/ }).click()
    await expect(page.locator('[data-note]')).toHaveCount(0)
    // The button that was pressed is gone: focus is on the one that adds a note.
    await expect(page.locator('[data-passage]').nth(1).getByRole('button', { name: /Add a note on passage 2/ })).toBeFocused()
    await page.reload()
    await expect(page.locator('[data-note]')).toHaveCount(0)
  })

})

// ---------------------------------------------------------------------------------------------------------
// The first entry of a topic (UX review WS4a): a preparation screen, never the reader, then the warm-up.

test.describe('the first entry of a topic', () => {
  test('is a preparation screen, never the reader, then the warm-up; reading stays one tap away', async ({ page }) => {
    test.setTimeout(240_000)
    await page.setViewportSize(DESKTOP)
    const email = `ws4a-entry-${Date.now()}@example.com`
    await signIn(page, email)
    const project = await page.request.post('/api/projects', { data: { name: `Entry ${Date.now()}` } })
    const courseId = (await project.json()).project.id as string
    const upload = await page.request.post(`/api/projects/${courseId}/materials?category=lecture_notes&filename=algorithms.pdf`, {
      data: readFileSync(FIXTURE_PDF),
      headers: { 'content-type': 'application/pdf' },
    })
    expect(upload.ok()).toBeTruthy()
    await expect
      .poll(async () => ((await (await page.request.get(`/api/projects/${courseId}/materials`)).json()).materials as { validationStatus: string }[]).map((item) => item.validationStatus).join(), { timeout: 120_000 })
      .toBe('valid')
    // Topic finding starts by itself and would undo the confirmation below if it were still running.
    await expect.poll(async () => (await (await page.request.get(`/api/projects/${courseId}/topics`)).json()).topics.length, { timeout: 120_000 }).toBeGreaterThan(0)
    const topic = await page.request.post(`/api/projects/${courseId}/topics`, { data: { name: 'Graph traversal', description: 'Breadth-first and depth-first search.' } })
    expect(topic.ok()).toBeTruthy()
    const topicId = (await topic.json()).topic.id as string
    await page.request.post(`/api/projects/${courseId}/topics/confirm`)
    await markIntroSeen(email)
    const base = `/courses/${courseId}/topics/${topicId}`

    // Preparation is held (the stack's E2E_HOLD_DIR hook), so the screen can be looked at while the warm-up is being written.
    const holdDir = join(process.env.E2E_RUN_DIR || join(process.cwd(), '..', '.e2e'), 'hold')
    const gate = join(holdDir, 'generate_content.hold')
    await mkdir(holdDir, { recursive: true })
    await writeFile(gate, '')
    try {
      await page.goto(base)
      await expect(page).toHaveURL(/\?view=read&entry=1$/)
      await expect(page.getByRole('heading', { name: 'Writing your warm-up questions, about a minute' })).toBeVisible()
      // The reader is not shown, and the path keeps its five steps: Warm-up and Recall say they are being prepared, none is tagged Next.
      await expect(page.locator('[data-passage]')).toHaveCount(0)
      await expect(pathNav(page).getByRole('link', { name: /Warm-up/ }).getByRole('img', { name: 'Being prepared' })).toBeVisible()
      await expect(pathNav(page).getByRole('link', { name: /Recall/ }).getByRole('img', { name: 'Being prepared' })).toBeVisible()
      await expect(pathNav(page).getByText('(next up)')).toHaveCount(0)
      await screenshotIfAsked(page, 'ws4a-entry-preparing-1440x900')

      // On a phone the panel is the page; the one axe check of this screen runs there.
      await page.setViewportSize({ width: 390, height: 844 })
      await screenshotIfAsked(page, 'ws4a-entry-preparing-390x844')
      await expectNoAxeViolations(page, 'topic entry, preparing, 390')
      await page.setViewportSize(DESKTOP)

      // Reading is a choice, not a fallback: it leaves the preparation screen at once.
      await page.getByRole('link', { name: 'Start reading instead' }).click()
      await expect(page).toHaveURL(/\?view=read$/)
      await expect(page.getByRole('heading', { name: 'Writing your warm-up questions, about a minute' })).toHaveCount(0)
      await page.goto(base)
      await expect(page).toHaveURL(/\?view=read&entry=1$/)
    } finally {
      await rm(gate, { force: true })
    }
    // Let go of what is held: the screen opens the warm-up by itself once it is written, once.
    for (const file of readdirSync(holdDir)) if (file.endsWith('.request.json')) await writeFile(join(holdDir, file.replace('.request.json', '.release')), '')
    await expect(page).toHaveURL(/\?view=warmup$/, { timeout: 150_000 })
    await expect(page.getByRole('button', { name: 'Start warm-up' })).toBeVisible()
    await expect(pathNav(page).getByRole('img', { name: 'Being prepared' })).toHaveCount(0)
  })
})
