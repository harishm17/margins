/**
 * Untrusted text in a prompt: one rule for every slot (prompt audit R2). The twin of
 * ai-service/app/services/llm/untrusted.py; keep the two in step.
 *
 * Text from the student's files or the student's own words is data. It goes into the prompt inside a tag and must not be
 * able to end that tag (or an outer one). Only a closing tag of a name the prompts use (`PROMPT_TAGS`, or the slot's own
 * name) is neutralised (`</notes` becomes `&lt;/notes`); every other character stays as written, so `a < b`, `x<y`, `&`
 * and HTML such as `</div>` reach the model unchanged. Attribute values are escaped in full.
 * Used by the audited (v2) prompts only.
 */

/** The same names, sorted, as the Python `PROMPT_TAGS`. */
export const PROMPT_TAGS: readonly string[] = [
  'already_seen', 'answer_key', 'app_result', 'ask_what_is_unclear', 'authored_answer', 'authored_solution',
  'candidate_pairs', 'check_question', 'claim', 'concept', 'concepts', 'confusable', 'confusable_concepts',
  'conversation', 'course_concepts', 'course_map', 'course_terms', 'current_step', 'difficulty', 'entry_points',
  'exam', 'excerpt', 'excerpts', 'file', 'gap', 'gaps', 'hints_shown', 'item', 'items', 'key_points', 'leak_notice',
  'move', 'notes', 'objective', 'objectives', 'outline', 'pair', 'passage', 'past_exam_files', 'past_exam_style',
  'prerequisite_concepts', 'problem', 'question', 'quote', 'recall_prompt', 'request', 'requests', 'rules',
  'sample_answer', 'section', 'situation', 'source_claim', 'source_claims', 'source_excerpts', 'source_notes',
  'source_passages', 'start_of_text', 'step_question', 'student_answer', 'student_answer_note', 'student_attempts',
  'student_focus', 'student_message', 'student_misconception', 'student_take', 'student_thinking', 'student_words',
  'student_working', 'syllabus', 'topic', 'topics', 'transfer_note', 'tutor_reply', 'units',
]

const TAG_NAMES = new Set(PROMPT_TAGS)
const CLOSING = /<\/(\s*)([A-Za-z_][A-Za-z0-9_-]*)/g

/** `text` with every closing tag of a prompt tag (and of each name in `extra`) made inert. */
export function neutralise(text: string | null | undefined, extra: Iterable<string> = []): string {
  const names = new Set(TAG_NAMES)
  for (const name of extra) names.add(name.toLowerCase())
  return (text ?? '').replace(CLOSING, (_match, space: string, name: string) => (names.has(name.toLowerCase()) ? '&lt;/' : '</') + space + name)
}

/** A value for inside double quotes in a tag's attribute (as Python's html.escape with quote=True). */
export function attr(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

export type TagAttrs = Record<string, string | number | boolean | null | undefined>

const attributesOf = (attrs: TagAttrs): string =>
  Object.entries(attrs)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ` ${key}="${attr(value)}"`)
    .join('')

/** `<name a="v">` newline, the text neutralised, newline `</name>`. Attributes that are null or undefined are left out. */
export function untrustedTag(name: string, text: string | null | undefined, attrs: TagAttrs = {}): string {
  return `<${name}${attributesOf(attrs)}>\n${neutralise(text, [name])}\n</${name}>`
}

/** As `untrustedTag`, on one line, for short values. */
export function inlineTag(name: string, text: string | null | undefined, attrs: TagAttrs = {}): string {
  return `<${name}${attributesOf(attrs)}>${neutralise(text, [name])}</${name}>`
}
