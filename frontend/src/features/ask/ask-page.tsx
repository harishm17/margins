'use client'

import * as React from 'react'
import { toast } from '@/components/ui/toaster'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { SelectOption } from '@/components/ui/select'
import { apiFetch, isApiError } from '@/lib/api/client'
import { exampleQuestions } from '@/lib/chat/examples'
import type { ChatMessage } from './chat-messages'
import { ALL_MATERIALS } from './composer'
import { Conversation } from './conversation'
import type { ThreadSummary } from './thread-groups'
import { ThreadList, ThreadPicker } from './thread-list'
import { useAskChat } from './use-ask-chat'

export type AskPageProps = {
  courseId: string
  threads: ThreadSummary[]
  /** The conversation named by ?thread=, already loaded on the server. */
  initialThread: { id: string; messages: ChatMessage[] } | null
  topics: { id: string; name: string }[]
  /** The topic from ?topic=, or null for all materials. */
  initialTopicId: string | null
  hasMaterials: boolean
  /** Text for the question box, from a link such as "Explain this mistake". Empty for none. */
  initialDraft?: string
  /** Server time, so the thread groups match between server and browser renders. */
  now: number
}

/** The full Ask page: conversations on the left, the conversation on the right. */
export default function AskPage({
  courseId,
  threads: initialThreads,
  initialThread,
  topics,
  initialTopicId,
  hasMaterials,
  initialDraft = '',
  now,
}: AskPageProps) {
  const base = `/courses/${courseId}/ask`
  const [threads, setThreads] = React.useState(initialThreads)
  const [scope, setScope] = React.useState(initialTopicId ?? ALL_MATERIALS)
  const [pendingDelete, setPendingDelete] = React.useState<ThreadSummary | null>(null)

  const chat = useAskChat({
    courseId,
    topicId: scope === ALL_MATERIALS ? null : scope,
    initialThreadId: initialThread?.id ?? null,
    initialMessages: initialThread?.messages ?? [],
    onThreadStarted: ({ id, title }) => {
      setThreads((current) => [{ id, title, updatedAt: new Date().toISOString() }, ...current.filter((t) => t.id !== id)])
      window.history.replaceState(null, '', `${base}?thread=${id}`)
    },
    onThreadDiscarded: (id) => {
      setThreads((current) => current.filter((t) => t.id !== id))
      window.history.replaceState(null, '', base)
    },
    onThreadActive: (id) => {
      setThreads((current) => {
        const found = current.find((t) => t.id === id)
        if (!found) return current
        return [{ ...found, updatedAt: new Date().toISOString() }, ...current.filter((t) => t.id !== id)]
      })
    },
  })
  const { loadThread, reset, threadId } = chat

  const selectThread = React.useCallback(
    (id: string) => {
      if (id === threadId) return
      window.history.pushState(null, '', `${base}?thread=${id}`)
      void loadThread(id)
    },
    [base, loadThread, threadId]
  )

  const newChat = React.useCallback(() => {
    if (threadId || chat.messages.length > 0) window.history.pushState(null, '', base)
    reset()
    document.getElementById('ask-composer')?.focus()
  }, [base, reset, threadId, chat.messages.length])

  // The back and forward buttons move between conversations.
  React.useEffect(() => {
    const onPopState = () => {
      const id = new URLSearchParams(window.location.search).get('thread')
      if (id) void loadThread(id)
      else reset()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [loadThread, reset])

  const deleteThread = async (thread: ThreadSummary) => {
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(courseId)}/chat/threads/${encodeURIComponent(thread.id)}`, {
        method: 'DELETE',
      })
    } catch (error) {
      toast.error(isApiError(error) ? error.message : "Couldn't delete the conversation. Try again.")
      throw error
    }
    setThreads((current) => current.filter((t) => t.id !== thread.id))
    if (thread.id === threadId) {
      window.history.replaceState(null, '', base)
      reset()
    }
    toast('Conversation deleted')
  }

  const scopeOptions = React.useMemo<SelectOption[]>(
    () => [{ value: ALL_MATERIALS, label: 'All materials' }, ...topics.map((t) => ({ value: t.id, label: t.name }))],
    [topics]
  )
  const examples = React.useMemo(() => {
    const focus = scope === ALL_MATERIALS ? topics.map((t) => t.name) : topics.filter((t) => t.id === scope).map((t) => t.name)
    return exampleQuestions(focus, 4)
  }, [topics, scope])

  const listProps = {
    threads,
    activeId: threadId,
    now,
    onSelect: selectThread,
    onNew: newChat,
    onDelete: setPendingDelete,
  }

  return (
    <div className="flex h-[calc(100dvh-var(--topbar-height)-var(--tabbar-height,0px))] min-h-0">
      <h1 className="sr-only">Ask your materials</h1>
      <aside className="hidden w-[248px] shrink-0 border-r border-border bg-surface lg:block">
        <ThreadList {...listProps} hrefFor={(id) => `${base}?thread=${id}`} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="lg:hidden">
          <ThreadPicker {...listProps} />
        </div>
        <Conversation
          chat={chat}
          courseId={courseId}
          variant="page"
          hasMaterials={hasMaterials}
          initialDraft={initialDraft}
          examples={examples}
          scopeOptions={scopeOptions}
          scope={scope}
          onScopeChange={setScope}
        />
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => (open ? undefined : setPendingDelete(null))}
        title="Delete this conversation?"
        description="The questions and answers in it will be removed."
        confirmLabel="Delete conversation"
        destructive
        onConfirm={() => (pendingDelete ? deleteThread(pendingDelete) : undefined)}
      />
    </div>
  )
}
