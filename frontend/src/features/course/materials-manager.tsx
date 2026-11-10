'use client'

import { materialsSummary, type MaterialsCounts } from './materials-summary'
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowSquareOut,
  CheckCircle,
  Tag,
  DotsThree,
  File as FileGeneric,
  FileDoc,
  FilePdf,
  FilePpt,
  Files,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
  XCircle,
} from '@phosphor-icons/react/dist/ssr'
import { PageIntro } from '@/components/shell/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { IconButton } from '@/components/ui/icon-button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Progress } from '@/components/ui/progress'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'
import { Tooltip } from '@/components/ui/tooltip'
import { stageLabel, useElapsed } from '@/components/ui/job-status'
import { useJob } from '@/features/jobs/use-job'
import { apiFetch, isApiError } from '@/lib/api/client'
import { track as trackEvent } from '@/lib/analytics/track'
import { estimateWords } from '@/lib/jobs/estimate'
import { formatBytes, formatElapsed, pluralize } from '@/lib/format'
import { isMaterialRole, MATERIAL_ROLES, ROLE_LABELS, roleBadgeLabel, roleForCategory, type MaterialRole } from '@/lib/materials/role'
import { UploadAbortedError, uploadMaterial } from '@/lib/uploads/upload-file'
import { cn } from '@/lib/utils'
import type { MaterialRow } from '@/server/queries/course'
import { useRefreshSoon } from './use-refresh-soon'
import { splitDuplicates, type KnownFile } from './duplicate-files'
import { fetchDeleteImpact, impactSentences, useDeleteImpact } from './delete-impact'
import {
  ACCEPT_ATTRIBUTE,
  CATEGORY_LABELS,
  fileProblem,
  problemMessage,
} from './summary'
import { useAiStatus } from '@/features/ai/ai-status'
import { fillResetTime } from '@/lib/budget/copy'
import { jobFailureMessage } from '@/lib/jobs/failure-message'

type Category = 'lecture_notes' | 'sample_exams' | 'book_chapters' | 'syllabus'

/** Marks the id of a file this browser is still sending (no server id yet) among the files a new one may repeat. */
const LOCAL_PREFIX = 'local:'

const newUploadKey = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

const isCategory = (value: string): value is Category => value in CATEGORY_LABELS

/** One short line under the choice that says what the chosen kind of file is, so "Past exams" is not left to guess. */
const CATEGORY_EXAMPLES: Record<Category, string> = {
  lecture_notes: 'Slides or notes from class.',
  sample_exams: 'Exam papers or practice tests. Margins matches their style.',
  book_chapters: 'Textbook or reading chapters.',
  syllabus: 'Your syllabus or schedule. It is not used to find topics.',
}

const CATEGORY_OPTIONS =(Object.keys(CATEGORY_LABELS) as Category[]).map((value) => ({
  value,
  label: CATEGORY_LABELS[value],
}))

/** A file this browser is sending, or has sent and the server list does not show yet. */
type LocalUpload = {
  key: string
  filename: string
  size: number
  category: Category
  percent: number
  /** When the upload began, for the time shown once the file is being read. */
  startedAt: number
  phase: 'uploading' | 'sent' | 'error'
  error?: string
  materialId?: string
  abort?: AbortController
}

/**
 * A change to the files that the student should still be able to read after the toast is gone: what happened and what it did to
 * the topics. It stays under the upload area until the next material action (an upload, a delete, a role change) replaces it.
 */
type Notice = { text: string; /** Offer the way to the topics that were built from the file. */ reviewTopics?: boolean }

function FileIcon({ filename }: { filename: string }) {
  const lower = filename.toLowerCase()
  // A neutral page for anything the app does not read (a refused .txt or .exe), not the Word glyph.
  const Icon = lower.endsWith('.pdf')
    ? FilePdf
    : lower.endsWith('.pptx')
      ? FilePpt
      : lower.endsWith('.docx') || lower.endsWith('.doc')
        ? FileDoc
        : FileGeneric
  return <Icon aria-hidden="true" className="size-5 shrink-0 text-fg-3" />
}

type StatusProps = {
  children: React.ReactNode
  tone?: 'neutral' | 'accent' | 'danger'
  icon: React.ReactNode
  /** A failure that just happened in this browser (an upload refused or broken): announced as an alert. */
  announce?: boolean
}

function StatusText({ children, tone = 'neutral', icon, announce }: StatusProps) {
  return (
    <span
      role={announce ? 'alert' : undefined}
      className={cn(
        'flex min-w-0 gap-1.5 text-small',
        // A problem is told in full, over as many lines as it needs: "Use a PDF, DOCX, PPTX or DOC file." was cut at "DO...".
        tone === 'danger' ? 'items-start text-danger-soft-fg' : 'items-center',
        tone === 'accent' ? 'text-fg' : tone === 'neutral' ? 'text-fg-2' : null
      )}
    >
      <span className={cn('inline-flex shrink-0', tone === 'danger' && 'mt-0.5')}>{icon}</span>
      <span className={cn('min-w-0', tone === 'danger' ? 'break-words' : 'truncate')}>{children}</span>
    </span>
  )
}

