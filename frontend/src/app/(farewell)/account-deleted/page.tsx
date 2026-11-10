import { phoneInlineHit } from '@/components/ui/styles'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { CONTACT_EMAIL } from '@/config/site'
import { LegalPage } from '@/features/marketing/legal-page'

export const metadata: Metadata = {
  title: 'Account deleted',
  robots: { index: false, follow: false },
}

/** Where Settings → Delete account lands once the account is gone. */
export default function AccountDeletedPage() {
  return (
    <LegalPage title="Your account is deleted">
      <p>Your account and course files have been deleted.</p>
      <p>Other devices are signed out when they next load a page.</p>
      <p>
        What stays is anonymous AI usage records, with no name, email, course or file, under a one-way key made from your
        Google account. The key can&apos;t be turned back into your account. It only stops a new account from restarting
        the day&apos;s AI allowance and voice minutes. Backups of the rest expire within 120 days.
      </p>
      <p>
        Questions? Email{' '}
        <a className={`${phoneInlineHit} text-accent underline underline-offset-4 hover:text-accent-hover`} href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
        .
      </p>
      <div>
        <Button asChild variant="secondary">
          <Link href="/">Go to the home page</Link>
        </Button>
      </div>
    </LegalPage>
  )
}
