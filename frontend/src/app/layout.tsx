import type { Metadata, Viewport } from 'next'
import { GeistSans } from 'geist/font/sans'
import localFont from 'next/font/local'
import Script from 'next/script'
import { Providers } from '@/components/shell/providers'
import { BRAND_NAME } from '@/config/brand'
import { SIDEBAR_INIT_SCRIPT } from '@/config/sidebar'
import { BRAND_COLORS, DEFAULT_DESCRIPTION, DEFAULT_TITLE, SITE_URL } from '@/config/site'
import './globals.css'

// Same file and variable as `geist/font/mono`, but not preloaded: mono text (code, timers) is rare,
// so pages should not pay for 70 KB of font before they paint.
const GeistMono = localFont({
  src: '../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2',
  variable: '--font-geist-mono',
  preload: false,
  adjustFontFallback: false,
  fallback: ['ui-monospace', 'SFMono-Regular', 'Roboto Mono', 'Menlo', 'Monaco', 'Liberation Mono', 'DejaVu Sans Mono', 'Courier New', 'monospace'],
  weight: '100 900',
})

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: DEFAULT_TITLE, template: `%s - ${BRAND_NAME}` },
  description: DEFAULT_DESCRIPTION,
  // The SVG tile comes from app/icon.svg and the apple-touch icon from app/apple-icon.tsx; the .ico is for crawlers and old browsers.
  icons: { icon: [{ url: '/favicon.ico', sizes: '48x48' }] },
  openGraph: { type: 'website', siteName: BRAND_NAME, title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION },
  twitter: { card: 'summary_large_image', title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: BRAND_COLORS.canvas },
    { media: '(prefers-color-scheme: dark)', color: BRAND_COLORS.canvasDark },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_INIT_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
        {/* Visit analytics: public/hm.js. Only on these pages, never on files the app serves. */}
        <Script src="/hm.js" strategy="afterInteractive" />
      </body>
    </html>
  )
}
