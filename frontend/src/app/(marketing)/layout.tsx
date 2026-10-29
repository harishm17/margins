import Link from 'next/link'
import { Brand } from '@/components/shell/brand'
import { SkipLink } from '@/components/shell/skip-link'
import { BRAND_NAME } from '@/config/brand'
import { CONTACT_EMAIL } from '@/config/site'
import { NavActions } from '@/features/marketing/auth-actions'
import { LINKS } from '@/features/marketing/content'
import { MarketingMenu } from '@/features/marketing/marketing-menu'
import { SECTION_LINKS } from '@/features/marketing/nav-links'
import { SectionLink } from '@/features/marketing/section-link'
import { ThemeSwitch } from '@/components/ui/theme-switch'
import { AiStatusBanner, AiStatusProvider } from '@/features/ai/ai-status'

const navLink =
  'rounded-chip px-2 py-1.5 text-body text-fg-2 transition-colors duration-120 hover:text-fg'
const footerLink = 'rounded-chip text-small text-fg-2 transition-colors duration-120 hover:text-fg hover:underline'
const footerHeading = 'text-small font-medium text-fg'

/** Public pages: a 64px nav with the theme switch, the content, and a footer that says where things are. Fully static; sign in state is a client island. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <AiStatusProvider>
      <div className="flex min-h-dvh flex-col">
        <SkipLink />
        <AiStatusBanner />
        <header className="mx-auto flex h-16 w-full max-w-[1280px] items-center gap-6 px-4 md:px-8">
          <Link href="/" aria-label={`${BRAND_NAME} home`} className="rounded-chip">
            <Brand />
          </Link>
          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            {SECTION_LINKS.map((link) => (
              <SectionLink key={link.section} section={link.section} className={navLink}>
                {link.label}
              </SectionLink>
            ))}
          </nav>
          <nav aria-label="Account" className="ml-auto flex items-center gap-1 sm:gap-2">
            <ThemeSwitch />
            <NavActions />
            <MarketingMenu className="md:hidden" />
          </nav>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          {children}
        </main>
        <footer className="border-t border-border">
          <div className="mx-auto grid w-full max-w-[1280px] gap-10 px-4 py-12 md:px-8 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
            <div>
              <Brand />
              <p className="mt-3 max-w-[32ch] text-small text-fg-2">Study from your own course files, with a plan to your exam date.</p>
            </div>
            <nav aria-label="Product" className="flex flex-col gap-2.5">
              <p className={footerHeading}>Product</p>
              {SECTION_LINKS.map((link) => (
                <SectionLink key={link.section} section={link.section} className={footerLink}>
                  {link.label}
                </SectionLink>
              ))}
              <Link href="/evaluation" className={footerLink}>
                How it is evaluated
              </Link>
              <Link href="/login" className={footerLink}>
                Sign in
              </Link>
            </nav>
            <nav aria-label="Open source" className="flex flex-col gap-2.5">
              <p className={footerHeading}>Open source</p>
              <a href={LINKS.github} className={footerLink} target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
              <a href={LINKS.eval} className={footerLink} target="_blank" rel="noopener noreferrer">
                Evaluation results
              </a>
              <a href={LINKS.license} className={footerLink} target="_blank" rel="noopener noreferrer">
                MIT license
              </a>
            </nav>
            <nav aria-label="Legal and contact" className="flex flex-col gap-2.5">
              <p className={footerHeading}>Company</p>
              <Link href="/privacy" className={footerLink}>
                Privacy
              </Link>
              <Link href="/terms" className={footerLink}>
                Terms
              </Link>
              <a href={LINKS.mail} className={footerLink}>
                {CONTACT_EMAIL}
              </a>
            </nav>
          </div>
          <div className="mx-auto w-full max-w-[1280px] border-t border-border px-4 py-5 text-small text-fg-2 md:px-8">
            &copy; <span className="tabular">{new Date().getFullYear()}</span> {BRAND_NAME}, built by Harish Manoharan.
          </div>
        </footer>
      </div>
    </AiStatusProvider>
  )
}
