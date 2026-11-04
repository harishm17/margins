import { phoneInlineHit } from '@/components/ui/styles'
import type { Metadata } from 'next'
import { CONTACT_EMAIL } from '@/config/site'
import { LegalContents, LegalPage, LegalSection } from '@/features/marketing/legal-page'

export const metadata: Metadata = {
  title: 'Terms',
  description: 'The terms for using Margins.',
  alternates: { canonical: '/terms' },
}

const SECTIONS = [
  { id: 'service', heading: 'The service' },
  { id: 'files', heading: 'Your files' },
  { id: 'generated', heading: 'Generated study material' },
  { id: 'acceptable-use', heading: 'Acceptable use' },
  { id: 'accounts', heading: 'Accounts' },
  { id: 'changes', heading: 'Changes and questions' },
]

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Use">
      <p>By using Margins you agree to these terms. Last updated October 20, 2026.</p>
      <LegalContents sections={SECTIONS} />
      <LegalSection id="service" heading="The service">
        <p>Margins is provided as is, for personal study. It is free to use, and features or limits may change.</p>
      </LegalSection>
      <LegalSection id="files" heading="Your files">
        <p>Only upload material you have the right to use. You keep ownership of your files and of what you write.</p>
      </LegalSection>
      <LegalSection id="generated" heading="Generated study material">
        <p>
          Study material created by Margins can contain mistakes. Check important facts against your course
          materials and your instructors.
        </p>
      </LegalSection>
      <LegalSection id="acceptable-use" heading="Acceptable use">
        <p>
          Don&apos;t use Margins to break the law, to attack the service, or to break your school&apos;s academic
          integrity rules, such as using it during an exam where that isn&apos;t allowed.
        </p>
      </LegalSection>
      <LegalSection id="accounts" heading="Accounts">
        <p>
          We may suspend accounts that misuse the service. You can stop using Margins and delete your data at any
          time.
        </p>
      </LegalSection>
      <LegalSection id="changes" heading="Changes and questions">
        <p>
          These terms may be updated; the date at the top shows the latest version. Questions:{' '}
          <a className={`${phoneInlineHit} text-accent underline underline-offset-4 hover:text-accent-hover`} href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  )
}
