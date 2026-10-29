import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Prisma, type PrismaClient } from '@prisma/client'

/**
 * The showcase account for the marketing and README screenshots: one student, one course, written by
 * hand (no model output), so nothing on a screenshot says "mock" or "placeholder".
 *
 * The course is "CS 161 Algorithms": nine files (one is a past exam), three units holding seven
 * topics, an exam date, a graded mock exam, a cited chat answer, and for the topic "Graph traversal"
 * real notes, worked examples, practice and a quiz with two attempts. The prose lives in
 * showcase-content.json. Idempotent: it deletes the showcase user (everything cascades) and builds
 * the account again. Local databases only: the screenshot script signs in with the local-only test sign-in.
 */
export const SHOWCASE_EMAIL = 'showcase@example.com'
const SHOWCASE_NAME = 'Jane Doe'
const COURSE_NAME = 'CS 161 Algorithms'

type Json = Record<string, any>
const content = JSON.parse(readFileSync(path.join(__dirname, 'showcase-content.json'), 'utf8')) as Json

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms)
const later = (ms: number) => new Date(Date.now() + ms)
/** Midnight UTC today plus `offsetMs`, but never in the future. */
const startOfUtcDay = (offsetMs: number) => {
  const now = new Date()
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return new Date(Math.min(midnight + offsetMs, now.getTime()))
}

/** Files: name, category (what the student chose), role, size, and the text of its chunks (heading, first page, last page, text). */
type FileSpec = {
  filename: string
  category: 'lecture_notes' | 'book_chapters' | 'sample_exams'
  size: number
  chunks: { heading: string; pages: [number, number]; text: string }[]
}

