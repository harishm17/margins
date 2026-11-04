import { notFound, redirect } from 'next/navigation'
import { ChatsCircle, Hourglass } from '@phosphor-icons/react/dist/ssr'
import { bareTopicRedirect } from '@/features/topic/activity-copy'
import { EntryPreparing } from '@/features/topic/entry-preparing'
import { ExamplesView } from '@/features/topic/examples-view'
import { ContentGate } from '@/features/topic/generation-ui'
import { ExplainerGate } from '@/features/topic/explainer-gate'
import { ExplainerView, NotesView } from '@/features/topic/notes-view'
import { PracticeView } from '@/features/topic/practice-view'
import { QuizView } from '@/features/topic/quiz-view'
import { RecallAbandonOnOpen } from '@/features/topic/recall-abandon'
import { RecallView } from '@/features/topic/recall-view'
import { ReaderView } from '@/features/topic/reader-view'
import { StepPlaceholder } from '@/features/topic/step-placeholder'
import { parseView } from '@/features/topic/types'
import { VoiceView } from '@/features/topic/voice-view'
import { WarmupView } from '@/features/topic/warmup-view'
import { voiceQuizStatus } from '@/lib/voice/drill-pack'
import { explainerAccess, loadGapExplainer } from '@/lib/learning/explainer-server'
import { prisma } from '@/lib/db/prisma'
import { fadeStart, type FadeLevel } from '@/lib/learning/fade'
import { recordInstruction } from '@/lib/learning/instruction-server'
import { teachBackClaims } from '@/lib/voice/topic-claims'
import { loadRecallState } from '@/lib/learning/recall-server'
import { latestWarmupResults, loadWarmupState } from '@/lib/learning/warmup-session'
import { withFocusCount } from '@/lib/reader/focus'
import { loadReader } from '@/lib/reader/load-reader'
import { getTopicPage } from '@/server/queries/topic'
import { requireUser } from '@/server/session'

type Params = Promise<{ courseId: string; topicId: string }>
type SearchParams = Promise<{
  view?: string | string[]
  set?: string | string[]
  start?: string | string[]
  difficulty?: string | string[]
  mode?: string | string[]
  concept?: string | string[]
  style?: string | string[]
  /** The concept a pointer or the next activity opened this view for (spec 18.3, 18.5). */
  focus?: string | string[]
  /** The examples' starting level when the next activity asks for it (`full` after two fails). */
  fade?: string | string[]
  /** `1` on the address a topic nobody has started opens on: the preparation screen, which moves on to the warm-up when it is written. */
  entry?: string | string[]
}>

