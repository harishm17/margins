'use client'

import * as React from 'react'
import { Plus } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'

/**
 * The course description, put away until wanted: it is optional and does nothing for the plan, so on New course and in Course
 * settings it is one "Add a description" button below the study plan (open already when the course has one).
 */
export function DescriptionField({
  value,
  onChange,
  rows = 2,
  maxLength,
}: {
  value: string
  onChange: (value: string) => void
  rows?: number
  maxLength?: number
}) {
  const [open, setOpen] = React.useState(value.length > 0)
  // Typed into and then emptied: it stays open rather than collapsing under the cursor.
  const [asked, setAsked] = React.useState(false)
  if (!open) {
    return (
      <div>
        <Button
          type="button"
          variant="ghost"
          icon={<Plus />}
          className="-ml-3.5"
          onClick={() => {
            setOpen(true)
            setAsked(true)
          }}
        >
          Add a description
        </Button>
      </div>
    )
  }
  return (
    <Field label="Description" optional hint="What are you preparing for?">
      <Textarea name="description" rows={rows} maxLength={maxLength} autoFocus={asked} value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  )
}
