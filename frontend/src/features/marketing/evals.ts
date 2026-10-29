import { GITHUB_URL } from '@/config/site'

/**
 * The eval numbers shown on /evaluation, in one place. Each block names the result file it is copied from;
 * evals.test.ts reads those files and fails when a number here differs from them. Change a number here only
 * together with its source.
 */

const RESULTS = `${GITHUB_URL}/blob/main/evals/results`

export const EVAL_FILES = {
  readme: `${GITHUB_URL}/blob/main/evals/README.md`,
  retrieval: `${RESULTS}/2026-10-20-rrf.md`,
  retrievalBaseline: `${RESULTS}/2026-10-20-baseline.md`,
  retrievalComparison: `${RESULTS}/2026-10-20-baseline-vs-rrf.md`,
  generation: `${RESULTS}/2026-10-21-structure.md`,
  modelChoice: `${RESULTS}/2026-10-20-model-choice.md`,
  opusEffort: `${RESULTS}/2026-10-21-opus-effort.md`,
  modelDecision: `${RESULTS}/2026-10-21-model-decision.md`,
}

/** evals/results/2026-10-20-rrf.md and 2026-10-20-baseline.md, "Overall". Macro averages over topics, K = 24. */
export const RETRIEVAL = {
  date: '2026-10-20',
  topics: 38,
  chunks: 306,
  documents: 3,
  k: 24,
  columns: ['recall@24', 'MRR', 'nDCG@24', 'hit@5'],
  rows: [
    { label: 'Hybrid search with reciprocal rank fusion (the app now)', values: ['0.989', '0.961', '0.932', '1.000'] },
    { label: 'Vector search only (reference)', values: ['0.984', '0.934', '0.917', '1.000'] },
    { label: 'Old hybrid search, before fusion', values: ['0.935', '0.830', '0.777', '0.895'] },
  ],
}

/** evals/results/2026-10-21-structure.md, header, "Judge" and "Automatic checks". */
export const GENERATION = {
  date: '2026-10-21',
  topics: 8,
  courses: 2,
  topicsPerCourse: 4,
  judgedItems: 32,
  model: 'opus:medium',
  judgeScores: [
    { label: 'Correctness', value: '4.88' },
    { label: 'Grounding in the source pages', value: '4.91' },
    { label: 'Teaching quality', value: '4.78' },
    { label: 'Quiz question quality', value: '4.50' },
  ],
  errors: 8,
  mathErrors: 2,
  /** `failed` rows are checks the output did not pass; `flagged` is a count to read, not a pass or fail. */
  checks: [
    { label: 'Notes with all expected sections', value: '0 of 8', status: 'failed' as const },
    { label: 'Notes inside the requested word band', value: '0 of 8 (mean 1,749 words)', status: 'failed' as const },
    { label: 'Plain-text fields with stray $ or backslash sequences (flagged for reading)', value: '38', status: 'flagged' as const },
    { label: 'Notes with 5-8 recap bullets', value: '8 of 8', status: 'passed' as const },
    { label: 'Worked-example sets with the requested count', value: '8 of 8', status: 'passed' as const },
    { label: 'Practice sets with the requested count', value: '8 of 8', status: 'passed' as const },
    { label: 'Quizzes with the requested question count', value: '8 of 8', status: 'passed' as const },
    { label: 'Quiz questions that restate a worked example (rescored, see the addendum)', value: '12% (4 of 32)', status: 'flagged' as const },
  ],
  costPerTopic: '$0.585',
  totalSpend: '$6.99',
}

/** evals/results/2026-10-21-model-decision.md, "Result". */
export const MODEL_CHOICE = {
  runs: '2026-10-20 and 2026-10-21',
  columns: ['Cost per topic', 'Correctness', 'Teaching', 'Quiz question quality', 'Maths errors'],
  rows: [
    { label: 'Opus, medium', values: ['$0.62', '4.81', '4.84', '4.38', '0'] },
    { label: 'Sonnet, medium', values: ['$0.24', '4.53', '3.84', '3.25', '6'] },
    { label: 'Haiku, medium', values: ['$0.02', '4.19', '3.75', '2.62', '7'] },
  ],
}
