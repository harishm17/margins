'use client'

import * as React from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowsLeftRight,
  DotsSixVertical,
  DotsThree,
  GitMerge,
  PencilSimple,
  Trash,
} from '@phosphor-icons/react/dist/ssr'
import { SourceIcon } from '@/components/learning/source-link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'
import { originalHref } from '@/lib/materials/original-href'
import { sourceText } from '@/lib/topics/sources'
import { cn } from '@/lib/utils'
import type { TopicRow } from '@/server/queries/course'

export type EditorTopic = Pick<
  TopicRow,
  'id' | 'name' | 'description' | 'keywords' | 'orderIndex' | 'confirmed' | 'unitId' | 'sources'
>

/** The topics a topic can be merged into, grouped by unit when the course has units. */
export type MergeGroup = { label: string | null; topics: EditorTopic[] }

function Keywords({ keywords }: { keywords: string[] }) {
  if (keywords.length === 0) return null
  const shown = keywords.slice(0, 3)
  const rest = keywords.slice(3)
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="text-caption font-normal text-fg-3">Keywords:</span>
      {shown.map((keyword) => (
        <Badge key={keyword} className="max-w-[160px] truncate">
          {keyword}
        </Badge>
      ))}
      {rest.length > 0 ? (
        <Tooltip content={rest.join(', ')}>
          <Badge tabIndex={0} className="cursor-default">{`+${rest.length}`}</Badge>
        </Tooltip>
      ) : null}
    </span>
  )
}

/**
 * Where the topic is taught from: "Taught from algorithms.pdf, pp. 1-4". Each reference opens the original file at the first page
 * of its range in a new tab, so a student checking the topic can see the pages it was built from. (The ranges are found from the
 * files and cannot be edited: no route writes a topic's sources.)
 */
function SourcesNote({ topic }: { topic: EditorTopic }) {
  if (topic.sources.length === 0) return null
  const text = topic.sources.map(sourceText).join('; ')
  return (
    <p className="mt-1.5 flex min-w-0 items-start gap-1.5 text-caption font-normal text-fg-3" title={`Taught from ${text}`}>
      <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0 [&>svg]:size-3.5">
        <SourceIcon filename={topic.sources[0].filename} />
      </span>
      <span className="min-w-0 wrap-anywhere">
        Taught from{' '}
        {topic.sources.map((source, index) => {
          const href = originalHref(source)
          return (
            <React.Fragment key={`${source.materialId ?? source.filename}|${source.pageStart ?? ''}|${source.pageEnd ?? ''}`}>
              {index > 0 ? '; ' : null}
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-chip text-fg-2 underline decoration-border-strong underline-offset-[3px] hover:text-fg max-sm:inline-block max-sm:py-3"
                >
                  {sourceText(source)}
                  <span className="sr-only"> (opens the file in a new tab)</span>
                </a>
              ) : (
                sourceText(source)
              )}
            </React.Fragment>
          )
        })}
      </span>
    </p>
  )
}

function EditFields({
  topic,
  onSave,
  onCancel,
}: {
  topic: EditorTopic
  onSave: (name: string, description: string) => void
  onCancel: () => void
}) {
  const [name, setName] = React.useState(topic.name)
  const [description, setDescription] = React.useState(topic.description ?? '')
  const formRef = React.useRef<HTMLDivElement>(null)
  const finished = React.useRef(false)

  function commit() {
    if (finished.current) return
    finished.current = true
    onSave(name, description)
  }
  function cancel() {
    if (finished.current) return
    finished.current = true
    onCancel()
  }
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
  }

  return (
    <div
      ref={formRef}
      className="flex flex-col gap-2"
      onBlur={(event) => {
        if (!formRef.current?.contains(event.relatedTarget as Node | null)) commit()
      }}
    >
      <Input
        autoFocus
        aria-label="Topic name"
        maxLength={255}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={keys}
      />
      <Input
        aria-label="Description"
        placeholder="Description (optional)"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        onKeyDown={keys}
      />
      {/* Enter, Escape and leaving the fields still save or cancel; the two buttons say so on a screen with no keyboard. */}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="primary" className="max-sm:min-h-11" onClick={commit}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" className="max-sm:min-h-11" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export type RowProps = {
  topic: EditorTopic
  /** Position in the whole course, 1-based, shown at the start of the row. */
  number: number
  /** Position inside its group (the unit, or the topics with no unit), 0-based. */
  index: number
  /** Size of that group. */
  total: number
  mergeGroups: MergeGroup[]
  /** The course has units, so "Move to unit" is offered. */
  hasUnits: boolean
  editing: boolean
  dragging: boolean
  indicator: 'before' | 'after' | null
  armed: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: (name: string, description: string) => void
  onMove: (to: number) => void
  onMoveToUnit: () => void
  onMerge: (target: EditorTopic) => void
  onDelete: () => void
  onArm: (armed: boolean) => void
  onDragStart: (event: React.DragEvent) => void
  onDragOver: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
  onDragEnd: () => void
  /** Merge mode: the row is a checkbox to pick, and the row's own actions are put away. */
  selectMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}

