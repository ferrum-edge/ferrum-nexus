import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon } from './Icon';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Wide layout for spec/preview content. */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Blocks Escape, overlay clicks and the close button — used by the show-once
   * secret dialog, which must be acknowledged rather than dismissed.
   */
  dismissible?: boolean;
}

const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
} as const;

/** Modal dialog built on Radix. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: DialogProps): ReactElement {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!dismissible && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          className={cn(
            'fx-pop fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col',
            SIZES[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold text-fg">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-sm text-fg-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            {dismissible ? (
              <DialogPrimitive.Close
                aria-label="Close dialog"
                className="rounded-md p-1 text-fg-subtle hover:bg-neutral-soft hover:text-fg"
              >
                <Icon name="x" />
              </DialogPrimitive.Close>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
              {footer}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
