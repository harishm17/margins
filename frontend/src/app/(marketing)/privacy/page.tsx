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
        November 10, 2026.
      </p>
      <LegalContents sections={SECTIONS} />
      <LegalSection id="store" heading="What we store">
        <LegalList
          items={[
            { name: 'Your account', text: 'your email address, your name and your Google account ID, from signing in with Google. Accounts made with a password before Google sign-in also still have that password stored, hashed and no longer used.' },
            { name: 'Your files and what Margins makes from them', text: 'notes, examples, practice, quizzes, mock exams, chat answers, your answers and scores, and voice practice transcripts. Transcripts are deleted after 180 days; the scores they produced stay.' },
            { name: 'Usage records', text: 'how much AI processing each of your requests used (cost and token counts, which part of Margins asked, and when), and how many seconds each voice practice session lasted. We use them to keep the service within its limits: a daily AI allowance for each person, and a daily limit on voice minutes. They are tied to a one-way key made from your Google account, which is not your email or your Google ID and cannot be turned back into either.' },
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
            { name: 'PostHog', text: 'counts visits and the steps people take (signing up, creating a course, starting a quiz) so we can see where Margins is hard to use. The browser talks to Margins, which passes the events on, and they carry no course names, file names, text, grades, emails or names.' },
            { name: 'Deepgram', text: 'turns your voice into text in voice practice. It does not keep the audio or use it to train models, and Margins stores only the text.' },
            { name: 'Your browser', text: "does the speech recognition instead if Deepgram is unavailable or you turn off Better speech recognition before a session. It may send audio to your browser vendor (Google for Chrome, Apple for Safari)." },
          ]}
        />
      </LegalSection>
      <LegalSection id="choices" heading="Your choices">
        <p>
          When you delete a course, its files and everything created from them are deleted. To delete your account
          entirely, open Settings and choose Delete account: your account, your courses, your files and everything
          made from them are deleted straight away. What stays is the usage records, without your name, email, courses
          or files, and a record of when the one-way key was first seen. We keep them so that deleting an account and
          signing up again with the same Google account does not restart the day&apos;s AI allowance or voice minutes;
          nothing in them identifies you to anyone without your Google account. Copies of everything stay in our encrypted backups until those expire, after at most
          120 days; if we ever restore a backup, deleted accounts are deleted again before the app reopens. If you can&apos;t sign in or need help, email {CONTACT_EMAIL}.
        </p>
        <p>
          When you delete a single file, the notes and questions already made from it stay until you regenerate them or
          delete the course.
        </p>
        <p>
          Server logs are kept by Railway for about a week and hold ids and error types, not your text.
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