const FILES: FileSpec[] = [
  {
    filename: 'week1-asymptotics.pdf',
    category: 'lecture_notes',
    size: 1_184_000,
    chunks: [
      { heading: 'Asymptotic notation', pages: [2, 4], text: 'We write f(n) = O(g(n)) when f grows no faster than a constant multiple of g for large n. Big-Omega bounds growth from below and big-Theta means both bounds hold.' },
      { heading: 'Comparing growth rates', pages: [5, 7], text: 'Logarithms grow slower than any polynomial, and polynomials grow slower than any exponential. To compare two functions, look at the limit of their ratio.' },
    ],
  },
  {
    filename: 'week2-divide-and-conquer.pdf',
    category: 'lecture_notes',
    size: 1_652_000,
    chunks: [
      { heading: 'Recurrences and the Master theorem', pages: [3, 6], text: 'For T(n) = aT(n/b) + f(n), compare f(n) with n^(log_b a). If the leaves dominate, T(n) = Theta(n^(log_b a)). If the work is balanced, an extra log factor appears.' },
      { heading: 'Merge sort', pages: [7, 9], text: 'Merge sort splits the array in half, sorts each half recursively and merges the two sorted halves in linear time, so T(n) = 2T(n/2) + Theta(n) = Theta(n log n).' },
    ],
  },
  {
    filename: 'week3-sorting.pdf',
    category: 'lecture_notes',
    size: 1_938_000,
    chunks: [
      { heading: 'Quicksort', pages: [2, 5], text: 'Quicksort partitions around a pivot. With a random pivot the expected running time is O(n log n); the worst case is Theta(n^2).' },
      { heading: 'Lower bound for comparison sorts', pages: [8, 10], text: 'Any comparison sort needs at least log2(n!) = Omega(n log n) comparisons in the worst case, by the decision tree argument.' },
    ],
  },
  {
    filename: 'week4-graph-traversal.pdf',
    category: 'lecture_notes',
    size: 2_410_000,
    chunks: [
      { heading: 'Graphs and adjacency lists', pages: [2, 3], text: 'A graph G = (V, E) is stored as an adjacency list: for every vertex, the list of its neighbours. The lists take O(V + E) space in total.' },
      { heading: 'Breadth-first search', pages: [4, 4], text: 'BFS discovers vertices in order of their distance from the source s. Every vertex at distance k is dequeued before any vertex at distance k + 1, so d[v] is the length of a shortest path from s to v.' },
      { heading: 'Depth-first search', pages: [8, 9], text: 'Classify each edge when it is explored. A back edge (u, v) leads to an ancestor v that is still on the stack. A directed graph has a cycle if and only if DFS finds a back edge.' },
    ],
  },
  {
    filename: 'week5-shortest-paths.pdf',
    category: 'lecture_notes',
    size: 2_276_000,
    chunks: [
      { heading: 'Dijkstra', pages: [3, 6], text: 'Dijkstra repeatedly finalises the unfinished vertex with the smallest tentative distance, then relaxes its outgoing edges. It requires non-negative edge weights.' },
      { heading: 'Bellman-Ford', pages: [7, 9], text: 'Bellman-Ford relaxes every edge V - 1 times. It handles negative weights and detects negative cycles with one extra round.' },
    ],
  },
  {
    filename: 'week6-dynamic-programming.pdf',
    category: 'lecture_notes',
    size: 2_103_000,
    chunks: [
      { heading: 'Optimal substructure', pages: [2, 5], text: 'A problem suits dynamic programming when an optimal solution is built from optimal solutions to subproblems and the same subproblems recur.' },
      { heading: 'Longest common subsequence', pages: [6, 9], text: 'Let L[i][j] be the length of the longest common subsequence of the first i letters of X and the first j letters of Y. The table has (m + 1)(n + 1) cells.' },
    ],
  },
  {
    filename: 'clrs-ch22-graph-algorithms.pdf',
    category: 'book_chapters',
    size: 3_842_000,
    chunks: [
      { heading: 'Analysis', pages: [5, 6], text: 'Both searches visit each vertex once and examine each adjacency list once, for a total running time of O(V + E).' },
      { heading: 'Topological sort', pages: [11, 12], text: 'A topological sort of a directed acyclic graph lists the vertices so that every edge goes from an earlier vertex to a later one. Listing vertices by decreasing DFS finish time gives one.' },
    ],
  },
  {
    filename: 'midterm-2024.pdf',
    category: 'sample_exams',
    size: 588_000,
    chunks: [{ heading: 'Midterm 2024', pages: [1, 4], text: 'Problem 1 (12 points). Solve the recurrence T(n) = 4T(n/2) + n. Problem 2 (16 points). Run BFS from vertex s and give the distance labels.' }],
  },
  {
    filename: 'midterm-2025.pdf',
    category: 'sample_exams',
    size: 642_000,
    chunks: [{ heading: 'Midterm 2025', pages: [1, 4], text: 'Problem 1 (10 points). Explain why Dijkstra fails with negative weights. Problem 3 (15 points). Order the tasks with a depth-first search.' }],
  },
]

type TopicSpec = {
  name: string
  description: string
  keywords: string[]
  unit: number
  minutes: number
  objectives: string[]
  after?: number
  source: { file: string; pages: [number, number]; chunks: [number, number] }
  /** Mastery 0..1 and days until its review is due (negative: overdue). Null: no review yet. */
  review: { mastery: number; dueInDays: number; interval: number } | null
  /** What the student has done: notes and worked examples read, a quiz taken, the best quiz score. */
  progress: { learned: boolean; quizScore: number | null } | null
  examRelevant: boolean
}

