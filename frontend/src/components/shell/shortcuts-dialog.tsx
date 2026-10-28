'use client'

import * as React from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useModKey } from '@/lib/hooks/use-is-mac'
import { useShell } from './shell-provider'

type Keys = { chord: string[] } | { range: [string, string] }
type Row = { label: string; keys: Keys[] }

const chord = (...keys: string[]): Keys => ({ chord: keys })
const range = (from: string, to: string): Keys => ({ range: [from, to] })

/** A row lists alternatives; a chord is keys pressed together, a range reads "1 to 4". */
function sections(mod: string): { title: string; rows: Row[] }[] {
  return [
    {
      title: 'Anywhere',
      rows: [
        { label: 'Open the command palette', keys: [chord(mod, 'K')] },
        { label: 'Show these shortcuts', keys: [chord('?')] },
      ],
    },
    {
      title: 'Topic page',
      rows: [
        { label: 'Switch view: notes, examples, practice, quiz, voice', keys: [range('1', '5')] },
        { label: 'Previous or next topic', keys: [chord('['), chord(']')] },
      ],
    },
    {
      title: 'Quiz and mock exam',
      rows: [
        { label: 'Pick an option', keys: [range('1', '4'), range('A', 'D')] },
        { label: 'True or false', keys: [chord('T'), chord('F')] },
        { label: 'Focus the short answer box', keys: [chord('S')] },
        { label: 'Next question, or check', keys: [chord('Enter')] },
        { label: 'Previous or next question', keys: [chord('Left'), chord('Right')] },
      ],
    },
    {
      title: 'Ask',
      rows: [
        { label: 'Send', keys: [chord('Enter')] },
        { label: 'New line', keys: [chord('Shift', 'Enter')] },
        { label: 'Stop an answer', keys: [chord('Esc')] },
      ],
    },
  ]
}

export function ShortcutsDialog() {
  const { shortcutsOpen, setShortcutsOpen } = useShell()
  const mod = useModKey()

  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press ? any time to see this list.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-6">
          {sections(mod).map((section) => (
            <section key={section.title} aria-labelledby={`shortcuts-${section.title}`}>
              <h3 id={`shortcuts-${section.title}`} className="mb-2 text-subheading text-fg">
                {section.title}
              </h3>
              <ul className="divide-y divide-border">
                {section.rows.map((row) => (
                  <li key={row.label} className="flex items-center justify-between gap-4 py-2 text-small text-fg-2">
                    <span>{row.label}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {row.keys.map((keys, index) => (
                        <React.Fragment key={index}>
                          {index > 0 ? <span className="text-caption font-normal text-fg-3">or</span> : null}
                          <span className="flex items-center gap-1">
                            {'range' in keys ? (
                              <>
                                <Kbd persistent>{keys.range[0]}</Kbd>
                                <span className="text-caption font-normal text-fg-3">to</span>
                                <Kbd persistent>{keys.range[1]}</Kbd>
                              </>
                            ) : (
                              keys.chord.map((key) => <Kbd key={key} persistent>{key}</Kbd>)
                            )}
                          </span>
                        </React.Fragment>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
