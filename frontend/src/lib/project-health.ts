/** Blockers and readiness for the project health API, from facts the route has already worked out. */
export type HealthFacts = {
  /** Setup is at step 1 (lib/course-setup.ts): no files and nothing written. */
  materialsMissing: boolean
  listConfirmed: boolean
  contentReady: boolean
  voiceReady: boolean
}

export function healthReadiness(facts: HealthFacts): { blockers: string[]; readiness: string } {
  const blockers: string[] = []
  if (facts.materialsMissing) blockers.push('No validated materials')
  if (!facts.listConfirmed) blockers.push('Topics not confirmed')
  if (!facts.contentReady) blockers.push('No fully generated learning content')
  if (!facts.voiceReady) blockers.push('Voice drill has no conceptual questions')

  const readiness =
    blockers.length === 0
      ? 'ready'
      : facts.materialsMissing
        ? 'needs_materials'
        : !facts.listConfirmed
          ? 'needs_topic_confirmation'
          : 'in_progress'
  return { blockers, readiness }
}
