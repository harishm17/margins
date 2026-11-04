'use client'

import { useParams, useRouter } from 'next/navigation'
import { BookOpenText, Check, CaretUpDown, Gear, Plus, SquaresFour } from '@phosphor-icons/react/dist/ssr'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useShell } from './shell-provider'

/** The button under the brand: the current course, with a menu to switch. */
export function CourseSwitcher({ rail }: { rail?: boolean }) {
  const { nav } = useShell()
  const params = useParams<{ courseId?: string }>()
  const router = useRouter()
  const current = nav.find((course) => course.id === params.courseId)
  const label = current?.name ?? 'All courses'

  const trigger = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        aria-label={`Course: ${label}. Switch course`}
        className={cn(
          'flex h-9 max-lg:min-h-11 w-full items-center gap-2 rounded-control border border-border-strong bg-surface px-2.5 text-left text-body-strong text-fg',
          'transition-colors duration-120 hover:bg-surface-2 data-[state=open]:bg-surface-2',
          'rail:justify-center rail:px-0'
        )}
      >
        <span aria-hidden="true" className="inline-flex text-fg-3 [&>svg]:size-[18px]">
          {current ? <BookOpenText /> : <SquaresFour />}
        </span>
        <span className="min-w-0 flex-1 truncate rail:hidden">{label}</span>
        <CaretUpDown aria-hidden="true" className="size-4 shrink-0 text-fg-3 rail:hidden" />
      </button>
    </DropdownMenuTrigger>
  )

  return (
    <DropdownMenu>
      {rail ? (
        <Tooltip content={label} side="right">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-[232px]">
        {nav.map((course) => (
          <DropdownMenuItem
            key={course.id}
            onSelect={() => router.push(`/courses/${course.id}`)}
            trailing={course.id === current?.id ? <span className="inline-flex text-accent" title="Current course"><Check weight="bold" className="size-4" /><span className="sr-only">Current course</span></span> : null}
          >
            {course.name}
          </DropdownMenuItem>
        ))}
        {nav.length > 0 ? <DropdownMenuSeparator /> : null}
        {current ? (
          <DropdownMenuItem icon={<Gear />} onSelect={() => router.push(`/courses/${current.id}/settings`)}>
            Course settings
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem icon={<SquaresFour />} onSelect={() => router.push('/home')}>
          All courses
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Plus />} onSelect={() => router.push('/courses/new')}>
          New course
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
