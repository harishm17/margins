import Link from 'next/link'
import { Brand } from '@/components/shell/brand'
import { SkipLink } from '@/components/shell/skip-link'
import { BRAND_NAME } from '@/config/brand'
import { Shot } from '@/features/marketing/shot'
import { SLOT_SIZES } from '@/features/marketing/shot-sources'
import { ThemeSwitch } from '@/components/ui/theme-switch'
import { AiStatusBanner, AiStatusProvider } from '@/features/ai/ai-status'

/**
 * Two columns on desktop: a form column, and a panel with the whole plan screen (never cropped) and one
 * line about it. On a phone only the form shows, from the top of the page, so the button is above the fold.
 * The screenshot is the real plan page from the showcase course (`npm run screens` refreshes it).
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <AiStatusProvider>
      <SkipLink />
      <AiStatusBanner />
      <div className="grid min-h-dvh lg:grid-cols-[minmax(440px,480px)_1fr]">
        <div className="flex flex-col px-6 py-5 sm:px-12">
          <header className="flex items-center justify-between">
            <Link href="/" className="rounded-chip" aria-label={`${BRAND_NAME} home`}>
              <Brand />
            </Link>
            <ThemeSwitch />
          </header>
          <main id="main" tabIndex={-1} className="flex flex-1 flex-col pt-8 outline-none sm:pt-14 lg:justify-center lg:pt-0">
            <div className="mx-auto w-full max-w-[360px] pb-10 lg:pb-16">{children}</div>
          </main>
        </div>
        <aside aria-label={`About ${BRAND_NAME}`} className="hidden p-4 lg:block">
          <div className="flex h-full flex-col justify-between gap-10 rounded-card bg-surface-2 p-10 xl:p-14">
            <p className="max-w-[26ch] text-title text-fg">
              Know what to study today, and every day until the exam.
            </p>
            <div className="overflow-hidden rounded-card border border-border bg-surface">
              <Shot
                name="plan"
                alt="The plan page of a course: Today lists a review and a quiz, and the days after it lead to the exam date"
                sizes={SLOT_SIZES.auth}
                className="h-auto w-full"
              />
            </div>
          </div>
        </aside>
      </div>
    </AiStatusProvider>
  )
}
