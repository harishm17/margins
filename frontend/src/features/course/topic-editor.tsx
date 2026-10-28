'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowDown,
  ArrowsClockwise,
  ArrowUp,
  DotsThree,
  Files,
  FolderSimplePlus,
  ListBullets,
  PencilSimple,
  Plus,
  Trash,
} from '@phosphor-icons/react/dist/ssr'
import { PageIntro } from '@/components/shell/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { IconButton } from '@/components/ui/icon-button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Input } from '@/components/ui/input'
import { JobStatus } from '@/components/ui/job-status'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { apiFetch, isApiError } from '@/lib/api/client'
import { pluralize } from '@/lib/format'
import { moveInOrder } from '@/lib/topics/ordering'
import { groupTopicsByUnit } from '@/lib/topics/units'
import { topicOriginSentence, type TopicListState } from '@/lib/course-setup'
import type { JobRef } from '@/server/queries/course'
import type { ShellUnit } from '@/server/queries/courses'
import { MoveTopicDialog, UnitDialog } from './editor-dialogs'
import { useExtraction } from './extraction'
import { TopicEditorRow, type EditorTopic, type MergeGroup } from './topic-editor-row'

const NO_UNIT = 'none'
const LAST = Number.MAX_SAFE_INTEGER

const byOrder = <T extends { orderIndex: number }>(list: T[]) => [...list].sort((a, b) => a.orderIndex - b.orderIndex)

/** Gives every topic its place in the course order: units in order, each unit's topics, then the rest. */
function renumber(topics: EditorTopic[], units: ShellUnit[]): EditorTopic[] {
  const position = new Map(groupTopicsByUnit(topics, units).flatMap((group) => group.topics).map((topic, index) => [topic.id, index]))
  return topics.map((topic) => ({ ...topic, orderIndex: position.get(topic.id) ?? topic.orderIndex }))
}

type TopicEditorProps = {
  courseId: string
  topics: EditorTopic[]
  /** In course order; empty for a flat course, which is edited as one plain list. */
  units: ShellUnit[]
  extractJob: JobRef | null
  extractFailure: string | null
  filesReady: number
  filesProcessing: number
  /** The course's topic list as setup sees it (lib/course-setup.ts): confirmed or not, and where it came from. */
  topicList: TopicListState
}

function SkeletonRows() {
  return (
    <ul aria-hidden="true" className="divide-y divide-border border-y border-border">
      {Array.from({ length: 5 }, (_, index) => (
        <li key={index} className="flex items-start gap-3 py-3.5">
          <Skeleton className="mt-0.5 size-6" />
          <div className="flex-1">
            <Skeleton className="h-4 w-48 max-w-full rounded-chip" />
            <Skeleton className="mt-2 h-3.5 w-80 max-w-full rounded-chip" />
          </div>
        </li>
      ))}
    </ul>
  )
}


