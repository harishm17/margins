import type { QuizSetData } from '@/server/queries/topic'

type HardSetShape = Pick<QuizSetData, 'id' | 'kind' | 'createdAt'> & { questions: { difficulty?: string }[] }

/** A transfer quiz is a set whose every question is hard (the same test the next-activity loader uses). */
export function isHardQuizSet(set: Pick<HardSetShape, 'questions'>): boolean {
  return set.questions.length > 0 && set.questions.every((question) => question.difficulty === 'hard')
}

/**
 * The set a harder quiz (?difficulty=hard, from the transfer_quiz activity) opens on: the newest regular
 * set of all-hard questions that has not been attempted. Null when there is none, and a new one is offered.
 */
export function freshHardSet(sets: HardSetShape[], attempts: { setId: string }[]): string | null {
  const taken = new Set(attempts.map((attempt) => attempt.setId))
  const fresh = sets
    .filter((set) => set.kind === 'standard' && isHardQuizSet(set) && !taken.has(set.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return fresh[0]?.id ?? null
}
