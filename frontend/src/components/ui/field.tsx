import * as React from 'react'
import { WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { cn } from '@/lib/utils'

type FieldProps = {
  label: React.ReactNode
  /** Quiet help under the input. Hidden while an error shows. */
  hint?: React.ReactNode
  error?: React.ReactNode
  /** Adds "(optional)" after the label. Required fields are never starred. */
  optional?: boolean
  /** One form control. It receives id, aria-invalid, aria-describedby and (unless it is named already) aria-labelledby. */
  children: React.ReactElement<Record<string, unknown>>
  className?: string
  id?: string
}

export function Field({ label, hint, error, optional, children, className, id }: FieldProps) {
  const generated = React.useId()
  const controlId = id ?? generated
  const hintId = `${controlId}-hint`
  const errorId = `${controlId}-error`
  const labelId = `${controlId}-label`
  const describedBy = [error ? errorId : null, !error && hint ? hintId : null].filter(Boolean).join(' ')
  const named = children.props['aria-label'] !== undefined || children.props['aria-labelledby'] !== undefined

  const control = React.cloneElement(children, {
    id: controlId,
    invalid: error ? true : (children.props.invalid as boolean | undefined),
    'aria-describedby': describedBy || undefined,
    // The name the <label> gives, as an id reference as well: a control with a popup (Select) passes
    // it on to the popup, so the open list box is named after the field instead of having no name.
    ...(named ? {} : { 'aria-labelledby': labelId }),
  })

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label id={labelId} htmlFor={controlId} className="text-small font-medium text-fg">
        {label}
        {optional ? <span className="font-normal text-fg-3"> (optional)</span> : null}
      </label>
      {control}
      {error ? (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-caption font-normal text-danger-soft-fg">
          <WarningCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-caption font-normal text-fg-3">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
