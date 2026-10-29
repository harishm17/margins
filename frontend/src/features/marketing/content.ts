import { BRAND_NAME } from '@/config/brand'
import { CONTACT_EMAIL, GITHUB_URL } from '@/config/site'

/**
 * The words on the public pages that make claims. Every one of them is checkable against the product, the
 * README or the eval results; the note after each says where. Change a claim here only with its source.
 */

export type Dimensions = { width: number; height: number }

export type LoopStep = {
  id: string
  title: string
  text: string
  /** Screenshot stem in public/screens, its size, and the size of its phone version. */
  shot: string
  desktop: Dimensions
  mobile: Dimensions
  alt: string
}

export const LOOP_STEPS: LoopStep[] = [
  {
    id: 'upload',
    title: 'Upload your files',
    // Upload accepts PDF, DOCX, PPTX and DOC up to 25 MB (materials page); "Past exams" is a category there.
    text: 'Add lecture notes, book chapters and past exams as PDF, Word or PowerPoint files. Mark the past exams so Margins can learn how they are written.',
    shot: 'materials',
    desktop: { width: 1200, height: 901 },
    mobile: { width: 780, height: 1400 },
    alt: 'The Materials page with a drop zone and a list of lecture notes, a book chapter and two past exams',
  },
  {
    id: 'plan',
    title: 'Check the course plan',
    // README, "What it does" step 2.
    text: 'Margins splits the course into units and topics, each tied to the pages that teach it. Rename, merge or move anything before it writes a word.',
    shot: 'topics-edit',
    desktop: { width: 1200, height: 901 },
    mobile: { width: 780, height: 1400 },
    alt: 'The topic editor listing units and topics, each with the file and pages it is taught from',
  },
  {
    id: 'daily',
    title: 'Follow a daily plan',
    // README step 5: a quiz the next day, spaced reviews, a mock exam after each unit and full mocks.
    text: 'Give your exam date and the time you have each day. Margins lists what to learn, quiz and review on each day, with spaced reviews and full mock exams before the date.',
    shot: 'plan-exam-day',
    desktop: { width: 1200, height: 735 },
    mobile: { width: 780, height: 1400 },
    alt: 'The plan for the last two days before the exam: a final review day and exam day, each with timed review items',
  },
  {
    id: 'study',
    title: 'Study each topic',
    // README step 3: notes, examples, quiz; notes list the files and pages they came from.
    text: 'Read notes written from your own pages, work through examples and practice one step at a time, then take a quiz. Each section names the files and pages it came from.',
    shot: 'notes-detail',
    desktop: { width: 1200, height: 900 },
    mobile: { width: 780, height: 1400 },
    alt: 'Topic notes with a Python code block, an outline of the page and a list of the source files and pages',
  },
  {
    id: 'mock',
    title: 'Sit mocks that match your exams',
    // new-exam-form.tsx: "Match my past exams", with its own help text.
    text: 'Mock exams are timed and autosaved. Choose Match my past exams and the questions follow the wording, task verbs and answer length of the exams you uploaded.',
    shot: 'exam-new',
    desktop: { width: 1200, height: 901 },
    mobile: { width: 780, height: 1400 },
    alt: 'The new mock exam form with question count, time limit, difficulty, question mix and the Match my past exams option ticked',
  },
  {
    id: 'review',
    title: 'Review what you missed',
    // Quiz review shows the answer, "Why" and "From <file>, p. N"; Retry what you missed and Voice practice exist.
    text: 'Results show the right answer, why, and the page it is from. Retry what you missed, or answer questions out loud in Voice practice.',
    shot: 'quiz-results',
    desktop: { width: 1200, height: 901 },
    mobile: { width: 780, height: 1400 },
    alt: 'Quiz results with a missed question, the correct answer, an explanation and the file and page it is from',
  },
]

const EVAL_URL = `${GITHUB_URL}/blob/main/evals/results/2026-10-21-structure.md`
const MODEL_DECISION_URL = `${GITHUB_URL}/blob/main/evals/results/2026-10-21-model-decision.md`

