'use client'

import * as React from 'react'
import type { CheckGradeHandler } from '@/components/ui/check-context'
import { apiFetch } from '@/lib/api/client'

/**
 * Where the "Check yourself" blocks of a topic's lesson send the student's own grade (level 2, `source=example`,
 * spec §5.4). The handler is stable, so the blocks do not render again for it.
 */
export function useCheckGrader(topicId: string): CheckGradeHandler {
  return React.useCallback(
    async ({ question, grade, idk, conceptId, conceptIds }) => {
      const result = await apiFetch<{ recorded?: boolean }>(`/api/topics/${topicId}/explainer-checks`, {
        method: 'POST',
        json: {
          question,
          grade,
          ...(idk ? { idk: true } : {}),
          ...(conceptId ? { conceptId } : {}),
          ...(conceptIds && conceptIds.length > 0 ? { conceptIds } : {}),
        },
      })
      return { recorded: result?.recorded === true }
    },
    [topicId]
  )
}
