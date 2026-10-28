import type { SectionId } from './in-page'

/** The landing page's sections as the header, the footer and the phone menu name them. */
export const SECTION_LINKS: { section: SectionId; label: string }[] = [
  { section: 'how-it-works', label: 'How it works' },
  { section: 'trust', label: 'Sources' },
  { section: 'faq', label: 'FAQ' },
]
