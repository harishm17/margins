import type { Metadata } from 'next'
import { FocusShell } from '@/components/shell/focus-shell'
import { AiStatusProvider } from '@/features/ai/ai-status'
import { toClientStatus } from '@/lib/ai/status'
import { getAiStatus } from '@/server/ai-status'
import { requireUser } from '@/server/session'

export const metadata: Metadata = { robots: { index: false, follow: false } }

/**
 * Exam taking and other full-screen tasks: signed-in only, no sidebar. The AI status is here too, so a screen that asks the
 * AI for something (the review session grades answers) learns of an outage the way the rest of the app does. It draws nothing
 * itself: a screen that wants the banner renders it.
 */
export default async function FocusLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  const aiStatus = await getAiStatus(user.id)
  return (
    <AiStatusProvider initial={toClientStatus(aiStatus)}>
      <FocusShell>{children}</FocusShell>
    </AiStatusProvider>
  )
}
