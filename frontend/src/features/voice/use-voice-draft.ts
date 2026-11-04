'use client'

import * as React from 'react'

/**
 * The answer a student has typed in Voice practice and not yet sent, kept so a reload does not lose it (W1-02).
 * The session view reads and writes it here; this version keeps it in this browser, one per course.
 * `restoredTranscript` is the earlier turns of the session the draft belongs to, when they were kept too.
 */
export function useVoiceDraft(courseId: string): {
  draft: string
  setDraft: (value: string) => void
  clear: () => void
  restoredTranscript: string[] | null
} {
  const key = `margins.voice.draft.${courseId}`
  const [draft, setDraftState] = React.useState('')

  // The saved draft is read after mount, so the server and the first browser render agree.
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(key)
      if (saved) setDraftState(saved)
    } catch {
      // Without storage the draft lives only in the page.
    }
  }, [key])

  const setDraft = React.useCallback(
    (value: string) => {
      setDraftState(value)
      try {
        if (value) localStorage.setItem(key, value)
        else localStorage.removeItem(key)
      } catch {
        // Not saving is fine.
      }
    },
    [key]
  )
  const clear = React.useCallback(() => setDraft(''), [setDraft])
  return { draft, setDraft, clear, restoredTranscript: null }
}
