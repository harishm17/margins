import { START_HERE_TEXT } from '@/lib/map/copy'
import { cn } from '@/lib/utils'

/**
 * The words on an idea that is ready to start. Several ideas can be "Next up"; only the first is "Start here", and only
 * it is drawn as a filled badge, so the one recommended place to begin stands out of the rest (which are quiet text).
 */
export function FrontierBadge({ text, className }: { text: string; className?: string }) {
  const start = text === START_HERE_TEXT
  return (
    <span
      className={cn(
        'whitespace-nowrap text-caption max-sm:text-small',
        start ? 'rounded-chip border border-accent bg-accent-soft px-1.5 font-medium text-accent-soft-fg' : 'font-normal text-fg-2',
        className
      )}
    >
      {text}
    </span>
  )
}
