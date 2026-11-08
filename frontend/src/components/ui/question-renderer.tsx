'use client'

import * as React from 'react'
import * as RadioGroup from '@radix-ui/react-radio-group'
import { answerUnit, type PublicQuizQuestion } from '@/lib/learning/quiz-questions'
import { cn } from '@/lib/utils'
import { Input } from './input'
import { MathText } from './math-text'
import { QuestionText, stemHasBlocks, stemIsLong } from './question-text'
import { useScrollableFocus } from './scrollable'
import { Textarea } from './textarea'

type QuestionRendererProps = {
  question: PublicQuizQuestion
  /** The current answer: an option id ("A"), "true" or "false", or the typed text. */
  value: string | null | undefined
  onChange: (value: string) => void
  disabled?: boolean
  /** Turn on the keyboard shortcuts: 1-4 or A-D, T/F, and S to focus the answer box. */
  shortcuts?: boolean
  /** Show "(2 points)" after the question. Default true. */
  showPoints?: boolean
  className?: string
}

const isTypingTarget = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

type Choice = { value: string; tile: string; content: React.ReactNode; label?: string }

/**
 * An option that is only a formula ("$12/36$") has no text a screen reader or axe can take a name
 * from once KaTeX has drawn it, so the button gets one: its letter and the formula's source.
 */
function mathOnlyLabel(tile: string, text: string): string | undefined {
  const match = /^\s*\$+([^$]+)\$+\s*$/.exec(text)
  return match ? `${tile}: ${match[1].trim()}` : undefined
}

function ChoiceList({
  choices,
  value,
  onChange,
  disabled,
  label,
}: {
  choices: Choice[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  label: string
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="flex flex-col gap-2"
    >
      {choices.map((choice) => (
        <RadioGroup.Item
          key={choice.value}
          value={choice.value}
          aria-label={choice.label}
          className={cn(
            'group flex w-full items-start gap-3 rounded-control border border-control bg-surface px-3 py-2.5 text-left text-body text-fg',
            'transition-[background-color,border-color] duration-120 hover:bg-surface-2',
            'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft',
            'disabled:cursor-default disabled:opacity-70 disabled:hover:bg-surface'
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'mt-px grid size-6 shrink-0 place-items-center rounded-chip bg-surface-2 font-mono text-caption text-fg-2',
              'group-data-[state=checked]:bg-accent group-data-[state=checked]:text-accent-fg'
            )}
          >
            {choice.tile}
          </span>
          <span className="min-w-0 flex-1 overflow-x-auto pt-px">{choice.content}</span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}

/**
 * One question and its answer control, shared by quizzes, mock exams and practice.
 * Controlled: the caller owns the value.
 */
export function QuestionRenderer({
  question,
  value,
  onChange,
  disabled,
  shortcuts,
  showPoints = true,
  className,
}: QuestionRendererProps) {
  const answerRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const current = value ?? ''
  const type = question.question_type

  const options = React.useMemo(
    () => (question.options ?? []).map((option, index) => ({ ...option, tile: option.id || String.fromCharCode(65 + index) })),
    [question.options]
  )

  React.useEffect(() => {
    if (!shortcuts || disabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return
      const key = event.key.toLowerCase()

      if (type === 'multiple_choice') {
        const index = /^[1-9]$/.test(key) ? Number(key) - 1 : key.charCodeAt(0) - 97
        const option = key.length === 1 ? options[index] : undefined
        if (option && index >= 0) {
          event.preventDefault()
          onChange(option.id)
        }
      } else if (type === 'true_false') {
        if (key === 't' || key === '1') onChange('true')
        else if (key === 'f' || key === '2') onChange('false')
        else return
        event.preventDefault()
      } else if (key === 's') {
        event.preventDefault()
        answerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shortcuts, disabled, type, options, onChange])

  let control: React.ReactNode
  if (type === 'multiple_choice') {
    control = (
      <ChoiceList
        label="Answer options"
        value={current}
        onChange={onChange}
        disabled={disabled}
        choices={options.map((option) => ({
          value: option.id,
          tile: option.tile,
          label: mathOnlyLabel(option.tile, option.text),
          content: <MathText>{option.text}</MathText>,
        }))}
      />
    )
  } else if (type === 'true_false') {
    control = (
      <ChoiceList
        label="True or false"
        value={current.toLowerCase()}
        onChange={onChange}
        disabled={disabled}
        choices={[
          { value: 'true', tile: 'T', content: 'True' },
          { value: 'false', tile: 'F', content: 'False' },
        ]}
      />
    )
  } else if (type === 'numerical') {
    control = (
      <Input
        ref={answerRef as React.Ref<HTMLInputElement>}
        aria-label="Your answer"
        inputMode="decimal"
        autoComplete="off"
        placeholder="Your answer"
        value={current}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        trailing={answerUnit(question.unit) || undefined}
        containerClassName="max-w-xs"
      />
    )
  } else {
    control = (
      <Textarea
        ref={answerRef as React.Ref<HTMLTextAreaElement>}
        aria-label="Your answer"
        placeholder="Write your answer"
        rows={4}
        maxRows={14}
        value={current}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }

  const blocks = stemHasBlocks(question.question_text)
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  useScrollableFocus(headingRef, question.question_text)
  const pointsText =
    showPoints && question.points ? `(${question.points} ${question.points === 1 ? 'point' : 'points'})` : null

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {blocks ? (
        // A stem with a table, a listing or several paragraphs: the question is the block text; the
        // heading is only there so assistive technology lands on it.
        <div>
          <h2 className="sr-only">Question</h2>
          <QuestionText>{question.question_text}</QuestionText>
          {pointsText ? <p className="mt-1 text-small text-fg-3 tabular">{pointsText}</p> : null}
        </div>
      ) : (
        <h2 ref={headingRef} className={cn('overflow-x-auto text-fg', stemIsLong(question.question_text) ? 'text-[17px] font-medium leading-[27px]' : 'text-heading')}>
          <MathText>{question.question_text}</MathText>
          {pointsText ? <span className="ml-2 whitespace-nowrap text-small font-normal text-fg-3 tabular">{pointsText}</span> : null}
        </h2>
      )}
      {control}
    </div>
  )
}
