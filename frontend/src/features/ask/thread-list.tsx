'use client'

import * as React from 'react'
import { CaretUpDown, ChatCircleText, DotsThree, Plus, Trash } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { groupThreads, threadTitle, UNTITLED_THREAD, type ThreadSummary } from './thread-groups'

type ThreadListProps = {
  threads: ThreadSummary[]
  activeId: string | null
  /** When the list was drawn, so the groups agree between server and browser. */
  now: number
  hrefFor: (id: string) => string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (thread: ThreadSummary) => void
}

const plainClick = (event: React.MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/** The conversations pane: New chat, then threads grouped by how recent they are. */
export function ThreadList({ threads, activeId, now, hrefFor, onSelect, onNew, onDelete }: ThreadListProps) {
  const groups = groupThreads(threads, now)
  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col">
      <div className="p-3">
        <Button variant="secondary" fullWidth icon={<Plus />} onClick={onNew}>
          New chat
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {groups.length === 0 ? (
          <p className="px-2.5 py-2 text-small text-fg-3">Your conversations will appear here.</p>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="mb-4">
              <h2 className="px-2.5 pb-1 text-caption text-fg-3">{group.label}</h2>
              <ul className="flex flex-col gap-0.5">
                {group.threads.map((thread) => {
                  const active = thread.id === activeId
                  return (
                    <li key={thread.id} className="group/row relative">
                      <a
                        href={hrefFor(thread.id)}
                        aria-current={active ? 'page' : undefined}
                        onClick={(event) => {
                          if (!plainClick(event)) return
                          event.preventDefault()
                          onSelect(thread.id)
                        }}
                        className={cn(
                          'block truncate rounded-control py-1.5 pl-2.5 pr-9 text-[13.5px] leading-5 text-fg-2',
                          'transition-colors duration-120 hover:bg-surface-2 hover:text-fg',
                          active && 'bg-surface-2 text-fg'
                        )}
                      >
                        {threadTitle(thread)}
                      </a>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            label={`Options for ${threadTitle(thread)}`}
                            icon={<DotsThree weight="bold" />}
                            size="sm"
                            noTooltip
                            className={cn(
                              'absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-120',
                              'focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 max-lg:opacity-100'
                            )}
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem destructive icon={<Trash />} onSelect={() => onDelete(thread)}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </nav>
  )
}

/** Below 1024px the list collapses into one dropdown above the conversation. */
export function ThreadPicker({
  threads,
  activeId,
  now,
  onSelect,
  onNew,
  onDelete,
}: Omit<ThreadListProps, 'hrefFor'>) {
  const groups = groupThreads(threads, now)
  const active = threads.find((thread) => thread.id === activeId) ?? null
  const shown = active ? threadTitle(active) : UNTITLED_THREAD
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            // The name starts with the visible title (WCAG 2.5.3) and then says what the button opens.
            aria-label={`${shown}, conversations`}
            className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-control border border-control bg-surface px-3 text-body-strong text-fg transition-colors duration-120 hover:bg-surface-2 max-sm:h-11"
          >
            <ChatCircleText aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1 truncate text-left">{shown}</span>
            <CaretUpDown aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-[min(340px,calc(100vw-32px))]">
          <DropdownMenuItem icon={<Plus />} onSelect={onNew}>
            New chat
          </DropdownMenuItem>
          {groups.map((group) => (
            <React.Fragment key={group.label}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
              {group.threads.map((thread) => (
                <DropdownMenuItem
                  key={thread.id}
                  onSelect={() => onSelect(thread.id)}
                  className={cn(thread.id === activeId && 'bg-surface-2')}
                >
                  {threadTitle(thread)}
                </DropdownMenuItem>
              ))}
            </React.Fragment>
          ))}
          {active ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive icon={<Trash />} onSelect={() => onDelete(active)}>
                Delete this conversation
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
