import { CheckCircle, CircleDashed, CircleHalf, ClockCountdown, LinkSimple, WarningCircle } from '@phosphor-icons/react/dist/ssr'
import type { ConceptLabel } from '@/lib/learning/concept-mastery'

/** One icon per state, so a state is never told by colour alone (the words sit beside it). */
const ICONS = {
  solid: CheckCircle,
  getting_there: CircleHalf,
  shaky: WarningCircle,
  fading: ClockCountdown,
  inferred: LinkSimple,
  not_started: CircleDashed,
} satisfies Record<ConceptLabel, typeof CheckCircle>

/** Tone classes for the icon, as text colour (HTML) or fill and stroke-free SVG use. */
export const STATE_TONE: Record<ConceptLabel, string> = {
  solid: 'text-accent',
  getting_there: 'text-accent',
  shaky: 'text-warning',
  fading: 'text-warning',
  inferred: 'text-fg-2',
  not_started: 'text-fg-3',
}

export function StateIcon({ label, size = 16, className, ...position }: { label: ConceptLabel; size?: number; className?: string; x?: number; y?: number }) {
  const Icon = ICONS[label]
  return <Icon aria-hidden="true" size={size} weight={label === 'not_started' || label === 'inferred' ? 'regular' : 'fill'} className={className ?? STATE_TONE[label]} {...position} />
}
