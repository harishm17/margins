/**
 * The UI state of a voice practice, as a pure reducer. The hook in use-voice-session.ts does the
 * imperative work (fetch, recognition, speech) and reports what happened here.
 */
import type { BoardSource, VoiceOption } from '@/lib/voice/turn-client'
import type { LobbyAlert, VoiceAlert } from './errors'
import type { VoiceStyle } from './voice-api'

export type Phase = 'lobby' | 'starting' | 'live' | 'summary'
export type InputMode = 'voice' | 'text'
export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused'

/** Why the session is not open any more. */
export type EndReason = 'user' | 'complete' | 'idle' | 'ended' | 'error'

/** A standing note about the microphone or recognizer, shown above the controls. */
export type MicNotice = 'unsupported' | 'language' | 'denied' | 'no-mic' | 'network' | 'unstable'

export type Evaluation = {
  isCorrect: boolean
  score: number
  comment: string
  explanation: string
  ungraded: boolean
  lookLinks?: BoardSource[]
}

export type EvaluationTone = 'accent' | 'warning' | 'danger' | 'neutral'

/** The badge for an evaluation: Correct, Partly, Not quite, or Noted when there was no answer key. */
export function evaluationBadge(evaluation: Pick<Evaluation, 'isCorrect' | 'score' | 'ungraded'>): {
  label: string
  tone: EvaluationTone
} {
  if (evaluation.ungraded) return { label: 'Noted', tone: 'neutral' }
  if (evaluation.isCorrect) return { label: 'Correct', tone: 'accent' }
  if (evaluation.score >= 0.4) return { label: 'Partly', tone: 'warning' }
  return { label: 'Not quite', tone: 'danger' }
}

/** `via`: spoken, or typed (a typed answer, and the Hint and Skip buttons). */
export type StudentEntry = { id: number; role: 'student'; text: string; via: 'voice' | 'text' }
export type CoachEntry = {
  id: number
  role: 'coach'
  text: string
  streaming: boolean
  interrupted: boolean
  /** A quiet line from the app in the coach's voice (the gentle line after a silence): not a turn, nothing was sent. */
  note?: boolean
  evaluation?: Evaluation
  hint?: string
}
export type TranscriptEntry = StudentEntry | CoachEntry

export type QuestionInfo = { index: number; total: number; text: string; options?: VoiceOption[] }

/**
 * What the board shows: the question, the idea to explain, the thing to predict or the claim just told, as text with
 * maths in it, and the page it comes from. It is the same text the coach says, so nothing is only audio.
 */
export type BoardItem = {
  kind: 'question' | 'concept' | 'prediction' | 'claim'
  text: string
  /** The check question that follows a claim. */
  question?: string
  options?: VoiceOption[]
  source?: BoardSource
  /** An idea to explain (teach-back): its name and concept. */
  idea?: { name: string; conceptId: string }
}

export type AnsweredQuestion = {
  text: string
  isCorrect: boolean
  score: number
  ungraded: boolean
  /** Where the question's concepts are in the student's own file, when the server knew. */
  lookLinks?: BoardSource[]
}

/** A teach-back idea that closed: explained, or taught after probes (with the pages to look at again). */
export type IdeaResult = { name: string; outcome: 'explained' | 'taught'; conceptId: string | null; lookAgain: string[]; lookLinks: BoardSource[] }

export type SpeechOutput = 'on' | 'off' | 'unsupported'

export type SessionState = {
  phase: Phase
  /** The coaching style of the open session (a sprint is always oral_quiz). */
  style: VoiceStyle
  inputMode: InputMode
  /** The language the coach speaks (en, es, ...). */
  language: string
  micPaused: boolean
  speech: SpeechOutput
  /** Coach audio is playing. */
  speaking: boolean
  /** A turn request is open (the coach is working or streaming). */
  turnActive: boolean
  interim: string
  /** The words are in and the wait for more has begun: the screen says it is still listening, and Done is ready. */
  holding: boolean
  entries: TranscriptEntry[]
  question: QuestionInfo | null
  /** The item the coach is on, updated from each tool result. */
  board: BoardItem | null
  /** Teach-back: the ideas that have closed, in order. */
  ideas: IdeaResult[]
  answered: AnsweredQuestion[]
  /** The coach said the drill is over; the summary follows when it stops talking. */
  complete: boolean
  alert: VoiceAlert | null
  micNotice: MicNotice | null
  /** What turns speech into text this session: the cloud service (spec 19.12) or the browser's own. */
  recognizer: 'cloud' | 'browser'
  lobbyAlert: LobbyAlert | null
  /** The daily limit was hit (the server said so), whatever the usage numbers say. */
  limitReached: boolean
  endReason: EndReason | null
  startedAt: number | null
  endedAt: number | null
  nextId: number
}

