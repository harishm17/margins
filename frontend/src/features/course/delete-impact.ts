'use client'

import * as React from 'react'
import { apiFetch } from '@/lib/api/client'
import { pluralize } from '@/lib/format'

export type DeleteImpact = { notes: number; ideas: number }

/**
 * What removing a file does to the student's work, as sentences with the real counts (GET /api/materials/[id]/delete-impact):
 * the notes on it are kept; the ideas taken only from it leave recall checks. Empty when it changes neither.
 */
export function impactSentences(impact: DeleteImpact | null): string[] {
  if (!impact) return []
  const out: string[] = []
  if (impact.notes > 0) out.push(`Your ${pluralize(impact.notes, 'note')} on this file ${impact.notes === 1 ? 'is' : 'are'} kept.`)
  if (impact.ideas > 0) out.push(`${pluralize(impact.ideas, 'idea')} taken only from this file ${impact.ideas === 1 ? 'leaves' : 'leave'} your recall checks.`)
  return out
}

/** The counts for one file, or null when they are not known (loading, or the request failed: the dialog then says nothing about them). */
export async function fetchDeleteImpact(materialId: string): Promise<DeleteImpact | null> {
  try {
    return await apiFetch<DeleteImpact>(`/api/materials/${encodeURIComponent(materialId)}/delete-impact`)
  } catch {
    return null
  }
}

/** The summed counts for these files, fetched while `enabled` (a dialog is open); null until they arrive. */
export function useDeleteImpact(materialIds: readonly string[], enabled: boolean): DeleteImpact | null {
  const [loaded, setLoaded] = React.useState<{ key: string; impact: DeleteImpact | null } | null>(null)
  const key = materialIds.join(',')
  React.useEffect(() => {
    if (!enabled || !key) return
    let current = true
    void Promise.all(key.split(',').map(fetchDeleteImpact)).then((all) => {
      if (!current) return
      const known = all.filter((item): item is DeleteImpact => item !== null)
      setLoaded({ key, impact: known.length === 0 ? null : { notes: known.reduce((n, i) => n + i.notes, 0), ideas: known.reduce((n, i) => n + i.ideas, 0) } })
    })
    return () => {
      current = false
    }
  }, [enabled, key])
  return enabled && loaded?.key === key ? loaded.impact : null
}
