import { request } from '@playwright/test'
import { signInApi } from './auth'
import { withPrisma } from './db'

/**
 * A voice-review course for the e2e spec.
 *
 * The mock LLM writes quiz and drill questions that contain digits ("idea 1"), and the voice
 * backend drops any question with a digit or a math word (src/lib/voice/concept.ts), so the
 * seeded demo course always answers 422 "no conceptual questions". This fixture adds a small
 * course with hand-written conceptual questions to its own test account, straight in the dev
 * database (DATABASE_URL). It is idempotent.
 *
 * Progress is set so the sprint's three weakest topics are known: Recursion basics (no data),
 * Graph search (40, unfinished), Sorting by comparison (70); Hash tables (90) is left out.
 */
export const VOICE_TEST_EMAIL = 'voice-test@example.com'
const COURSE_NAME = 'Voice practice'

type Question = {
  question_type: string
  question_text: string
  options?: { id: string; text: string }[]
  correct_answer?: string
  sample_answer: string
  key_points: string[]
  explanation: string
  concepts_tested: string[]
}

const shortAnswer = (text: string, sample: string, points: string[]): Question => ({
  question_type: 'short_answer',
  question_text: text,
  sample_answer: sample,
  key_points: points,
  explanation: sample,
  concepts_tested: [],
})

const TOPICS: {
  name: string
  description: string
  quizScore: number | null
  complete: boolean
  questions: Question[]
}[] = [
  {
    name: 'Hash tables',
    description: 'How a hash function places keys into buckets, and what happens on a collision.',
    quizScore: 90,
    complete: true,
    questions: [
      {
        question_type: 'multiple_choice',
        question_text: 'Which statement best describes a hash table?',
        options: [
          { id: 'A', text: 'A list that keeps its items in sorted order' },
          { id: 'B', text: 'A structure that maps keys to buckets using a hash function' },
          { id: 'C', text: 'A tree where every node has two children' },
          { id: 'D', text: 'A queue that serves the oldest item first' },
        ],
        correct_answer: 'B',
        sample_answer: 'A hash table uses a hash function to choose a bucket for each key.',
        key_points: ['Maps keys to buckets'],
        explanation: 'A hash table uses a hash function to choose a bucket for each key.',
        concepts_tested: [],
      },
      shortAnswer('Why do hash tables need a way to handle collisions?', 'Two keys can land in the same bucket, so the table must keep both.', [
        'Different keys can share a bucket',
        'Chaining or probing keeps both keys',
      ]),
    ],
  },
  {
    name: 'Recursion basics',
    description: 'Base cases, recursive calls and how the call stack grows and unwinds.',
    quizScore: null,
    complete: false,
    questions: [
      shortAnswer('Why does every recursive function need a base case?', 'Without a base case the calls never stop.', [
        'It stops the calls',
        'Otherwise the stack overflows',
      ]),
      shortAnswer('Explain what the call stack does during a recursive call.', 'Each call waits on the stack until the call it made returns.', [
        'One frame per call',
        'Frames unwind in reverse order',
      ]),
    ],
  },
  {
    name: 'Graph search',
    description: 'Breadth first and depth first search, and when each one fits.',
    quizScore: 40,
    complete: false,
    questions: [
      shortAnswer('Explain why breadth first search finds shortest paths in unweighted graphs.', 'It visits nodes level by level, so the first time it reaches a node is by the fewest edges.', [
        'Level by level',
        'First visit is the fewest edges',
      ]),
      shortAnswer('When would you pick depth first search over breadth first search?', 'When you need to explore a whole branch, such as finding cycles or a topological order.', [
        'Explores a branch fully',
        'Cycles and ordering',
      ]),
    ],
  },
  {
    name: 'Sorting by comparison',
    description: 'Merge sort and quicksort, and why comparison sorts have a lower bound.',
    quizScore: 70,
    complete: true,
    questions: [
      shortAnswer('What is the idea behind merge sort?', 'Split the list, sort each half, then merge the sorted halves.', [
        'Divide and conquer',
        'Merge sorted halves',
      ]),
    ],
  },
]

export type VoiceFixture = {
  courseId: string
  topics: Record<string, string>
  /** The three weakest topics in sprint order. */
  weakest: string[]
}

export async function ensureVoiceFixture(baseURL: string): Promise<VoiceFixture> {
  // The first test sign-in makes the account.
  const api = await request.newContext({ baseURL })
  try {
    await signInApi(api, VOICE_TEST_EMAIL, 'Voice Tester')
  } finally {
    await api.dispose()
  }

  return withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: VOICE_TEST_EMAIL } })
    let project = await prisma.project.findFirst({ where: { userId: user.id, name: COURSE_NAME } })
    project ??= await prisma.project.create({
      data: { userId: user.id, name: COURSE_NAME, description: 'Fixture for the voice review spec.', status: 'active' },
    })

    const topics: Record<string, string> = {}
    for (const [index, spec] of TOPICS.entries()) {
      let topic = await prisma.topic.findFirst({ where: { projectId: project.id, name: spec.name } })
      topic ??= await prisma.topic.create({
        data: {
          projectId: project.id,
          name: spec.name,
          description: spec.description,
          keywords: [],
          orderIndex: index,
          sourceMaterialIds: [],
          userConfirmed: true,
        },
      })
      topics[spec.name] = topic.id
      await prisma.topicContent.upsert({
        where: { topicId_contentType: { topicId: topic.id, contentType: 'topic_quiz' } },
        create: { topicId: topic.id, contentType: 'topic_quiz', contentData: spec.questions },
        update: { contentData: spec.questions },
      })
      await prisma.topicProgress.upsert({
        where: { topicId_userId: { topicId: topic.id, userId: user.id } },
        create: {
          topicId: topic.id,
          userId: user.id,
          quizScore: spec.quizScore,
          quizCompleted: spec.complete,
          notesCompleted: spec.complete,
          examplesCompleted: spec.complete,
        },
        update: {
          quizScore: spec.quizScore,
          quizCompleted: spec.complete,
          notesCompleted: spec.complete,
          examplesCompleted: spec.complete,
        },
      })
    }

    return {
      courseId: project.id,
      topics,
      weakest: ['Recursion basics', 'Graph search', 'Sorting by comparison'],
    }
  })
}

/**
 * Forget the test account's voice sessions, so no earlier run leaves one "live" (a second
 * session would answer 409 ACTIVE_SESSION) or uses up the daily minutes.
 */
export async function clearVoiceSessions(): Promise<void> {
  await withPrisma((prisma) => prisma.voiceDrillSession.deleteMany({ where: { user: { email: VOICE_TEST_EMAIL } } }))
}
