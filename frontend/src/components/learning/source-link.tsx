import * as React from 'react'
import { File, FileDoc, FilePdf, FilePpt } from '@phosphor-icons/react/dist/ssr'
import { viewerUrl } from '@/lib/chat/citations'
import { mergeSources, sourceText, type SourceRef } from '@/lib/topics/sources'
import { cn } from '@/lib/utils'

/** The file-type icon for a file name (PDF, Word, slides, anything else). */
export function SourceIcon({ filename }: { filename: string }) {
  const extension = filename.split('.').pop()?.toLowerCase()
  if (extension === 'pdf') return <FilePdf />
  if (extension === 'docx' || extension === 'doc') return <FileDoc />
  if (extension === 'pptx' || extension === 'ppt') return <FilePpt />
  return <File />
}

// On a phone the link's own box is 44px high (padding on an inline box does not move the lines), not only its touch area.
const linkClass =
  'relative rounded-chip max-sm:py-3.5 underline decoration-border-strong decoration-1 underline-offset-[3px] transition-colors duration-120 hover:text-fg hover:decoration-fg-3 max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:top-1/2 max-sm:after:h-11 max-sm:after:-translate-y-1/2 max-sm:after:content-[""]'

/** "lecture3.pdf, pp. 4-9" as a link to the file viewer at that page (plain text for a file with no id). */
export function SourceLink({ source, className }: { source: SourceRef; className?: string }) {
  const text = sourceText(source)
  if (!source.materialId) return <span className={className}>{text}</span>
  return (
    <a
      href={viewerUrl({ materialId: source.materialId, filename: source.filename, pageStart: source.pageStart })}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(linkClass, className)}
    >
      {text}
    </a>
  )
}

/**
 * "From lecture3.pdf, p. 4": the line under a worked example, practice problem or review item.
 * Pages of the same file are merged; each file is a link to the viewer. Nothing for content written
 * before sources existed.
 */
export function SourceLine({ sources, className }: { sources: readonly SourceRef[]; className?: string }) {
  const merged = mergeSources(sources)
  if (merged.length === 0) return null
  return (
    <p className={cn('text-small text-fg-3', className)}>
      From{' '}
      {merged.map((source, index) => (
        <React.Fragment key={`${source.materialId ?? source.filename}|${source.pageStart ?? ''}|${source.pageEnd ?? ''}`}>
          {index > 0 ? (index === merged.length - 1 ? ' and ' : ', ') : null}
          <SourceLink source={source} />
        </React.Fragment>
      ))}
    </p>
  )
}
