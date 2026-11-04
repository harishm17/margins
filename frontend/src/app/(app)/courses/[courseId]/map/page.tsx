import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { TreeStructure } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ListView } from '@/features/map/list-view'
import { MapToolbar } from '@/features/map/map-toolbar'
import { InPageSkipLink } from '@/components/shell/skip-link'
import { MapView } from '@/features/map/map-view'
import { NodePanel, type PanelWords } from '@/features/map/node-panel'
import { prisma } from '@/lib/db/prisma'
import { conceptTeachBackPrompt } from '@/lib/learning/recall-server'
import { eventLine, frontierTexts, stateLine } from '@/lib/map/copy'
import { defaultUnit } from '@/lib/map/default-unit'
import { layoutMap } from '@/lib/map/layout'
import { isNarrow, NARROW_COOKIE, narrowKnown } from '@/lib/map/narrow'
import { mapHref, NO_UNIT, parseView } from '@/lib/map/params'
import { getCourseShell } from '@/server/queries/courses'
import { getUnitMap, getConceptPanel, listMapUnits, type MapUnit } from '@/server/queries/map'
import { getPlanData } from '@/server/queries/plan'
import { requireUser } from '@/server/session'
import { getTimeZone } from '@/server/timezone'

export const metadata: Metadata = { title: 'Map' }

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

const unitLabel = (unit: MapUnit) => (unit.weekLabel ? `${unit.weekLabel}: ${unit.title}` : unit.title)

