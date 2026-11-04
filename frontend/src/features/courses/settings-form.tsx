'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { apiFetch, isApiError } from '@/lib/api/client'
import { DescriptionField } from './description-field'
import { PlanFields } from './plan-fields'

type CourseSettingsFormProps = {
  course: { id: string; name: string; description: string | null; examDate: string | null; dailyMinutes: number }
}

export function CourseSettingsForm({ course }: CourseSettingsFormProps) {
  const router = useRouter()
  const [name, setName] = React.useState(course.name)
  const [description, setDescription] = React.useState(course.description ?? '')
  const [examDate, setExamDate] = React.useState(course.examDate ?? '')
  const [dailyMinutes, setDailyMinutes] = React.useState(course.dailyMinutes)
  const [nameError, setNameError] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [typedName, setTypedName] = React.useState('')

  const dirty =
    name.trim() !== course.name ||
    description.trim() !== (course.description ?? '') ||
    examDate !== (course.examDate ?? '') ||
    dailyMinutes !== course.dailyMinutes

  async function onSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (!name.trim()) {
      setNameError('Give the course a name.')
      return
    }
    setNameError(null)
    setSaving(true)
    try {
      await apiFetch(`/api/projects/${course.id}`, {
        method: 'PATCH',
        json: { name: name.trim(), description: description.trim(), examDate: examDate || null, dailyMinutes },
      })
      toast.success(name.trim() !== course.name ? 'Course renamed' : 'Course saved')
      router.refresh()
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not save the course. Try again.')
    } finally {
      setSaving(false)
    }
  }

  async function onDelete() {
    try {
      await apiFetch(`/api/projects/${course.id}`, { method: 'DELETE' })
    } catch {
      toast.error("Couldn't delete the course. Try again.")
      throw new Error('delete failed')
    }
    toast.success('Course deleted')
    router.push('/home')
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-12">
      <form onSubmit={onSave} noValidate className="flex flex-col gap-5">
        <Field label="Course name" required error={nameError}>
          <Input name="name" autoComplete="off" maxLength={255} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <PlanFields heading="Study plan" examDate={examDate} dailyMinutes={dailyMinutes} onExamDate={setExamDate} onDailyMinutes={setDailyMinutes} />
        <DescriptionField value={description} onChange={setDescription} rows={3} />
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="submit" variant="primary" loading={saving} disabled={!dirty} aria-describedby={dirty ? undefined : 'save-state'}>
            Save changes
          </Button>
          {/* Said in words, so a pale button is never the only sign that there is nothing to save. */}
          {dirty ? null : (
            <span id="save-state" className="text-small text-fg-2">
              No changes yet
            </span>
          )}
        </div>
      </form>

      <section aria-labelledby="delete-heading" className="border-t border-border pt-8">
        <h2 id="delete-heading" className="text-heading text-fg">
          Delete course
        </h2>
        <p className="mt-1.5 max-w-[56ch] text-small text-fg-2">
          This permanently deletes the course with its topics, study content, quiz and exam history, and the
          files you uploaded. It can&apos;t be undone.
        </p>
        <Button
          variant="danger"
          className="mt-4"
          onClick={() => {
            setTypedName('')
            setDeleteOpen(true)
          }}
        >
          Delete course
        </Button>
      </section>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this course?"
        description={
          <>
            Everything in <strong className="font-medium text-fg wrap-anywhere">{course.name}</strong> goes with it, including its topics, study
            content, quiz and exam history, and the files you uploaded. Type the course name to confirm.
          </>
        }
        confirmLabel="Delete course"
        destructive
        confirmDisabled={typedName.trim() !== course.name}
        confirmDisabledReason="Type the course name to turn this on."
        onConfirm={onDelete}
      >
        <Field label={<span className="wrap-anywhere">{`Type "${course.name}"`}</span>}>
          <Input autoComplete="off" value={typedName} onChange={(event) => setTypedName(event.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  )
}
