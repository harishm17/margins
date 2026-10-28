import type { Metadata } from 'next'
import { CONTACT_EMAIL } from '@/config/site'
import { LegalPage, LegalSection } from '@/features/marketing/legal-page'

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
        October 20, 2026.
      </p>
      <LegalSection heading="What we store">
        <p>
          Your account: your email address, your name if you give one, and a hashed password (or your Google
          account ID if you sign in with Google). Your course files and what Margins creates from them: notes,
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
        <p>
          Anthropic processes the text of your files and your questions to create study material and answers
          (Anthropic does not use this data to train its models by default). Railway hosts the app, the database
          and file storage in the United States. Google provides sign-in if you choose it. Voice practice uses your
          browser&apos;s built-in speech recognition, which may send audio to your browser vendor (Google for
          Chrome, Apple for Safari).
        </p>
      </LegalSection>
      <LegalSection heading="Your choices">
        <p>
          When you delete a course, its files and everything created from them are deleted. To delete your account
          entirely, email {CONTACT_EMAIL} from the address you signed up with and we&apos;ll remove it within 30
          days.
        </p>
      </LegalSection>
      <LegalSection heading="Contact">
        <p>
          <a className="text-accent underline underline-offset-4 hover:text-accent-hover" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
        </p>
      </LegalSection>
    </LegalPage>
  )
}
