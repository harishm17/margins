import { phoneInlineHit } from '@/components/ui/styles'
import type { Metadata } from 'next'
import { CONTACT_EMAIL } from '@/config/site'
import { LegalContents, LegalList, LegalPage, LegalSection } from '@/features/marketing/legal-page'

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What Margins stores, why, and the choices you have.',
  alternates: { canonical: '/privacy' },
}

const SECTIONS = [
  { id: 'store', heading: 'What we store' },
  { id: 'use', heading: "How it's used" },
  { id: 'services', heading: 'Services we use' },
  { id: 'choices', heading: 'Your choices' },
  { id: 'contact', heading: 'Contact' },
]

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        Margins is a study tool run by Harish Manoharan. This page explains what we store and why. Last updated
        November 4, 2026.
      </p>
      <LegalContents sections={SECTIONS} />
      <LegalSection id="store" heading="What we store">
        <LegalList
          items={[
            { name: 'Your account', text: 'your email address, your name and your Google account ID, from signing in with Google. Accounts made with a password before Google sign-in also still have that password stored, hashed and no longer used.' },
            { name: 'Your files and what Margins makes from them', text: 'notes, examples, practice, quizzes, mock exams, chat answers, your answers and scores, and voice practice transcripts. Transcripts are deleted after 180 days; the scores they produced stay.' },
            { name: 'Basic usage records', text: 'such as how much AI processing your account used each day, so we can keep the service within its limits.' },
          ]}
        />
      </LegalSection>
      <LegalSection id="use" heading="How it's used">
        <p>
          Only to run Margins for you: to process your files, create study material, grade your answers and show
          your progress. We don&apos;t sell your data, show ads, or use your files to train AI models.
        </p>
      </LegalSection>
      <LegalSection id="services" heading="Services we use">
        <LegalList
          items={[
            { name: 'Anthropic', text: 'processes the text of your files and your questions to create study material and answers. It does not use this data to train its models by default.' },
            { name: 'Railway', text: 'hosts the app, the database and the file storage, in the United States.' },
            { name: 'Cloudflare', text: 'stores the encrypted nightly backups of the database and the files (R2 storage). Cloudflare cannot read them.' },
            { name: 'Google', text: 'provides sign-in.' },
            { name: 'Deepgram', text: 'turns your voice into text in voice practice. It does not keep the audio or use it to train models, and Margins stores only the text.' },
            { name: 'Your browser', text: "does the speech recognition instead if Deepgram is unavailable or you turn off Better speech recognition before a session. It may send audio to your browser vendor (Google for Chrome, Apple for Safari)." },
          ]}
        />
      </LegalSection>
      <LegalSection id="choices" heading="Your choices">
        <p>
          When you delete a course, its files and everything created from them are deleted. To delete your account
          entirely, open Settings and choose Delete account: your account, your courses, your files and everything
          made from them are deleted straight away. We keep only anonymous AI usage totals (cost and token counts,
          with nothing that identifies you). Copies stay in our encrypted backups until those expire, after at most
          120 days; if we ever restore a backup, deleted accounts are deleted again before the app reopens. If you can&apos;t sign in or need help, email {CONTACT_EMAIL}.
        </p>
      </LegalSection>
      <LegalSection id="contact" heading="Contact">
        <p>
          <a className={`${phoneInlineHit} text-accent underline underline-offset-4 hover:text-accent-hover`} href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
        </p>
      </LegalSection>
    </LegalPage>
  )
}
