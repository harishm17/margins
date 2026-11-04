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

/** Where the topic is taught from, read-only: "algorithms.pdf, pp. 1-4". */
function SourcesNote({ topic }: { topic: EditorTopic }) {
  if (topic.sources.length === 0) return null
  const text = topic.sources.map(sourceText).join('; ')
  return (
    <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-caption font-normal text-fg-3" title={`Taught from ${text}`}>
      <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:size-3.5">
        <SourceIcon filename={topic.sources[0].filename} />
      </span>
      <span className="sr-only">Taught from </span>
      <span className="min-w-0 truncate">{text}</span>
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
}: RowProps) {
  const renameRequested = React.useRef(false)
  const hasOthers = mergeGroups.some((group) => group.topics.length > 0)

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
      className={cn('relative flex items-start gap-2 py-3 max-sm:gap-1.5', dragging && 'opacity-40')}
    >
      {indicator ? (
        <span
          aria-hidden="true"
          className={cn('absolute inset-x-0 h-0.5 rounded-full bg-accent', indicator === 'before' ? '-top-px' : '-bottom-px')}
        />
      ) : null}
      <button
        type="button"
        data-handle={topic.id}
        aria-label={`Reorder ${topic.name}. Use the up and down arrow keys to move it.`}
        onKeyDown={onHandleKey}
        onPointerDown={() => onArm(true)}
        onPointerUp={() => onArm(false)}
        className="mt-0.5 inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded-chip text-fg-3 hover:bg-surface-2 hover:text-fg active:cursor-grabbing max-sm:size-11"
      >
        <DotsSixVertical aria-hidden="true" weight="bold" className="size-4" />
      </button>
      <span className="mt-0.5 w-6 shrink-0 text-right text-small tabular text-fg-3">{number}</span>

      <div className="min-w-0 flex-1 pl-1">
        {editing ? (
          <EditFields topic={topic} onSave={onSave} onCancel={onCancelEdit} />
        ) : (
          <>
            <button
              type="button"
              onClick={onStartEdit}
              aria-label={`Rename ${topic.name}`}
              className="block max-w-full truncate rounded-chip text-left text-body-strong text-fg hover:underline max-sm:min-h-11 max-sm:whitespace-normal max-sm:py-2.5"
            >
              {topic.name}
            </button>
            {topic.description ? (
              <p className="mt-0.5 line-clamp-3 text-small text-fg-2 sm:line-clamp-1" title={topic.description}>
                {topic.description}
              </p>
            ) : null}
            {topic.keywords.length > 0 ? (
              <div className="mt-1.5">
                <Keywords keywords={topic.keywords} />
              </div>
            ) : null}
            <SourcesNote topic={topic} />
          </>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={`Actions for ${topic.name}`} icon={<DotsThree weight="bold" />} size="sm" noTooltip />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[200px]"
          onCloseAutoFocus={(event) => {
            // Rename opens an input that has focus; the menu must not take it back.
            if (renameRequested.current) {
              event.preventDefault()
              renameRequested.current = false
            }
          }}
        >
          <DropdownMenuItem
            icon={<PencilSimple />}
            onSelect={() => {
              renameRequested.current = true
              onStartEdit()
            }}
          >
            Rename
          </DropdownMenuItem>
          {hasUnits ? (
            <DropdownMenuItem icon={<ArrowsLeftRight />} onSelect={onMoveToUnit}>
              Move to unit...
            </DropdownMenuItem>
          ) : null}
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
          <DropdownMenuItem icon={<ArrowUp />} disabled={index === 0} onSelect={() => onMove(index - 1)}>
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem icon={<ArrowDown />} disabled={index === total - 1} onSelect={() => onMove(index + 1)}>
            Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Trash />} destructive onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