export const initialSessionState: SessionState = {
  phase: 'lobby',
  style: 'oral_quiz',
  inputMode: 'voice',
  language: 'en',
  micPaused: false,
  speech: 'on',
  speaking: false,
  turnActive: false,
  interim: '',
  holding: false,
  entries: [],
  question: null,
  board: null,
  ideas: [],
  answered: [],
  complete: false,
  alert: null,
  micNotice: null,
  recognizer: 'browser',
  lobbyAlert: null,
  limitReached: false,
  endReason: null,
  startedAt: null,
  endedAt: null,
  nextId: 1,
}

export type SessionAction =
  | { type: 'starting' }
  | { type: 'start-failed'; lobbyAlert: LobbyAlert; limitReached?: boolean }
  | {
      type: 'started'
      at: number
      style: VoiceStyle
      language?: string
      inputMode: InputMode
      speech: SpeechOutput
      micNotice: MicNotice | null
      recognizer?: 'cloud' | 'browser'
    }
  /** Cloud recognition failed and the browser's recognizer took over. */
  | { type: 'recognizer'; kind: 'cloud' | 'browser' }
  | { type: 'reset' }
  | { type: 'student-said'; text: string; via?: 'voice' | 'text' }
  | { type: 'turn-started' }
  | { type: 'coach-text'; delta: string }
  | { type: 'question'; question: QuestionInfo }
  | { type: 'board'; board: BoardItem }
  | { type: 'idea-done'; idea: IdeaResult }
  | { type: 'evaluation'; evaluation: Evaluation }
  | { type: 'hint'; text: string }
  | { type: 'session-complete' }
  | { type: 'turn-done' }
  | { type: 'turn-failed'; alert: VoiceAlert }
  | { type: 'turn-aborted' }
  | { type: 'speaking'; on: boolean }
  | { type: 'interim'; text: string }
  | { type: 'holding'; on: boolean }
  | { type: 'note'; text: string }
  | { type: 'mic-paused'; paused: boolean }
  | { type: 'input-mode'; mode: InputMode; micNotice?: MicNotice | null }
  | { type: 'speech'; output: SpeechOutput }
  | { type: 'mic-notice'; notice: MicNotice | null }
  | { type: 'dismiss-alert' }
  | { type: 'finish'; reason: EndReason; at: number; alert?: VoiceAlert | null }

/** The newest coach entry if it is still being written. */
function openCoachIndex(entries: TranscriptEntry[]): number {
  const last = entries.length - 1
  const entry = entries[last]
  return entry && entry.role === 'coach' && entry.streaming ? last : -1
}

function patchOpenCoach(state: SessionState, patch: (entry: CoachEntry) => CoachEntry): SessionState {
  const index = openCoachIndex(state.entries)
  if (index >= 0) {
    const entries = state.entries.slice()
    entries[index] = patch(entries[index] as CoachEntry)
    return { ...state, entries }
  }
  // Events outside a turn (should not happen): start a coach entry rather than lose them.
  const entry = patch({ id: state.nextId, role: 'coach', text: '', streaming: true, interrupted: false })
  return { ...state, entries: [...state.entries, entry], nextId: state.nextId + 1 }
}

