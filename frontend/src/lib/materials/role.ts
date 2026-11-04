/**
 * What a file is for. Set when the AI service validates the upload (the student's category wins
 * for a syllabus or past exam, otherwise the validator's reading of the file) and editable by the
 * student. Content and "other" files can be topic sources; syllabus and exam files never are, and
 * topic mapping and content generation never read them.
 */

export const MATERIAL_ROLES = ['content', 'syllabus', 'exam', 'other'] as const
export type MaterialRole = (typeof MATERIAL_ROLES)[number]

/** Words for the role badge and the menu that changes it. */
export const ROLE_LABELS: Record<MaterialRole, string> = {
  content: 'Content',
  syllabus: 'Syllabus',
  exam: 'Past exam',
  other: 'Other',
}

export const isMaterialRole = (value: unknown): value is MaterialRole =>
  typeof value === 'string' && (MATERIAL_ROLES as readonly string[]).includes(value)

/** The role a file starts with, from the upload category; the validator may refine content. */
export function roleForCategory(category: string): MaterialRole {
  if (category === 'syllabus') return 'syllabus'
  if (category === 'sample_exams') return 'exam'
  return 'content'
}

/** Whether files of this role can be what a topic is taught from. */
export const canBeTopicSource = (role: MaterialRole): boolean => role === 'content' || role === 'other'

/** A stored role as a MaterialRole (anything unknown reads as content, the column default). */
export const readRole = (value: unknown): MaterialRole => (isMaterialRole(value) ? value : 'content')

/** The words for a file's badge in the list: the student's own category (Lecture notes, Book chapters) while the role is still the content it started as. */
const CATEGORY_BADGE: Record<string, string> = { lecture_notes: 'Lecture notes', book_chapters: 'Book chapters' }
export function roleBadgeLabel(role: MaterialRole, category: string): string {
  return role === 'content' ? (CATEGORY_BADGE[category] ?? ROLE_LABELS.content) : ROLE_LABELS[role]
}
