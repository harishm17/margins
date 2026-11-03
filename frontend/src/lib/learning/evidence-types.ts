// Shared types for learner-model evidence (spec §3.2 to §3.4).

export type Assistance = 0 | 1 | 2 | 3

export type EvidenceSource =
  | 'warmup'
  | 'recall'
  | 'quiz'
  | 'review'
  | 'exam'
  | 'practice'
  | 'example'
  | 'voice'
  | 'teach_back'
  | 'ask_check'
  | 'reader'
  | 'drill'
  | 'implicit'
  | 'instruction'

// What an instruction event (source 'instruction', weight 0) showed the student (spec 18.2): a page pointer
// opened, the gap or full explainer, a worked example delivered, a revealed answer or missed claim, a reader
// restatement, a voice explanation.
export type InstructionKind =
  | 'pointer'
  | 'gap_explainer'
  | 'full_explainer'
  | 'worked_example'
  | 'reveal'
  | 'restatement'
  | 'voice_explain'

export type GradedBy = 'rule' | 'model' | 'self'

// One graded answer to one item, before it is split per concept.
export type ItemAnswerInput = {
  userId: string
  projectId: string
  topicId: string | null
  itemKey: string
  conceptIds: string[]
  blamedConceptId?: string
  source: EvidenceSource
  score: number
  assistance: Assistance
  confidence?: number
  gradedBy: GradedBy
  sessionKey: string
  latencyMs?: number
  metadata?: Record<string, unknown>
  at?: Date
}

// The fields replay reads from an evidence event.
export type EventRow = {
  source: EvidenceSource
  score: number
  assistance: Assistance
  confidence: number | null
  weight: number
  sessionKey: string
  createdAt: Date
  metadata: Record<string, unknown>
  // Present on stored events; replay uses them for the solid rule and the judgment gate (§3.6).
  itemKey?: string
  gradedBy?: GradedBy
}

// An EventRow plus the fields needed to insert it as an EvidenceEvent.
export type ConceptEvent = EventRow & {
  userId: string
  projectId: string
  topicId: string | null
  conceptId: string
  itemKey: string
  role: 'primary' | 'secondary'
  gradedBy: GradedBy
  latencyMs: number | null
}