function closeCoach(entries: TranscriptEntry[], interrupted: boolean): TranscriptEntry[] {
  const index = openCoachIndex(entries)
  if (index < 0) return entries
  const next = entries.slice()
  const entry = next[index] as CoachEntry
  const hasContent = entry.text.trim() !== '' || !!entry.evaluation || !!entry.hint
  if (!hasContent) {
    next.splice(index, 1)
    return next
  }
  next[index] = { ...entry, streaming: false, interrupted: interrupted && entry.text.trim() !== '' }
  return next
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'starting':
      return { ...state, phase: 'starting', lobbyAlert: null }

    case 'start-failed':
      return {
        ...initialSessionState,
        lobbyAlert: action.lobbyAlert,
        limitReached: action.limitReached ?? state.limitReached,
      }

    case 'started':
      return {
        ...initialSessionState,
        phase: 'live',
        style: action.style,
        language: action.language ?? 'en',
        startedAt: action.at,
        inputMode: action.inputMode,
        speech: action.speech,
        micNotice: action.micNotice,
        recognizer: action.recognizer ?? 'browser',
        limitReached: state.limitReached,
      }

    case 'reset':
      return { ...initialSessionState, limitReached: state.limitReached }

    case 'student-said':
      return {
        ...state,
        alert: null,
        interim: '',
        holding: false,
        entries: [...state.entries, { id: state.nextId, role: 'student', text: action.text, via: action.via ?? 'voice' }],
        nextId: state.nextId + 1,
      }

    case 'turn-started':
      return {
        ...state,
        alert: null,
        turnActive: true,
        entries: [
          ...closeCoach(state.entries, false),
          { id: state.nextId, role: 'coach', text: '', streaming: true, interrupted: false },
        ],
        nextId: state.nextId + 1,
      }

    case 'coach-text':
      return patchOpenCoach(state, (entry) => ({ ...entry, text: entry.text + action.delta }))

    case 'question':
      return {
        ...state,
        question: action.question,
        board: { kind: 'question', text: action.question.text, ...(action.question.options ? { options: action.question.options } : {}) },
      }

    case 'board':
      return { ...state, board: action.board }

    case 'idea-done':
      return { ...state, ideas: [...state.ideas, action.idea] }

    case 'evaluation': {
      const next = patchOpenCoach(state, (entry) => ({ ...entry, evaluation: action.evaluation }))
      return {
        ...next,
        answered: [
          ...next.answered,
          {
            text: state.question?.text ?? state.board?.question ?? state.board?.text ?? 'A question',
            isCorrect: action.evaluation.isCorrect,
            score: action.evaluation.score,
            ungraded: action.evaluation.ungraded,
            ...(action.evaluation.lookLinks && action.evaluation.lookLinks.length > 0 ? { lookLinks: action.evaluation.lookLinks } : {}),
          },
        ],
      }
    }

    case 'hint':
      return patchOpenCoach(state, (entry) => ({ ...entry, hint: action.text }))

    case 'session-complete':
      return { ...state, complete: true }

    case 'turn-done':
      return { ...state, turnActive: false, entries: closeCoach(state.entries, false) }

    case 'turn-failed':
      return { ...state, turnActive: false, alert: action.alert, entries: closeCoach(state.entries, false) }

    case 'turn-aborted':
      return { ...state, turnActive: false, speaking: false, entries: closeCoach(state.entries, true) }

    case 'speaking':
      return state.speaking === action.on ? state : { ...state, speaking: action.on }

    case 'interim':
      return state.interim === action.text ? state : { ...state, interim: action.text }

    case 'mic-paused':
      return { ...state, micPaused: action.paused, interim: action.paused ? '' : state.interim, holding: action.paused ? false : state.holding }

    case 'note':
      return {
        ...state,
        entries: [...state.entries, { id: state.nextId, role: 'coach', text: action.text, streaming: false, interrupted: false, note: true }],
        nextId: state.nextId + 1,
      }

    case 'holding':
      return state.holding === action.on ? state : { ...state, holding: action.on }

    case 'recognizer':
      return { ...state, recognizer: action.kind }
    case 'input-mode':
      return {
        ...state,
        inputMode: action.mode,
        micPaused: false,
        interim: '',
        holding: false,
        micNotice: action.micNotice === undefined ? (action.mode === 'voice' ? null : state.micNotice) : action.micNotice,
      }

    case 'speech':
      return { ...state, speech: action.output, speaking: action.output === 'on' ? state.speaking : false }

    case 'mic-notice':
      return { ...state, micNotice: action.notice }

    case 'dismiss-alert':
      return { ...state, alert: null }

    case 'finish':
      return {
        ...state,
        phase: 'summary',
        endReason: action.reason,
        endedAt: action.at,
        turnActive: false,
        speaking: false,
        interim: '',
        holding: false,
        alert: action.alert ?? null,
        entries: closeCoach(state.entries, false),
      }

    default:
      return state
  }
}

