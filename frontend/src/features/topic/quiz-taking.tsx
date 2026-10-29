'use client'

import * as React from 'react'
import { ArrowLeft, ArrowRight, Check, SignOut } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Progress } from '@/components/ui/progress'
import { QuestionRenderer } from '@/components/ui/question-renderer'
import type { PublicQuizQuestion } from '@/lib/learning/quiz-questions'
import { useQuestionMotion } from '@/lib/question-motion'
import { cn } from '@/lib/utils'

type QuizTakingProps = {
  questions: PublicQuizQuestion[]
  answers: Record<string, string>
  index: number
  error: string | null
  onAnswer: (index: number, value: string) => void
  onIndex: (index: number) => void
  onSubmit: () => Promise<void> | void
  onExit: () => void
}

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

const isAnswered = (answers: Record<string, string>, index: number) => !!answers[String(index)]?.trim()

/**
 * One question per screen in a 720px column, with a navigator of numbered chips. Keys: 1 to 4 or
 * A to D and T/F pick an option, S focuses the answer box, Enter or Right goes on, Left goes back.
 */
export function QuizTaking({ questions, answers, index, error, onAnswer, onIndex, onSubmit, onExit }: QuizTakingProps) {
  const [confirmSubmit, setConfirmSubmit] = React.useState(false)
  const [confirmExit, setConfirmExit] = React.useState(false)
  const total = questions.length
  const current = Math.min(index, total - 1)
  const motion = useQuestionMotion(current)
  const question = questions[current]
  const answeredCount = questions.filter((_q, position) => isAnswered(answers, position)).length
  const unanswered = total - answeredCount
  const isLast = current === total - 1

  const go = React.useCallback(
    (next: number) => onIndex(Math.max(0, Math.min(total - 1, next))),
    [onIndex, total]
  )

  function requestSubmit() {
    if (unanswered > 0) setConfirmSubmit(true)
    else void onSubmit()
  }

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || confirmSubmit || confirmExit) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'TEXTAREA') return
      const typing = isTyping(event.target)

      if (event.key === 'Enter' && !isLast) {
        // A button has its own Enter; the answer box and the page use it to move on.
        if (target?.tagName === 'BUTTON' || target?.tagName === 'A') return
        event.preventDefault()
        go(current + 1)
      } else if (!typing && event.key === 'ArrowRight') {
        event.preventDefault()
        go(current + 1)
      } else if (!typing && event.key === 'ArrowLeft') {
        event.preventDefault()
        go(current - 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [go, current, isLast, confirmSubmit, confirmExit])

  return (
    <div className="max-w-[720px]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h2 className="tabular text-body-strong text-fg">
          Question {current + 1} of {total}
        </h2>
        <nav aria-label="Questions" className="flex flex-wrap items-center gap-1">
          {questions.map((_q, position) => {
            const answered = isAnswered(answers, position)
            const active = position === current
            return (
              <button
                key={position}
                type="button"
                aria-label={`Question ${position + 1}${answered ? ', answered' : ', not answered'}`}
                aria-current={active ? 'step' : undefined}
                onClick={() => go(position)}
                className={cn(
                  'grid size-7 place-items-center rounded-chip border text-caption tabular transition-colors duration-120 max-sm:size-9',
                  active && 'border-accent text-fg ring-2 ring-accent/25',
                  !active && answered && 'border-transparent bg-surface-3 text-fg',
                  !active && !answered && 'border-border text-fg-3 hover:border-border-strong hover:text-fg-2'
                )}
              >
                {position + 1}
              </button>
            )
          })}
        </nav>
      </div>

      <Progress aria-label="Questions answered" className="mt-4" value={(answeredCount / total) * 100} />

      <div key={current} data-question="" className={cn('mt-8', motion)}>
        <QuestionRenderer
          question={question}
          value={answers[String(current)]}
          onChange={(value) => onAnswer(current, value)}
          shortcuts
        />
      </div>

      {error ? (
        <InlineAlert className="mt-6" tone="danger">
          {error}
        </InlineAlert>
      ) : null}

      <div className="mt-10 flex items-center justify-between gap-3 border-t border-border pt-5">
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<ArrowLeft />} disabled={current === 0} onClick={() => go(current - 1)}>
            Previous
          </Button>
          <Button variant="ghost" icon={<SignOut />} className="text-fg-2" onClick={() => setConfirmExit(true)}>
            Exit
          </Button>
        </div>
        {isLast ? (
          <Button variant="primary" icon={<Check />} onClick={requestSubmit}>
            Submit quiz
          </Button>
        ) : (
          <Button variant="primary" onClick={() => go(current + 1)}>
            <span className="inline-flex items-center gap-1.5">
              Next
              <ArrowRight className="size-4" />
            </span>
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmSubmit}
        onOpenChange={setConfirmSubmit}
        title="Submit with unanswered questions?"
        description={`${unanswered} ${unanswered === 1 ? 'question is' : 'questions are'} unanswered. ${
          unanswered === 1 ? "It'll" : "They'll"
        } be marked wrong.`}
        confirmLabel="Submit quiz"
        onConfirm={onSubmit}
      />
      <ConfirmDialog
        open={confirmExit}
        onOpenChange={setConfirmExit}
        title="Leave this quiz?"
        description="Your answers so far will be cleared."
        confirmLabel="Leave quiz"
        destructive
        onConfirm={onExit}
      />
    </div>
  )
}
