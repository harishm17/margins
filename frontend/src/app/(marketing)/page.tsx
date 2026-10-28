import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr'
import { BRAND_NAME } from '@/config/brand'
import { DEFAULT_DESCRIPTION, SITE_URL } from '@/config/site'
import { FinalCta, HeroActions } from '@/features/marketing/auth-actions'
import { EVAL_FACTS, FAQ, LINKS, LOOP_STEPS } from '@/features/marketing/content'
import { Loop } from '@/features/marketing/loop'
import { SectionArrival } from '@/features/marketing/section-link'
import { Shot } from '@/features/marketing/shot'

export const metadata: Metadata = {
  alternates: { canonical: '/' },
}

const jsonLd = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: BRAND_NAME,
    url: SITE_URL,
    applicationCategory: 'EducationalApplication',
    operatingSystem: 'Web',
    offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' },
    description: DEFAULT_DESCRIPTION,
  },
  {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: BRAND_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/icon-512.png`,
  },
  {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer.join(' ') },
    })),
  },
]

const container = 'mx-auto w-full max-w-[1280px] px-4 md:px-8'
const h2 = 'text-[30px] font-semibold leading-9 tracking-[-0.02em] text-fg md:text-display'
const link = 'inline-flex items-center gap-1 rounded-chip text-small font-medium text-accent hover:underline'

function Hero() {
  return (
    <section className={`${container} pb-14 pt-8 md:pb-20 md:pt-12`}>
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-12">
        <div>
          <h1 className="text-balance text-[38px] font-semibold leading-[44px] tracking-[-0.025em] text-fg md:text-[44px] md:leading-[50px]">
            Your course files, planned to exam day.
          </h1>
          <p className="mt-5 max-w-[36ch] text-reading text-fg-2">
            Upload your notes and past exams. {BRAND_NAME} plans each day to your exam and writes the practice from your files.
          </p>
          <HeroActions />
        </div>
        <div className="mx-auto w-full max-w-[420px] overflow-hidden rounded-card border border-border bg-surface md:max-w-none">
          <Shot
            name="plan"
            desktop={{ width: 1400, height: 957 }}
            mobile={{ width: 780, height: 1400 }}
            eager
            alt="The Margins plan page. Today lists a review and a quiz, and the days after it lead to the exam date."
            sizes="(min-width: 1280px) 700px, (min-width: 1024px) 55vw, 704px"
            className="h-auto w-full"
          />
        </div>
      </div>
    </section>
  )
}

function LoopSection() {
  return (
    <section id="how-it-works" aria-labelledby="loop-heading" className={`${container} scroll-mt-4 py-14 md:py-20`}>
      <h2 id="loop-heading" data-section-heading tabIndex={-1} className={h2}>
        From your files to exam day
      </h2>
      <div className="mt-10 md:mt-12">
        <Loop steps={LOOP_STEPS} />
      </div>
    </section>
  )
}

function Trust() {
  return (
    <section id="trust" aria-labelledby="trust-heading" className="scroll-mt-4 bg-surface-2">
      <div className={`${container} py-14 md:py-20`}>
        <h2 id="trust-heading" data-section-heading tabIndex={-1} className={h2}>
          Sources you can check
        </h2>
        <div className="mt-10 grid gap-6 md:mt-12 lg:grid-cols-12 lg:gap-8">
          <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface lg:col-span-7">
            <div className="p-6 pb-5 md:p-8 md:pb-6">
              <h3 className="text-heading text-fg">Every answer points to your files</h3>
              <p className="mt-2 max-w-[52ch] text-reading text-fg-2">
                Notes, worked examples, quiz results and chat answers name the file and page they came from. Select a number in an answer to read the passage itself.
              </p>
            </div>
            <div className="flex flex-1 px-6 md:px-8">
              <div className="relative min-h-[400px] flex-1 overflow-hidden rounded-t-control border border-b-0 border-border">
                <Shot
                  name="ask"
                  desktop={{ width: 1000, height: 1022 }}
                  mobile={{ width: 780, height: 1400 }}
                  alt="An answer in Ask your materials with a citation open: the quoted passage, the file name and the page"
                  sizes="(min-width: 1280px) 620px, (min-width: 1024px) 55vw, 704px"
                  className="absolute inset-0 h-full w-full object-cover object-[50%_32%] md:object-[50%_38%]"
                />
              </div>
            </div>
          </div>

          <ul className="flex flex-col divide-y divide-border lg:col-span-5">
            <li className="pb-8">
              <h3 className="text-heading text-fg">Quality is measured</h3>
              <p className="mt-2 text-reading text-fg-2">
                We run the generators on two MIT OpenCourseWare courses and have a judge model, which does not know which model wrote the text, score the output. In the latest run on {EVAL_FACTS.topics} topics, correctness scored {EVAL_FACTS.correctness} out of 5 and grounding in the source pages {EVAL_FACTS.grounding}. The judge also listed {EVAL_FACTS.errors} errors, {EVAL_FACTS.mathErrors} of them mathematical, and we publish them.
              </p>
              <a href={LINKS.eval} target="_blank" rel="noopener noreferrer" className={`${link} mt-3`}>
                Read the evaluation <ArrowUpRight aria-hidden="true" className="size-3.5" />
              </a>
            </li>
            <li className="py-8">
              <h3 className="text-heading text-fg">Open source</h3>
              <p className="mt-2 text-reading text-fg-2">
                {BRAND_NAME} is MIT licensed. Read the code, see how your files are handled, or run it yourself.
              </p>
              <a href={LINKS.github} target="_blank" rel="noopener noreferrer" className={`${link} mt-3`}>
                View the code on GitHub <ArrowUpRight aria-hidden="true" className="size-3.5" />
              </a>
            </li>
            <li className="pt-8">
              <h3 className="text-heading text-fg">Your files stay yours</h3>
              <p className="mt-2 text-reading text-fg-2">
                Your files stay in your account. Delete a course and its files, and everything made from them, go with it. We do not sell your data or use your files to train AI models.
              </p>
              <Link href="/privacy" className={`${link} mt-3`}>
                Read the privacy policy
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </section>
  )
}

/**
 * Plus when closed, minus when open: one icon whose vertical stroke folds away as the answer opens
 * (the plan's caret turns the same way), instead of two icons swapped. Drawn at Phosphor's regular
 * weight so it matches the other icons.
 */
function OpenMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className="size-5 shrink-0 text-fg-3">
      <path d="M3.75 10h12.5" />
      <path
        d="M10 3.75v12.5"
        className="origin-center transition-transform duration-180 ease-enter [transform-box:fill-box] group-open:scale-y-0"
      />
    </svg>
  )
}

function Faqs() {
  return (
    <section id="faq" aria-labelledby="faq-heading" className={`${container} scroll-mt-4 py-14 md:py-20`}>
      <h2 id="faq-heading" data-section-heading tabIndex={-1} className={h2}>
        Common questions
      </h2>
      <div className="mt-8 border-t border-border md:mt-10">
        {FAQ.map((item, index) => (
          <details key={item.id} className="group border-b border-border" name="faq" open={index === 0}>
            <summary className="flex list-none items-center justify-between gap-6 rounded-chip py-5 text-heading text-fg marker:hidden [&::-webkit-details-marker]:hidden">
              {item.question}
              <OpenMark />
            </summary>
            <div className="flex max-w-[68ch] flex-col gap-3 pb-6 text-reading text-fg-2">
              {item.answer.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}

function ClosingCta() {
  return (
    <section aria-labelledby="cta-heading" className="border-t border-border px-4 py-20 text-center md:py-28">
      <h2 id="cta-heading" className={h2}>
        Start with one course.
      </h2>
      <p className="mx-auto mt-4 max-w-[44ch] text-reading text-fg-2">
        Free to use, with a daily AI allowance. Add your files and see what to do today.
      </p>
      <div className="mt-8 flex justify-center">
        <FinalCta />
      </div>
    </section>
  )
}

/** The landing page: static, with the signed-in state read in the browser by small client islands. */
export default function LandingPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SectionArrival />
      <Hero />
      <LoopSection />
      <Trust />
      <Faqs />
      <ClosingCta />
    </>
  )
}
