import { prisma } from '@/lib/db/prisma'

/** Whether the topic's pages have been read into ideas with claims: Teach it back and Read it with me need them, Quiz me does not. */
export async function topicHasClaims(topicId: string): Promise<boolean> {
  return (await prisma.conceptClaim.count({ where: { concept: { topicId, status: 'active' } } })) > 0
}

/**
 * Whether Teach it back can run from this link. With an idea named (the map's panel and the recall card name one) it is that
 * idea's claims that count, however many the topic's other ideas have; `ofIdea` says the answer is about the idea, for the
 * lobby's wording. An idea that is not an active idea of the topic is judged by the topic.
 */
export async function teachBackClaims(topicId: string, conceptId?: string): Promise<{ hasClaims: boolean; ofIdea: boolean }> {
  if (conceptId) {
    const idea = await prisma.concept.findFirst({ where: { id: conceptId, topicId, status: 'active' }, select: { id: true } })
    if (idea) return { hasClaims: (await prisma.conceptClaim.count({ where: { conceptId: idea.id } })) > 0, ofIdea: true }
  }
  return { hasClaims: await topicHasClaims(topicId), ofIdea: false }
}