const TOPICS: TopicSpec[] = [
  {
    name: 'Asymptotic analysis',
    description: 'Big-O, big-Omega and big-Theta, and how to compare growth rates.',
    keywords: ['big-O', 'growth rates', 'recurrences'],
    unit: 0,
    minutes: 30,
    objectives: ['compare two functions by their growth rate', 'prove an upper bound with the definition of big-O'],
    source: { file: 'week1-asymptotics.pdf', pages: [2, 7], chunks: [0, 1] },
    review: { mastery: 0.91, dueInDays: 12, interval: 14 },
    progress: { learned: true, quizScore: 95 },
    examRelevant: false,
  },
  {
    name: 'Divide and conquer',
    description: 'Splitting a problem, solving the parts, and combining them, with the Master theorem.',
    keywords: ['Master theorem', 'merge sort', 'recursion tree'],
    unit: 0,
    minutes: 40,
    objectives: ['solve a recurrence with the Master theorem', 'write the recurrence for a divide-and-conquer algorithm'],
    after: 0,
    source: { file: 'week2-divide-and-conquer.pdf', pages: [3, 9], chunks: [0, 1] },
    review: { mastery: 0.84, dueInDays: 9, interval: 7 },
    progress: { learned: true, quizScore: 90 },
    examRelevant: true,
  },
  {
    name: 'Sorting algorithms',
    description: 'Merge sort, quicksort and heapsort, with their running times and the comparison lower bound.',
    keywords: ['quicksort', 'merge sort', 'heapsort'],
    unit: 0,
    minutes: 35,
    objectives: ['trace merge sort and quicksort on a small array', 'explain why a comparison sort needs Omega(n log n) comparisons'],
    after: 1,
    source: { file: 'week3-sorting.pdf', pages: [2, 10], chunks: [0, 1] },
    review: { mastery: 0.68, dueInDays: 0, interval: 3 },
    progress: { learned: true, quizScore: 80 },
    examRelevant: false,
  },
  {
    name: 'Graph traversal',
    description: 'How breadth-first and depth-first search explore a graph, and when to use each.',
    keywords: ['BFS', 'DFS', 'topological sort'],
    unit: 1,
    minutes: 30,
    objectives: ['run breadth-first and depth-first search by hand', 'choose between them for a given problem', 'find shortest paths in an unweighted graph'],
    after: 2,
    source: { file: 'week4-graph-traversal.pdf', pages: [2, 9], chunks: [0, 2] },
    review: { mastery: 0.62, dueInDays: 3, interval: 3 },
    progress: { learned: true, quizScore: 75 },
    examRelevant: true,
  },
  {
    name: 'Shortest paths',
    description: 'Dijkstra, Bellman-Ford and why edge weights decide which one you can use.',
    keywords: ['Dijkstra', 'Bellman-Ford', 'relaxation'],
    unit: 1,
    minutes: 45,
    objectives: ['run Dijkstra by hand on a weighted graph', 'explain why negative edges break Dijkstra', 'pick the right algorithm for a graph'],
    after: 3,
    source: { file: 'week5-shortest-paths.pdf', pages: [3, 9], chunks: [0, 1] },
    review: null,
    progress: { learned: true, quizScore: null },
    examRelevant: true,
  },
  {
    name: 'Dynamic programming',
    description: 'Optimal substructure, overlapping subproblems, and building solutions bottom up.',
    keywords: ['memoization', 'knapsack', 'LCS'],
    unit: 2,
    minutes: 50,
    objectives: ['spot optimal substructure and overlapping subproblems', 'fill a table bottom up', 'recover the solution from the table'],
    after: 4,
    source: { file: 'week6-dynamic-programming.pdf', pages: [2, 9], chunks: [0, 1] },
    review: null,
    progress: null,
    examRelevant: false,
  },
  {
    name: 'Hash tables',
    description: 'Hash functions, collision resolution by chaining and open addressing, and load factor.',
    keywords: ['chaining', 'load factor', 'universal hashing'],
    unit: 2,
    minutes: 30,
    objectives: ['pick a hash function and handle collisions', 'work out the load factor and its effect on speed'],
    after: 2,
    source: { file: 'week3-sorting.pdf', pages: [11, 14], chunks: [1, 1] },
    review: null,
    progress: null,
    examRelevant: false,
  },
]
export const GRAPH_TOPIC = 3

const UNITS = [
  { title: 'Foundations', weekLabel: 'Weeks 1-3', summary: 'Growth rates, recurrences and sorting.' },
  { title: 'Graphs', weekLabel: 'Weeks 4-5', summary: 'Traversal and shortest paths.' },
  { title: 'Dynamic programming and hashing', weekLabel: 'Weeks 6-7', summary: 'Tables, memoization and hash tables.' },
]

export type ShowcaseIds = {
  email: string
  userId: string
  courseId: string
  topicIds: string[]
  graphTopicId: string
  materialIds: Record<string, string>
  examId: string
  threadId: string
}

const sourceOf = (materialIds: Record<string, string>, filename: string, start: number, end = start) => ({
  material_id: materialIds[filename],
  filename,
  page_start: start,
  page_end: end,
})

