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
      <p>
        Your courses, the files you uploaded and everything made from them are gone. You&apos;ve been signed out on
        this device, and any other device you used is signed out the next time it loads a page.
      </p>
      <p>
        Questions? Email{' '}
        <a className="text-accent underline underline-offset-4 hover:text-accent-hover" href={`mailto:${CONTACT_EMAIL}`}>
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
