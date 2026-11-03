'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowCounterClockwise, Barbell } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { InlineAlert } from '@/components/ui/inline-alert'
import { MathText } from '@/components/ui/math-text'
import { ProgressRing } from '@/components/ui/progress-ring'
import { linkForLabel } from '@/lib/voice/page-refs'
import type { VoiceAlert } from './errors'
import { clip, sessionLine } from './format'
import type { EndReason, SessionSummary } from './session-state'
import type { VoiceStyle } from './voice-api'

type SummaryProps = {
  /** The style of the session that ended; words the heading and the counts. */
  style: VoiceStyle
  summary: SessionSummary
  reason: EndReason | null
  alert: VoiceAlert | null
  back: { href: string; label: string }
  /** Where "Practice this" goes: a drill on the idea (or the topic) that came up short. Null when there is no such page. */
  practiceHref: string | null
  onRestart: () => void
}

const REASON_NOTE: Partial<Record<EndReason, string>> = {
  idle: 'The session ended because it was quiet for a while.',
  ended: 'This session had already ended.',
}

const FINISHED: Record<VoiceStyle, { quiz: string; talk: string }> = {
  oral_quiz: { quiz: 'Practice finished', talk: 'Conversation finished' },
  teach_back: { quiz: 'Teach-back finished', talk: 'Teach-back finished' },
  guided_reading: { quiz: 'Reading finished', talk: 'Reading finished' },
}

