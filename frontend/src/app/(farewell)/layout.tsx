import Link from 'next/link'
import { Brand } from '@/components/shell/brand'
import { SkipLink } from '@/components/shell/skip-link'
import { ThemeSwitch } from '@/components/ui/theme-switch'
import { phoneRow } from '@/components/ui/styles'
import { BRAND_NAME } from '@/config/brand'
import { CONTACT_EMAIL } from '@/config/site'

/**
 * The page shown right after the account is closed. It has the public header without sign-in buttons and a
 * one-line footer instead of the product footer, so the confirmation, the contact address and the way out
 * are the only things on the page (a "Sign in" link under "your account is deleted" pulls the eye away).
 */
export default function FarewellLayout({ children }: { children: React.ReactNode }) {
  const link = `${phoneRow} rounded-chip underline underline-offset-2 transition-colors duration-120 hover:text-fg`
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <header className="mx-auto flex h-16 w-full max-w-[1280px] items-center justify-between px-4 md:px-8">
        <Link href="/" aria-label={`${BRAND_NAME} home`} className="inline-flex rounded-chip max-sm:min-h-11 max-sm:items-center">
          <Brand />
        </Link>
        <ThemeSwitch />
      </header>
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <footer className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-6 border-t border-border px-4 py-3 text-small text-fg-2 md:px-8">
        <span>
          &copy; <span className="tabular">{new Date().getFullYear()}</span> {BRAND_NAME}
        </span>
        <Link href="/privacy" className={link}>
          Privacy
        </Link>
        <a href={`mailto:${CONTACT_EMAIL}`} className={link}>
          {CONTACT_EMAIL}
        </a>
      </footer>
    </div>
  )
}
