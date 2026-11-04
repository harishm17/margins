'use client'

import * as React from 'react'
import { ArrowLeft, ArrowRight, Check, ListNumbers, SignOut } from '@phosphor-icons/react/dist/ssr'
import { QuestionNavigator } from '@/components/learning/question-navigator'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Progress } from '@/components/ui/progress'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { QuestionRenderer } from '@/components/ui/question-renderer'
import { isAnswered as hasAnswer, type QuizAnswer } from '@/lib/learning/quiz-answers'
import type { PublicQuizQuestion } from '@/lib/learning/quiz-questions'
import { useQuestionMotion } from '@/lib/question-motion'
import { cn } from '@/lib/utils'
import { ConfidenceRow, optionCountOf, ThinkingBox } from './quiz-confidence'

type QuizTakingProps = {
  questions: PublicQuizQuestion[]
  answers: Record<string, QuizAnswer>
  index: number
  error: string | null
  onAnswer: (index: number, value: string) => void
  /** The optional parts of an answer: how sure the student is, and their thinking. */
  onDetail: (index: number, detail: Partial<Pick<QuizAnswer, 'confidence' | 'confidenceLevel' | 'thinking'>>) => void
  /** The "I don't know" button: on records `{answer: '', idk: true}`, off takes it back. */
  onDontKnow: (index: number, on: boolean) => void
  onIndex: (index: number) => void
  onSubmit: () => Promise<void> | void
  /** "Save and finish later": the answers stay saved and the quiz closes. */
  onSaveAndExit: () => Promise<void> | void
  /** "Discard my answers": the saved answers are deleted. */
  onDiscard: () => Promise<void> | void
  /** The draft's quiet status line ("Saved", "Saving..."), or null. */
  saveStatus?: string | null
}

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

const isAnswered = (answers: Record<string, QuizAnswer>, index: number) => hasAnswer(answers[String(index)])

/**
 * One question per screen in a 720px column, with a navigator of numbered chips. Keys: 1 to 4 or
 * A to D and T/F pick an option, S focuses the answer box, Enter or Right goes on, Left goes back.
 */
export function QuizTaking({ questions, answers, index, error, onAnswer, onDetail, onDontKnow, onIndex, onSubmit, onSaveAndExit, onDiscard, saveStatus }: QuizTakingProps) {
  const [confirmSubmit, setConfirmSubmit] = React.useState(false)
  const [confirmExit, setConfirmExit] = React.useState(false)
  const [leaving, setLeaving] = React.useState(false)
  const total = questions.length
  const current = Math.min(index, total - 1)
  const motion = useQuestionMotion(current)
  // On a phone every number is also in one sheet, so reaching question 9 does not take precise swiping along a row.
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const question = questions[current]
  const answeredCount = questions.filter((_q, position) => isAnswered(answers, position)).length
  const unanswered = total - answeredCount
  const answeredSet = React.useMemo(() => new Set(questions.flatMap((_q, position) => (isAnswered(answers, position) ? [position] : []))), [questions, answers])
  const isLast = current === total - 1
  const dontKnow = answers[String(current)]?.idk === true

  const go = React.useCallback(
    (next: number) => onIndex(Math.max(0, Math.min(total - 1, next))),
    [onIndex, total]
  )

  async function leave(action: () => Promise<void> | void) {
    setLeaving(true)
    try {
      await action()
    } finally {
      setLeaving(false)
      setConfirmExit(false)
    }
  }

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
        {/* The numbers are one row (it scrolls sideways on a phone, two rows of them pushed the question down the screen), and the same
            numbers are in a sheet from the Questions button: the one navigator the mock exam uses. */}
        <div className="flex items-center gap-2 max-sm:w-full max-sm:flex-col max-sm:items-stretch">
          <QuestionNavigator total={total} current={current} answered={answeredSet} onSelect={go} layout="row" />
          <Button variant="secondary" size="sm" icon={<ListNumbers />} className="shrink-0 sm:hidden max-sm:min-h-11" onClick={() => setPickerOpen(true)}>
            All questions
          </Button>
        </div>
      </div>

      <Progress aria-label="Questions answered" className="mt-4" value={(answeredCount / total) * 100} />

      <div key={current} data-question="" className={cn('mt-5 sm:mt-8', motion)}>
        <QuestionRenderer
          question={question}
          value={answers[String(current)]?.answer}
          onChange={(value) => onAnswer(current, value)}
          shortcuts
        />
        {dontKnow ? (
          <p className="mt-5 text-small text-fg-2" data-testid="idk-marked">
            Marked as I don&apos;t know. It counts as a miss, and the results show where to look. Pick or type an answer to change it.
          </p>
        ) : (
          <>
            <ConfidenceRow
              value={answers[String(current)]?.confidence}
              level={answers[String(current)]?.confidenceLevel}
              optionCount={optionCountOf(question)}
              onChange={(confidenceLevel, confidence) => onDetail(current, { confidence, confidenceLevel })}
            />
            <ThinkingBox
              value={answers[String(current)]?.thinking ?? ''}
              onChange={(thinking) => onDetail(current, { thinking })}
            />
          </>
        )}
        <div className="mt-4">
          <Button variant="secondary" size="sm" aria-pressed={dontKnow} onClick={() => onDontKnow(current, !dontKnow)}>
            I don&apos;t know
          </Button>
        </div>
      </div>

      {error ? (
        <InlineAlert className="mt-6" tone="danger">
          {error}
        </InlineAlert>
      ) : null}

      <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<ArrowLeft />} disabled={current === 0} disabledReason="This is the first question." onClick={() => go(current - 1)}>
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

      <Sheet open={pickerOpen} onOpenChange={setPickerOpen}>
        <SheetContent className="sm:hidden">
          <SheetHeader>
            <SheetTitle>Questions</SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto p-5">
            <QuestionNavigator
              total={total}
              current={current}
              answered={answeredSet}
              onSelect={(position) => {
                go(position)
                setPickerOpen(false)
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

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
      <Dialog open={confirmExit} onOpenChange={(open) => (leaving ? undefined : setConfirmExit(open))}>
        <DialogContent hideClose>
          <DialogHeader className="mb-0 pr-0">
            <DialogTitle>Leave this quiz?</DialogTitle>
            <DialogDescription>
              Your answers are saved. Pick up where you left off from this quiz&apos;s page.
            </DialogDescription>
          </DialogHeader>
          {saveStatus ? <p className="mt-3 text-caption text-fg-3">{saveStatus}</p> : null}
          <DialogFooter className="max-sm:flex-col-reverse">
            <DialogClose asChild>
              <Button variant="ghost" disabled={leaving}>
                Keep going
              </Button>
            </DialogClose>
            <Button variant="danger" disabled={leaving} onClick={() => void leave(onDiscard)}>
              Discard my answers
            </Button>
            <Button variant="primary" autoFocus loading={leaving} onClick={() => void leave(onSaveAndExit)}>
              Save and finish later
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
