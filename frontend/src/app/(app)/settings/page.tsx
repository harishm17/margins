import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Page } from '@/components/shell/page'
import { AccountDetails, AiAllowance, DeleteAccount, SettingsSection, ThemeSetting } from '@/features/settings/settings-sections'
import { getAccountDetails } from '@/server/account'
import { requireUser } from '@/server/session'
import { getTimeZoneState } from '@/server/timezone'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const user = await requireUser()
  const [account, { timeZone }] = await Promise.all([getAccountDetails(user.id), getTimeZoneState()])
  // The session outlived its account (deleted in another tab a moment ago).
  if (!account) redirect('/login')

  return (
    <Page width="narrow" className="pt-8">
      <h1 className="text-title text-fg">Settings</h1>
      <p className="mt-1.5 text-body text-fg-2">Your account, today&apos;s AI allowance and how Margins looks.</p>
      <div className="mt-8 flex flex-col gap-8">
        <SettingsSection id="account-heading" title="Account">
          <AccountDetails email={account.email} signInProvider={account.signInProvider} />
        </SettingsSection>
        <SettingsSection
          id="ai-heading"
          title="Today's AI allowance"
          description="Writing notes and quizzes, Ask, mock exams and voice practice use it. It resets every day."
        >
          <AiAllowance timeZone={timeZone} />
        </SettingsSection>
        <SettingsSection id="theme-heading" title="Theme">
          <ThemeSetting />
        </SettingsSection>
        <SettingsSection
          id="delete-heading"
          title="Delete account"
          description="This permanently deletes your account, your courses, the files you uploaded and everything made from them, including your progress and quiz and exam history. It can't be undone."
        >
          <DeleteAccount email={account.email} />
        </SettingsSection>
      </div>
    </Page>
  )
}
