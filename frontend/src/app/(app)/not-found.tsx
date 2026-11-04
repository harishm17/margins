import { Page } from '@/components/shell/page'
import { NotFoundPanel } from '@/components/shell/not-found-panel'

export const metadata = { title: 'Page not found' }

/** A signed-in page that does not exist, or a course that is not the student's. */
export default function AppNotFound() {
  return (
    <Page width="focus">
      <NotFoundPanel
        className="py-24"
        body="The page may have moved, or the course may have been deleted."
        action={{ href: '/home', label: 'Go to your courses' }}
      />
    </Page>
  )
}
