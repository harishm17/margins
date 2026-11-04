import Link from 'next/link'
import { Brand } from '@/components/shell/brand'
import { NotFoundBack } from '@/features/marketing/auth-actions'

export const metadata = { title: 'Page not found' }

/** Public pages and anything outside the signed-in app. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col px-4 py-6 md:px-8">
      <header>
        <Link href="/" className="inline-block w-fit rounded-chip" aria-label="Margins home">
          <Brand />
        </Link>
      </header>
      <main id="main" className="flex flex-1 items-center justify-center">
        <NotFoundBack />
      </main>
    </div>
  )
}