export async function generateMetadata({ params }: { params: Params }) {
  const user = await requireUser()
  const { courseId, topicId } = await params
  const data = await getTopicPage(user.id, courseId, topicId)
  // A topic that does not exist shows the not-found page, so the tab says so.
  return { title: data?.topic.name ?? 'Page not found' }
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

const FADE_LEVELS: FadeLevel[] = ['full', 'partial', 'problem_first']

/**
 * One view of the topic. Without a valid ?view= the page redirects to the next activity (spec §8.1), so
 * the address always names what is on screen and finishing a view never moves the student somewhere else
 * on the next refresh. A next activity that is its own page (a drill, a review, a mock exam) leaves the
 * topic on Practice, where the next-activity card offers it. "notes", the first view before the path
 * existed, is the Read step.
 */
export default async function TopicPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const user = await requireUser()
  const { courseId, topicId } = await params
  const { view: requested, set: requestedSet, start, difficulty, mode, concept, style, focus, fade, entry } = await searchParams
  const focusConceptId = first(focus) ?? null
  const data = await getTopicPage(user.id, courseId, topicId)
  if (!data) notFound()

  const base = `/courses/${courseId}/topics/${topicId}`
  const wanted = parseView(first(requested))
  // The layout has already sent a bare address on; this is the same decision for a request it did not see the path of.
  if (!wanted) redirect(bareTopicRedirect(base, null, data.nextActivity) ?? base)

  const { content, topic } = data
  // After the notes: recall when the path has it, else practice (a topic without concepts is Read, Practice, Quiz).
  const afterNotes = data.pathSteps.includes('recall')
    ? { href: `${base}?view=recall`, label: 'Next: Recall' }
    : { href: `${base}?view=practice`, label: 'Next: Practice' }

  // The notes are the reading for a topic with no text to read from: opening them abandons an open recall card.
  const notesView = () => (
    <>
      <RecallAbandonOnOpen topicId={topicId} />
      <ContentGate kind="notes" topicName={topic.name} present={!!content.notes}>
        {content.notes ? (
          <NotesView
            topicId={topicId}
            notes={content.notes}
            completed={topic.progress.notes || data.pathDone.read}
            nextHref={afterNotes.href}
            nextLabel={afterNotes.label}
          />
        ) : null}
      </ContentGate>
    </>
  )

  // The address a topic nobody has started opens on. While its warm-up is being written it is the preparation screen; once
  // the topic is ready the screen replaces itself with the bare address, which names the first step (the warm-up).
  if (first(entry) === '1' && (wanted === 'read' || wanted === 'warmup')) {
    return <EntryPreparing ready={!data.preparingEntry} target={bareTopicRedirect(base, null, data.nextActivity) ?? base} readHref={`${base}?view=read`} />
  }

  switch (wanted) {
    case 'warmup':
      // Being prepared: the step is in the path, and says so until the questions are written.
      if (data.preparingEntry) return <EntryPreparing ready={false} target={base} readHref={`${base}?view=read`} />
      // No bank and none taken: the step is not offered, and its address goes on to reading.
      if (!data.pathSteps.includes('warmup')) redirect(`${base}?view=read`)
      return <WarmupView topicId={topicId} courseId={courseId} readHref={`${base}?view=read`} quizHref={`${base}?view=quiz`} initial={await withFocusCount(user.id, topicId, await loadWarmupState(user.id, topicId))} />
    case 'recall':
      // A topic without concepts (from before v3, or extraction failed) has no recall; its path is Read, Practice, Quiz.
      if (!data.pathSteps.includes('recall')) redirect(`${base}?view=practice`)
      if (data.preparingConcepts) {
        return (
          <StepPlaceholder
            icon={<Hourglass />}
            title="Getting this topic ready"
            description="Margins is finding the ideas in this topic. Recall opens when it is done. You can read in the meantime."
            nextHref={`${base}?view=read`}
            nextLabel="Go to Read"
          />
        )
      }
      {
        const teachBack = first(mode) === 'teach_back'
        const recall = await loadRecallState(user.id, topicId, { mode: teachBack ? 'teach_back' : 'recall', conceptId: first(concept) ?? null })
        if (recall && recall.cards.length > 0) {
          return (
            <RecallView
              topicId={topicId}
              state={recall}
              nextHref={teachBack ? base : `${base}?view=practice`}
              nextLabel={teachBack ? 'Back to the topic' : 'Go to Practice'}
              next={data.nextActivity}
              voiceHref={teachBack ? `${base}?view=voice&style=teach_back${first(concept) ? `&concept=${encodeURIComponent(first(concept) as string)}` : ''}` : undefined}
            />
          )
        }
      }
      // Concepts without claims to grade an answer against: nothing to write to yet.
      return (
        <StepPlaceholder
          icon={<ChatsCircle />}
          title="Recall isn't ready yet"
          description="There is nothing in this topic's pages to check an answer against yet. For now, go on to practice."
          nextHref={`${base}?view=practice`}
          nextLabel="Go to Practice"
        />
      )
    case 'read': {
      // The student's own pages as text (spec §5.2). A topic with no text to read from shows its notes instead.
      const reader = await loadReader(user.id, topicId)
      // Opening a pointer (the reader at a concept) is an instruction event (spec 18.5); once per concept per day.
      if (focusConceptId) await recordInstruction(prisma, { userId: user.id, topicId, kind: 'pointer', conceptIds: [focusConceptId], ref: focusConceptId }).catch((error) => console.error('Recording a pointer failed:', error))
      if (reader && reader.files.length > 0) {
        return (
          <>
            <RecallAbandonOnOpen topicId={topicId} />
            <ReaderView topicId={topicId} reader={reader} completed={topic.progress.notes || data.pathDone.read} nextHref={afterNotes.href} nextLabel={afterNotes.label} focusConceptId={focusConceptId} />
          </>
        )
      }
      return notesView()
    }
    // The explainer (spec §5.4): locked until a recall or the thin-source unlock, and the server refuses its text until then.
    case 'explainer': {
      const access = await explainerAccess(user.id, topicId)
      if (!access?.open) return <ExplainerGate topicId={topicId} recallHref={`${base}?view=recall`} canUnlock={access?.canUnlock ?? false} />
      const gaps = await loadGapExplainer(user.id, topicId)
      // The explainer opened for a concept (from the next activity, a pointer list or the map) is instruction on it
      // (spec 18.5): the gap explainer when there are gaps, else the full lesson. Once per concept per day.
      if (focusConceptId) {
        const kind = gaps.status === 'none' ? 'full_explainer' : 'gap_explainer'
        await recordInstruction(prisma, { userId: user.id, topicId, kind, conceptIds: [focusConceptId], ref: focusConceptId }).catch((error) => console.error('Recording an explainer visit failed:', error))
      }
      return (
        <ExplainerView
          topicId={topicId}
          gaps={gaps}
          nextHref={`${base}?view=practice`}
          nextLabel="Next: Practice"
          focusConceptId={focusConceptId}
          full={
            <ContentGate kind="notes" topicName={topic.name} present={!!content.notes}>
              {content.notes ? <NotesView topicId={topicId} notes={content.notes} completed={false} nextHref={`${base}?view=practice`} nextLabel="Next: Practice" form="explainer" /> : null}
            </ContentGate>
          }
        />
      )
    }
    case 'examples': {
      // How much of the first example is hidden (spec §5.5, §18.6): the topic's support band, which already counts the warm-up
      // (a guessed right answer counts as wrong). Each later example moves from there by the student's self-grades.
      const asked = FADE_LEVELS.find((candidate) => candidate === first(fade))
      const level = asked ?? fadeStart(data.topicBand)
      return (
        <ContentGate kind="examples" topicName={topic.name} present={!!content.examples}>
          {content.examples ? (
            <ExamplesView
              topicId={topicId}
              courseId={courseId}
              examples={content.examples}
              completed={topic.progress.examples}
              nextHref={`${base}?view=practice`}
              level={level}
              focusConceptId={focusConceptId}
            />
          ) : null}
        </ContentGate>
      )
    }
    case 'practice':
      return (
        <ContentGate kind="practice" topicName={topic.name} present={!!content.practice}>
          {content.practice ? <PracticeView topicId={topicId} practice={content.practice} /> : null}
        </ContentGate>
      )
    case 'quiz':
      return (
        <ContentGate kind="quiz" topicName={topic.name} present={!!content.quiz}>
          {content.quiz ? (
            <QuizView
              key={content.quiz.sets[0].id}
              courseId={courseId}
              topicId={topicId}
              review={data.review}
              initialSetId={first(requestedSet)}
              autoStart={first(start) === '1'}
              harder={first(difficulty) === 'hard'}
              sets={content.quiz.sets}
              attempts={data.attempts}
              waiting={data.waitingQuizzes}
              voiceHref={`${base}?view=voice`}
            />
          ) : null}
        </ContentGate>
      )
    default: {
      const [claims, quiz] = await Promise.all([teachBackClaims(topicId, first(concept)), voiceQuizStatus([topicId], user.id)])
      return (
        <VoiceView
          courseId={courseId}
          topic={{ id: topicId, name: topic.name, keywords: topic.keywords }}
          initialStyle={['oral_quiz', 'teach_back', 'guided_reading'].includes(first(style) ?? '') ? (first(style) as 'oral_quiz' | 'teach_back' | 'guided_reading') : undefined}
          conceptId={first(concept)}
          hasClaims={claims.hasClaims}
          claimsOfIdea={claims.ofIdea}
          quiz={quiz}
        />
      )
    }
  }
}
