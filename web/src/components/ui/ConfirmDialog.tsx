import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Input } from './Input';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** Extra fields (a reason textarea, a checkbox) rendered above the buttons. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button, for destructive operations. */
  danger?: boolean;
  /**
   * When set, the user must type this exact string before confirming. Used by
   * every god-mode action.
   */
  confirmPhrase?: string;
  loading?: boolean;
  /** Disable confirm for reasons the caller owns (e.g. an empty reason field). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
}

/** Destructive-action confirmation, optionally gated on a typed phrase. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  confirmPhrase,
  loading = false,
  confirmDisabled = false,
  onConfirm,
}: ConfirmDialogProps): ReactElement {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const phraseSatisfied = !confirmPhrase || typed.trim() === confirmPhrase;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
            disabled={!phraseSatisfied || confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {children}
        {confirmPhrase ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="confirm-phrase" className="text-sm text-fg-muted">
              Type <code className="font-mono text-fg">{confirmPhrase}</code> to confirm
            </label>
            <Input
              id="confirm-phrase"
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
              placeholder={confirmPhrase}
            />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
