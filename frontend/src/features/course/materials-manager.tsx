'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowSquareOut,
  CheckCircle,
  Tag,
  DotsThree,
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
import { EmptyState } from '@/components/ui/empty-state'
import { IconButton } from '@/components/ui/icon-button'
import { Progress } from '@/components/ui/progress'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'
import { Tooltip } from '@/components/ui/tooltip'
import { stageLabel, useElapsed } from '@/components/ui/job-status'
import { useJob } from '@/features/jobs/use-job'
import { apiFetch, isApiError } from '@/lib/api/client'
import { estimateWords } from '@/lib/jobs/estimate'
import { formatBytes, formatElapsed } from '@/lib/format'
import { isMaterialRole, MATERIAL_ROLES, ROLE_LABELS, roleForCategory, type MaterialRole } from '@/lib/materials/role'
import { UploadAbortedError, uploadMaterial } from '@/lib/uploads/upload-file'
import { cn } from '@/lib/utils'
import type { MaterialRow } from '@/server/queries/course'
import { useRefreshSoon } from './use-refresh-soon'
import {
  ACCEPT_ATTRIBUTE,
  categoryLabel,
  CATEGORY_LABELS,
  fileProblem,
  problemMessage,
} from './summary'

type Category = 'lecture_notes' | 'sample_exams' | 'book_chapters' | 'syllabus'

const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABELS) as Category[]).map((value) => ({
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

function FileIcon({ filename }: { filename: string }) {
  const lower = filename.toLowerCase()
  const Icon = lower.endsWith('.pdf') ? FilePdf : lower.endsWith('.pptx') ? FilePpt : FileDoc
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
        'flex min-w-0 items-center gap-1.5 text-small',
        tone === 'danger' ? 'text-danger-soft-fg' : tone === 'accent' ? 'text-fg' : 'text-fg-2'
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
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
  { stage: 'embedding', label: 'Indexing for search' },
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
                'h-1 flex-1 rounded-full',
                position < index ? 'bg-accent' : position === index ? 'animate-pulse bg-accent/60' : 'bg-surface-3'
              )}
            />
          ))}
        </span>
        <span className="min-w-0 truncate">
          {elapsed !== null ? <span className="tabular">{formatElapsed(elapsed)}</span> : null}
          {typicalSeconds ? `${elapsed !== null ? ', ' : ''}usually ${estimateWords(typicalSeconds)}` : null}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------
// Rows

/** What the file is for. Syllabus and past exam files are shown in the accent tone; the word carries the meaning. */
function RoleBadge({ role }: { role: MaterialRole }) {
  return <Badge tone={role === 'syllabus' || role === 'exam' ? 'accent' : 'neutral'}>{ROLE_LABELS[role]}</Badge>
}

