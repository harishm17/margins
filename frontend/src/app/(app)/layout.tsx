import type { Metadata } from 'next'
import { CommandPalette } from '@/components/shell/command-palette'
import { MobileNav } from '@/components/shell/mobile-nav'
import { MobileTabs } from '@/components/shell/mobile-tabs'
import { ShellProvider } from '@/components/shell/shell-provider'
import { ShortcutsDialog } from '@/components/shell/shortcuts-dialog'
import { TimeZoneSync } from '@/features/shell/time-zone-sync'
import { Sidebar } from '@/components/shell/sidebar'
import { SkipLink } from '@/components/shell/skip-link'
import { Topbar } from '@/components/shell/topbar'
import { AiStatusBanner, AiStatusProvider } from '@/features/ai/ai-status'
import { toClientStatus } from '@/lib/ai/status'
import { getAiStatus } from '@/server/ai-status'
import { getNavIndex } from '@/server/queries/courses'
import { requireUser } from '@/server/session'
import { getTimeZoneState } from '@/server/timezone'

export const metadata: Metadata = { robots: { index: false, follow: false } }

/**
 * Signed-in app: sidebar, top bar, command palette, and the AI status (a banner while AI is
 * unavailable; the AI buttons read it too). Signed-out visitors go to /login?next=.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  const { timeZone, known } = await getTimeZoneState()
  const [nav, aiStatus] = await Promise.all([getNavIndex(user.id, timeZone), getAiStatus(user.id)])

  return (
    <AiStatusProvider initial={toClientStatus(aiStatus)}>
      <ShellProvider user={{ name: user.name, email: user.email }} nav={nav}>
        <TimeZoneSync serverKnewZone={known} />
        <SkipLink />
        <div className="flex min-h-dvh">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <AiStatusBanner />
            <Topbar />
            <main id="main" tabIndex={-1} className="flex-1 outline-none">
              {children}
            </main>
            <MobileTabs />
          </div>
        </div>
        <MobileNav />
        <CommandPalette />
        <ShortcutsDialog />
      </ShellProvider>
    </AiStatusProvider>
  )
}
