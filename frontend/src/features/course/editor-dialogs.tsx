'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { ShellUnit } from '@/server/queries/courses'

const NO_UNIT = 'none'

/** Add a unit (no `unit`) or edit one: a title and an optional week label. */
export function UnitDialog({
  open,
  onOpenChange,
  unit,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  unit: ShellUnit | null
  onSubmit: (values: { title: string; weekLabel: string | null }) => Promise<void>
}) {
  const [title, setTitle] = React.useState('')
  const [weekLabel, setWeekLabel] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const name = title.trim()
    if (!name) {
      setError('Give the unit a title.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSubmit({ title: name, weekLabel: weekLabel.trim() || null })
      onOpenChange(false)
    } catch {
      // The editor already showed why; the dialog stays open to try again.
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setTitle(unit?.title ?? '')
          setWeekLabel(unit?.weekLabel ?? '')
          setError(null)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent size="sm">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{unit ? 'Edit unit' : 'Add a unit'}</DialogTitle>
            <DialogDescription>
              {unit ? 'Rename this unit or change its week.' : 'A unit groups topics, like a week or a chapter.'}
            </DialogDescription>
          </DialogHeader>
          <Field label="Title" error={error}>
            <Input
              autoFocus
              autoComplete="off"
              maxLength={200}
              placeholder="Sorting and searching"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="Week" optional>
            <Input
              autoComplete="off"
              maxLength={80}
              placeholder="Week 3"
              value={weekLabel}
              onChange={(event) => setWeekLabel(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={saving}>
              {unit ? 'Save' : 'Add unit'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Move a topic to another unit (or out of every unit) with a select. It lands last in that unit. */
export function MoveTopicDialog({
  topic,
  units,
  onOpenChange,
  onMove,
}: {
  topic: { id: string; name: string; unitId: string | null } | null
  units: ShellUnit[]
  onOpenChange: (open: boolean) => void
  onMove: (unitId: string | null) => Promise<void>
}) {
  return (
    <Dialog open={!!topic} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        {topic ? <MoveForm key={topic.id} topic={topic} units={units} onCancel={() => onOpenChange(false)} onMove={onMove} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function MoveForm({
  topic,
  units,
  onCancel,
  onMove,
}: {
  topic: { id: string; name: string; unitId: string | null }
  units: ShellUnit[]
  onCancel: () => void
  onMove: (unitId: string | null) => Promise<void>
}) {
  const [value, setValue] = React.useState(topic.unitId ?? NO_UNIT)
  const [saving, setSaving] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (value === (topic.unitId ?? NO_UNIT)) {
      onCancel()
      return
    }
    setSaving(true)
    try {
      await onMove(value === NO_UNIT ? null : value)
      onCancel()
    } catch {
      // The editor already showed why.
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Move topic</DialogTitle>
        <DialogDescription>{`Choose the unit for “${topic.name}”. It goes to the end of that unit.`}</DialogDescription>
      </DialogHeader>
      <Field label="Unit">
        <Select
          value={value}
          onValueChange={setValue}
          options={[
            ...units.map((unit) => ({ value: unit.id, label: unit.title, hint: unit.weekLabel })),
            { value: NO_UNIT, label: 'No unit' },
          ]}
        />
      </Field>
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          Move
        </Button>
      </DialogFooter>
    </form>
  )
}
