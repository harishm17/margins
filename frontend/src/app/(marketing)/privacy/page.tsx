import { phoneInlineHit } from '@/components/ui/styles'
import type { Metadata } from 'next'
import { CONTACT_EMAIL } from '@/config/site'
import { LegalList, LegalPage, LegalSection } from '@/features/marketing/legal-page'

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What Margins stores, why, and the choices you have.',
  alternates: { canonical: '/privacy' },
}

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        Margins is a study tool run by Harish Manoharan. This page explains what we store and why. Last updated
        November 3, 2026.
      </p>
      <LegalSection heading="What we store">
        <p>
          Your account: your email address, your name and your Google account ID, from signing in with Google.
          Accounts made with a password before Google sign-in also still have that password stored, hashed and no
          longer used. Your course files and what Margins creates from them: notes,
          examples, practice, quizzes, mock exams, chat answers, your answers and scores, and voice practice
          transcripts. Basic usage records, such as how much AI processing your account used each day, so we can
          keep the service within its limits.
        </p>
      </LegalSection>
      <LegalSection heading="How it's used">
        <p>
          Only to run Margins for you: to process your files, create study material, grade your answers and show
          your progress. We don&apos;t sell your data, show ads, or use your files to train AI models.
        </p>
      </LegalSection>
      <LegalSection heading="Services we use">
        <LegalList
          items={[
            { name: 'Anthropic', text: 'processes the text of your files and your questions to create study material and answers. It does not use this data to train its models by default.' },
            { name: 'Railway', text: 'hosts the app, the database and the file storage, in the United States.' },
            { name: 'Google', text: 'provides sign-in.' },
            { name: 'Deepgram', text: 'turns your voice into text in voice practice. It does not keep the audio or use it to train models, and Margins stores only the text.' },
            { name: 'Your browser', text: "does the speech recognition instead if Deepgram is unavailable or you turn off Better speech recognition before a session. It may send audio to your browser vendor (Google for Chrome, Apple for Safari)." },
          ]}
        />
      </LegalSection>
      <LegalSection heading="Your choices">
        <p>
          When you delete a course, its files and everything created from them are deleted. To delete your account
          entirely, open Settings and choose Delete account: your account, your courses, your files and everything
          made from them are deleted straight away. We keep only anonymous AI usage totals (cost and token counts,
          with nothing that identifies you). If you can&apos;t sign in or need help, email {CONTACT_EMAIL}.
        </p>
      </LegalSection>
      <LegalSection heading="Contact">
        <p>
          <a className={`${phoneInlineHit} text-accent underline underline-offset-4 hover:text-accent-hover`} href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
        </p>
      </LegalSection>
    </LegalPage>
  )
}
