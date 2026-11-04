/**
 * Working that cannot be asked or answered out loud: an expression with operators between numbers, an equation, a math symbol,
 * or a word that asks for a calculation. A bare number is not math ("step 2", "O(1) lookup", "a tree with 5 nodes"), and a word
 * counts only whole ("assume", "summary" and "resolve" are not "sum" and "solve"). The first version of this matched any digit and
 * any substring, which dropped most questions of a real quiz and left Quiz me with "no questions".
 */
export const MATH_PATTERN =
  /(\d\s*[-+*/^×÷±<>]\s*\d|\d\s*%|[\w)\]]\s*[=≈≠≤≥]\s*[\w(\[-]|[±√∫∑∆]|\\[a-z]+|\$[^$]+\$|\b(sqrt|integral|derivative|derive|calculate|solve|equation|formula|compute)\b)/i

export type VoiceQuestion = {
  question_type: string
  question_text: string
  options?: Array<{ id: string; text: string }>
  correct_answer?: string | number | boolean
  sample_answer?: string
  key_points?: string[]
  explanation?: string
  difficulty?: string
  concepts_tested?: string[]
  /** Ids of the concepts the question tests (the concept graph); absent on drills from before it. */
  concept_ids?: string[]
  source?: string
  topic_id?: string
}

const safeString = (value: unknown) => (value ? String(value) : '')
const safeStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
      .map((entry) => safeString(entry).trim())
      .filter(Boolean)
    : []

export const hasMath = (value: string) => MATH_PATTERN.test(value)

export const normalizeVoiceQuestion = (question: Partial<VoiceQuestion>): VoiceQuestion | null => {
  const questionText = safeString(question.question_text).trim()
  if (!questionText) return null

  return {
    question_type: safeString(question.question_type || 'conceptual'),
    question_text: questionText,
    options: Array.isArray(question.options)
      ? question.options
        .map((opt) => ({
          id: safeString((opt as { id?: unknown })?.id).trim(),
          text: safeString((opt as { text?: unknown })?.text).trim(),
        }))
        .filter((opt) => opt.id && opt.text)
      : [],
    correct_answer: question.correct_answer,
    sample_answer: safeString(question.sample_answer).trim(),
    key_points: safeStringArray(question.key_points),
    explanation: safeString(question.explanation).trim(),
    difficulty: safeString(question.difficulty).trim(),
    concepts_tested: safeStringArray(question.concepts_tested),
    concept_ids: safeStringArray(question.concept_ids),
    source: safeString(question.source).trim(),
    topic_id: safeString(question.topic_id).trim(),
  }
}

export const isConceptualQuestion = (question: VoiceQuestion) => {
  if (!question) return false
  if (question.question_type === 'numerical') return false

  // What the coach says aloud: the question, its options and the answer. The key points and tags are only its notes.
  const fields = [
    question.question_text,
    question.sample_answer,
    safeString(question.correct_answer),
    ...(question.options?.map(opt => opt.text) || []),
  ]

  return !fields.some(field => hasMath(safeString(field)))
}

export const filterConceptQuestions = (questions: VoiceQuestion[]) =>
  questions.filter(isConceptualQuestion)

export const extractQuestionsFromContent = (contentData: any): VoiceQuestion[] => {
  if (!contentData) return []
  if (Array.isArray(contentData)) {
    return contentData
      .map((entry: unknown) => normalizeVoiceQuestion((entry || {}) as Partial<VoiceQuestion>))
      .filter((entry: VoiceQuestion | null): entry is VoiceQuestion => entry !== null)
  }
  if (Array.isArray(contentData.questions)) {
    return contentData.questions
      .map((entry: unknown) => normalizeVoiceQuestion((entry || {}) as Partial<VoiceQuestion>))
      .filter((entry: VoiceQuestion | null): entry is VoiceQuestion => entry !== null)
  }
  return []
}

export const extractTextFromNotes = (contentData: any): string => {
  if (!contentData) return ''
  const parts: string[] = []

  const collect = (value: any) => {
    if (value == null) return
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(collect)
      return
    }
    if (typeof value === 'object') {
      Object.values(value).forEach(collect)
    }
  }

  collect(contentData)
  return parts.join('\n')
}
