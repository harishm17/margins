'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select } from '@/components/ui/select'
import { NARROW_QUERY, writeNarrowCookie } from '@/lib/map/narrow'
import { mapHref, NO_UNIT, type MapView } from '@/lib/map/params'

export type ToolbarUnit = { id: string | null; label: string }

/** The unit to look at, and the map or the list of it (spec §9). Both are in the address, so a view can be linked to. */
export function MapToolbar({
  courseId,
  units,
  unitId,
  nodeId,
  topicId,
  view,
  explicitView,
}: {
  courseId: string
  units: ToolbarUnit[]
  unitId: string | null
  nodeId: string | null
  /** The topic the address names, kept when the view moves. */
  topicId: string | null
  view: MapView
  /** The address names the view: a choice the student made, which stays. */
  explicitView: boolean
}) {
  const router = useRouter()
  // With no view in the address, a phone opens on the list and a wide window on the map, chosen on the server from the browser's
  // cookie. A cookie that is out of date (the window was a different width when it was written) or missing (the first page this
  // browser ever opened) gave the other one: the cookie is put right here and the page is read again with it. Choosing a view
  // puts it in the address, and then the cookie is not asked.
  React.useEffect(() => {
    if (explicitView) return
    const narrow = window.matchMedia(NARROW_QUERY).matches
    writeNarrowCookie(narrow)
    if (narrow !== (view === 'list')) router.refresh()
  }, [explicitView, view, router])
  const unitKey = (id: string | null) => id ?? NO_UNIT
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1 sm:max-w-[360px]">
        <Select
          aria-label="Unit"
          value={unitKey(unitId)}
          onValueChange={(next) => router.push(mapHref(courseId, { unitId: next === NO_UNIT ? null : next, view }))}
          options={units.map((unit) => ({ value: unitKey(unit.id), label: unit.label }))}
        />
      </div>
      <SegmentedControl<MapView>
        aria-label="How to show the unit"
        value={view}
        onValueChange={(next) => router.replace(mapHref(courseId, { unitId, topicId, nodeId, view: next }), { scroll: false })}
        options={[
          { value: 'map', label: 'Map' },
          { value: 'list', label: 'List view' },
        ]}
      />
    </div>
  )
}
