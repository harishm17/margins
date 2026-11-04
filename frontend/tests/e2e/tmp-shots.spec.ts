import { test, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'
import { withPrisma } from './helpers/db'
import { addQuizSet, createCourse, reviewItem, seedDueConcept, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { clearVoiceSessions, ensureVoiceFixture, VOICE_TEST_EMAIL } from './helpers/voice-fixture'
import { installVoiceStubs } from './helpers/voice-stubs'

test.use({ timezoneId: ZONE })
const OUT = '/tmp/r4-w1/shots'
const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
]

async function shot(page: Page, name: string, size: string, scheme: string) {
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/${name}-${size}-${scheme}.png` })
}

for (const scheme of ['light', 'dark'] as const) {
  for (const size of SIZES) {
    test(`shots ${scheme} ${size.name}`, async ({ page, baseURL }) => {
      test.setTimeout(240_000)
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize(size)
      await setZoneCookie(page.context())

      // Ask
      await signIn(page, DEMO_EMAIL)
      await page.goto(`/courses/${demoIds().course}/ask`, { waitUntil: 'networkidle' })
      await shot(page, 'ask-empty', size.name, scheme)

      // Exam
      const { email } = await signUpAndIn(page, `shots-${scheme}-${size.name}-${Date.now()}`, { own: true })
      const course = await createCourse(page, `Shots ${Date.now()}`, [{ name: 'Hash tables' }, { name: 'Sorting' }])
      const topicId = course.topics['Hash tables']
      const exam = await withPrisma((prisma) =>
        prisma.sampleExam.create({
          data: {
            projectId: course.courseId,
            name: 'Sample Exam - 2026-11-20',
            durationMinutes: 30,
            difficultyLevel: 'medium',
            topicsCovered: ['Hash tables'],
            questions: [
              { question_type: 'multiple_choice', question_text: 'Which structure does BFS use?', options: [{ id: 'A', text: 'A queue' }, { id: 'B', text: 'A stack' }], correct_answer: 'A', explanation: 'x', points: 2, topic_id: topicId, topic_name: 'Hash tables' },
              { question_type: 'multiple_choice', question_text: 'Which structure does DFS use?', options: [{ id: 'A', text: 'A queue' }, { id: 'B', text: 'A stack' }], correct_answer: 'B', explanation: 'x', points: 2, topic_id: topicId, topic_name: 'Hash tables' },
            ],
          },
          select: { id: true },
        })
      )
      await page.goto(`/courses/${course.courseId}/exams/${exam.id}`)
      await page.getByRole('button', { name: /^(Start exam|Resume)/ }).click()
      await page.waitForURL(/\/take$/)
      await shot(page, 'exam-taking', size.name, scheme)
      await page.getByRole('button', { name: 'Submit exam' }).first().click()
      await shot(page, 'exam-blank-dialog', size.name, scheme)

      // Review
      for (const [topicName, conceptName] of [['Hash tables', 'Hashing'], ['Sorting', 'Quicksort']] as const) {
        const tid = course.topics[topicName]
        const conceptId = await seedDueConcept(email, tid, conceptName)
        await addQuizSet(tid, [reviewItem(conceptId, `${conceptName} statement 1 holds.`, 'easy'), reviewItem(conceptId, `${conceptName} statement 2 holds.`, 'easy'), reviewItem(conceptId, `${conceptName} statement 3 holds.`, 'easy')])
      }
      await page.goto(`/courses/${course.courseId}/review/session`)
      await page.getByRole('heading', { name: /^Question 1 of 2/ }).waitFor({ timeout: 60_000 })
      await shot(page, 'review-question', size.name, scheme)
      await page.getByRole('radio', { name: 'False' }).click()
      await page.getByRole('button', { name: 'Check answer' }).click()
      await page.getByTestId('length-notice').waitFor()
      await shot(page, 'review-feedback', size.name, scheme)

      // Voice lobby card
      const fixture = await ensureVoiceFixture(baseURL ?? 'http://localhost:3000')
      await clearVoiceSessions()
      await signIn(page, VOICE_TEST_EMAIL)
      await installVoiceStubs(page, { recognition: false, synthesis: false })
      await page.goto(`/courses/${fixture.courseId}/review/voice`)
      await page.getByRole('button', { name: /Start (voice practice|sprint)/ }).click()
      await page.getByTestId('voice-question').waitFor({ timeout: 30_000 })
      await page.getByLabel('Your answer').fill('It maps a key to a bucket.')
      await page.getByRole('button', { name: 'Send' }).click()
      await page.getByTestId('voice-evaluation').first().waitFor({ timeout: 30_000 })
      await page.getByLabel('Your answer').fill('An unsent second answer')
      await page.waitForTimeout(1200)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByTestId('voice-resume').waitFor({ timeout: 30_000 })
      await shot(page, 'voice-resume', size.name, scheme)
    })
  }
}
