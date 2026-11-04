import type { Metadata } from 'next'
import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr'
import { phoneInlineHit } from '@/components/ui/styles'
import { BRAND_NAME } from '@/config/brand'
import { AUTHOR, GITHUB_URL, SITE_URL } from '@/config/site'
import { EVAL_FACTS, LEARNING_V3_EVAL_DRAFT, type DraftCheck } from '@/features/marketing/content'
import { EVAL_FILES, GENERATION, MODEL_CHOICE, RETRIEVAL } from '@/features/marketing/evals'

/**
 * DRAFT FOR HARISH. Shows the learning v3 sections from LEARNING_V3_EVAL_DRAFT. Keep this false until the eval
 * runs are done and every "(eval numbers pending)" has a real number and a source file. The text is a draft too.
 */
const SHOW_LEARNING_V3_DRAFT = false

const PATH = '/evaluation'
const TITLE = 'How Margins is evaluated'
const DESCRIPTION =
  'The method and latest results of the two Margins evaluations: finding the right pages in course files, and the quality of the notes and quizzes it writes. Sample sizes, limits and failed checks included.'
const PUBLISHED = '2026-10-28'
const MODIFIED = '2026-11-04'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    type: 'article',
    siteName: BRAND_NAME,
    url: PATH,
    title: `${TITLE} - ${BRAND_NAME}`,
    description: DESCRIPTION,
    publishedTime: PUBLISHED,
    modifiedTime: MODIFIED,
    authors: [AUTHOR.name],
  },
  twitter: { card: 'summary_large_image', title: `${TITLE} - ${BRAND_NAME}`, description: DESCRIPTION },
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  '@id': `${SITE_URL}${PATH}#article`,
  headline: TITLE,
  description: DESCRIPTION,
  url: `${SITE_URL}${PATH}`,
  mainEntityOfPage: `${SITE_URL}${PATH}`,
  datePublished: PUBLISHED,
  dateModified: MODIFIED,
  inLanguage: 'en',
  author: { '@type': 'Person', '@id': `${AUTHOR.url}#person`, name: AUTHOR.name, url: AUTHOR.url },
  publisher: { '@type': 'Organization', '@id': `${SITE_URL}/#organization`, name: BRAND_NAME, url: SITE_URL },
}

const h2 = 'mt-14 scroll-mt-20 text-reading-h2 text-fg'
const h3 = 'mt-8 text-heading text-fg'
const p = 'mt-4 text-reading text-fg-2'
const ul = 'mt-4 flex list-disc flex-col gap-3 pl-6 text-reading text-fg-2 marker:text-fg-3'
const link = `${phoneInlineHit} rounded-chip text-accent underline underline-offset-4 hover:text-accent-hover`
const th = 'px-3 py-2 text-left text-small font-medium text-fg'
const td = 'px-3 py-2 text-small text-fg-2 tabular'