/** One topic in the editor: handle, number, name and description, sources, and its menu. */
export function TopicEditorRow({
  topic,
  number,
  index,
  total,
  mergeGroups,
  hasUnits,
  editing,
  dragging,
  indicator,
  armed,
  onStartEdit,
  onCancelEdit,
  onSave,
  onMove,
  onMoveToUnit,
  onMerge,
  onDelete,
  onArm,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  selectMode = false,
  selected = false,
  onToggleSelect,
}: RowProps) {
  const hasOthers = mergeGroups.some((group) => group.topics.length > 0)
  const hasDetails = !!topic.description || topic.keywords.length > 0
  const [detailsOpen, setDetailsOpen] = React.useState(false)

  function onHandleKey(event: React.KeyboardEvent) {
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault()
      onMove(index - 1)
    } else if (event.key === 'ArrowDown' && index < total - 1) {
      event.preventDefault()
      onMove(index + 1)
    }
  }

  return (
    <li
      draggable={armed}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn('relative flex items-start gap-2 py-3 max-sm:gap-1.5', dragging && 'opacity-40', selectMode && selected && 'bg-accent-soft/40')}
    >
      {indicator ? (
        <span
          aria-hidden="true"
          className={cn('absolute inset-x-0 h-0.5 rounded-full bg-accent', indicator === 'before' ? '-top-px' : '-bottom-px')}
        />
      ) : null}
      {selectMode ? (
        <Checkbox
          aria-label={`Select ${topic.name} to merge`}
          checked={selected}
          onCheckedChange={() => onToggleSelect?.()}
          className="mt-1.5 max-sm:mt-3"
        />
      ) : null}
      <button
        type="button"
        data-handle={topic.id}
        aria-label={`Reorder ${topic.name}. Use the up and down arrow keys to move it.`}
        onKeyDown={onHandleKey}
        onPointerDown={() => onArm(true)}
        onPointerUp={() => onArm(false)}
        className="mt-0.5 inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded-chip text-fg-3 hover:bg-surface-2 hover:text-fg active:cursor-grabbing max-sm:hidden"
        hidden={selectMode}
      >
        <DotsSixVertical aria-hidden="true" weight="bold" className="size-4" />
      </button>
      <span className="mt-0.5 w-6 shrink-0 text-right text-small tabular text-fg-3">{number}</span>

      <div className="min-w-0 flex-1 pl-1">
        {editing ? (
          <EditFields topic={topic} onSave={onSave} onCancel={onCancelEdit} />
        ) : (
          <>
            {selectMode ? (
              <button
                type="button"
                onClick={onToggleSelect}
                className="block max-w-full rounded-chip text-left text-body-strong text-fg max-sm:min-h-11 max-sm:py-2.5"
                aria-hidden="true"
                tabIndex={-1}
              >
                {topic.name}
              </button>
            ) : (
              <p className="max-w-full wrap-anywhere text-body-strong text-fg">{topic.name}</p>
            )}
            {/* On a phone the description and keywords wait behind "Details": a row is the name, where it is taught from and Rename,
                so three topics fit a screen and a half. From sm up they are shown as before. */}
            {hasDetails ? (
              <>
                <div className={cn(!detailsOpen && 'max-sm:hidden')} id={`details-${topic.id}`}>
                  {topic.description ? (
                    <p className="mt-0.5 text-small text-fg-2 sm:line-clamp-1" title={topic.description}>
                      {topic.description}
                    </p>
                  ) : null}
                  {topic.keywords.length > 0 ? (
                    <div className="mt-1.5">
                      <Keywords keywords={topic.keywords} />
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
            <SourcesNote topic={topic} />
            {selectMode ? null : (
              // Rename stays on the row (it is what checking the topics is for); Move, Merge and Delete are in the row's one menu.
              <div className="-ml-2.5 mt-1 flex flex-wrap items-center gap-1">
                <Button variant="ghost" size="sm" icon={<PencilSimple />} aria-label={`Rename ${topic.name}`} onClick={onStartEdit}>
                  Rename
                </Button>
                {hasDetails ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="sm:hidden"
                    aria-expanded={detailsOpen}
                    aria-controls={`details-${topic.id}`}
                    aria-label={`${detailsOpen ? 'Hide' : 'Show'} details of ${topic.name}`}
                    onClick={() => setDetailsOpen((open) => !open)}
                  >
                    Details
                  </Button>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {selectMode ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={`Actions for ${topic.name}`} icon={<DotsThree weight="bold" />} size="sm" noTooltip />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]">
            <DropdownMenuItem icon={<ArrowUp />} disabled={index === 0} onSelect={() => onMove(index - 1)}>
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem icon={<ArrowDown />} disabled={index === total - 1} onSelect={() => onMove(index + 1)}>
              Move down
            </DropdownMenuItem>
            {hasUnits ? (
              <DropdownMenuItem icon={<ArrowsLeftRight />} onSelect={onMoveToUnit}>
                Move to unit...
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger icon={<GitMerge />} disabled={!hasOthers}>
                Merge into...
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                {mergeGroups.map((group, position) =>
                  group.topics.length === 0 ? null : (
                    <React.Fragment key={group.label ?? 'loose'}>
                      {group.label ? (
                        <>
                          {position > 0 ? <DropdownMenuSeparator /> : null}
                          <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                        </>
                      ) : null}
                      {group.topics.map((other) => (
                        <DropdownMenuItem key={other.id} onSelect={() => onMerge(other)}>
                          {other.name}
                        </DropdownMenuItem>
                      ))}
                    </React.Fragment>
                  )
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Trash />} destructive onSelect={onDelete}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  )
}
