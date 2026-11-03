import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { addContent, createCourse, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { expectNoSidewaysScroll } from './helpers/overflow'

// The explainer (spec §5.4): locked until a recall, opened early only by "I'd rather read an explanation now" once the topic
// has been read; a gap form that explains what the recall missed, each with a check; and attempt-first check blocks that
// record the student's own grade. The AI service runs on the mock provider, so the gap explanations are the mock's.
// Set SCREENS_DIR to keep screenshots at both sizes.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const ANSWER = 'A hash table sends each key to a bucket and keeps a list in the bucket when two keys land together, which is how it avoids losing a key.'
const NOTES = [
  '# Notes',
  '',
  'Some notes to read.',
  '',
  '## Collisions',
  '',
  'Two keys can share a bucket.',
  '',
  '```check',
  'Q: What is a Collision in a hash table?',
  'A: Two keys that land in one bucket.',
  '```',
  '',
  '## Load',
  '',
  'The table fills up as entries are added.',
  '',
  '```check',
  'Q: What does the load factor measure?',
  'A: Entries divided by buckets.',
  '```',
].join('\n')

type SeedOptions = { read?: boolean; recall?: boolean; concepts?: boolean; backfilled?: boolean }

/** Concepts with claims and recall prompts, and the stages the topic has reached, written straight into the database. */
async function seed(email: string, topicId: string, options: SeedOptions = {}) {
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { projectId: true } })
    const material = await prisma.material.findFirstOrThrow({ where: { projectId: topic.projectId }, select: { id: true } })
    if (options.concepts !== false) {
      const specs = [
        { name: 'Hash function', objectives: [0], claims: ['A hash function maps a key to a bucket index.'] },
        { name: 'Collision', objectives: [0], claims: ['A collision is two keys that land in one bucket.', 'Chaining keeps a list of entries per bucket.'] },
        { name: 'Load factor', objectives: [1], claims: ['The load factor is entries divided by buckets.'] },
      ]
      for (const [orderIndex, spec] of specs.entries()) {
        const concept = await prisma.concept.create({
          data: { projectId: topic.projectId, topicId, name: spec.name, summary: `${spec.name}.`, kind: 'concept', orderIndex, objectiveIndexes: spec.objectives },
        })
        for (const [n, text] of spec.claims.entries()) {
          await prisma.conceptClaim.create({ data: { conceptId: concept.id, text, quote: `Page text for: ${text}`, materialId: material.id, orderIndex: n, pageStart: 4 + orderIndex } })
        }
      }
      if (options.backfilled !== false) await prisma.topic.update({ where: { id: topicId }, data: { evidenceBackfilledAt: new Date() } })
      await prisma.topicContent.create({
        data: {
          topicId,
          contentType: 'concept_prompts',
          contentData: {
            focus_questions: [],
            recall_prompts: [
              { objective_index: 0, prompt: 'Explain how a hash table handles keys that share a bucket.' },
              { objective_index: 1, prompt: 'Explain what the load factor tells you.' },
            ],
          },
        },
      })
    }
    const at = new Date(Date.now() - 3_600_000)
    const data = { ...(options.read ? { readAt: at } : {}), ...(options.recall ? { readAt: at, recallAt: at } : {}) }
    await prisma.topicProgress.upsert({ where: { topicId_userId: { topicId, userId: user.id } }, create: { topicId, userId: user.id, ...data }, update: data })
  })
}