/** Where each quiz question, worked example and practice problem comes from. */
function withSources<T extends Json>(items: T[], refs: ReturnType<typeof sourceOf>[][]): T[] {
  return items.map((item, index) => ({ ...item, sources: refs[index] ?? refs[refs.length - 1] }))
}

export async function seedShowcase(prisma: PrismaClient): Promise<ShowcaseIds> {
  await prisma.user.deleteMany({ where: { email: SHOWCASE_EMAIL } })
  const user = await prisma.user.create({
    data: { email: SHOWCASE_EMAIL, name: SHOWCASE_NAME },
  })

  // The exam is in 16 days, stored as midnight UTC of that calendar date.
  const exam = later(16 * DAY)
  const examDate = new Date(Date.UTC(exam.getUTCFullYear(), exam.getUTCMonth(), exam.getUTCDate()))
  const course = await prisma.project.create({
    data: {
      userId: user.id,
      name: COURSE_NAME,
      description: 'Midterm and final prep: sorting, graphs, shortest paths and dynamic programming.',
      status: 'active',
      examDate,
      dailyMinutes: 60,
      examPromptDismissed: true,
      createdAt: ago(14 * DAY),
    },
  })

  // Files and their chunks.
  const materialIds: Record<string, string> = {}
  const chunkIds: Record<string, string[]> = {}
  for (const file of FILES) {
    const isExam = file.category === 'sample_exams'
    const material = await prisma.material.create({
      data: {
        projectId: course.id,
        category: file.category,
        filename: file.filename,
        gcsPath: `showcase/${course.id}/${file.filename}`,
        sizeBytes: BigInt(file.size),
        validationStatus: 'valid',
        role: isExam ? 'exam' : 'content',
        metadata: { mimeType: 'application/pdf', extension: '.pdf' },
        uploadedAt: ago(13 * DAY),
        validatedAt: ago(13 * DAY),
        ...(isExam
          ? {
              styleProfile: {
                version: 1,
                question_count: 5,
                total_points: 60,
                type_mix: [
                  { kind: 'multiple_choice', share: 0.4 },
                  { kind: 'short_answer', share: 0.4 },
                  { kind: 'numerical', share: 0.2 },
                ],
                points_distribution: [
                  { points: 10, count: 2 },
                  { points: 15, count: 2 },
                  { points: 20, count: 1 },
                ],
                typical_answer_length: 'a short paragraph or a worked trace',
                phrasing_conventions: ['Gives the graph or recurrence first, then asks the question', 'Asks for a justification after each answer'],
                task_verbs: ['run', 'explain', 'solve', 'order', 'justify'],
                multi_part: true,
                calculator_and_units: 'not stated',
                example_stems: [],
              },
            }
          : {}),
      },
    })
    materialIds[file.filename] = material.id
    chunkIds[file.filename] = []
    let index = 0
    for (const chunk of file.chunks) {
      const row = await prisma.materialChunk.create({
        data: {
          materialId: material.id,
          chunkText: chunk.text,
          sectionHierarchy: chunk.heading,
          pageStart: chunk.pages[0],
          pageEnd: chunk.pages[1],
          chunkIndex: index,
          tokenCount: Math.ceil(chunk.text.length / 4),
        },
      })
      chunkIds[file.filename].push(row.id)
      index += 1
    }
  }

  // Units and topics.
  const units = []
  for (const [index, unit] of UNITS.entries()) {
    units.push(await prisma.unit.create({ data: { projectId: course.id, orderIndex: index, ...unit } }))
  }
  const topicIds: string[] = []
  for (const [index, spec] of TOPICS.entries()) {
    const topic = await prisma.topic.create({
      data: {
        projectId: course.id,
        unitId: units[spec.unit].id,
        name: spec.name,
        description: spec.description,
        keywords: spec.keywords,
        orderIndex: index,
        sourceMaterialIds: [materialIds[spec.source.file]],
        userConfirmed: true,
        objectives: spec.objectives,
        prerequisiteIds: spec.after === undefined ? [] : [topicIds[spec.after]],
        estimatedMinutes: spec.minutes,
        examRelevant: spec.examRelevant,
        createdAt: ago(13 * DAY),
      },
    })
    topicIds.push(topic.id)
    await prisma.topicSource.create({
      data: {
        topicId: topic.id,
        materialId: materialIds[spec.source.file],
        pageStart: spec.source.pages[0],
        pageEnd: spec.source.pages[1],
        chunkIndexStart: spec.source.chunks[0],
        chunkIndexEnd: spec.source.chunks[1],
        role: 'primary',
      },
    })
    for (const chunkId of chunkIds[spec.source.file].slice(spec.source.chunks[0], spec.source.chunks[1] + 1)) {
      await prisma.topicChunkMapping.create({
        data: { topicId: topic.id, chunkId, relevanceScore: 0.9, relevanceSource: 'semantic_search' },
      })
    }
    if (spec.review) {
      await prisma.reviewSchedule.create({
        data: {
          userId: user.id,
          projectId: course.id,
          topicId: topic.id,
          mastery: spec.review.mastery,
          // "Due today" means since midnight UTC, so the plan puts it in today's list (the screenshots
          // are taken with the browser time zone set to UTC).
          dueAt: spec.review.dueInDays === 0 ? startOfUtcDay(5 * 60_000) : later(spec.review.dueInDays * DAY),
          intervalDays: spec.review.interval,
          streak: spec.review.mastery > 0.6 ? 2 : 1,
          lastReviewedAt: ago(2 * DAY),
        },
      })
    }
    if (spec.progress) {
      await prisma.topicProgress.create({
        data: {
          userId: user.id,
          topicId: topic.id,
          notesCompleted: spec.progress.learned,
          examplesCompleted: spec.progress.learned,
          quizCompleted: spec.progress.quizScore !== null,
          quizScore: spec.progress.quizScore,
          lastAccessedAt: ago((index + 1) * DAY),
        },
      })
    }
  }

  // The past exam says which topics it tests.
  const midterm = materialIds['midterm-2025.pdf']
  await prisma.material.update({
    where: { id: midterm },
    data: {
      examTopicMap: {
        version: 1,
        input_hash: 'showcase',
        questions: [
          { label: 'Problem 1', summary: 'Why Dijkstra fails with negative edge weights', topic_ids: [topicIds[4]] },
          { label: 'Problem 3', summary: 'Order tasks with a depth-first search', topic_ids: [topicIds[3]] },
        ],
      },
    },
  })

  // The topic with everything: Graph traversal.
  const graph = topicIds[GRAPH_TOPIC]
  const wk4 = 'week4-graph-traversal.pdf'
  const clrs = 'clrs-ch22-graph-algorithms.pdf'
  const midterm25 = 'midterm-2025.pdf'
  await prisma.topicContent.create({
    data: {
      topicId: graph,
      contentType: 'section_notes',
      contentData: content.notes,
      metadata: {
        chunk_count: 14,
        citations: [
          { filename: wk4, category: 'lecture_notes', pages: '4', page: 4, material_id: materialIds[wk4] },
          { filename: wk4, category: 'lecture_notes', pages: '9', page: 9, material_id: materialIds[wk4] },
          { filename: clrs, category: 'book_chapters', pages: '5-6', page: 5, material_id: materialIds[clrs] },
          { filename: midterm25, category: 'sample_exams', pages: '3', page: 3, material_id: materialIds[midterm25] },
        ],
      },
      createdAt: ago(3 * DAY),
    },
  })
  const exampleSources = [
    [sourceOf(materialIds, wk4, 4)],
    [sourceOf(materialIds, clrs, 11, 12), sourceOf(materialIds, wk4, 9)],
    [sourceOf(materialIds, wk4, 9)],
  ]
  await prisma.topicContent.create({
    data: {
      topicId: graph,
      contentType: 'solved_examples',
      contentData: withSources(content.examples, exampleSources),
      metadata: { example_type: 'solved', difficulty_level: 'medium', count: content.examples.length },
      createdAt: ago(3 * DAY),
    },
  })
  await prisma.topicContent.create({
    data: {
      topicId: graph,
      contentType: 'interactive_examples',
      contentData: withSources(content.practice, [[sourceOf(materialIds, wk4, 4)], [sourceOf(materialIds, clrs, 5, 6)], [sourceOf(materialIds, wk4, 9)]]),
      metadata: { example_type: 'interactive', difficulty_level: 'medium', count: content.practice.length },
      createdAt: ago(3 * DAY),
    },
  })

  const quiz = withSources(content.quiz, [
    [sourceOf(materialIds, clrs, 5, 6)],
    [sourceOf(materialIds, wk4, 4)],
    [sourceOf(materialIds, wk4, 9)],
    [sourceOf(materialIds, wk4, 4)],
    [sourceOf(materialIds, wk4, 2, 3)],
    [sourceOf(materialIds, wk4, 4), sourceOf(materialIds, wk4, 9)],
  ])
  const quizSet = randomUUID()
  await prisma.topicQuiz.create({ data: { id: quizSet, topicId: graph, questions: quiz, createdAt: ago(3 * DAY) } })
  await prisma.topicContent.create({
    data: {
      topicId: graph,
      contentType: 'topic_quiz',
      contentData: quiz,
      metadata: {
        total_questions: quiz.length,
        difficulty_level: 'medium',
        question_types: ['multiple_choice', 'true_false', 'numerical', 'short_answer'],
        quiz_set_id: quizSet,
      },
      createdAt: ago(3 * DAY),
    },
  })
  await prisma.quizAttempt.create({
    data: {
      userId: user.id,
      topicId: graph,
      quizSetId: quizSet,
      answers: content.quizAnswersFirst,
      results: content.quizResultsFirst,
      score: 29.17,
      takenAt: ago(2 * DAY + HOUR),
    },
  })
  await prisma.quizAttempt.create({
    data: {
      userId: user.id,
      topicId: graph,
      quizSetId: quizSet,
      answers: content.quizAnswersBest,
      results: content.quizResultsBest,
      score: 75,
      takenAt: ago(20 * HOUR),
    },
  })
  await prisma.learningSignal.create({
    data: {
      userId: user.id,
      projectId: course.id,
      topicId: graph,
      source: 'quiz',
      score: 0.75,
      confidence: 3,
      metadata: { quizSetId: quizSet },
      createdAt: ago(20 * HOUR),
    },
  })

  // A graded mock exam over every topic.
  const examQuestions: Json[] = (content.examQuestions as Json[]).map((question) => {
    const { topic, ...rest } = question
    return { ...rest, topic_id: topicIds[topic], topic_name: TOPICS[topic].name, concepts_tested: [] }
  })
  const answers: Record<string, string> = {}
  const graded: Json[] = []
  let earned = 0
  let total = 0
  examQuestions.forEach((question, index) => {
    const [answer, points, feedback] = content.examAnswers[String(index)] as [string, number, string | null]
    answers[String(index)] = answer
    const possible = question.points as number
    total += possible
    earned += points
    const kind = question.question_type as string
    const wrong = `Incorrect. The correct answer is ${question.correct_answer}. ${question.explanation}`
    graded.push({
      question_index: index,
      question_type: kind,
      question_text: question.question_text,
      student_answer: answer,
      correct_answer: question.sample_answer ?? question.correct_answer,
      points_possible: possible,
      points_earned: points,
      is_correct: points >= 0.7 * possible,
      needs_review: false,
      feedback: kind === 'short_answer' ? feedback : points ? 'Correct.' : wrong,
    })
  })
  const examDay = ago(2 * DAY)
  examDay.setUTCHours(14, 0, 0, 0)
  const sampleExam = await prisma.sampleExam.create({
    data: {
      projectId: course.id,
      name: `Sample Exam - ${examDay.toISOString().slice(0, 10)}`,
      questions: examQuestions,
      durationMinutes: 45,
      difficultyLevel: 'medium',
      topicsCovered: TOPICS.map((topic) => topic.name),
      createdAt: examDay,
    },
  })
  const started = new Date(examDay.getTime() + 5 * 60_000)
  const submitted = new Date(started.getTime() + 38 * 60_000)
  const submissionId = randomUUID()
  await prisma.examSubmission.create({
    data: {
      id: submissionId,
      sampleExamId: sampleExam.id,
      userId: user.id,
      answers,
      aiGrading: {
        graded_at: submitted.toISOString(),
        total_points: total,
        earned_points: earned,
        overall_score: Math.round((earned / total) * 10000) / 100,
        submission_id: submissionId,
        graded_questions: graded,
      },
      submittedAt: submitted,
      gradedAt: new Date(submitted.getTime() + 60_000),
      status: 'submitted',
      startedAt: started,
      deadlineAt: new Date(started.getTime() + 45 * 60_000),
      answersSavedAt: submitted,
    },
  })

  // Chat: one cited answer, three older threads.
  const thread = await prisma.chatThread.create({
    data: { userId: user.id, projectId: course.id, title: 'BFS or DFS', createdAt: ago(40 * 60_000), updatedAt: ago(39 * 60_000) },
  })
  await prisma.chatMessage.create({ data: { threadId: thread.id, role: 'user', content: content.chatQuestion, createdAt: ago(40 * 60_000) } })
  const answer: string = content.chatAnswer
  const chunkOf = (filename: string, index: number) => chunkIds[filename][index]
  const sources = [
    { marker: 1, chunkId: chunkOf(wk4, 1), materialId: materialIds[wk4], filename: wk4, pageStart: 4, pageEnd: 4, section: 'Breadth-first search', citedText: FILES[3].chunks[1].text },
    { marker: 2, chunkId: chunkOf(wk4, 2), materialId: materialIds[wk4], filename: wk4, pageStart: 9, pageEnd: 9, section: 'Depth-first search', citedText: FILES[3].chunks[2].text },
    { marker: 3, chunkId: chunkOf(clrs, 0), materialId: materialIds[clrs], filename: clrs, pageStart: 5, pageEnd: 6, section: 'Analysis', citedText: FILES[6].chunks[0].text },
  ]
  const marks = (content.chatMarks as [string, number][]).map(([sentence, marker]) => ({
    offset: answer.indexOf(sentence) + sentence.length,
    marker,
  }))
  await prisma.chatMessage.create({
    data: { threadId: thread.id, role: 'assistant', content: answer, citations: { sources, marks }, createdAt: ago(39 * 60_000) },
  })
  for (const [title, question, when] of [
    ['Master theorem practice', 'Can you walk me through the Master theorem?', ago(DAY + 3 * HOUR)],
    ['Dijkstra and negative weights', 'Why does Dijkstra fail with negative edges?', ago(3 * DAY)],
    ['Quicksort pivots', "How does the pivot choice change quicksort's running time?", ago(9 * DAY)],
  ] as [string, string, Date][]) {
    const other = await prisma.chatThread.create({
      data: { userId: user.id, projectId: course.id, title, createdAt: when, updatedAt: when },
    })
    await prisma.chatMessage.create({ data: { threadId: other.id, role: 'user', content: question, createdAt: when } })
  }

  return {
    email: SHOWCASE_EMAIL,
    userId: user.id,
    courseId: course.id,
    topicIds,
    graphTopicId: graph,
    materialIds,
    examId: sampleExam.id,
    threadId: thread.id,
  }
}

/** An exam attempt that started `minutesAgo` ago with the first six answers filled in, for the exam screenshot. */
export async function startExamAttempt(prisma: PrismaClient, ids: ShowcaseIds, minutesAgo = 3.25): Promise<void> {
  await prisma.examSubmission.deleteMany({ where: { sampleExamId: ids.examId, status: 'in_progress' } })
  const started = new Date(Date.now() - minutesAgo * 60_000)
  const answers: Record<string, string> = {}
  for (let index = 0; index < 6; index += 1) answers[String(index)] = content.examAnswers[String(index)][0]
  await prisma.examSubmission.create({
    data: {
      sampleExamId: ids.examId,
      userId: ids.userId,
      answers,
      status: 'in_progress',
      startedAt: started,
      deadlineAt: new Date(started.getTime() + 45 * 60_000),
      answersSavedAt: new Date(),
      submittedAt: started,
    },
  })
}

export async function clearExamAttempt(prisma: PrismaClient, ids: ShowcaseIds): Promise<void> {
  await prisma.examSubmission.deleteMany({ where: { sampleExamId: ids.examId, status: 'in_progress' } })
}

export type { Prisma }