/** The orb shows one state; speaking and thinking win over the mic state. */
export function deriveOrbState(
  state: Pick<SessionState, 'phase' | 'inputMode' | 'micPaused' | 'speaking' | 'turnActive'>
): OrbState {
  if (state.phase !== 'live') return 'idle'
  if (state.speaking) return 'speaking'
  if (state.turnActive) return 'thinking'
  if (state.inputMode === 'text') return 'idle'
  return state.micPaused ? 'paused' : 'listening'
}

export const ORB_LABEL: Record<OrbState, string> = {
  idle: 'Your turn',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  paused: 'Paused',
}

export type SessionSummary = {
  answered: number
  correct: number
  partly: number
  /** 0..1 of graded answers that were correct, null when nothing was graded. */
  score: number | null
  /** The questions answered wrongly, each once, with the pages of their concepts when known. */
  revisit: { text: string; lookLinks: BoardSource[] }[]
  /** Teach-back: the ideas explained in the student's own words, and the ones the coach had to explain after two probes. */
  explained: string[]
  taught: { name: string; conceptId: string | null; lookAgain: string[]; lookLinks: BoardSource[] }[]
  /** Teach-back: the idea that was open when the session ended, if it never closed. */
  unfinished: { name: string; conceptId: string } | null
  /** How long the session ran, in seconds (0 when it never started). */
  seconds: number
  /** The same in whole minutes, rounded; 0 for a session under half a minute. */
  minutes: number
  exchanges: number
  /** How many of the student's messages were typed. */
  typed: number
}

export function summarize(state: Pick<SessionState, 'answered' | 'entries' | 'startedAt' | 'endedAt' | 'ideas'> & Partial<Pick<SessionState, 'board'>>): SessionSummary {
  const graded = state.answered.filter((item) => !item.ungraded)
  const correct = graded.filter((item) => item.isCorrect).length
  const partly = graded.filter((item) => !item.isCorrect && item.score >= 0.4).length
  const revisit: SessionSummary['revisit'] = []
  for (const item of graded.filter((answer) => !answer.isCorrect)) {
    const seen = revisit.find((entry) => entry.text === item.text)
    if (!seen) revisit.push({ text: item.text, lookLinks: item.lookLinks ?? [] })
    else if (seen.lookLinks.length === 0 && item.lookLinks) seen.lookLinks = item.lookLinks
  }
  const openIdea = state.board?.kind === 'concept' ? (state.board.idea ?? null) : null
  const seconds = state.startedAt !== null && state.endedAt !== null ? Math.max(0, (state.endedAt - state.startedAt) / 1000) : 0
  return {
    answered: state.answered.length,
    correct,
    partly,
    score: graded.length > 0 ? correct / graded.length : null,
    revisit,
    explained: state.ideas.filter((idea) => idea.outcome === 'explained').map((idea) => idea.name),
    taught: state.ideas.filter((idea) => idea.outcome === 'taught').map((idea) => ({ name: idea.name, conceptId: idea.conceptId, lookAgain: idea.lookAgain, lookLinks: idea.lookLinks })),
    unfinished: openIdea && !state.ideas.some((idea) => idea.name === openIdea.name) ? openIdea : null,
    seconds: Math.round(seconds),
    minutes: Math.round(seconds / 60),
    exchanges: state.entries.filter((entry) => entry.role === 'student').length,
    typed: state.entries.filter((entry) => entry.role === 'student' && entry.via === 'text').length,
  }
}

/** The one idea a drill after the session is about: the only idea taught, else the one left unfinished; with both or neither, none (the topic). */
export function practiceConceptOf(summary: Pick<SessionSummary, 'taught' | 'unfinished'>): string | null {
  if (summary.taught.length === 1 && !summary.unfinished) return summary.taught[0].conceptId
  if (summary.taught.length === 0 && summary.unfinished) return summary.unfinished.conceptId
  return null
}

/** The word under the orb: while the wait for more words runs, Listening becomes "Still listening". */
export function orbLabel(orb: OrbState, holding: boolean): string {
  return orb === 'listening' && holding ? STILL_LISTENING : ORB_LABEL[orb]
}

export const STILL_LISTENING = 'Still listening'