function RowShell({
  filename,
  category,
  role,
  size,
  status,
  menu,
}: {
  filename: string
  category: string
  role: MaterialRole
  size: number
  status: React.ReactNode
  menu: React.ReactNode
}) {
  return (
    <tr className="min-h-12 max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-center max-md:gap-x-2 max-md:gap-y-1 max-md:py-3">
      <td className="py-2.5 pr-3 max-md:col-start-1 max-md:row-start-1 max-md:p-0 md:w-full md:max-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <FileIcon filename={filename} />
          <div className="min-w-0">
            <p className="truncate text-body-strong text-fg">{filename}</p>
            <p className="flex min-w-0 items-center gap-2 text-caption font-normal text-fg-3 md:hidden">
              <span className="truncate">
                {categoryLabel(category)}, {formatBytes(size)}
              </span>
              <RoleBadge role={role} />
            </p>
          </div>
        </div>
      </td>
      <td className="truncate whitespace-nowrap px-3 py-2.5 text-small text-fg-2 max-md:hidden">{categoryLabel(category)}</td>
      <td className="whitespace-nowrap px-3 py-2.5 max-md:hidden">
        <RoleBadge role={role} />
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-small tabular text-fg-2 max-md:hidden">{formatBytes(size)}</td>
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

function ServerRow({ row, onDeleted, typicalSeconds }: { row: MaterialRow; onDeleted: () => void; typicalSeconds: number | null }) {
  const router = useRouter()
  const refreshSoon = useRefreshSoon()
  // The role the student just picked shows at once; the server's value takes over once it is saved.
  const [picked, setPicked] = React.useState<{ value: MaterialRole; base: MaterialRole } | null>(null)
  const role = picked && picked.base === row.role ? picked.value : row.role
  const { job: live } = useJob(row.job?.id ?? null, { timeoutMs: 600_000, onSettled: refreshSoon })
  const [confirmOpen, setConfirmOpen] = React.useState(false)

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
    onDeleted()
  }

  async function onRole(next: string) {
    if (!isMaterialRole(next) || next === role) return
    setPicked({ value: next, base: row.role })
    try {
      const result = await apiFetch<{ material: { removedSources: number } }>(`/api/materials/${row.id}`, {
        method: 'PATCH',
        json: { role: next },
      })
      const dropped = next === 'syllabus' || next === 'exam'
      toast.success(
        dropped
          ? result.material.removedSources > 0
            ? `Marked as ${ROLE_LABELS[next].toLowerCase()}. Topics no longer use it. Find topics again to update them.`
            : `Marked as ${ROLE_LABELS[next].toLowerCase()}`
          : `Marked as ${ROLE_LABELS[next].toLowerCase()}. Find topics again to use it.`
      )
      router.refresh()
    } catch {
      setPicked(null)
      toast.error("Couldn't change the file's role. Try again.")
    }
  }

  return (
    <>
      <RowShell
        filename={row.filename}
        category={row.category}
        role={role}
        size={row.sizeBytes}
        status={status}
        menu={
          <RowMenu filename={row.filename}>
            <DropdownMenuItem
              icon={<ArrowSquareOut />}
              onSelect={() => window.open(`/api/materials/${row.id}/file`, '_blank', 'noopener')}
            >
              Open file
            </DropdownMenuItem>
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
        description="Topics built from it keep their content."
        confirmLabel="Delete file"
        destructive
        onConfirm={onDelete}
      />
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
      category={upload.category}
      role={roleForCategory(upload.category)}
      size={upload.size}
      status={status}
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
  const [category, setCategory] = React.useState<Category>('lecture_notes')
  const [dragging, setDragging] = React.useState(false)
  const [uploads, setUploads] = React.useState<LocalUpload[]>([])

  const patchUpload = React.useCallback((key: string, patch: Partial<LocalUpload>) => {
    setUploads((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }, [])
  const removeUpload = React.useCallback((key: string) => {
    setUploads((current) => current.filter((item) => item.key !== key))
  }, [])

  function startUpload(file: File) {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const problem = fileProblem(file, maxUploadMb)
    if (problem) {
      setUploads((current) => [
        { key, filename: file.name, size: file.size, category, percent: 0, startedAt: Date.now(), phase: 'error', error: problemMessage(problem, maxUploadMb) },
        ...current,
      ])
      return
    }
    const abort = new AbortController()
    setUploads((current) => [
      { key, filename: file.name, size: file.size, category, percent: 0, startedAt: Date.now(), phase: 'uploading', abort },
      ...current,
    ])
    uploadMaterial({
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
      })
      .catch((error: unknown) => {
        if (error instanceof UploadAbortedError) return
        patchUpload(key, { phase: 'error', error: error instanceof Error ? error.message : 'Upload failed. Try again.' })
      })
  }

  function addFiles(list: FileList | File[] | null) {
    if (!list) return
    Array.from(list).forEach(startUpload)
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
  const working = visibleUploads.some((item) => item.phase !== 'error') || materials.some((row) => row.status === 'processing')
  const inline = variant === 'inline'

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
      {banner}

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
        <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-body-strong text-fg">
          <UploadSimple aria-hidden="true" className="size-5 text-fg-3" />
          Drop files here or
          <Button variant="link" className="h-auto px-0 text-body-strong" onClick={() => inputRef.current?.click()}>
            browse
          </Button>
        </p>
        <p className="text-small text-fg-2">PDF, DOCX, PPTX or DOC, up to {maxUploadMb} MB each.</p>
        <div className="flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2">
          <span id={`category-label-${variant}`} className="text-small text-fg-2">
            These are:
          </span>
          <SegmentedControl
            aria-labelledby={`category-label-${variant}`}
            options={CATEGORY_OPTIONS}
            value={category}
            onValueChange={setCategory}
            className="min-w-0 flex-wrap justify-center overflow-visible"
          />
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose files to upload"
          onChange={(event) => {
            addFiles(event.target.files)
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
                <th scope="col" className="px-3 py-2 font-medium">Type</th>
                <th scope="col" className="px-3 py-2 font-medium">Used as</th>
                <th scope="col" className="px-3 py-2 font-medium">Size</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
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
                  <ServerRow key={item.row.id} row={item.row} typicalSeconds={typicalSeconds} onDeleted={() => router.refresh()} />
                )
              )}
            </tbody>
          </table>
          <p className="mt-3 min-h-5 text-small text-fg-2" aria-live="polite">
            {working
              ? "You can leave this page. Files keep being read."
              : 'Every file here has been read.'}
          </p>
        </div>
      )}
    </div>
  )
}
