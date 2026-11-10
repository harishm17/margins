import { postTutor } from '@/lib/ai-service/tutor'
import type { MissKind } from '@/lib/tutor/state'
import type { ClaimVerdictKind } from '@/lib/learning/recall-scores'

/** The body of POST /grade/recall (ai-service RecallGradeRequest). */
export type RecallGradeRequest = {
  prompt: string
  claims: { id: string; concept_id: string; concept_name: string; text: string; quote: string; page?: number }[]
  answer: string
  user_id: string
  project_id: string
  session_id?: string
}

export type RecallClaimVerdict = {
  claim_id: string
  verdict: ClaimVerdictKind
  student_quote?: string | null
  misconception?: string | null
  kind?: MissKind | null
  /** "Look again at p. 14: ...", for a missing or partial claim. */
  pointer?: string | null
  /** For a covered claim: true when it was stated without the support or reason the source gives, false when the reason was there. */
  reasoning_gap?: boolean | null
}

/** Verdicts per claim, or (ungraded) the one question that would make the answer gradable. */
export type RecallGradeAnswer = {
  status: 'graded' | 'ungraded'
  verdicts: RecallClaimVerdict[]
  clarifying_question?: string | null
  confidence: number
}

/** Throws TutorUnavailableError when the AI service cannot answer; nothing is graded then. */
export const requestRecallGrade = (request: RecallGradeRequest): Promise<RecallGradeAnswer> => postTutor('/grade/recall', request)