/** The unit's title row: title, week, size, and its menu (edit, move, delete). */
function UnitHeader({
  unit,
  count,
  index,
  total,
  onEdit,
  onMove,
  onDelete,
}: {
  unit: ShellUnit
  count: number
  index: number
  total: number
  onEdit: () => void
  onMove: (to: number) => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-x-3 gap-y-1 pb-1">
      <h2 className="min-w-0 break-words text-heading text-fg">{unit.title}</h2>
      {unit.weekLabel ? <Badge>{unit.weekLabel}</Badge> : null}
      <span className="shrink-0 text-small tabular text-fg-3">{pluralize(count, 'topic')}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            label={`Actions for unit ${unit.title}`}
            icon={<DotsThree weight="bold" />}
            size="sm"
            noTooltip
            className="ml-auto"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[200px]">
          <DropdownMenuItem icon={<PencilSimple />} onSelect={onEdit}>
            Edit unit
          </DropdownMenuItem>
          <DropdownMenuItem icon={<ArrowUp />} disabled={index === 0} onSelect={() => onMove(index - 1)}>
            Move unit up
          </DropdownMenuItem>
          <DropdownMenuItem icon={<ArrowDown />} disabled={index === total - 1} onSelect={() => onMove(index + 1)}>
            Move unit down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Trash />} destructive disabled={count > 0} onSelect={onDelete}>
            Delete unit
          </DropdownMenuItem>
          {count > 0 ? <DropdownMenuLabel className="max-w-[220px] whitespace-normal">Move or delete its topics first.</DropdownMenuLabel> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * The topic editor: units with their topics (a flat course is one plain list). Rename, reorder
 * (drag or keyboard, inside a unit), move to another unit, merge, delete and add topics; add, edit,
 * move and delete units; find again; and confirm. Changes are applied at once and put back if the
 * server refuses them. Each topic shows the files it is taught from, read-only.
 */
export function TopicEditor({
  courseId,
  topics: serverTopics,
  units: serverUnits,
  extractJob,
  extractFailure,
  filesReady,
  filesProcessing,
  topicList,
}: TopicEditorProps) {
  const router = useRouter()
  const extraction = useExtraction(courseId, extractJob)
  // Confirm is the only way to finish the list: adding topics by hand confirms those topics, not the list.
  const listConfirmed = topicList.listConfirmed

  const [items, setItems] = React.useState(() => byOrder(serverTopics))
  const [unitItems, setUnitItems] = React.useState(() => byOrder(serverUnits))
  const [seen, setSeen] = React.useState({ topics: serverTopics, units: serverUnits })
  if (serverTopics !== seen.topics || serverUnits !== seen.units) {
    setSeen({ topics: serverTopics, units: serverUnits })
    setItems(byOrder(serverTopics))
    setUnitItems(byOrder(serverUnits))
  }

  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [armed, setArmed] = React.useState<string | null>(null)
  const [drag, setDrag] = React.useState<{ id: string; group: string } | null>(null)
  const [overIndex, setOverIndex] = React.useState<number | null>(null)
  const [announcement, setAnnouncement] = React.useState('')
  const [mergePair, setMergePair] = React.useState<{ source: EditorTopic; target: EditorTopic } | null>(null)
  const [deleting, setDeleting] = React.useState<EditorTopic | null>(null)
  const [moving, setMoving] = React.useState<EditorTopic | null>(null)
  const [unitDialog, setUnitDialog] = React.useState<{ unit: ShellUnit | null } | null>(null)
  const [deletingUnit, setDeletingUnit] = React.useState<ShellUnit | null>(null)
  const [findAgainOpen, setFindAgainOpen] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  const [newUnit, setNewUnit] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const addRef = React.useRef<HTMLInputElement>(null)
  const refocus = React.useRef<string | null>(null)
  const queue = React.useRef<Promise<unknown>>(Promise.resolve())

  const groups = React.useMemo(() => groupTopicsByUnit(items, unitItems, { includeEmpty: true }), [items, unitItems])
  const hasUnits = unitItems.length > 0
  const numbers = React.useMemo(
    () => new Map(groups.flatMap((group) => group.topics).map((topic, index) => [topic.id, index + 1])),
    [groups]
  )
  const mergeGroupsFor = (topic: EditorTopic): MergeGroup[] =>
    groups.map((group) => ({
      label: hasUnits ? (group.unit ? group.unit.title : 'No unit') : null,
      topics: group.topics.filter((other) => other.id !== topic.id),
    }))

  // After a keyboard move the list re-renders in the new order; put focus back on the handle.
  React.useEffect(() => {
    if (!refocus.current) return
    document.querySelector<HTMLElement>(`[data-handle="${refocus.current}"]`)?.focus()
    refocus.current = null
  })

  const running = extraction.running

  /** Requests go one after another so quick key presses reach the server in order. */
  function enqueue(task: () => Promise<void>) {
    queue.current = queue.current.then(task)
  }

  function move(id: string, to: number, viaKeyboard = false) {
    const group = groups.find((item) => item.topics.some((topic) => topic.id === id))
    if (!group) return
    const ids = group.topics.map((topic) => topic.id)
    const nextIds = moveInOrder(ids, id, to)
    if (nextIds.every((value, position) => value === ids[position])) return
    const before = items
    const byId = new Map(items.map((item) => [item.id, item]))
    const reordered = groups.flatMap((item) =>
      item === group ? nextIds.map((value) => byId.get(value) as EditorTopic) : item.topics
    )
    const position = reordered.findIndex((topic) => topic.id === id)
    setItems(reordered.map((topic, index) => ({ ...topic, orderIndex: index })))
    const moved = byId.get(id)!
    setAnnouncement(`Moved ${moved.name} to position ${nextIds.indexOf(id) + 1} of ${nextIds.length}`)
    if (viaKeyboard) refocus.current = id

    enqueue(async () => {
      try {
        // The route takes the place in the whole course order (units and topics listed in order).
        await apiFetch(`/api/topics/${id}`, { method: 'PATCH', json: { orderIndex: position } })
        // A refresh that was already on its way (after adding a topic, say) can land after the
        // optimistic move and put the old order back; this one brings the saved order.
        router.refresh()
      } catch {
        setItems(before)
        toast.error("Couldn't move the topic. Try again.")
      }
    })
  }

  async function moveToUnit(topic: EditorTopic, unitId: string | null) {
    const before = items
    setItems(renumber(items.map((item) => (item.id === topic.id ? { ...item, unitId, orderIndex: LAST } : item)), unitItems))
    try {
      await apiFetch(`/api/topics/${topic.id}`, { method: 'PATCH', json: { unitId } })
    } catch {
      setItems(before)
      toast.error("Couldn't move the topic. Try again.")
      throw new Error('move failed')
    }
    const target = unitItems.find((unit) => unit.id === unitId)
    setAnnouncement(`Moved ${topic.name} to ${target ? target.title : 'no unit'}`)
    toast.success(target ? `Moved to ${target.title}` : 'Taken out of its unit')
    router.refresh()
  }

  async function save(topic: EditorTopic, nameInput: string, descriptionInput: string) {
    setEditingId(null)
    const name = nameInput.trim()
    const description = descriptionInput.trim()
    if (!name || (name === topic.name && description === (topic.description ?? ''))) return
    const before = items
    setItems((current) => current.map((item) => (item.id === topic.id ? { ...item, name, description: description || null } : item)))
    try {
      await apiFetch(`/api/topics/${topic.id}`, { method: 'PATCH', json: { name, description } })
      router.refresh()
    } catch (error) {
      setItems(before)
      toast.error(isApiError(error) && error.status === 400 ? 'Give the topic a name.' : "Couldn't save the change. Try again.")
    }
  }

  async function mergeTopics() {
    if (!mergePair) return
    try {
      await apiFetch(`/api/projects/${courseId}/topics/merge`, {
        method: 'POST',
        json: { sourceTopicId: mergePair.source.id, targetTopicId: mergePair.target.id },
      })
    } catch (error) {
      toast.error(isApiError(error) ? error.message : "Couldn't merge the topics. Try again.")
      throw error
    }
    setItems((current) => renumber(current.filter((item) => item.id !== mergePair.source.id), unitItems))
    toast.success(`Merged into ${mergePair.target.name}`)
    router.refresh()
  }

  async function deleteTopic() {
    if (!deleting) return
    try {
      await apiFetch(`/api/topics/${deleting.id}`, { method: 'DELETE' })
    } catch {
      toast.error("Couldn't delete the topic. Try again.")
      throw new Error('delete failed')
    }
    setItems((current) => renumber(current.filter((item) => item.id !== deleting.id), unitItems))
    toast.success('Topic deleted')
    router.refresh()
  }

  // The unit a new topic goes to: the student's pick while it still exists, else the last unit.
  const addTarget = newUnit && unitItems.some((unit) => unit.id === newUnit) ? newUnit : (unitItems[unitItems.length - 1]?.id ?? NO_UNIT)

  // Enter adds the topic and the field stays ready for the next one: it is cleared at once and never
  // disabled (a disabled field drops focus and whatever is typed next). Adds go to the server in order.
  function addTopic(event: React.FormEvent) {
    event.preventDefault()
    const name = newName.trim()
    if (!name) return
    setNewName('')
    addRef.current?.focus()
    const unitId = hasUnits && addTarget !== NO_UNIT ? addTarget : null
    enqueue(async () => {
      try {
        const result = await apiFetch<{ topic: { id: string; name: string; description: string | null; keywords: string[]; orderIndex: number; userConfirmed: boolean; unitId?: string | null } }>(
          `/api/projects/${courseId}/topics`,
          { method: 'POST', json: unitId ? { name, unitId } : { name } }
        )
        const topic = result.topic
        setItems((current) =>
          renumber(
            [
              ...current.filter((item) => item.id !== topic.id),
              {
                id: topic.id,
                name: topic.name,
                description: topic.description,
                keywords: topic.keywords ?? [],
                orderIndex: LAST,
                confirmed: topic.userConfirmed,
                unitId: topic.unitId ?? unitId,
                sources: [],
              },
            ],
            unitItems
          )
        )
        setAnnouncement(`Added ${topic.name}`)
        router.refresh()
      } catch (error) {
        // Put the name back unless the student is already typing the next one.
        setNewName((current) => current || name)
        toast.error(isApiError(error) ? error.message : "Couldn't add the topic. Try again.")
      }
    })
  }

  async function submitUnit(unit: ShellUnit | null, values: { title: string; weekLabel: string | null }) {
    try {
      if (unit) {
        await apiFetch(`/api/units/${unit.id}`, { method: 'PATCH', json: values })
        setUnitItems((current) => current.map((item) => (item.id === unit.id ? { ...item, ...values } : item)))
        toast.success('Unit saved')
      } else {
        const result = await apiFetch<{ unit: ShellUnit }>(`/api/projects/${courseId}/units`, { method: 'POST', json: values })
        setUnitItems((current) => [...current, result.unit])
        setNewUnit(result.unit.id)
        toast.success('Unit added')
      }
      router.refresh()
    } catch (error) {
      toast.error(isApiError(error) ? error.message : "Couldn't save the unit. Try again.")
      throw error
    }
  }

  function moveUnit(unit: ShellUnit, to: number) {
    const ids = unitItems.map((item) => item.id)
    const nextIds = moveInOrder(ids, unit.id, to)
    if (nextIds.every((value, position) => value === ids[position])) return
    const before = { items, unitItems }
    const byId = new Map(unitItems.map((item) => [item.id, item]))
    const nextUnits = nextIds.map((id, index) => ({ ...(byId.get(id) as ShellUnit), orderIndex: index }))
    setUnitItems(nextUnits)
    setItems(renumber(items, nextUnits))
    setAnnouncement(`Moved ${unit.title} to position ${nextIds.indexOf(unit.id) + 1} of ${nextIds.length}`)
    enqueue(async () => {
      try {
        await apiFetch(`/api/units/${unit.id}`, { method: 'PATCH', json: { orderIndex: nextIds.indexOf(unit.id) } })
        router.refresh()
      } catch {
        setUnitItems(before.unitItems)
        setItems(before.items)
        toast.error("Couldn't move the unit. Try again.")
      }
    })
  }

  async function deleteUnit() {
    if (!deletingUnit) return
    try {
      await apiFetch(`/api/units/${deletingUnit.id}`, { method: 'DELETE' })
    } catch (error) {
      toast.error(isApiError(error) ? error.message : "Couldn't delete the unit. Try again.")
      throw error
    }
    setUnitItems((current) => current.filter((unit) => unit.id !== deletingUnit.id))
    toast.success('Unit deleted')
    router.refresh()
  }

  async function confirmTopics() {
    setConfirming(true)
    try {
      // Topics still being added (or moved) reach the server first, so the list confirmed is the one on screen.
      await queue.current
      await apiFetch(`/api/projects/${courseId}/topics/confirm`, { method: 'POST' })
      router.push(`/courses/${courseId}`)
      router.refresh()
    } catch (error) {
      toast.error(isApiError(error) ? error.message : "Couldn't confirm the topics. Try again.")
      setConfirming(false)
    }
  }

  // Drag and drop (mouse), inside a unit. Touch and keyboard use the handle keys and the row menu.
  function dropAt(position: number) {
    if (!drag) return
    const group = groups.find((item) => item.topics.some((topic) => topic.id === drag.id))
    const from = group ? group.topics.findIndex((topic) => topic.id === drag.id) : -1
    const to = position > from ? position - 1 : position
    if (from !== -1) move(drag.id, to)
  }
  function endDrag() {
    setDrag(null)
    setOverIndex(null)
    setArmed(null)
  }

  const title = listConfirmed ? 'Edit topics' : 'Check the topics'
  // "Found" only describes topics that came from the files; a list made by hand says so.
  const description = listConfirmed
    ? hasUnits
      ? 'Rename, move, merge or remove topics and units. Changes save as you go.'
      : 'Rename, reorder, merge or remove topics. Changes save as you go.'
    : topicList.newSinceConfirm > 0
      ? `${topicOriginSentence(topicList)} Rename, merge or remove any, then confirm.`
      : topicList.extracted > 0
        ? hasUnits
          ? 'We grouped what we found into units. Rename, move, merge or remove any. You can change them later.'
          : 'We found these in your materials. Rename, merge or remove any. You can change them later.'
        : 'Add the topics you want to study, then confirm. You can change them later.'

  const unitIndex = (unit: ShellUnit) => unitItems.findIndex((item) => item.id === unit.id)

  return (
    <div className="flex min-h-[calc(100dvh-8.5rem)] flex-col">
      <PageIntro
        title={title}
        description={description}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<ArrowsClockwise />}
              disabled={running || filesReady === 0}
              onClick={() => setFindAgainOpen(true)}
            >
              Find again
            </Button>
            <Button variant="secondary" icon={<FolderSimplePlus />} onClick={() => setUnitDialog({ unit: null })}>
              Add unit
            </Button>
            <Button
              variant="secondary"
              icon={<Plus />}
              onClick={() => {
                addRef.current?.scrollIntoView({ block: 'center' })
                addRef.current?.focus()
              }}
            >
              Add topic
            </Button>
          </>
        }
      />

      <div aria-live="assertive" className="sr-only">
        {announcement}
      </div>

      {running || extraction.failed ? (
        <div className="flex flex-col gap-5">
          <div className="rounded-control bg-surface-2 px-3.5 py-3">
            <JobStatus
              job={extraction.job}
              label="Finding topics"
              since={extraction.since}
              timedOut={extraction.timedOut}
              onRetry={extraction.start}
              retrying={extraction.starting}
            />
          </div>
          {running ? <SkeletonRows /> : null}
        </div>
      ) : null}

      {!running && !extraction.failed && extractFailure ? (
        <InlineAlert
          tone="danger"
          className={items.length > 0 || hasUnits ? 'mb-5' : undefined}
          title="We couldn't find topics"
          action={
            <Button size="sm" variant="secondary" onClick={extraction.start} loading={extraction.starting}>
              Try again
            </Button>
          }
        >
          {extractFailure}
        </InlineAlert>
      ) : null}

      {!running && items.length === 0 && !hasUnits && !extractFailure ? (
        <EmptyState
          icon={<ListBullets />}
          title="No topics yet"
          action={
            filesReady > 0 ? (
              <Button variant="primary" onClick={extraction.start} loading={extraction.starting}>
                Find topics
              </Button>
            ) : (
              <Button asChild variant="primary" icon={<Files />}>
                <Link href={`/courses/${courseId}/materials`}>Add materials</Link>
              </Button>
            )
          }
        >
          {filesReady > 0
            ? 'Margins reads your files and suggests a topic list, or add your own below.'
            : filesProcessing > 0
              ? 'Your files are still being read. Topics appear here once they finish.'
              : 'Add lecture notes or past exams, and Margins will suggest the topics.'}
        </EmptyState>
      ) : null}

      {!running && (items.length > 0 || hasUnits) ? (
        <div className={hasUnits ? 'flex flex-col gap-8' : undefined}>
          {groups.map((group) => {
            const key = group.unit?.id ?? 'loose'
            const label = group.unit ? `Topics in ${group.unit.title}` : 'Topics'
            return (
              <div key={key}>
                {hasUnits && group.unit ? (
                  <UnitHeader
                    unit={group.unit}
                    count={group.topics.length}
                    index={unitIndex(group.unit)}
                    total={unitItems.length}
                    onEdit={() => setUnitDialog({ unit: group.unit })}
                    onMove={(to) => moveUnit(group.unit as ShellUnit, to)}
                    onDelete={() => setDeletingUnit(group.unit)}
                  />
                ) : hasUnits ? (
                  <div className="flex items-center gap-3 pb-1">
                    <h2 className="text-heading text-fg">Topics</h2>
                    <span className="text-small tabular text-fg-3">{pluralize(group.topics.length, 'topic')}</span>
                  </div>
                ) : null}
                {group.topics.length === 0 ? (
                  <p className="border-y border-border py-4 text-small text-fg-3">
                    No topics in this unit yet. Move one here from its menu, or add a topic below.
                  </p>
                ) : (
                  <ul
                    aria-label={label}
                    className="divide-y divide-border border-y border-border"
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverIndex(null)
                    }}
                  >
                    {group.topics.map((topic, index) => {
                      const inDragGroup = drag?.group === key
                      return (
                        <TopicEditorRow
                          key={topic.id}
                          topic={topic}
                          number={numbers.get(topic.id) ?? index + 1}
                          index={index}
                          total={group.topics.length}
                          mergeGroups={mergeGroupsFor(topic)}
                          hasUnits={hasUnits}
                          editing={editingId === topic.id}
                          dragging={drag?.id === topic.id}
                          indicator={
                            inDragGroup && overIndex === index
                              ? 'before'
                              : inDragGroup && overIndex === group.topics.length && index === group.topics.length - 1
                                ? 'after'
                                : null
                          }
                          armed={armed === topic.id}
                          onStartEdit={() => setEditingId(topic.id)}
                          onCancelEdit={() => setEditingId(null)}
                          onSave={(name, desc) => save(topic, name, desc)}
                          onMove={(to) => move(topic.id, to, true)}
                          onMoveToUnit={() => setMoving(topic)}
                          onMerge={(target) => setMergePair({ source: topic, target })}
                          onDelete={() => setDeleting(topic)}
                          onArm={(value) => setArmed(value ? topic.id : null)}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData('text/plain', topic.id)
                            setDrag({ id: topic.id, group: key })
                          }}
                          onDragOver={(event) => {
                            // Only inside the unit it came from: other units are reached from the row menu.
                            if (!drag || drag.group !== key) return
                            event.preventDefault()
                            const rect = event.currentTarget.getBoundingClientRect()
                            setOverIndex(index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0))
                          }}
                          onDrop={(event) => {
                            event.preventDefault()
                            if (overIndex !== null) dropAt(overIndex)
                            endDrag()
                          }}
                          onDragEnd={endDrag}
                        />
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      ) : null}

      {!running ? (
        <form onSubmit={addTopic} className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            ref={addRef}
            aria-label="Add a topic"
            placeholder="Add a topic"
            icon={<Plus />}
            maxLength={255}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            containerClassName="min-w-0 flex-1 basis-56 border-dashed"
          />
          {hasUnits ? (
            <div className="w-full sm:w-56">
              <Select
                aria-label="Unit for the new topic"
                value={addTarget}
                onValueChange={setNewUnit}
                options={[
                  ...unitItems.map((unit) => ({ value: unit.id, label: unit.title, hint: unit.weekLabel })),
                  { value: NO_UNIT, label: 'No unit' },
                ]}
              />
            </div>
          ) : null}
        </form>
      ) : null}

      <div className="sticky bottom-(--tabbar-height,0px) z-sticky -mx-4 -mb-16 mt-auto border-t border-border bg-surface px-4 py-3 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8">
        <div className="mx-auto flex max-w-[1120px] items-center justify-between gap-4">
          <p className="text-small tabular text-fg-2">
            {running ? 'Finding topics' : hasUnits ? `${pluralize(items.length, 'topic')} in ${pluralize(unitItems.length, 'unit')}` : pluralize(items.length, 'topic')}
          </p>
          {listConfirmed ? (
            <Button asChild variant="primary">
              <Link href={`/courses/${courseId}/topics`}>Done</Link>
            </Button>
          ) : (
            <Button variant="primary" onClick={confirmTopics} loading={confirming} disabled={items.length === 0 || running}>
              Confirm topics
            </Button>
          )}
        </div>
      </div>

      <UnitDialog
        open={!!unitDialog}
        onOpenChange={(open) => !open && setUnitDialog(null)}
        unit={unitDialog?.unit ?? null}
        onSubmit={(values) => submitUnit(unitDialog?.unit ?? null, values)}
      />
      <MoveTopicDialog
        topic={moving}
        units={unitItems}
        onOpenChange={(open) => !open && setMoving(null)}
        onMove={(unitId) => (moving ? moveToUnit(moving, unitId) : Promise.resolve())}
      />
      <ConfirmDialog
        open={findAgainOpen}
        onOpenChange={setFindAgainOpen}
        title="Find topics again?"
        description="Topics you already confirmed stay."
        confirmLabel="Find again"
        onConfirm={() => extraction.start()}
      />
      <ConfirmDialog
        open={!!mergePair}
        onOpenChange={(open) => !open && setMergePair(null)}
        title={mergePair ? `Merge ${mergePair.source.name} into ${mergePair.target.name}?` : 'Merge topics?'}
        description={mergePair ? `Content and quiz history move to ${mergePair.target.name}.` : undefined}
        confirmLabel="Merge topics"
        onConfirm={mergeTopics}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={deleting ? `Delete ${deleting.name}?` : 'Delete topic?'}
        description="Its notes, quizzes and progress are deleted with it."
        confirmLabel="Delete topic"
        destructive
        onConfirm={deleteTopic}
      />
      <ConfirmDialog
        open={!!deletingUnit}
        onOpenChange={(open) => !open && setDeletingUnit(null)}
        title={deletingUnit ? `Delete ${deletingUnit.title}?` : 'Delete unit?'}
        description="The unit has no topics. Only the heading goes."
        confirmLabel="Delete unit"
        destructive
        onConfirm={deleteUnit}
      />
    </div>
  )
}