const READY_ICON = <CheckCircle aria-hidden="true" weight="fill" className="size-4 shrink-0 text-accent" />
const FAILED_ICON = <WarningCircle aria-hidden="true" className="size-4 shrink-0 text-danger" />

// ---------------------------------------------------------------------------------------
// Stages of reading a file

/**
 * What the pipeline really reports: three phases, in this order. It does not report a percentage
 * within a phase, so none is drawn: the student sees which phase the file is in, for how long, and
 * (when enough files have finished to know) how long files usually take.
 */
const PIPELINE = [
  { stage: 'validating', label: 'Checking the file' },
  { stage: 'chunking', label: 'Reading pages' },
  { stage: 'embedding', label: 'Getting your pages ready for study and search' },
] as const

function pipelineIndex(stage: string | null | undefined, jobType?: string): number {
  const found = PIPELINE.findIndex((item) => item.stage === stage)
  if (found >= 0) return found
  return jobType === 'chunk_material' ? 1 : 0
}

/**
 * A file being read: the current phase with its position ("step 2 of 3"), three segments for the
 * phases, the time so far and the usual time. The block keeps the height of a finished row's
 * status, so nothing below it moves when the file is ready.
 */
function PipelineStatus({
  index,
  since,
  typicalSeconds,
  pendingLabel,
}: {
  index: number
  since: string | number
  typicalSeconds: number | null
  /** Replaces the phase word (waiting for the worker to pick the file up). */
  pendingLabel?: string
}) {
  const elapsed = useElapsed(since, true)
  const current = PIPELINE[index]
  return (
    <div aria-live="polite" className="min-h-[38px]">
      <StatusText icon={<Spinner className="text-accent" />}>
        {pendingLabel ?? current.label}
        <span className="text-fg-3">{`, step ${index + 1} of ${PIPELINE.length}`}</span>
      </StatusText>
      <div className="mt-0.5 flex h-4 items-center gap-2 text-caption font-normal text-fg-3">
        <span aria-hidden="true" className="flex w-16 shrink-0 gap-0.5">
          {PIPELINE.map((item, position) => (
            <span
              key={item.stage}
              className={cn(
                // Each segment has an edge in the control-border colour, so the ones still to come show against the page.
                'h-[6px] flex-1 rounded-full border',
                position < index
                  ? 'border-accent bg-accent'
                  : position === index
                    ? 'animate-pulse border-accent bg-accent/60'
                    : 'border-control bg-surface-3'
              )}
            />
          ))}
        </span>
        <span className="min-w-0">
          {elapsed !== null ? <span className="tabular">{formatElapsed(elapsed)}</span> : null}
          {/* Past the usual time, "usually about 10 s" would only be wrong; the file is just taking longer. */}
          {typicalSeconds && (elapsed === null || elapsed <= typicalSeconds)
            ? `${elapsed !== null ? ', ' : ''}usually ${estimateWords(typicalSeconds)}`
            : typicalSeconds
              ? ', taking longer than usual'
              : null}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------
// Rows

/** What the file is for. Syllabus and past exam files are shown in the accent tone; the word carries the meaning. */
function RoleBadge({ role, category }: { role: MaterialRole; category: string }) {
  return <Badge tone={role === 'syllabus' || role === 'exam' ? 'accent' : 'neutral'}>{roleBadgeLabel(role, category)}</Badge>
}

/**
 * One file. It shows one label for what the file is for. Its role decides how the file is used and the student can change it; while
 * the role is still the content the file started as, the label is the category the student uploaded it under (Lecture notes, Book
 * chapters), so "Content" is only the word for a file that no category names.
 */
function RowShell({
  filename,
  role,
  category,
  size,
  status,
  menu,
  unused,
}: {
  filename: string
  role: MaterialRole
  category: string
  size: number
  status: React.ReactNode
  menu: React.ReactNode
  /** The file will not be used (refused, unreadable, failed): what it would be used as, and its size, mean nothing. */
  unused?: boolean
}) {
  return (
    <tr className="min-h-12 max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-center max-md:gap-x-2 max-md:gap-y-1 max-md:py-3">
      <td className="py-2.5 pr-3 max-md:col-start-1 max-md:row-start-1 max-md:p-0 md:w-full md:max-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <FileIcon filename={filename} />
          <div className="min-w-0">
            <p className="truncate text-body-strong text-fg">{filename}</p>
            {unused ? null : (
              <p className="flex min-w-0 items-center gap-2 text-caption font-normal text-fg-3 md:hidden">
                <span className="truncate">{formatBytes(size)}</span>
                <RoleBadge role={role} category={category} />
              </p>
            )}
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 max-md:hidden">
        {unused ? <span aria-hidden="true" className="text-fg-3">&ndash;</span> : <RoleBadge role={role} category={category} />}
        {unused ? <span className="sr-only">Not used</span> : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-small tabular text-fg-2 max-md:hidden">
        {unused ? <span aria-hidden="true" className="text-fg-3">&ndash;</span> : formatBytes(size)}
      </td>
      <td className="min-w-0 px-3 py-2.5 max-md:col-span-2 max-md:row-start-2 max-md:p-0 max-md:pl-8"><div className="md:w-52">{status}</div></td>
      <td className="py-1.5 pl-3 text-right max-md:col-start-2 max-md:row-start-1 max-md:p-0">{menu}</td>
    </tr>
  )
}

function RowMenu({ filename, children }: { filename: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`Actions for ${filename}`} icon={<DotsThree weight="bold" />} size="sm" noTooltip />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A past exam that was read but whose style could not be analysed: say so on its row, with a way
 * to analyze the course's past exams again.
 */
function ExamAnalysisFailed({
  courseId,
  errorCode,
  onRetried,
}: {
  courseId: string
  errorCode: string | null
  onRetried: () => void
}) {
  const { blocked, report } = useAiStatus()
  const [pending, setPending] = React.useState(false)
  const text = fillResetTime(jobFailureMessage(errorCode, 'profile_exam').text)

  async function retry() {
    setPending(true)
    try {
      await apiFetch(`/api/projects/${courseId}/exam-style`, { method: 'POST' })
      onRetried()
    } catch (error) {
      if (isApiError(error)) report(error.code)
      toast.error(isApiError(error) ? error.message : "Couldn't start the analysis. Try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-[38px] flex-col items-start gap-1">
      <Tooltip content={text} side="top" align="start">
        <span className="block min-w-0">
          <StatusText icon={FAILED_ICON} tone="danger">
            {"Read, but its exam style couldn't be analyzed"}
          </StatusText>
        </span>
      </Tooltip>
      {blocked ? null : (
        <Button size="sm" variant="link" className="h-auto p-0 text-small" loading={pending} onClick={() => void retry()}>
          Analyze again
        </Button>
      )}
    </div>
  )
}

function ServerRow({
  courseId,
  row,
  onDeleted,
  onNotice,
  onReplace,
  typicalSeconds,
}: {
  courseId: string
  row: MaterialRow
  /** Called once the file is gone, with how many topics were built from it (for the status that stays after the toast). */
  onDeleted: (topicCount: number) => void
  /** A status line that stays under the upload area after a change made from this row's menu. */
  onNotice: (notice: Notice | null) => void
  /** Opens the file picker to swap this file for a new one instead of deleting it. */
  onReplace: () => void
  typicalSeconds: number | null
}) {
  const router = useRouter()
  const refreshSoon = useRefreshSoon()
  // The role the student just picked shows at once; the server's value takes over once it is saved.
  const [picked, setPicked] = React.useState<{ value: MaterialRole; base: MaterialRole } | null>(null)
  const role = picked && picked.base === row.role ? picked.value : row.role
  const { job: live } = useJob(row.job?.id ?? null, { timeoutMs: 600_000, onSettled: refreshSoon })
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const impact = useDeleteImpact([row.id], confirmOpen)

  const stage = live?.stage ?? row.job?.stage ?? null
  const queued = live?.status === 'queued'

  let status: React.ReactNode
  if (row.status === 'processing') {
    status = (
      <PipelineStatus
        index={pipelineIndex(stage, row.job?.jobType)}
        since={row.uploadedAt}
        typicalSeconds={typicalSeconds}
        pendingLabel={queued ? stageLabel(stage, 'queued') : undefined}
      />
    )
  } else if (row.status === 'ready' && row.examAnalysisFailure && role === 'exam') {
    status = <ExamAnalysisFailed courseId={courseId} errorCode={row.examAnalysisFailure.errorCode} onRetried={refreshSoon} />
  } else if (row.status === 'ready') {
    status = (
      // The height of a file being read (two lines), with the word centred in it, so it sits on the row's middle line.
      <div className="flex min-h-[38px] items-center">
        <StatusText icon={READY_ICON} tone="accent">Ready</StatusText>
      </div>
    )
  } else if (row.status === 'unusable') {
    const reason = row.notes?.trim() || 'No readable text found'
    status = (
      <Tooltip content={reason} side="top" align="start">
        <span className="block min-w-0">
          <StatusText icon={<XCircle aria-hidden="true" weight="fill" className="size-4 shrink-0 text-danger" />} tone="danger">
            Not usable: {reason}
          </StatusText>
        </span>
      </Tooltip>
    )
  } else {
    status = (
      <StatusText icon={FAILED_ICON} tone="danger">
        Failed. Remove it and upload again.
      </StatusText>
    )
  }

  async function onDelete() {
    try {
      await apiFetch(`/api/materials/${row.id}`, { method: 'DELETE' })
    } catch {
      toast.error("Couldn't delete the file. Try again.")
      throw new Error('delete failed')
    }
    toast.success('File deleted')
    onDeleted(row.topics.length)
  }

  async function onRole(next: string) {
    if (!isMaterialRole(next) || next === role) return
    setPicked({ value: next, base: row.role })
    onNotice(null)
    try {
      const result = await apiFetch<{ material: { removedSources: number } }>(`/api/materials/${row.id}`, {
        method: 'PATCH',
        json: { role: next },
      })
      const dropped = next === 'syllabus' || next === 'exam'
      // What the new role does, so the line is not just the new name: a syllabus is not read for topics, a past exam sets the
      // style of mock exams.
      const effect = next === 'syllabus' ? " It isn't used to find topics." : next === 'exam' ? ' Mock exams follow its style.' : ''
      const message = dropped
        ? result.material.removedSources > 0
          ? `Marked as ${ROLE_LABELS[next].toLowerCase()}.${effect} Topics no longer use it. Find topics again to update them.`
          : `Marked as ${ROLE_LABELS[next].toLowerCase()}.${effect}`
        : `Marked as ${ROLE_LABELS[next].toLowerCase()}. Find topics again to use it.`
      toast.success(message)
      // The toast goes in a few seconds; what changed for the topics stays under the upload area.
      onNotice({ text: `${row.filename}: ${message}` })
      router.refresh()
    } catch {
      setPicked(null)
      toast.error("Couldn't save the change. Try again.")
    }
  }

  const unused = row.status === 'failed' || row.status === 'unusable'

  return (
    <>
      <RowShell
        filename={row.filename}
        role={role}
        category={row.category}
        size={row.sizeBytes}
        status={status}
        unused={unused}
        menu={
          <RowMenu filename={row.filename}>
            <DropdownMenuItem
              icon={<ArrowSquareOut />}
              onSelect={() => window.open(`/api/materials/${row.id}/file`, '_blank', 'noopener')}
            >
              Open file
            </DropdownMenuItem>
            {/* A refused or unread file is never used, whatever it is marked as, so its menu offers a replacement instead of a
                role: changing the role of a file nothing reads only left "Marked as syllabus" with the file still refused. */}
            {unused ? (
              <DropdownMenuItem icon={<UploadSimple />} onSelect={onReplace}>
                Replace with another file
              </DropdownMenuItem>
            ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger icon={<Tag />}>Use as</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={role} onValueChange={onRole}>
                  {MATERIAL_ROLES.map((value) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {ROLE_LABELS[value]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Trash />} destructive onSelect={() => setConfirmOpen(true)}>
              Delete
            </DropdownMenuItem>
          </RowMenu>
        }
      />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${row.filename}?`}
        description="Existing topic content stays. Links to this file from Ask answers and generated content will stop opening."
        confirmLabel="Delete file"
        destructive
        onConfirm={onDelete}
      >
        {impactSentences(impact).length > 0 ? (
          <p className="mb-3 text-small text-fg-2" data-testid="delete-impact">
            {impactSentences(impact).join(' ')}
          </p>
        ) : null}
        {row.topics.length > 0 ? (
          // Optional: look before deleting. The topics open in the course's topic list; nothing here is a required step.
          <details className="group text-small text-fg-2">
            <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1.5 rounded-chip text-accent hover:underline max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
              View affected topics ({row.topics.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {row.topics.map((topic) => (
                <li key={topic.id}>
                  <a
                    href={`/courses/${courseId}/topics/${topic.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-6 items-center rounded-chip text-fg underline underline-offset-2 max-sm:min-h-11"
                  >
                    {topic.name}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {/* Deleting is not the only way to change a source: a new copy can take this file's place. */}
        <div className={cn(row.topics.length > 0 && 'mt-3')}>
          <Button
            variant="link"
            className="h-auto px-0 text-small max-sm:min-h-11"
            onClick={() => {
              setConfirmOpen(false)
              onReplace()
            }}
          >
            Replace this file instead
          </Button>
        </div>
      </ConfirmDialog>
    </>
  )
}

function LocalRow({ upload, onDismiss, typicalSeconds }: { upload: LocalUpload; onDismiss: () => void; typicalSeconds: number | null }) {
  let status: React.ReactNode
  if (upload.phase === 'uploading') {
    status = (
      <div aria-live="polite" className="min-h-[38px]">
        <StatusText icon={<Spinner className="text-accent" />}>
          Uploading <span className="tabular text-fg-3">{upload.percent}%</span>
        </StatusText>
        <Progress aria-label={`Uploading ${upload.filename}`} value={upload.percent} className="mt-1.5 max-w-[200px]" />
      </div>
    )
  } else if (upload.phase === 'sent') {
    status = <PipelineStatus index={0} since={upload.startedAt} typicalSeconds={typicalSeconds} />
  } else {
    status = (
      <StatusText icon={FAILED_ICON} tone="danger" announce>
        {upload.error}
      </StatusText>
    )
  }

  return (
    <RowShell
      filename={upload.filename}
      role={roleForCategory(upload.category)}
      category={upload.category}
      size={upload.size}
      status={status}
      unused={upload.phase === 'error'}
      menu={
        upload.phase === 'sent' ? null : (
          <IconButton
            label={upload.phase === 'uploading' ? `Cancel upload of ${upload.filename}` : `Dismiss ${upload.filename}`}
            icon={<X />}
            size="sm"
            onClick={() => {
              upload.abort?.abort()
              onDismiss()
            }}
          />
        )
      }
    />
  )
}

// ---------------------------------------------------------------------------------------
// Manager

type MaterialsManagerProps = {
  courseId: string
  maxUploadMb: number
  materials: MaterialRow[]
  /** "page" draws the title and the empty state; "inline" is the setup guide's step. */
  variant?: 'page' | 'inline'
  /** Shown between the title and the uploader (topic finding banners). */
  banner?: React.ReactNode
  /** How long a file usually takes to be read (seconds), from finished jobs; null when unknown. */
  typicalReadSeconds?: number | null
}

/**
 * The uploader and the list of files with their live pipeline status. Used by the Materials
 * page and by step 1 of the setup guide.
 */
export function MaterialsManager({
  courseId,
  maxUploadMb,
  materials,
  variant = 'page',
  banner,
  typicalReadSeconds = null,
}: MaterialsManagerProps) {
  const router = useRouter()
  const inputRef = React.useRef<HTMLInputElement>(null)
  // The "usually about" figure stays what it was when the page first knew it. The server works it out
  // again on every refresh (each upload and each finished file refreshes the page) from the latest
  // finished jobs, and those soon include this batch's own files, whose times include waiting behind
  // the other files of the batch. So the figure moved while the student watched ("about 35 seconds",
  // then 40, then 30). A reload starts again from the server's figure.
  const [typicalSeconds, setTypicalSeconds] = React.useState(typicalReadSeconds)
  if (typicalSeconds === null && typicalReadSeconds !== null) setTypicalSeconds(typicalReadSeconds)
  const [chosenCategory, setCategory] = React.useState<Category>('lecture_notes')
  const [dragging, setDragging] = React.useState(false)
  const [uploads, setUploads] = React.useState<LocalUpload[]>([])
  const [notice, setNotice] = React.useState<Notice | null>(null)
  // The file the picker is open for when the student chose "Replace this file instead"; null for a plain upload.
  const replacing = React.useRef<MaterialRow | null>(null)

  // A picker closed without a choice must not leave the next, ordinary pick to be read as a replacement.
  React.useEffect(() => {
    const input = inputRef.current
    const forget = () => {
      replacing.current = null
    }
    input?.addEventListener('cancel', forget)
    return () => input?.removeEventListener('cancel', forget)
  }, [])

  const patchUpload =React.useCallback((key: string, patch: Partial<LocalUpload>) => {
    setUploads((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }, [])
  const removeUpload = React.useCallback((key: string) => {
    setUploads((current) => current.filter((item) => item.key !== key))
  }, [])
  // A file deleted on the server leaves no trace here: the row this browser kept for it (while it waited for the server's) would
  // otherwise show again as a file still being checked.
  const removeUploadsOf = React.useCallback((materialId: string) => {
    setUploads((current) => current.filter((item) => item.materialId !== materialId))
  }, [])

  // Files that match one already in the course wait here for the student's choice (cancel, replace, keep both).
  const [duplicates, setDuplicates] = React.useState<{ file: File; matches: KnownFile[] }[] | null>(null)
  const [removeFailedOpen, setRemoveFailedOpen] = React.useState(false)
  // What replacing the repeated files would do to the student's work on the earlier copies.
  const duplicateImpact = useDeleteImpact(
    (duplicates ?? []).flatMap((item) => item.matches.map((match) => match.id)).filter((id) => !id.startsWith(LOCAL_PREFIX)),
    duplicates !== null
  )

  /** Starts one file; the promise says whether it reached the server (for the count of files uploaded). */
  function startUpload(file: File, category: Category = chosenCategory): Promise<boolean> {
    const key = newUploadKey()
    const problem = fileProblem(file, maxUploadMb)
    if (problem) {
      setUploads((current) => [
        { key, filename: file.name, size: file.size, category, percent: 0, startedAt: Date.now(), phase: 'error', error: problemMessage(problem, maxUploadMb) },
        ...current,
      ])
      return Promise.resolve(false)
    }
    const abort = new AbortController()
    setUploads((current) => [
      { key, filename: file.name, size: file.size, category, percent: 0, startedAt: Date.now(), phase: 'uploading', abort },
      ...current,
    ])
    return uploadMaterial({
      projectId: courseId,
      category,
      file,
      maxUploadMb,
      signal: abort.signal,
      onProgress: (percent) => patchUpload(key, { percent }),
    })
      .then((result) => {
        patchUpload(key, { phase: 'sent', percent: 100, materialId: result.material.id })
        router.refresh()
        return true
      })
      .catch((error: unknown) => {
        if (error instanceof UploadAbortedError) return false
        patchUpload(key, { phase: 'error', error: error instanceof Error ? error.message : 'Upload failed. Try again.' })
        return false
      })
  }

  /** Uploads the files and reports how many arrived (a number only, never a name). */
  function uploadAll(files: File[], afterEach?: (file: File, arrived: boolean) => void, category?: Category) {
    setNotice(null)
    void Promise.all(
      files.map((file) =>
        startUpload(file, category).then((arrived) => {
          afterEach?.(file, arrived)
          return arrived
        })
      )
    ).then((results) => {
      const count = results.filter(Boolean).length
      if (count > 0) trackEvent('files_uploaded', { file_count: count })
    })
  }

  /** Everything the course has or is about to have, for noticing a file added twice. */
  function knownFiles(): KnownFile[] {
    const local = uploads
      .filter((item) => item.phase !== 'error' && !(item.materialId && serverIds.has(item.materialId)))
      .map((item) => ({ id: `${LOCAL_PREFIX}${item.key}`, filename: item.filename, sizeBytes: item.size }))
    return [...materials.map((row) => ({ id: row.id, filename: row.filename, sizeBytes: row.sizeBytes })), ...local]
  }

  /** Opens the file picker; with a file given, what is chosen takes that file's place instead of being added. */
  function pickFiles(target: MaterialRow | null = null) {
    replacing.current = target
    inputRef.current?.click()
  }

  /** "Replace this file instead": the new copy is uploaded in the old one's role, and the old one goes once the new one has arrived. */
  function replaceFile(target: MaterialRow, file: File) {
    // The old file's counts are read before it goes (its notes lose their link when it does) and stated in the notice.
    const impact = fetchDeleteImpact(target.id)
    uploadAll(
      [file],
      (_, arrived) => {
        if (!arrived) return
        void impact.then((counts) => {
          void removeKnown(target.id)
          const builtTopics = target.topics.length > 0
          const kept = impactSentences(counts).join(' ')
          setNotice({
            text: `${
              builtTopics
                ? `Replaced ${target.filename} with ${file.name}. Topics built from the old file keep their content, but their links to it no longer open.`
                : `Replaced ${target.filename} with ${file.name}.`
            }${kept ? ` ${kept}` : ''}`,
            reviewTopics: builtTopics,
          })
        })
      },
      // A file that was used keeps its kind in the new copy. One that was refused or unread was never used, so the new file
      // takes the kind chosen above the drop area (it may be a different kind of file altogether).
      target.status === 'ready' || target.status === 'processing' ? (isCategory(target.category) ? target.category : undefined) : undefined
    )
  }

  function addFiles(list: FileList | File[] | null) {
    if (!list) return
    const { fresh, duplicates: same } = splitDuplicates(Array.from(list), knownFiles())
    // New files go at once; a file that is already here waits until the student says what to do with it.
    uploadAll(fresh)
    if (same.length > 0) setDuplicates(same)
  }

  /** Cancel drops the repeated files. Keep both uploads them as new files. Replace uploads them, then removes the files they repeat. */
  function resolveDuplicates(choice: 'cancel' | 'keep' | 'replace') {
    const waiting = duplicates ?? []
    setDuplicates(null)
    if (choice === 'cancel') return
    uploadAll(
      waiting.map((item) => item.file),
      choice === 'replace'
        ? (file, arrived) => {
            // Only once the new copy has reached the server, so a failed upload never leaves the course with neither.
            if (!arrived) return
            for (const match of waiting.find((item) => item.file === file)?.matches ?? []) void removeKnown(match.id)
            const kept = impactSentences(duplicateImpact).join(' ')
            setNotice({ text: `Replaced the earlier copy of ${file.name}.${kept ? ` ${kept}` : ''}` })
          }
        : undefined
    )
  }

  async function removeKnown(id: string) {
    if (id.startsWith(LOCAL_PREFIX)) {
      const key = id.slice(LOCAL_PREFIX.length)
      uploads.find((item) => item.key === key)?.abort?.abort()
      removeUpload(key)
      return
    }
    try {
      await apiFetch(`/api/materials/${id}`, { method: 'DELETE' })
      removeUploadsOf(id)
      router.refresh()
    } catch {
      toast.error("Couldn't remove the earlier copy. You can delete it from its menu.")
    }
  }

  const serverIds = new Set(materials.map((row) => row.id))
  const visibleUploads = uploads.filter((item) => !(item.materialId && serverIds.has(item.materialId)))
  // A file keeps its place in the list when the server's row takes over from the one this browser
  // was showing: rows never swap places while a batch finishes, which would shift everything under them.
  const orderedRows = React.useMemo(() => {
    const byId = new Map(materials.map((row) => [row.id, row]))
    const used = new Set<string>()
    const rows: ({ kind: 'local'; upload: LocalUpload } | { kind: 'server'; row: MaterialRow })[] = []
    for (const upload of uploads) {
      const row = upload.materialId ? byId.get(upload.materialId) : undefined
      if (row) {
        used.add(row.id)
        rows.push({ kind: 'server', row })
      } else rows.push({ kind: 'local', upload })
    }
    for (const row of materials) if (!used.has(row.id)) rows.push({ kind: 'server', row })
    return rows
  }, [uploads, materials])
  const empty = materials.length === 0 && visibleUploads.length === 0
  // Every row the list shows is counted once: a row the server has taken over is a server row, so the
  // browser's copy of it is not counted twice.
  const counts: MaterialsCounts = {
    ready: materials.filter((row) => row.status === 'ready').length,
    working:
      visibleUploads.filter((item) => item.phase !== 'error').length + materials.filter((row) => row.status === 'processing').length,
    needsAttention:
      visibleUploads.filter((item) => item.phase === 'error').length +
      materials.filter((row) => row.status !== 'ready' && row.status !== 'processing').length,
  }
  const inline = variant === 'inline'
  const failedRows = materials.filter((row) => row.status !== 'ready' && row.status !== 'processing')
  const failedUploads = visibleUploads.filter((item) => item.phase === 'error')

  // A refused or broken upload in this browser was never stored, so clearing it only dismisses it; "Remove" is for files that are on
  // the server. A mix says "Dismiss", the milder word, and the dialog says which of the two happens to which.
  const problemCount = failedUploads.length + failedRows.length
  const dismissOnly = failedRows.length === 0
  const problemAction = dismissOnly
    ? `Dismiss ${failedUploads.length === 1 ? 'failed upload' : 'failed uploads'}`
    : failedUploads.length === 0
      ? `Remove ${pluralize(failedRows.length, 'failed file')}`
      : `Dismiss ${pluralize(problemCount, 'failed upload')}`

  async function removeFailed() {
    for (const item of failedUploads) removeUpload(item.key)
    const results = await Promise.allSettled(failedRows.map((row) => apiFetch(`/api/materials/${row.id}`, { method: 'DELETE' })))
    router.refresh()
    if (results.some((result) => result.status === 'rejected')) {
      toast.error("Couldn't remove every file. Try again, or delete them from their menus.")
      throw new Error('remove failed')
    }
    toast.success(dismissOnly ? 'Failed uploads dismissed' : 'Files with problems removed')
  }

  return (
    <div className={cn(!inline && 'flex flex-col gap-6')}>
      {/* No Upload button in the header: the drop zone under it is the one way in, with its own
          "browse" button and the "These are:" choice that an upload needs. */}
      {inline ? null : (
        <PageIntro
          className="mb-0"
          title="Materials"
          description="Lecture notes, a syllabus, past exams and book chapters for this course."
        />
      )}
      <div
        onDragEnter={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          addFiles(event.dataTransfer.files)
        }}
        className={cn(
          'flex min-h-[120px] flex-col items-center justify-center gap-2.5 rounded-card border border-dashed px-4 py-5 text-center',
          'transition-[border-color,background-color] duration-120',
          dragging ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface',
          inline && 'mt-4'
        )}
      >
        {/* What the files are comes first: it is the answer the upload needs, and a student who has already picked files
            would otherwise find it after the button they just used. A default is selected, so nothing has to be chosen. */}
        <div className="flex max-w-full flex-col items-center gap-1.5">
          <div className="flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2">
            <span id={`category-label-${variant}`} className="text-small font-medium text-fg">
              These files are:
            </span>
            <SegmentedControl
              aria-labelledby={`category-label-${variant}`}
              options={CATEGORY_OPTIONS}
              value={chosenCategory}
              onValueChange={setCategory}
              className="min-w-0 flex-wrap justify-center overflow-visible"
            />
          </div>
          <p className="text-caption font-normal text-fg-3" aria-live="polite">
            {CATEGORY_EXAMPLES[chosenCategory]}
          </p>
        </div>
        {/* Nothing can be dropped on a phone: there it is one button, "Choose files". */}
        <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-body-strong text-fg max-sm:hidden">
          <UploadSimple aria-hidden="true" className="size-5 text-fg-3" />
          Drop files here or
          <Button variant="link" className="h-auto px-0 text-body-strong" onClick={() => pickFiles()}>
            browse
          </Button>
        </p>
        <Button variant="secondary" icon={<UploadSimple />} className="sm:hidden" onClick={() => pickFiles()}>
          Choose files
        </Button>
        <p className="text-small text-fg-2">
          PDF, DOCX, PPTX or DOC, up to {maxUploadMb} MB each. PDFs need selectable text. Scans can&apos;t be read.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose files to upload"
          onChange={(event) => {
            const target = replacing.current
            replacing.current = null
            const picked = event.target.files
            if (target && picked && picked.length > 0) replaceFile(target, picked[0])
            else addFiles(picked)
            event.target.value = ''
          }}
        />
      </div>

      {empty ? (
        inline ? null : (
          <EmptyState className="py-8" icon={<Files />} title="No materials yet">
            Start with your lecture notes, then add past exams if you have them.
          </EmptyState>
        )
      ) : (
        <div className={cn(inline && 'mt-4')}>
          {/* Column widths that don't depend on the status: the status changes while a file is read
              ("Reading pages, step 2 of 3, 12s, usually about 35 seconds", then "Ready") and used to
              resize every column and widen the table past the drop zone. The status has a fixed
              width (RowShell), the name takes what is left and truncates (w-full with max-w-0), and
              the short columns fit their words. Not table-fixed: in the setup guide's narrower column
              fixed widths left the name no room. */}
          <table className="w-full text-left max-md:block">
            <thead className="max-md:hidden">
              <tr className="border-b border-border text-caption text-fg-3">
                <th scope="col" className="py-2 pr-3 font-medium">Name</th>
                <th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">Used as</th>
                <th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">Size</th>
                <th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">Status</th>
                <th scope="col" className="w-10 py-2 pl-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="max-md:block [&>tr+tr]:border-t [&>tr+tr]:border-border">
              {orderedRows.map((item) =>
                item.kind === 'local' ? (
                  <LocalRow key={item.upload.key} upload={item.upload} typicalSeconds={typicalSeconds} onDismiss={() => removeUpload(item.upload.key)} />
                ) : (
                  <ServerRow
                    key={item.row.id}
                    courseId={courseId}
                    row={item.row}
                    typicalSeconds={typicalSeconds}
                    onNotice={setNotice}
                    onReplace={() => pickFiles(item.row)}
                    onDeleted={(topicCount) => {
                      removeUploadsOf(item.row.id)
                      setNotice({
                        text: `Deleted ${item.row.filename}. Existing topics keep their content${
                          topicCount > 0 ? `, but ${pluralize(topicCount, 'topic')} can no longer open links to it` : ''
                        }.`,
                        reviewTopics: topicCount > 0,
                      })
                      router.refresh()
                    }}
                  />
                )
              )}
            </tbody>
          </table>
          {counts.needsAttention > 0 ? (
            // A file that cannot be used is a problem to fix, so the line is an alert with the way to fix it, not grey small print.
            <InlineAlert
              tone="danger"
              className="mt-3"
              action={
                <Button size="sm" onClick={() => setRemoveFailedOpen(true)}>
                  {problemAction}
                </Button>
              }
            >
              <span aria-live="polite">{materialsSummary(counts)}</span>
            </InlineAlert>
          ) : (
            <p className="mt-3 min-h-5 text-small text-fg-2" aria-live="polite">
              {materialsSummary(counts)}
            </p>
          )}
        </div>
      )}

      {/* Under the file list, not above the upload area: the status of the last change and the topic-finding banner come and
          go as files are read, and above the list they pushed the rows down each time. */}
      {notice ? (
        <InlineAlert tone="neutral" data-testid="materials-notice">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{notice.text}</span>
            {notice.reviewTopics ? (
              <Link href={`/courses/${courseId}/topics?edit=1`} className="rounded-chip font-medium text-accent underline-offset-[3px] hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
                Review topics
              </Link>
            ) : null}
          </span>
        </InlineAlert>
      ) : null}
      {banner}

      <ConfirmDialog
        open={removeFailedOpen}
        onOpenChange={setRemoveFailedOpen}
        title={dismissOnly ? 'Dismiss the failed uploads?' : 'Remove the files with problems?'}
        description={
          dismissOnly
            ? 'These files were refused or did not arrive, so nothing was saved. The files that were read are not touched.'
            : failedUploads.length === 0
              ? 'These files could not be read, so they are not used for your topics. They are deleted from the course. The files that were read are not touched.'
              : 'Files that did not arrive are dismissed. Files that could not be read are deleted from the course. The files that were read are not touched.'
        }
        confirmLabel={problemAction}
        destructive
        onConfirm={removeFailed}
      />

      <Dialog open={duplicates !== null} onOpenChange={(open) => (open ? undefined : resolveDuplicates('cancel'))}>
        <DialogContent size="sm" hideClose>
          <DialogHeader className="mb-0 pr-0">
            <DialogTitle>{(duplicates?.length ?? 0) === 1 ? 'This file is already here' : 'These files are already here'}</DialogTitle>
            <DialogDescription>
              The name and size match a file in this course. Adding it again would read it a second time and ask for another topic review.
            </DialogDescription>
          </DialogHeader>
          {impactSentences(duplicateImpact).length > 0 ? (
            <p className="mt-3 text-small text-fg-2" data-testid="duplicate-impact">
              Replace removes the earlier copy. {impactSentences(duplicateImpact).join(' ')}
            </p>
          ) : null}
          <ul className="mt-4 flex flex-col gap-1 text-small text-fg" data-testid="duplicate-files">
            {(duplicates ?? []).map((item, index) => (
              <li key={`${item.file.name}-${index}`} className="flex min-w-0 items-center gap-2">
                <FileIcon filename={item.file.name} />
                <span className="min-w-0 flex-1 truncate">{item.file.name}</span>
                <span className="shrink-0 tabular text-fg-3">{formatBytes(item.file.size)}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="secondary" onClick={() => resolveDuplicates('cancel')}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => resolveDuplicates('keep')}>
              Keep both
            </Button>
            <Button variant="primary" onClick={() => resolveDuplicates('replace')}>
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