const CONTENTS = [
  { id: 'retrieval', label: 'Retrieval' },
  { id: 'generation', label: 'Generation quality' },
  { id: 'model-choice', label: 'Model choice' },
  { id: 'raw-results', label: 'Raw results' },
]

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${link} inline-flex items-center gap-1`}>
      {children} <ArrowUpRight aria-hidden="true" className="size-3.5" />
    </a>
  )
}

/** A scrollable region keeps a wide table inside the page on a phone and reachable from the keyboard. */
function TableBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      {/* The tables are wider than a phone: say so before the table, so the cut-off column is not a surprise. */}
      <p aria-hidden="true" className="mt-5 text-caption font-normal text-fg-3 sm:hidden">
        Swipe the table sideways for more columns.
      </p>
      <div role="region" aria-label={label} tabIndex={0} className="mt-2 overflow-x-auto rounded-control border border-border sm:mt-5">
        {children}
      </div>
    </>
  )
}

function ComparisonTable({
  caption,
  rowHeader,
  columns,
  rows,
}: {
  caption: string
  rowHeader: string
  columns: string[]
  rows: { label: string; values: string[] }[]
}) {
  return (
    <TableBox label={caption}>
      <table className="w-full min-w-[520px] border-collapse">
        <caption className="px-3 pb-1 pt-3 text-left text-small text-fg-2">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={th}>
              {rowHeader}
            </th>
            {columns.map((column) => (
              <th key={column} scope="col" className={th}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row" className={`${th} font-normal`}>
                {row.label}
              </th>
              {row.values.map((value, i) => (
                <td key={columns[i]} className={td}>
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableBox>
  )
}

const STATUS = { failed: 'Failed', flagged: 'Flagged for reading', passed: 'Passed' }

/** Draft block (see SHOW_LEARNING_V3_DRAFT): one heading, its text, a gate table and the limits. */
function DraftSection({
  section,
}: {
  section: { heading: string; text: string[]; checks: DraftCheck[]; limits: string }
}) {
  return (
    <>
      <h3 className={h3}>{section.heading}</h3>
      {section.text.map((paragraph) => (
        <p key={paragraph} className={p}>
          {paragraph}
        </p>
      ))}
      <TableBox label={section.heading}>
        <table className="w-full min-w-[520px] border-collapse">
          <caption className="px-3 pb-1 pt-3 text-left text-small text-fg-2">{section.heading}: gate and result.</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={th}>
                Check
              </th>
              <th scope="col" className={th}>
                Gate
              </th>
              <th scope="col" className={th}>
                Result
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {section.checks.map((check) => (
              <tr key={check.label}>
                <th scope="row" className={`${th} font-normal`}>
                  {check.label}
                </th>
                <td className={td}>{check.gate}</td>
                <td className={td}>{check.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>
      <p className={p}>{section.limits}</p>
    </>
  )
}

export default function EvaluationPage() {
  return (
    <article className="mx-auto w-full max-w-[760px] px-4 pb-24 pt-10 md:px-8 md:pt-16">
      <h1 className="text-title text-fg">{TITLE}</h1>
      <section aria-labelledby="for-you" className="mt-6 rounded-card border border-border bg-surface-2 p-4 md:p-5">
        <h2 id="for-you" className="text-heading text-fg">
          What this means for you
        </h2>
        <ul className="mt-3 flex flex-col gap-2 text-reading text-fg-2">
          <li>
            <strong className="font-medium text-fg">How often an answer is wrong.</strong> In the latest check the judge
            scored correctness {EVAL_FACTS.correctness} out of 5 and listed {GENERATION.errors} errors in{' '}
            {GENERATION.topics} topics, {GENERATION.mathErrors} of them in maths. The judge is the model that writes the
            text, so this is a limited check.
          </li>
          <li>
            <strong className="font-medium text-fg">What is checked.</strong> Whether the right pages are found for a
            topic, and whether the notes, examples, practice and quizzes are correct, complete and based on the pages.
          </li>
          <li>
            <strong className="font-medium text-fg">What is not shown here.</strong> Whether the practice tutor, Ask
            and the voice coach give the answer away is checked with scripted students, and those results are in{' '}
            <a href={`${GITHUB_URL}/tree/main/evals/results`} className={link}>the repository</a>, not on this page yet.
            Not checked at all: scanned or handwritten files, how often the recall grader agrees with hand labels, and
            whether students learn more with {BRAND_NAME}.
          </li>
        </ul>
      </section>
      <p className={p}>
        {BRAND_NAME} has two evaluations. A retrieval eval measures how well the app maps a topic to the chunks of the
        course material that explain it. A generation eval runs the app&apos;s real generators (notes, worked examples,
        practice problems, quiz) on two real courses, then checks the output two ways: automatic checks in code, and
        scores from a model judge.
      </p>
      <p className={p}>
        The numbers on this page are copied from the result files in the repository, which are linked at the end. The
        runs are from October 20 and 21, 2026. The tutoring checks were run on November 2, 2026, and their numbers are not on this page yet.
      </p>

      <nav aria-label="On this page" className="mt-8 rounded-card border border-border bg-surface-2 px-4 py-3">
        <p className="text-small font-medium text-fg">On this page</p>
        <ul className="mt-1 flex flex-col sm:flex-row sm:flex-wrap sm:gap-x-5">
          {CONTENTS.map((item) => (
            <li key={item.id}>
              <a href={`#${item.id}`} className="flex min-h-11 items-center rounded-chip text-small text-accent underline underline-offset-4 hover:text-accent-hover sm:min-h-8">
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <h2 id="retrieval" className={h2}>Retrieval</h2>
      <p className={p}>
        When the extract-topics job finds a topic, it looks up that topic&apos;s source chunks, keeps the top{' '}
        {RETRIEVAL.k} and stores them. Every notes, quiz and exam generator later reads only those chunks. If the right
        chunks are not in the stored {RETRIEVAL.k}, the generated material cannot be grounded in them.
      </p>
      <p className={p}>
        The harness answers: for a topic whose answer we know the location of, how many of the right chunks are in that
        top {RETRIEVAL.k}, and how high are they ranked?
      </p>

      <h3 className={h3}>Method</h3>
      <ul className={ul}>
        <li>
          The corpus is chapters from three OpenStax textbooks (CS, science, social science): {RETRIEVAL.chunks} chunks,
          ingested through the app&apos;s real chunker and real embedder.
        </li>
        <li>
          There are {RETRIEVAL.topics} topics, each with a name, a description and keywords, shaped like what the topic
          extractor produces. Each lists the section whose chunks count as relevant.
        </li>
        <li>
          For every topic the harness calls the app&apos;s retrieval the way the app does, with the same arguments and
          the same number of results. Relevance is binary and averaged over topics.
        </li>
      </ul>

      <h3 className={h3}>Results</h3>
      {/* The column names are the field's own; each gets one plain line here, before the numbers. */}
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 text-small text-fg-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="font-medium text-fg">recall@{RETRIEVAL.k}</dt>
        <dd className="mb-2 sm:mb-0">Of the right chunks, the share that made it into the top {RETRIEVAL.k}.</dd>
        <dt className="font-medium text-fg">MRR</dt>
        <dd className="mb-2 sm:mb-0">How high the first right chunk ranks. 1 means it is first.</dd>
        <dt className="font-medium text-fg">nDCG@{RETRIEVAL.k}</dt>
        <dd className="mb-2 sm:mb-0">How well all the right chunks are ordered, with the highest ones counting most.</dd>
        <dt className="font-medium text-fg">hit@5</dt>
        <dd>Whether at least one right chunk is in the first five.</dd>
      </dl>
      <ComparisonTable
        caption={`Retrieval, run of October 20, 2026. Hybrid search with fusion, the search the app uses now, finds and ranks the right pages best. Averages over ${RETRIEVAL.topics} topics, top ${RETRIEVAL.k}.`}
        rowHeader="System"
        columns={RETRIEVAL.columns}
        rows={RETRIEVAL.rows}
      />
      <p className={p}>
        The old search found nearly all the relevant chunks within {RETRIEVAL.k} but ranked them badly. Fusion is the
        large change. Against vector search only the gap is smaller: MRR 0.961 against 0.934, and nDCG 0.932 against
        0.917.
      </p>
      <p className={p}>
        recall@24 is high for almost any method on this corpus, so the useful signal is in the ordering (MRR, nDCG and
        hit@5).
      </p>

      <h3 className={h3}>Limits</h3>
      <ul className={ul}>
        <li>
          <strong className="font-medium text-fg">Small corpus.</strong> About 300 chunks across three documents, and
          K = {RETRIEVAL.k} is 8% of it. The corpus is also tidy: well-structured textbook prose, not scanned slides or
          lecture notes.
        </li>
        <li>
          <strong className="font-medium text-fg">{RETRIEVAL.topics} topics, one writer.</strong> The topics were
          written by one person, not generated by the topic extractor, so they are cleaner than real extractor output.
          Per-topic numbers are noisy.
        </li>
        <li>
          <strong className="font-medium text-fg">Relevance by section is an approximation.</strong> A chunk in another
          section that also explains the topic is counted as wrong.
        </li>
        <li>
          <strong className="font-medium text-fg">Tuned on this corpus.</strong> The similarity floor and the full-text
          query were chosen by looking at these {RETRIEVAL.topics} topics. A different corpus may want a different floor.
        </li>
        <li>
          <strong className="font-medium text-fg">One embedder, English only.</strong> Results are for the default local
          embedding model, and the full-text search is English only.
        </li>
      </ul>

      <h2 id="generation" className={h2}>Generation quality</h2>
      <p className={p}>
        The latest run is from October 21, 2026. It generated {GENERATION.topics} topics ({GENERATION.topicsPerCourse}{' '}
        from MIT 18.05, probability and statistics, and {GENERATION.topicsPerCourse} from MIT 6.006, algorithms) with
        Claude Opus at medium effort. Each topic got notes, worked examples, practice problems and a quiz: 3 examples of
        each kind, 10 quiz questions, medium difficulty. The topics came from the app&apos;s course planner.
      </p>

      <h3 className={h3}>Automatic checks</h3>
      <p className={p}>
        These involve no model. They are lexical heuristics: they find things worth reading, they do not show content is
        right. The ones below include every check the output failed; the report has the rest.
      </p>
      <TableBox label="Automatic checks on the latest generation run">
        <table className="w-full min-w-[520px] border-collapse">
          <caption className="px-3 pb-1 pt-3 text-left text-small text-fg-2">
            Automatic checks, run of October 21, 2026, over {GENERATION.topics} topics.
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={th}>
                Check
              </th>
              <th scope="col" className={th}>
                Result
              </th>
              <th scope="col" className={th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {GENERATION.checks.map((check) => (
              <tr key={check.label}>
                <th scope="row" className={`${th} font-normal`}>
                  {check.label}
                </th>
                <td className={td}>{check.value}</td>
                <td className={`${td} ${check.status === 'failed' ? 'font-medium text-fg' : ''}`}>{STATUS[check.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>
      <p className={p}>
        The recall-copy check was tightened after the run. On the stored outputs it now finds 4 of 32 numeric quiz
        questions (12%) that restate a worked example. The report&apos;s own table still shows the earlier 50%.
      </p>

      <h3 className={h3}>Judge scores</h3>
      <p className={p}>
        The judge is Claude Opus at medium effort, the same model that wrote the content. It sees the source excerpts
        and is not told which model wrote what, but a model grading its own output is not an independent reviewer, so
        read the judge scores as limited evidence.
      </p>
      <TableBox label="Judge scores on the latest generation run">
        <table className="w-full border-collapse">
          <caption className="px-3 pb-1 pt-3 text-left text-small text-fg-2">
            Judge scores out of 5, mean over {GENERATION.judgedItems} judged items (topic and content type pairs).
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={th}>
                Measure
              </th>
              <th scope="col" className={th}>
                Score
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {GENERATION.judgeScores.map((score) => (
              <tr key={score.label}>
                <th scope="row" className={`${th} font-normal`}>
                  {score.label}
                </th>
                <td className={td}>{score.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>
      <p className={p}>
        The judge listed {GENERATION.errors} errors, {GENERATION.mathErrors} of them mathematical: a heap-building
        explanation that gave about 1.44n swaps where the exact total is at most n - 1, and an index range that was off
        by one. The report lists all {GENERATION.errors}. The judge can be wrong, so check an error before relying on
        it.
      </p>
      <p className={p}>
        Cost per topic, all four content types: {GENERATION.costPerTopic}. The run cost {GENERATION.totalSpend} in
        total, with the judge.
      </p>

      <h3 className={h3}>Limits</h3>
      <ul className={ul}>
        <li>
          <strong className="font-medium text-fg">One sample per cell.</strong> Each topic, model and content type is
          generated once. Model output varies run to run.
        </li>
        <li>
          <strong className="font-medium text-fg">Small corpora.</strong> Two MIT OpenCourseWare courses, four topics
          each.
        </li>
        <li>
          <strong className="font-medium text-fg">Excerpts, not the whole course.</strong> The judge and the grounding
          check see only the 24 excerpts each topic is mapped to.
        </li>
        <li>
          <strong className="font-medium text-fg">Checks are lexical.</strong> Zero hits means none were found, not that
          none exist.
        </li>
      </ul>

      <h2 id="model-choice" className={h2}>Model choice</h2>
      <p className={p}>
        Before the run, a rule was set: per purpose, the cheapest model whose judge correctness mean is at least 4.5 with
        no mathematical error, and whose teaching and question-quality mean is within 0.3 of Opus. The runs used the
        same two courses ({GENERATION.topicsPerCourse} topics each) and the same Opus judge, which is also one of the
        three models.
      </p>
      <ComparisonTable
        caption={`Model choice, runs of ${MODEL_CHOICE.runs}. Only Opus passes the rule for every content type. Cost per topic covers the four content types.`}
        rowHeader="Model"
        columns={MODEL_CHOICE.columns}
        rows={MODEL_CHOICE.rows}
      />
      <p className={p}>
        Sonnet and Haiku fail the rule for every content type: maths errors in notes, worked examples and quizzes, and
        teaching about a point below Opus. Opus at low effort costs $0.52 per topic (16% less), but its sample was
        partial and its teaching mean was lower, so it is not used.
      </p>
      <p className={p}>
        Notes, worked examples, practice, quizzes and exams stay on Claude Opus at medium effort. Cost is controlled by
        generating on demand, when a student opens a topic, rather than by a weaker model.
      </p>

      {SHOW_LEARNING_V3_DRAFT ? (
        <>
          <h2 className={h2}>{LEARNING_V3_EVAL_DRAFT.heading}</h2>
          <p className={p}>{LEARNING_V3_EVAL_DRAFT.intro}</p>
          <DraftSection section={LEARNING_V3_EVAL_DRAFT.tutoring} />
          <DraftSection section={LEARNING_V3_EVAL_DRAFT.recall} />
          <DraftSection section={LEARNING_V3_EVAL_DRAFT.generation} />
        </>
      ) : null}

      <h2 id="raw-results" className={h2}>Raw results</h2>
      <p className={p}>Every table above comes from one of these files in the public repository.</p>
      <ul className={ul}>
        <li>
          <External href={EVAL_FILES.retrieval}>Finding the right pages: the search the app uses now (2026-10-20)</External>
        </li>
        <li>
          <External href={EVAL_FILES.retrievalBaseline}>Finding the right pages: the old search it replaced (2026-10-20)</External>
        </li>
        <li>
          <External href={EVAL_FILES.retrievalComparison}>Finding the right pages: old and new side by side (2026-10-20)</External>
        </li>
        <li>
          <External href={EVAL_FILES.generation}>Quality of notes, examples, practice and quizzes, with every error the judge listed (2026-10-21)</External>
        </li>
        <li>
          <External href={EVAL_FILES.modelChoice}>Which model writes each kind of content: Opus, Sonnet and Haiku compared (2026-10-20)</External>
        </li>
        <li>
          <External href={EVAL_FILES.opusEffort}>Whether lower effort is good enough: Opus low against medium (2026-10-21)</External>
        </li>
        <li>
          <External href={EVAL_FILES.modelDecision}>Why the app uses Opus at medium effort (2026-10-21)</External>
        </li>
        <li>
          <External href={EVAL_FILES.readme}>The evals README: method, metrics and limitations</External>
        </li>
      </ul>
      <p className={p}>
        The courses are MIT OpenCourseWare materials and the textbooks are from OpenStax, both under CC BY-NC-SA 4.0, so
        the source text is not committed to the repository.
      </p>
      <p className={p}>
        Margins was built by{' '}
        <a href={AUTHOR.url} className={link}>
          {AUTHOR.name}
        </a>
        .
      </p>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </article>
  )
}