async function world(page: Page, label: string, names = ['Hash tables']) {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, label, { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Explainer ${Date.now()}`, names.map((name) => ({ name })))
  for (const id of Object.values(course.topics)) await addContent(id, { section_notes: NOTES })
  const topicUrl = (name: string) => `/courses/${course.courseId}/topics/${course.topics[name]}`
  return { email, course, topicUrl, topicId: (name: string) => course.topics[name] }
}

const gate = (page: Page) => page.getByRole('heading', { name: "Try recalling first. It's how this sticks" })
const unlockButton = (page: Page) => page.getByRole('button', { name: "I'd rather read an explanation now" })

test('explainer locked before recall', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'ex-locked')
  await seed(email, topicId('Hash tables'))
  await page.goto(`${topicUrl('Hash tables')}?view=explainer`)

  await expect(gate(page)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Start recall' })).toHaveAttribute('href', /view=recall/)
  // The topic has not been read: the way round is there, and says why it is shut.
  await expect(unlockButton(page)).toBeDisabled()
  await expect(page.getByText('Available once you have read this topic.')).toBeVisible()
  // None of the lesson is on the page.
  await expect(page.locator('#main').getByText('Some notes to read.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show answer' })).toHaveCount(0)
  await screenshotIfAsked(page, 'e5-explainer-locked-1440x900')
  await expectNoAxeViolations(page, 'explainer locked, 1440')

  // The server refuses too: the content route does not send the notes, whether asked for or listed with the rest.
  const asked = await page.request.get(`/api/topics/${topicId('Hash tables')}/content?type=section_notes`)
  expect(asked.status()).toBe(403)
  expect((await asked.json()).code).toBe('EXPLAINER_LOCKED')
  const listed = await page.request.get(`/api/topics/${topicId('Hash tables')}/content`)
  expect(listed.ok()).toBeTruthy()
  expect(JSON.stringify(await listed.json())).not.toContain('Some notes to read.')
  expect((await page.request.get(`/api/topics/${topicId('Hash tables')}/explainer`)).status()).toBe(403)
  expect((await page.request.post(`/api/topics/${topicId('Hash tables')}/explainer`, { data: { action: 'viewed' } })).status()).toBe(403)
  // Nor can the gate be opened from the API before the topic is read.
  const early = await page.request.post(`/api/topics/${topicId('Hash tables')}/explainer-unlock`)
  expect(early.status()).toBe(409)
  await withPrisma(async (prisma) => {
    const progress = await prisma.topicProgress.findFirst({ where: { topicId: topicId('Hash tables') } })
    expect(progress?.explainerUnlockedAt ?? null).toBeNull()
  })

  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(gate(page)).toBeVisible()
  await screenshotIfAsked(page, 'e5-explainer-locked-390x844')
  await expectNoAxeViolations(page, 'explainer locked, 390')
  await expectNoSidewaysScroll(page, page.url())

  // Start recall goes to the recall step.
  await page.getByRole('link', { name: 'Start recall' }).click()
  await expect(page).toHaveURL(/view=recall/)
})

test('thin source unlock needs read', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'ex-thin')
  await seed(email, topicId('Hash tables'), { read: true })
  await page.goto(`${topicUrl('Hash tables')}?view=explainer`)

  await expect(gate(page)).toBeVisible()
  // Read: the way round is open, and the lesson is still not on the page.
  await expect(unlockButton(page)).toBeEnabled()
  await expect(page.getByText('Available once you have read this topic.')).toHaveCount(0)
  await expect(page.locator('#main').getByText('Some notes to read.')).toHaveCount(0)
  await screenshotIfAsked(page, 'e5-explainer-thin-source-1440x900')
  await expectNoAxeViolations(page, 'explainer thin source, 1440')
  await page.setViewportSize(PHONE)
  await screenshotIfAsked(page, 'e5-explainer-thin-source-390x844')
  await expectNoAxeViolations(page, 'explainer thin source, 390')
  await page.setViewportSize(DESKTOP)

  await unlockButton(page).click()
  await expect(page.locator('#main').getByText('Some notes to read.')).toBeVisible()
  await expect(gate(page)).toHaveCount(0)
  // A lesson read here is not the student's pages: it cannot mark the topic read.
  await expect(page.getByRole('button', { name: 'Mark as read' })).toHaveCount(0)
  await withPrisma(async (prisma) => {
    const progress = await prisma.topicProgress.findFirstOrThrow({ where: { topicId: topicId('Hash tables') } })
    expect(progress.explainerUnlockReason).toBe('asked')
    expect(progress.explainerUnlockedAt).not.toBeNull()
    expect(progress.recallAt).toBeNull()
  })
  // And the server now sends the notes.
  expect((await page.request.get(`/api/topics/${topicId('Hash tables')}/content?type=section_notes`)).ok()).toBeTruthy()
  // It stays open after a reload.
  await page.reload()
  await expect(page.locator('#main').getByText('Some notes to read.')).toBeVisible()
})

test('a new topic with concepts and no overview load shows Recall and a locked explainer', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'ex-fresh')
  // Concepts have just finished; the course overview has not been opened since, so nothing has converted the topic.
  await seed(email, topicId('Hash tables'), { backfilled: false })
  await withPrisma(async (prisma) => expect((await prisma.topic.findUniqueOrThrow({ where: { id: topicId('Hash tables') } })).evidenceBackfilledAt).toBeNull())

  await page.goto(`${topicUrl('Hash tables')}?view=explainer`)
  await expect(gate(page)).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Recall/ })).toBeVisible()
  await expect(page.getByText('Some notes to read.')).toHaveCount(0)
  await withPrisma(async (prisma) => expect((await prisma.topic.findUniqueOrThrow({ where: { id: topicId('Hash tables') } })).evidenceBackfilledAt).not.toBeNull())
  // Start recall leads to a recall card, not to "Recall isn't ready yet".
  await page.getByRole('link', { name: 'Start recall' }).click()
  await expect(page.getByRole('heading', { name: 'Close the book and say what you remember' })).toBeVisible()
})

test('a topic with nothing to recall is not locked', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { topicUrl } = await world(page, 'ex-legacy')
  // No concepts: a course from before v3, or extraction that failed. Its explainer is the old notes.
  await page.goto(`${topicUrl('Hash tables')}?view=explainer`)
  await expect(page.locator('#main').getByText('Some notes to read.')).toBeVisible()
  await expect(gate(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Mark as read' })).toHaveCount(0)
})

test('check block needs an answer before reveal', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'ex-check')
  await seed(email, topicId('Hash tables'), { recall: true })
  await page.goto(`${topicUrl('Hash tables')}?view=explainer`)

  const block = page.locator('.md-check').first()
  await expect(block).toBeVisible()
  const reveal = block.getByRole('button', { name: 'Show answer' })
  // Before an answer: the answer is not there, and the button waits.
  await expect(block.getByText('Two keys that land in one bucket.')).toHaveCount(0)
  await expect(reveal).toBeDisabled()
  await expect(block.getByText('Write an answer, or tap “I don\'t know”, to see the answer.')).toBeVisible()
  await expect(block.getByRole('group', { name: 'How did you do?' })).toHaveCount(0)
  await block.scrollIntoViewIfNeeded()
  await screenshotIfAsked(page, 'e5-check-before-1440x900')
  await expectNoAxeViolations(page, 'check block before an answer, 1440')

  await block.getByRole('textbox', { name: 'Your answer' }).fill('When two keys end up in the same bucket.')
  await expect(reveal).toBeEnabled()
  await reveal.click()
  await expect(block.getByText('Two keys that land in one bucket.')).toBeVisible()
  await expect(block.getByRole('textbox', { name: 'Your answer' })).toHaveAttribute('readonly', '')
  const grades = block.getByRole('group', { name: 'How did you do?' })
  await expect(grades.getByRole('button')).toHaveText(['Got it', 'Partly', 'Missed'])
  await screenshotIfAsked(page, 'e5-check-after-1440x900')
  await expectNoAxeViolations(page, 'check block after reveal, 1440')

  await grades.getByRole('button', { name: 'Partly' }).click()
  await expect(block.getByText('Saved: Partly')).toBeVisible()
  await withPrisma(async (prisma) => {
    const rows = await prisma.evidenceEvent.findMany({ where: { topicId: topicId('Hash tables'), source: 'example' }, include: { concept: { select: { name: true } } } })
    // The question names the Collision concept: one event, level 2, graded by the student, for display.
    expect(rows.map((row) => row.concept.name)).toEqual(['Collision'])
    expect(rows[0]).toMatchObject({ assistance: 2, gradedBy: 'self', score: 0.5 })
  })

  // "I don't know" is an attempt.
  const second = page.locator('.md-check').nth(1)
  await second.scrollIntoViewIfNeeded()
  await expect(second.getByRole('button', { name: 'Show answer' })).toBeDisabled()
  await second.getByRole('button', { name: "I don't know" }).click()
  await expect(second.getByRole('textbox', { name: 'Your answer' })).toHaveValue("I don't know")
  await second.getByRole('button', { name: 'Show answer' }).click()
  await expect(second.getByText('Entries divided by buckets.')).toBeVisible()
  // After "I don't know" the only honest grade is Missed.
  await expect(second.getByRole('button', { name: 'Got it' })).toHaveCount(0)
  await expect(second.getByRole('button', { name: 'Partly' })).toHaveCount(0)
  await second.getByRole('button', { name: 'Missed' }).click()
  await expect(second.getByText('Saved: Missed')).toBeVisible()
  await withPrisma(async (prisma) => {
    const row = await prisma.evidenceEvent.findFirstOrThrow({ where: { topicId: topicId('Hash tables'), source: 'example', score: 0 } })
    expect((row.metadata as Record<string, unknown>).idk).toBe(true)
  })

  await page.setViewportSize(PHONE)
  await page.reload()
  // The markdown loads as its own chunk and replaces the server's copy of the block: scroll to the one that stays.
  await page.waitForLoadState('networkidle')
  const phoneBlock = page.locator('.md-check').first()
  await expect(phoneBlock).toBeVisible()
  await phoneBlock.scrollIntoViewIfNeeded()
  await screenshotIfAsked(page, 'e5-check-before-390x844')
  await expectNoAxeViolations(page, 'check block before an answer, 390')
  await phoneBlock.getByRole('textbox', { name: 'Your answer' }).fill('Two keys in one bucket.')
  await phoneBlock.getByRole('button', { name: 'Show answer' }).click()
  await expect(phoneBlock.getByRole('group', { name: 'How did you do?' })).toBeVisible()
  await screenshotIfAsked(page, 'e5-check-after-390x844')
  await expectNoAxeViolations(page, 'check block after reveal, 390')
  await expectNoSidewaysScroll(page, page.url())
})

test('what is typed in a check block is kept on the server across a reload, and cleared once graded', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'ex-draft')
  await seed(email, topicId('Hash tables'), { recall: true })
  await page.goto(`${topicUrl('Hash tables')}?view=explainer`)

  const first = page.locator('.md-check').first()
  await first.getByRole('textbox', { name: 'Your answer' }).fill('Two keys that end up in one bucket.')
  await expect(first.getByText('Saved', { exact: true })).toBeVisible()
  const drafts = () => withPrisma((prisma) => prisma.studyDraft.findMany({ where: { surface: 'explainer_check', topicId: topicId('Hash tables') }, select: { scopeKey: true, payload: true } }))
  await expect.poll(async () => (await drafts()).map((row) => row.payload)).toEqual([{ answer: 'Two keys that end up in one bucket.' }])

  // The browser's own copy is gone: the text comes back from the server, and only into the block it was typed in.
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await expect(page.locator('.md-check').first().getByRole('textbox', { name: 'Your answer' })).toHaveValue('Two keys that end up in one bucket.')
  await expect(page.locator('.md-check').nth(1).getByRole('textbox', { name: 'Your answer' })).toHaveValue('')

  // Settled with a grade: the draft is gone.
  const block = page.locator('.md-check').first()
  await block.getByRole('button', { name: 'Show answer' }).click()
  await block.getByRole('button', { name: 'Got it' }).click()
  await expect(block.getByText('Saved: Got it')).toBeVisible()
  await expect(block.getByRole('textbox', { name: 'Your answer' })).toHaveValue('Two keys that end up in one bucket.')
  await expect.poll(async () => (await drafts()).length).toBe(0)
})

test('gap explainer covers what the recall missed, and each gap ends with a check', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'ex-gaps')
  await seed(email, topicId('Hash tables'), { read: true })

  // A recall answer (the mock grader: the first claim covered, the second missing, the third wrong).
  const graded = await page.request.post(`/api/topics/${topicId('Hash tables')}/recall`, { data: { kind: 'recall', objectiveIndex: 0, answer: ANSWER } })
  expect(graded.ok()).toBeTruthy()
  const attemptId = (await graded.json()).feedback.attemptId as string

  // The recall opened the explainer; the gaps are written in the background.
  await page.goto(`${topicUrl('Hash tables')}?view=explainer`)
  await expect(gate(page)).toHaveCount(0)
  const list = page.getByRole('list', { name: 'Ideas to look at again' })
  await expect(list).toBeVisible({ timeout: 60_000 })
  const items = list.getByRole('listitem')
  await expect(items).toHaveCount(2)
  // Only the ideas the answer missed or got wrong: both are about the Collision concept; the covered Hash function is not here.
  await expect(list.getByRole('heading', { name: /^Collision, part \d of 2$/ })).toHaveText(['Collision, part 1 of 2', 'Collision, part 2 of 2'])
  await expect(list.getByRole('heading', { name: 'Hash function' })).toHaveCount(0)
  // Each gap ends with its check.
  for (const index of [0, 1]) {
    const item = items.nth(index)
    await expect(item.locator('.md-check')).toHaveCount(1)
    await expect(item.locator('.md-check').getByRole('button', { name: 'Show answer' })).toBeDisabled()
    const checkBox = await item.locator('.md-check').boundingBox()
    const linkBox = await item.getByRole('link').first().boundingBox()
    expect(checkBox && linkBox && checkBox.y > linkBox.y).toBeTruthy()
  }
  await expect(page.getByText('Your pages put it this way:').first()).toBeVisible()
  await expect(items.first().getByRole('link', { name: /notes\.pdf/ })).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'Explainer form' }).getByRole('radio', { name: 'What you missed' })).toBeChecked()
  await screenshotIfAsked(page, 'e5-explainer-gaps-1440x900')
  await expectNoAxeViolations(page, 'gap explainer, 1440')

  // Opening it is a visit, recorded on the attempt, next to the explanations.
  await expect
    .poll(async () => withPrisma(async (prisma) => ((await prisma.recallAttempt.findUniqueOrThrow({ where: { id: attemptId } })).explainer as Record<string, unknown> | null)?.viewedAt ?? null))
    .not.toBeNull()
  await withPrisma(async (prisma) => {
    const stored = (await prisma.recallAttempt.findUniqueOrThrow({ where: { id: attemptId } })).explainer as { status: string; gaps: { check: { question: string } }[] }
    expect(stored.status).toBe('ready')
    expect(stored.gaps).toHaveLength(2)
    expect(stored.gaps.every((gap) => gap.check.question.endsWith('?'))).toBeTruthy()
  })

  // Reading the gaps is instruction on the idea they explain (spec 18.5): one event for the Collision concept, graded by no one.
  await expect
    .poll(() => withPrisma(async (prisma) => (await prisma.evidenceEvent.findMany({ where: { topicId: topicId('Hash tables'), source: 'instruction' }, include: { concept: { select: { name: true } } } })).map((row) => `${row.concept.name}:${(row.metadata as { kind?: string }).kind}`)))
    .toEqual(['Collision:gap_explainer'])

  // A gap's check is filed under the gap's concept.
  const check = items.first().locator('.md-check')
  await check.getByRole('textbox', { name: 'Your answer' }).fill('Two keys sharing a bucket.')
  await check.getByRole('button', { name: 'Show answer' }).click()
  await check.getByRole('button', { name: 'Got it' }).click()
  await expect(check.getByText('Saved: Got it')).toBeVisible()
  await withPrisma(async (prisma) => {
    const rows = await prisma.evidenceEvent.findMany({ where: { topicId: topicId('Hash tables'), source: 'example' }, include: { concept: { select: { name: true } } }, orderBy: { assistance: 'asc' } })
    // The self-grade (level 2), and the AI's explanation shown (level 3, once, on the concept of the gaps, no score).
    expect(rows.map((row) => `${row.concept.name}:${row.assistance}:${row.gradedBy}:${row.score}`)).toEqual(['Collision:2:self:1', 'Collision:3:rule:0'])
  })
  // Showing the gaps again after a reload does not record them again.
  await page.reload()
  await expect(list).toBeVisible()
  // Whatever the page sends when it shows the gaps has been sent.
  await page.waitForLoadState('networkidle')
  await withPrisma(async (prisma) => {
    expect(await prisma.evidenceEvent.count({ where: { topicId: topicId('Hash tables'), source: 'example', assistance: 3 } })).toBe(1)
  })

  // The full form is one switch away; the gap form is back with the switch.
  await page.getByRole('radio', { name: 'Full explainer' }).click()
  await expect(page.locator('#main').getByText('Some notes to read.')).toBeVisible()
  await expect(list).toHaveCount(0)
  await page.getByRole('radio', { name: 'What you missed' }).click()
  await expect(list).toBeVisible()

  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(list).toBeVisible()
  await screenshotIfAsked(page, 'e5-explainer-gaps-390x844')
  await expectNoAxeViolations(page, 'gap explainer, 390')
  await expectNoSidewaysScroll(page, page.url())
})

test('a slow explainer stops spinning and offers to check again', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'ex-slow')
  await seed(email, topicId('Hash tables'), { recall: true })
  // A graded recall from a while ago whose job is still running.
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId('Hash tables') }, select: { projectId: true } })
    const claim = await prisma.conceptClaim.findFirstOrThrow({ where: { text: { startsWith: 'A collision' }, concept: { topicId: topicId('Hash tables') } }, include: { concept: { select: { id: true } } } })
    const attempt = await prisma.recallAttempt.create({
      data: {
        userId: user.id, topicId: topicId('Hash tables'), kind: 'recall', promptText: 'Explain.', objectiveIndex: 0, answerText: ANSWER, mode: 'text',
        createdAt: new Date(Date.now() - 600_000),
        result: { status: 'graded', claims: [{ claim_id: claim.id, concept_id: claim.concept.id, verdict: 'missing' }] },
      },
    })
    await prisma.processingJob.create({
      data: { userId: user.id, projectId: topic.projectId, jobType: 'gap_explainer', status: 'processing', leaseUntil: new Date(Date.now() + 3_600_000), inputData: { attemptId: attempt.id }, targetKey: `gap-explainer:${attempt.id}` },
    })
  })
  await page.clock.install()
  await page.goto(`${topicUrl('Hash tables')}?view=explainer`)
  await expect(page.getByText('Writing short explanations of what you missed.')).toBeVisible()
  await page.clock.runFor(4000 * 50)
  await expect(page.getByText('This is taking longer than expected')).toBeVisible()
  await expect(page.getByText('Writing short explanations of what you missed.')).toHaveCount(0)
  await screenshotIfAsked(page, 'e5-explainer-slow-1440x900')
  await expectNoAxeViolations(page, 'gap explainer waited out, 1440')
  await page.getByRole('button', { name: 'Check again' }).click()
  await expect(page.getByText('Writing short explanations of what you missed.')).toBeVisible()
})

test('explanations that were never written can be written again', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  const { email, topicUrl, topicId } = await world(page, 'ex-again')
  await seed(email, topicId('Hash tables'), { recall: true })
  // A graded recall whose explainer job never ran (the AI was off when it was answered).
  const attemptId = await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const claims = await prisma.conceptClaim.findMany({ where: { concept: { topicId: topicId('Hash tables') } }, orderBy: { text: 'asc' }, include: { concept: { select: { id: true } } } })
    const missed = claims.find((claim) => claim.text.startsWith('A collision'))
    if (!missed) throw new Error('no claim')
    const attempt = await prisma.recallAttempt.create({
      data: {
        userId: user.id,
        topicId: topicId('Hash tables'),
        kind: 'recall',
        promptText: 'Explain how a hash table handles keys that share a bucket.',
        objectiveIndex: 0,
        answerText: ANSWER,
        mode: 'text',
        createdAt: new Date(Date.now() - 600_000),
        result: { status: 'graded', claims: [{ claim_id: missed.id, concept_id: missed.concept.id, verdict: 'missing', student_quote: null, misconception: null, kind: null, pointer: null }] },
      },
    })
    return attempt.id
  })
  await page.goto(`${topicUrl('Hash tables')}?view=explainer`)
  await expect(page.getByText("The explanations haven't been written")).toBeVisible()
  await screenshotIfAsked(page, 'e5-explainer-failed-1440x900')
  await expectNoAxeViolations(page, 'gap explainer not written, 1440')
  await page.getByRole('button', { name: 'Write them again' }).click()
  const list = page.getByRole('list', { name: 'Ideas to look at again' })
  await expect(list).toBeVisible({ timeout: 60_000 })
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await withPrisma(async (prisma) => {
    const job = await prisma.processingJob.findFirstOrThrow({ where: { jobType: 'gap_explainer', targetKey: `gap-explainer:${attemptId}` } })
    expect(job.status).toBe('completed')
  })
})
