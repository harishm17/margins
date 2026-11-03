'use client'

import * as React from 'react'
import { ArrowSquareOut, FileText } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { LazyMarkdown } from '@/components/ui/lazy-markdown'
import { cn } from '@/lib/utils'
import {
  isPdf,
  pageLabel,
  quoteForDisplay,
  sourceLabel,
  viewerUrl,
  type ChatSource,
} from '@/lib/chat/citations'

/** The cited text of a source in a dialog, for files that cannot open at a page. */
export function ExcerptDialog({
  source,
  open,
  onOpenChange,
}: {
  source: ChatSource
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{source.filename}</DialogTitle>
          <DialogDescription>{pageLabel(source) ?? source.section ?? 'Excerpt from your materials'}</DialogDescription>
        </DialogHeader>
        <blockquote className="border-l-2 border-border-strong pl-4">
          <LazyMarkdown variant="compact">{quoteForDisplay(source.citedText) || 'No excerpt was saved for this source.'}</LazyMarkdown>
        </blockquote>
      </DialogContent>
    </Dialog>
  )
}

/** "Open page" for PDFs, "View excerpt" for everything else. */
function SourceAction({ source, onExcerpt, className }: { source: ChatSource; onExcerpt: () => void; className?: string }) {
  if (isPdf(source.filename)) {
    return (
      <Button asChild variant="link" size="sm" className={cn('h-auto p-0', className)} icon={<ArrowSquareOut />}>
        <a href={viewerUrl(source)} target="_blank" rel="noopener noreferrer">
          Open page
        </a>
      </Button>
    )
  }
  return (
    <Button variant="link" size="sm" className={cn('h-auto p-0', className)} icon={<FileText />} onClick={onExcerpt}>
      View excerpt
    </Button>
  )
}

/** The small superscript number in an answer. Hover, focus or tap shows the quote. */
export function CitationPill({ source, marker }: { source: ChatSource | undefined; marker: number }) {
  const [open, setOpen] = React.useState(false)
  const [excerptOpen, setExcerptOpen] = React.useState(false)

  if (!source) {
    return <sup className="mx-0.5 font-mono text-[11px] text-fg-3">[{marker}]</sup>
  }
  const pages = pageLabel(source)

  return (
    <>
      <HoverCard open={open} onOpenChange={setOpen}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-label={`Source ${marker}: ${sourceLabel(source)}`}
            onClick={() => setOpen(true)}
            className={cn(
              'relative -top-[0.35em] mx-[1px] inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-chip px-1 align-baseline',
              'bg-accent-soft font-mono text-[11px] font-medium leading-none text-accent-soft-fg',
              'transition-colors duration-120 hover:bg-accent hover:text-accent-fg',
              // A larger tap area on touch screens without growing the pill.
              'before:absolute before:-inset-2 before:content-[""]'
            )}
          >
            {marker}
          </button>
        </HoverCardTrigger>
        <HoverCardContent align="start">
          <p className="truncate text-body-strong text-fg">{source.filename}</p>
          <p className="text-caption text-fg-3">{pages ?? source.section ?? 'Your materials'}</p>
          {source.citedText ? (
            <blockquote className="mt-3 line-clamp-5 border-l-2 border-border-strong pl-3 text-small text-fg-2">
              {quoteForDisplay(source.citedText)}
            </blockquote>
          ) : null}
          <div className="mt-3">
            <SourceAction
              source={source}
              onExcerpt={() => {
                setOpen(false)
                setExcerptOpen(true)
              }}
            />
          </div>
        </HoverCardContent>
      </HoverCard>
      <ExcerptDialog source={source} open={excerptOpen} onOpenChange={setExcerptOpen} />
    </>
  )
}

const COLLAPSED_SOURCES = 3

/** The numbered sources under an answer, collapsed to the first three. */
export function SourcesList({ sources }: { sources: readonly ChatSource[] }) {
  const [expanded, setExpanded] = React.useState(false)
  const [excerpt, setExcerpt] = React.useState<ChatSource | null>(null)
  if (sources.length === 0) return null

  const ordered = [...sources].sort((a, b) => a.marker - b.marker)
  const shown = expanded ? ordered : ordered.slice(0, COLLAPSED_SOURCES)

  return (
    <section aria-label="Sources" className="mt-4">
      <h2 className="text-caption text-fg-3">Sources</h2>
      <ol className="mt-1.5 flex flex-col">
        {shown.map((source) => (
          <li key={source.marker} className="flex min-h-8 items-center gap-2.5 py-1 text-small">
            <span className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-chip bg-accent-soft px-1 font-mono text-[11px] font-medium text-accent-soft-fg">
              {source.marker}
            </span>
            <span className="min-w-0 flex-1 truncate text-fg-2" title={sourceLabel(source)}>
              {sourceLabel(source)}
            </span>
            <SourceAction source={source} onExcerpt={() => setExcerpt(source)} className="shrink-0 text-small" />
          </li>
        ))}
      </ol>
      {sources.length > COLLAPSED_SOURCES ? (
        <Button
          variant="link"
          size="sm"
          className="mt-1 h-auto p-0 text-small"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show fewer' : `Show all ${sources.length}`}
        </Button>
      ) : null}
      {excerpt ? (
        <ExcerptDialog source={excerpt} open onOpenChange={(open) => (open ? undefined : setExcerpt(null))} />
      ) : null}
    </section>
  )
}