export const LINKS = {
  github: GITHUB_URL,
  license: `${GITHUB_URL}/blob/main/LICENSE`,
  eval: EVAL_URL,
  modelDecision: MODEL_DECISION_URL,
  evalReadme: `${GITHUB_URL}/blob/main/evals/README.md`,
  mail: `mailto:${CONTACT_EMAIL}`,
}

/** The numbers are quoted as they are in README.md and evals/results/2026-10-21-structure.md. */
export const EVAL_FACTS = {
  date: 'October 21, 2026',
  topics: 8,
  correctness: '4.88',
  grounding: '4.91',
  errors: 8,
  mathErrors: 2,
  // "Models: opus:medium" and "Judge: opus:medium": the judge is the model that wrote the text.
  judge: 'Claude Opus',
  // "Automatic checks" table: the two checks that failed on every topic.
  notesWithAllSections: '0 of 8',
  notesInWordBand: '0 of 8',
}

export type Faq = { id: string; question: string; answer: string[] }

export const FAQ: Faq[] = [
  {
    id: 'free',
    question: 'Is it free?',
    // Terms: "It is free to use". No billing code exists. Budgets: ai-service/app/services/budget.py (per user and
    // site-wide, reset after midnight UTC); voice has its own daily minutes (VOICE_DAILY_MINUTES).
    answer: [
      `Yes. ${BRAND_NAME} is free to use, with no paid plan and no card.`,
      'Every AI request costs real money, so each account has a daily AI allowance, and the whole site has a daily cap. When one is used up, anything that needs the AI (new notes, quizzes, chat answers, voice practice) waits until it resets after midnight UTC. What is already written stays readable. Voice practice also has its own daily time limit.',
    ],
  },
  {
    id: 'files',
    question: 'Which files can I upload?',
    // Upload copy: "PDF, DOCX, PPTX or DOC, up to 25 MB each"; the validator rejects scanned PDFs (no OCR).
    answer: [
      'PDF, Word (DOCX or DOC) and PowerPoint (PPTX) files, up to 25 MB each. A PDF needs selectable text: scanned pages are not read yet.',
      'When you upload past exams, choose Past exams. That is what lets mock exams match their style.',
    ],
  },
  {
    id: 'mistakes',
    question: 'Does it make things up?',
    // Terms: "can contain mistakes"; README: generators only see the topic's own excerpts; Ask says when the files
    // do not cover the question; the eval lists every error the judge found.
    answer: [
      'It can make mistakes, like any AI. Notes and quizzes are written from excerpts of your own files and point back to them, so you can check a claim against the page. Answers in Ask come only from your files, and Ask says so when they do not cover your question.',
      'We measure this and publish the errors the judge found, not only the scores. For anything that matters, check it against your course materials and your instructor.',
    ],
  },
  {
    id: 'privacy',
    question: 'What happens to my files?',
    // Privacy page, "What we store", "How it's used", "Services we use", "Your choices".
    answer: [
      'They stay in your account and are used only to run Margins for you. The text of your files and your questions are sent to Anthropic to write study material and answers; Anthropic does not use this data to train its models by default. We do not sell your data, show ads or use your files to train AI models.',
      `When you delete a course, its files and everything made from them are deleted. You can delete your whole account yourself in Settings; if you need help, email ${CONTACT_EMAIL}. Voice practice uses your browser's speech recognition, which may send audio to Google (Chrome) or Apple (Safari).`,
    ],
  },
  {
    id: 'model',
    question: 'Which AI model does it use?',
    // README "Models" and evals/results/2026-10-21-model-decision.md. These are the defaults in ai-service/app/config.py.
    answer: [
      'Claude, from Anthropic. By default Claude Opus writes the notes, examples, quizzes and exams, plans the course and answers questions in Ask. Claude Haiku checks uploaded files, grades short answers and runs the voice coach.',
      'We tried Sonnet and Haiku for writing as well. They made maths errors in our eval, so writing stays on Opus.',
    ],
  },
  {
    id: 'self-host',
    question: 'Can I run it myself?',
    // README "Run it locally": needs an Anthropic API key (or LLM_PROVIDER=mock).
    answer: [
      'Yes. The code is MIT licensed. The README explains how to run it with Docker or without, and you bring your own Anthropic API key.',
    ],
  },
]
