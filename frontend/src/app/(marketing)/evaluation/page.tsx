import type { Metadata } from 'next'
import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr'
import { BRAND_NAME } from '@/config/brand'
import { AUTHOR, SITE_URL } from '@/config/site'
import { EVAL_FILES, GENERATION, MODEL_CHOICE, RETRIEVAL } from '@/features/marketing/evals'

const PATH = '/evaluation'
const TITLE = 'How Margins is evaluated'
const DESCRIPTION =
  'The method and latest results of the two Margins evaluations: finding the right pages in course files, and the quality of the notes and quizzes it writes. Sample sizes, limits and failed checks included.'
const PUBLISHED = '2026-10-28'
const MODIFIED = '2026-10-28'

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

const h2 = 'mt-14 text-reading-h2 text-fg'
const h3 = 'mt-8 text-heading text-fg'
const p = 'mt-4 text-reading text-fg-2'
const ul = 'mt-4 flex list-disc flex-col gap-3 pl-6 text-reading text-fg-2 marker:text-fg-3'
const link = 'rounded-chip text-accent underline underline-offset-4 hover:text-accent-hover'
const th = 'px-3 py-2 text-left text-small font-medium text-fg'
const td = 'px-3 py-2 text-small text-fg-2 tabular'

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
    <div role="region" aria-label={label} tabIndex={0} className="mt-5 overflow-x-auto rounded-control border border-border">
      {children}
    </div>
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

export default function EvaluationPage() {
  return (
    <article className="mx-auto w-full max-w-[760px] px-4 pb-24 pt-10 md:px-8 md:pt-16">
      <h1 className="text-title text-fg">{TITLE}</h1>
      <p className={p}>
        {BRAND_NAME} has two evaluations. A retrieval eval measures how well the app maps a topic to the chunks of the
        course material that explain it. A generation eval runs the app&apos;s real generators (notes, worked examples,
        practice problems, quiz) on two real courses, then checks the output two ways: automatic checks in code, and
        scores from a model judge.
      </p>
      <p className={p}>
        The numbers on this page are copied from the result files in the repository, which are linked at the end. The
        runs are from October 20 and 21, 2026.
      </p>

      <h2 className={h2}>Retrieval</h2>
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
      <ComparisonTable
        caption={`Retrieval, run of October 20, 2026. Averages over ${RETRIEVAL.topics} topics, top ${RETRIEVAL.k}.`}
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

      <h2 className={h2}>Generation quality</h2>
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

      <h2 className={h2}>Model choice</h2>
      <p className={p}>
        Before the run, a rule was set: per purpose, the cheapest model whose judge correctness mean is at least 4.5 with
        no mathematical error, and whose teaching and question-quality mean is within 0.3 of Opus. The runs used the
        same two courses ({GENERATION.topicsPerCourse} topics each) and the same Opus judge, which is also one of the
        three models.
      </p>
      <ComparisonTable
        caption={`Model choice, runs of ${MODEL_CHOICE.runs}. Cost per topic covers the four content types.`}
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

      <h2 className={h2}>Raw results</h2>
      <p className={p}>Every table above comes from one of these files in the public repository.</p>
      <ul className={ul}>
        <li>
          <External href={EVAL_FILES.retrieval}>Retrieval, hybrid search with fusion (2026-10-20)</External>
        </li>
        <li>
          <External href={EVAL_FILES.retrievalBaseline}>Retrieval, the old search (2026-10-20)</External>
        </li>
        <li>
          <External href={EVAL_FILES.retrievalComparison}>Retrieval, the two compared (2026-10-20)</External>
        </li>
        <li>
          <External href={EVAL_FILES.generation}>Generation quality, with every error the judge listed (2026-10-21)</External>
        </li>
        <li>
          <External href={EVAL_FILES.modelChoice}>Model choice run (2026-10-20)</External>
        </li>
        <li>
          <External href={EVAL_FILES.opusEffort}>Opus low against medium effort (2026-10-21)</External>
        </li>
        <li>
          <External href={EVAL_FILES.modelDecision}>The model decision (2026-10-21)</External>
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
