import { test } from '@playwright/test'
import { expectNoSidewaysScroll } from './helpers/overflow'
import { addContent, addFileRow, createCourse, createEmptyCourse, quizQuestions, signUpAndIn } from './helpers/loop'

// A student can name a course or a topic anything, including a 150-character string with no space in it (a pasted URL, a
// course code with underscores). No page may scroll sideways for it on a phone, whatever it shows the name in: the page
// title, the sidebar, breadcrumbs, cards, the setup guide, Home. The mock LLM's demo course is not used: this spec makes its own.
test.use({ viewport: { width: 390, height: 844 } })

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
]

const long = (label: string) => `${label}_${'x'.repeat(150 - label.length - 1)}`
const COURSE = long('Course')
const TOPIC = long('Topic')

test.describe('a 150-character name with no spaces', () => {
  for (const viewport of VIEWPORTS) {
    test(`fits the window on every page that shows it (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport)
      test.setTimeout(240_000)
      await signUpAndIn(page, 'long-names', { own: true })

      // A course that is still being set up, which shows the setup guide.
      const setupId = await createEmptyCourse(page, COURSE)
      // A course with a topic, its quiz and a file.
      const loop = await createCourse(page, COURSE, [{ name: TOPIC, minutes: 30 }])
      await addFileRow(loop.courseId, `${long('lecture')}.pdf`)
      const topicId = loop.topics[TOPIC]
      await addContent(topicId, { topic_quiz: quizQuestions(4) })

      const pages: [string, string][] = [
        ['home', '/home'],
        ['courses', '/courses'],
        ['setup guide', `/courses/${setupId}`],
        ['setup guide, materials', `/courses/${setupId}/materials`],
        ['course overview', `/courses/${loop.courseId}`],
        ['topics', `/courses/${loop.courseId}/topics`],
        ['topic editor', `/courses/${loop.courseId}/topics?edit=1`],
        ['topic warm-up', `/courses/${loop.courseId}/topics/${topicId}`],
        ['topic read', `/courses/${loop.courseId}/topics/${topicId}?view=read`],
        ['topic recall', `/courses/${loop.courseId}/topics/${topicId}?view=recall`],
        ['topic examples', `/courses/${loop.courseId}/topics/${topicId}?view=examples`],
        ['topic practice', `/courses/${loop.courseId}/topics/${topicId}?view=practice`],
        ['topic quiz', `/courses/${loop.courseId}/topics/${topicId}?view=quiz`],
        ['topic voice', `/courses/${loop.courseId}/topics/${topicId}?view=voice`],
        ['materials', `/courses/${loop.courseId}/materials`],
        ['plan', `/courses/${loop.courseId}/plan`],
        ['ask', `/courses/${loop.courseId}/ask`],
        ['mock exams', `/courses/${loop.courseId}/exams`],
        ['new mock exam', `/courses/${loop.courseId}/exams/new`],
        ['review', `/courses/${loop.courseId}/review`],
        ['map', `/courses/${loop.courseId}/map`],
        ['course settings', `/courses/${loop.courseId}/settings`],
      ]
      const failures: string[] = []
      for (const [name, url] of pages) {
        try {
          await expectNoSidewaysScroll(page, url)
        } catch (error) {
          failures.push(`${name}: ${(error as Error).message.split('\n')[0]}`)
        }
      }
      if (failures.length > 0) throw new Error(`Pages that scroll sideways for a long name:\n${failures.join('\n')}`)
    })
  }
})