export function Summary({ style, summary, reason, alert, back, practiceHref, onRestart }: SummaryProps) {
  const quiz = summary.answered > 0
  const note = reason ? REASON_NOTE[reason] : undefined
  const nextStep = nextStepFor(style, summary)
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  React.useEffect(() => headingRef.current?.focus(), [])

  return (
    <div className="flex max-w-[560px] flex-col gap-4" data-testid="voice-summary">
      {alert ? (
        <InlineAlert tone={alert.tone} title={alert.title}>
          {alert.text}
        </InlineAlert>
      ) : note ? (
        <InlineAlert tone="neutral">{note}</InlineAlert>
      ) : null}

      <Card>
        <h2 ref={headingRef} tabIndex={-1} className="text-heading text-fg outline-none">
          {quiz ? FINISHED[style].quiz : FINISHED[style].talk}
        </h2>
        <p className="mt-1 text-small text-fg-2">
          {sessionLine(summary, !quiz)}
        </p>

        {quiz ? (
          <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-4">
            <ProgressRing
              size={96}
              value={summary.score}
              label={summary.score === null ? undefined : `${Math.round(summary.score * 100)}%`}
              aria-label={summary.score === null ? 'Not graded' : `${Math.round(summary.score * 100)} percent correct`}
            />
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              <Stat label={style === 'guided_reading' ? 'Checks answered' : 'Questions answered'} value={summary.answered} testId="voice-stat-answered" />
              <Stat label="Correct" value={summary.correct} testId="voice-stat-correct" />
              {summary.partly > 0 ? <Stat label="Partly right" value={summary.partly} /> : null}
            </dl>
          </div>
        ) : null}

        {style === 'teach_back' ? (
          <div className="mt-6 flex flex-col gap-4 border-t border-border pt-4" data-testid="voice-ideas">
            {summary.explained.length > 0 ? (
              <div>
                <h3 className="text-subheading text-fg">Explained in your own words</h3>
                <ul className="mt-2 flex flex-col gap-1" data-testid="voice-ideas-explained">
                  {summary.explained.map((name) => (
                    <li key={name} className="text-small text-fg-2">
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {summary.taught.length > 0 ? (
              <div>
                <h3 className="text-subheading text-fg">Explained to you after two questions</h3>
                <ul className="mt-2 flex flex-col gap-1" data-testid="voice-ideas-taught">
                  {summary.taught.map((idea) => (
                    <li key={idea.name} className="text-small text-fg-2">
                      {idea.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {summary.explained.length === 0 && summary.taught.length === 0 ? (
              <div>
                <h3 className="text-subheading text-fg">Explained in your own words</h3>
                <p className="mt-1 text-small text-fg-2" data-testid="voice-ideas-none">
                  No idea was finished before the session ended.
                </p>
              </div>
            ) : null}
            <div>
              <h3 className="text-subheading text-fg">To revisit</h3>
              {summary.taught.length > 0 || summary.unfinished ? (
                <ul className="mt-2 flex flex-col gap-1" data-testid="voice-ideas-revisit">
                  {summary.taught.map((idea) => (
                    <li key={idea.name} className="text-small text-fg-2">
                      {idea.name}
                      {idea.lookAgain.length > 0 ? <>: look again at <PageLinks labels={idea.lookAgain} links={idea.lookLinks} /></> : null}
                    </li>
                  ))}
                  {summary.unfinished ? (
                    <li className="text-small text-fg-2">
                      {summary.unfinished.name}: not finished
                    </li>
                  ) : null}
                </ul>
              ) : (
                <p className="mt-1 text-small text-fg-2" data-testid="voice-ideas-revisit">
                  Nothing to revisit.
                </p>
              )}
            </div>
          </div>
        ) : null}

        {quiz ? (
          <div className="mt-6 border-t border-border pt-4">
            <h3 className="text-subheading text-fg">{style === 'guided_reading' ? 'Checks to revisit' : 'Questions to revisit'}</h3>
            {summary.revisit.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-2" data-testid="voice-revisit">
                {summary.revisit.slice(0, 6).map((question) => (
                  <li key={question.text} className="text-small text-fg-2">
                    <MathText>{clip(question.text)}</MathText>
                    {question.lookLinks.length > 0 ? (
                      <span className="mt-0.5 block">
                        Look again at <PageLinks labels={question.lookLinks.map((link) => link.label)} links={question.lookLinks} />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-small text-fg-2">Every answer was right. Nothing to revisit.</p>
            )}
          </div>
        ) : null}

        {nextStep ? (
          <div className="mt-6 flex flex-col items-start gap-3 border-t border-border pt-4" data-testid="voice-next-step">
            <div>
              <h3 className="text-subheading text-fg">Next step</h3>
              <p className="mt-1 text-small text-fg-2">{nextStep.text}</p>
            </div>
            {nextStep.practice && practiceHref ? (
              <Button asChild variant="primary" icon={<Barbell />}>
                <Link href={practiceHref}>Practice this</Link>
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button variant={nextStep?.practice && practiceHref ? 'secondary' : 'primary'} icon={<ArrowCounterClockwise />} onClick={onRestart}>
            Start again
          </Button>
          <Button asChild variant="secondary">
            <Link href={back.href}>{back.label}</Link>
          </Button>
        </div>
      </Card>
    </div>
  )
}

/** One thing to do next: practise what came up short, or explain it again later to make it stick. Null when nothing happened. */
function nextStepFor(style: VoiceStyle, summary: SessionSummary): { text: string; practice: boolean } | null {
  if (summary.taught.length > 0 || summary.revisit.length > 0 || summary.unfinished) {
    return { text: 'Practise what came up short while it is fresh, then check the pages above.', practice: true }
  }
  if (style === 'teach_back' && summary.explained.length > 0) {
    return { text: 'Explain it again tomorrow, from memory. Saying it twice, a day apart, is what makes it stick.', practice: false }
  }
  // Ended before anything began: the way on is the same button as always, with a line that says what it does.
  if (style === 'teach_back') return { text: 'Start again to explain the first idea in your own words.', practice: false }
  return null
}

/** "p. 5, p. 7": each page opens in the student's own file when a link for it is known (the same label, or a range that covers the page). */
function PageLinks({ labels, links }: { labels: string[]; links: { label: string; href: string }[] }) {
  return labels.map((label, index) => {
    const link = linkForLabel(label, links)
    return (
      <React.Fragment key={`${label}-${index}`}>
        {index > 0 ? ', ' : null}
        {link ? (
          <a href={link.href} target="_blank" rel="noreferrer" className="text-fg underline decoration-border-strong decoration-1 underline-offset-[3px] hover:text-accent">
            {label}
            <span className="sr-only"> (opens your file in a new tab)</span>
          </a>
        ) : (
          label
        )}
      </React.Fragment>
    )
  })
}

function Stat({ label, value, testId }: { label: string; value: number; testId?: string }) {
  return (
    <div>
      <dt className="text-small text-fg-2">{label}</dt>
      <dd className="tabular text-heading text-fg" data-testid={testId}>
        {value}
      </dd>
    </div>
  )
}
