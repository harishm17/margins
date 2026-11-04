'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { DotsThree, Files, Gear, ListBullets, Sparkle } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { PrepareAllDialog } from './prepare-all'

/**
 * The course actions menu: on the course overview and in the topic editor. "Prepare all topics now" is the only place that
 * writes content for the whole course; it is left out when every topic is already written. From 1024px the course settings are
 * a labelled link beside the menu instead of a row in it.
 */
export function CourseMenu({
  courseId,
  topicsToPrepare = 0,
  hideEditTopics = false,
  extraItems,
}: {
  courseId: string
  topicsToPrepare?: number
  /** The page is the topic editor already. */
  hideEditTopics?: boolean
  /** Actions that belong to the page that shows the menu (the topic editor's "Find topics again"), above the common ones. */
  extraItems?: React.ReactNode
}) {
  const router = useRouter()
  const [preparing, setPreparing] = React.useState(false)
  const base = `/courses/${courseId}`
  return (
    <>
      {/* Wide screens: the course's settings are a labelled link beside the menu, which keeps the occasional actions. */}
      <Button asChild variant="secondary" icon={<Gear />} className="max-lg:hidden">
        <Link href={`${base}/settings`}>Course settings</Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="Course actions" icon={<DotsThree weight="bold" />} variant="secondary" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {extraItems}
          <DropdownMenuItem icon={<Files />} onSelect={() => router.push(`${base}/materials`)}>
            Materials
          </DropdownMenuItem>
          {hideEditTopics ? null : (
            <DropdownMenuItem icon={<ListBullets />} onSelect={() => router.push(`${base}/topics?edit=1`)}>
              Edit topics
            </DropdownMenuItem>
          )}
          {topicsToPrepare > 0 ? (
            <DropdownMenuItem icon={<Sparkle />} onSelect={() => setPreparing(true)}>
              Prepare all topics now
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem icon={<Gear />} className="lg:hidden" onSelect={() => router.push(`${base}/settings`)}>
            Course settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PrepareAllDialog
        courseId={courseId}
        topicCount={topicsToPrepare}
        open={preparing}
        onOpenChange={setPreparing}
      />
    </>
  )
}