export default async function MapPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>
  searchParams: Promise<{ unit?: string | string[]; topic?: string | string[]; node?: string | string[]; view?: string | string[] }>
}) {
  const user = await requireUser()
  const { courseId } = await params
  const query = await searchParams
  // These do not depend on each other.
  const [course, units, timeZone, cookieStore] = await Promise.all([getCourseShell(user.id, courseId), listMapUnits(user.id, courseId), getTimeZone(), cookies()])
  if (!course) notFound()

  // The view the address names; without one, a phone (the browser's cookie says so) opens on the list, which it reads better
  // than a picture that scrolls sideways, and everything else on the map. Chosen here so the map is never drawn and swapped.
  const explicitView = first(query.view) !== undefined
  const narrowCookie = explicitView ? undefined : cookieStore.get(NARROW_COOKIE)?.value
  const view = explicitView ? parseView(first(query.view)) : isNarrow(narrowCookie) ? 'list' : 'map'
  // A browser's first page has not told the server its width yet. Both views are then in the page and the window's width picks one
  // (the app's sm breakpoint, the same line the cookie uses), so a phone never sees the map drawn and swapped for the list.
  const widthUnknown = !explicitView && !narrowKnown(narrowCookie)
  const intro = (
    <PageIntro
      title="Map"
      description="One unit at a time: what builds on what, and where you stand on each idea. The topic pages are the main way through; this is for seeing how ideas connect."
    />
  )
  if (units.length === 0) {
    return (
      <Page>
        {intro}
        <EmptyState
          icon={<TreeStructure />}
          title="No map yet"
          action={
            <Button asChild variant="primary">
              <Link href={`/courses/${courseId}/topics`}>Go to topics</Link>
            </Button>
          }
        >
          The map appears once Margins has found the ideas in a topic. Open a topic to start that.
        </EmptyState>
      </Page>
    )
  }

  // Which unit: the one asked for, the one a topic or idea belongs to, else the unit of today's plan.
  const known = new Set(units.map((unit) => unit.id))
  const unitParam = first(query.unit)
  const topicParam = first(query.topic)
  const nodeParam = first(query.node)
  let unitId: string | null | undefined = unitParam === NO_UNIT ? null : unitParam && known.has(unitParam) ? unitParam : undefined
  if (unitId === undefined && topicParam) {
    const topic = await prisma.topic.findFirst({ where: { id: topicParam, projectId: courseId, project: { userId: user.id } }, select: { unitId: true } })
    if (topic && known.has(topic.unitId)) unitId = topic.unitId
  }
  if (unitId === undefined && nodeParam) {
    const concept = await prisma.concept.findFirst({ where: { id: nodeParam, projectId: courseId, project: { userId: user.id } }, select: { topic: { select: { unitId: true } } } })
    if (concept && known.has(concept.topic.unitId)) unitId = concept.topic.unitId
  }
  if (unitId === undefined || !known.has(unitId)) {
    const plan = await getPlanData(user.id, courseId, timeZone).then(
      (data) => data?.plan ?? null,
      () => null
    )
    unitId = defaultUnit(plan, units.map((unit) => unit.id))
  }

  const now = new Date()
  // The idea named in the address is read at the same time as the unit; it is used when it turns out to be in the unit.
  const [{ nodes, edges }, namedPanel] = await Promise.all([
    getUnitMap(user.id, courseId, unitId, now),
    nodeParam ? getConceptPanel(user.id, courseId, nodeParam, now) : Promise.resolve(null),
  ])
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const selectedId = nodeParam && byId.has(nodeParam) ? nodeParam : (topicParam ? nodes.find((node) => node.topicId === topicParam)?.id : undefined) ?? null
  const panel = !selectedId ? null : selectedId === nodeParam ? namedPanel : await getConceptPanel(user.id, courseId, selectedId, now)

  const unit = units.find((item) => item.id === unitId)
  const label = `${unit ? unitLabel(unit) : 'Unit'}: ${nodes.length} ${nodes.length === 1 ? 'idea' : 'ideas'}`
  const hrefFor = (nodeId: string) => mapHref(courseId, { unitId, nodeId, view })

  let words: PanelWords | null = null
  if (panel) {
    const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone })
    words = {
      stateLine: stateLine(panel.label, panel.dueAt, now, timeZone),
      frontier: frontierTexts(nodes)[panel.id] ?? null,
      events: panel.events.map((event) => ({ id: event.id, text: eventLine(event), when: date.format(new Date(event.createdAt)) })),
      teachBackPrompt: conceptTeachBackPrompt(panel.name),
    }
  }

  return (
    <Page>
      {intro}
      <MapToolbar
        courseId={courseId}
        units={units.map((item) => ({ id: item.id, label: unitLabel(item) }))}
        unitId={unitId}
        nodeId={selectedId}
        view={view}
        topicId={topicParam ?? null}
        explicitView={explicitView}
      />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <section aria-labelledby="map-unit-heading" className="min-w-0">
          <h2 id="map-unit-heading" className="sr-only">
            {label}
          </h2>
          {/* Past the ideas to the one chosen: the keyboard would otherwise cross every idea to reach it. */}
          {panel && nodes.length > 0 ? <InPageSkipLink href="#map-panel-heading">Skip to the details of {panel.name}</InPageSkipLink> : null}
          {nodes.length === 0 ? (
            <EmptyState icon={<TreeStructure />} title="Nothing to show for this unit yet">
              The ideas of this unit have not been found yet. Open one of its topics to start that.
            </EmptyState>
          ) : widthUnknown ? (
            <>
              <div className="max-sm:hidden">
                <MapView nodes={nodes} edges={edges} layout={layoutMap(nodes, edges)} selectedId={selectedId} hrefFor={hrefFor} label={label} />
              </div>
              <div className="sm:hidden">
                <ListView nodes={nodes} edges={edges} selectedId={selectedId} hrefFor={hrefFor} />
              </div>
            </>
          ) : view === 'list' ? (
            <ListView nodes={nodes} edges={edges} selectedId={selectedId} hrefFor={hrefFor} />
          ) : (
            <MapView nodes={nodes} edges={edges} layout={layoutMap(nodes, edges)} selectedId={selectedId} hrefFor={hrefFor} label={label} />
          )}
        </section>
        {panel && words ? (
          <div className="min-w-0 lg:sticky lg:top-4">
            <NodePanel
              courseId={courseId}
              panel={panel}
              words={words}
              closeHref={mapHref(courseId, { unitId, view })}
              backLabel={view === 'list' ? 'Back to the list' : 'Back to the map'}
            />
          </div>
        ) : nodes.length > 0 ? (
          <p className="text-small text-fg-3">Choose an idea to see what your pages say about it, how you have done on it, and to practice it.</p>
        ) : null}
      </div>
    </Page>
  )
}
