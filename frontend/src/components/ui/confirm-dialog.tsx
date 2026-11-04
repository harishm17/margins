'use client'

import * as React from 'react'
import { Button } from './button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog'

type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** One sentence on what will happen. */
  description?: React.ReactNode
  /** Names the action: "Delete course", never "OK". */
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  /** May return a promise; the dialog shows progress and closes when it resolves. */
  onConfirm: () => void | Promise<void>
  confirmDisabled?: boolean
  /** Why the confirm button is off ("Type the course name to turn this on."), read out with the disabled button. */
  confirmDisabledReason?: string
  /** Extra content under the description, e.g. a field to type the course name. */
  children?: React.ReactNode
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
  confirmDisabled,
  confirmDisabledReason,
  children,
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false)

  async function handleConfirm() {
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch {
      // The caller reports the failure (toast or inline); the dialog stays open to retry.
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent size="sm" hideClose>
        <DialogHeader className="mb-0 pr-0">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children ? <div className="mt-4">{children}</div> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            loading={pending}
            disabled={confirmDisabled}
            disabledReason={confirmDisabledReason}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
