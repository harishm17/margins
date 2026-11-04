'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { NARROW_QUERY } from '@/lib/map/narrow'
import { NodePanel } from './node-panel'

/**
 * Where an idea's details sit. Beside the map (or under it) on a wide screen, as before; on a phone in a bottom sheet over
 * the list, so choosing an idea opens a clear "back" and the list stays where it was. The address still holds the idea
 * (?node=), so closing the sheet is a navigation back to the list and a reload reopens it.
 */
export function NodePanelFrame({
  serverNarrow,
  ...panelProps
}: {
  /** The width class the server read from the browser's cookie; the first paint agrees with it. */
  serverNarrow: boolean
} & Omit<React.ComponentProps<typeof NodePanel>, 'inSheet'>) {
  const { closeHref } = panelProps
  const name = panelProps.panel.name
  const router = useRouter()
  const narrow = useMediaQuery(NARROW_QUERY, serverNarrow)
  // The idea that was chosen, to give focus back to when the sheet closes.
  const opener = React.useRef<HTMLElement | null>(null)
  React.useEffect(() => {
    if (!narrow) return
    const chosen = document.querySelector<HTMLElement>('[data-node-link][aria-current="true"]')
    if (chosen) opener.current = chosen
  }, [narrow])

  if (!narrow) return <NodePanel {...panelProps} />
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : router.push(closeHref, { scroll: false }))}>
      <SheetContent
        aria-describedby="map-sheet-description"
        hideClose
        onOpenAutoFocus={(event) => {
          // Focus goes to the idea's name, as it did when the details were under the list.
          event.preventDefault()
          document.getElementById('map-panel-heading')?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          opener.current?.focus()
        }}
        className="max-sm:max-h-[90dvh]"
      >
        <SheetTitle className="sr-only">Details of {name}</SheetTitle>
        <SheetDescription id="map-sheet-description" className="sr-only">
          What your pages say about this idea, how you stand on it and ways to study it. Use Back to return to the list.
        </SheetDescription>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-[max(1rem,env(safe-area-inset-bottom))]"><NodePanel {...panelProps} inSheet />
        </div>
      </SheetContent>
    </Sheet>
  )
}
