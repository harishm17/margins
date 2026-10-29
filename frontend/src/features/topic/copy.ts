import type { ContentKind } from './types'

/** Words for each kind of content, in one place so the tabs, empty states and toasts agree. */
export const KIND_COPY: Record<
  ContentKind,
  {
    /** "notes", for "Regenerate notes". */
    noun: string
    /** "No notes yet". */
    emptyTitle: string
    /** "Write notes". */
    create: string
    /** "Notes are ready". */
    ready: string
    /** "Notes couldn't be written". */
    failed: string
    /** Menu label: "Regenerate notes". */
    regenerate: string
    /** What a replacement removes. */
    replaces: string
  }
> = {
  notes: {
    noun: 'notes',
    emptyTitle: 'No notes yet',
    create: 'Write notes',
    ready: 'Notes are ready',
    failed: "Notes couldn't be written",
    regenerate: 'Regenerate notes',
    replaces: 'This replaces your current notes.',
  },
  examples: {
    noun: 'worked examples',
    emptyTitle: 'No worked examples yet',
    create: 'Create examples',
    ready: 'Worked examples are ready',
    failed: "Worked examples couldn't be created",
    regenerate: 'Regenerate examples',
    replaces: 'This replaces your current worked examples.',
  },
  practice: {
    noun: 'practice',
    emptyTitle: 'No practice yet',
    create: 'Create practice',
    ready: 'Practice is ready',
    failed: "Practice couldn't be created",
    regenerate: 'Regenerate practice',
    replaces: 'This replaces your current practice problems and clears your progress on them.',
  },
  quiz: {
    noun: 'quiz',
    emptyTitle: 'No quiz yet',
    create: 'Create a quiz',
    ready: 'Your new quiz set is ready',
    failed: "The quiz couldn't be created",
    regenerate: 'Regenerate quiz',
    replaces: 'This adds a new quiz set. Your earlier sets and attempts stay.',
  },
}
