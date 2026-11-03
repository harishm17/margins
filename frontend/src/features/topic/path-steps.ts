import { PATH_VIEWS, type PathView } from './types'

/**
 * The steps of the path this topic can offer (Review Focus 2: no step that cannot work). Warm-up needs a
 * bank and a topic not read yet (or one already taken); Recall needs concepts, or concepts on the way. A topic from before concepts,
 * or whose extraction failed, is Read, Practice, Quiz. Every view still has its address.
 */
export function pathSteps(input: {
  hasConcepts: boolean
  warmupReady: boolean
  warmupDone: boolean
  /** The topic is read: a pretest after reading measures nothing new (spec §5.1). Left out, it counts as not read. */
  readDone?: boolean
  preparingConcepts: boolean
}): PathView[] {
  return PATH_VIEWS.filter((step) => {
    if (step === 'warmup') return (input.warmupReady && !input.readDone) || input.warmupDone
    if (step === 'recall') return input.hasConcepts || input.preparingConcepts
    return true
  })
}
