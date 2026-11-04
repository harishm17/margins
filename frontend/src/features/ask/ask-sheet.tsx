'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { ArrowSquareOut } from '@phosphor-icons/react/dist/ssr'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton, SkeletonText } from '@/components/ui/skeleton'
import { exampleQuestions } from '@/lib/chat/examples'
import { useAskChat } from './use-ask-chat'

// The conversation (markdown, citations, composer) loads the first time the sheet opens.
const Conversation = dynamic(() => import('./conversation').then((m) => m.Conversation), {
  loading: () => (
    <div aria-busy="true" aria-label="Loading" className="flex flex-1 flex-col gap-6 p-5">
      <Skeleton className="ml-auto h-10 w-2/3 rounded-card" />
      <SkeletonText lines={4} />
    </div>
  ),
})

export type AskSheetProps = {
  courseId: string
  topicId: string
  topicName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function AskSheetBody({ courseId, topicId, topicName, open, onOpenChange }: AskSheetProps) {
  const chat = useAskChat({ courseId, topicId })
  const examples = React.useMemo(() => exampleQuestions([topicName], 3), [topicName])
  const fullPage = `/courses/${courseId}/ask?topic=${encodeURIComponent(topicId)}${chat.threadId ? `&thread=${encodeURIComponent(chat.threadId)}` : ''}`

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="max-sm:h-[85dvh]"
        onEscapeKeyDown={(event) => {
          // While an answer is being written, Escape stops it instead of closing the sheet.
          if (chat.sending) event.preventDefault()
        }}
      >
        <SheetHeader>
          <SheetTitle>Ask about this topic</SheetTitle>
          <SheetDescription className="truncate">{topicName}</SheetDescription>
          <Link
            href={fullPage}
            className="mt-1 inline-flex w-fit items-center gap-1 rounded-chip text-small text-accent hover:underline"
          >
            Open full page
            <ArrowSquareOut className="size-3.5" aria-hidden="true" />
          </Link>
        </SheetHeader>
        <Conversation
          chat={chat}
          courseId={courseId}
          variant="sheet"
          hasMaterials
          examples={examples}
          fixedScope={topicName}
          topicName={topicName}
          draftNewKey={`new-${topicId}`}
        />
      </SheetContent>
    </Sheet>
  )
}

/**
 * The Ask conversation in a right sheet (a bottom sheet on mobile), scoped to one topic. The
 * conversation is kept while the sheet is closed and starts over when the topic changes.
 */
export function AskSheet(props: AskSheetProps) {
  return <AskSheetBody key={props.topicId} {...props} />
}
