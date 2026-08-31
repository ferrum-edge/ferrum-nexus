import type { ReactElement } from 'react';
import { cn } from '../../lib/cn';

export interface SpinnerProps {
  className?: string;
  label?: string;
}

/** Indeterminate progress indicator. */
export function Spinner({ className, label }: SpinnerProps): ReactElement {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className={cn('h-5 w-5 animate-spin text-accent', className)}
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="2.5"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      {label ? <span className="text-sm text-fg-muted">{label}</span> : null}
      <span className="sr-only">{label ?? 'Loading'}</span>
    </span>
  );
}

/** Full-panel loading state used while a page's first query resolves. */
export function LoadingPanel({ label = 'Loading' }: { label?: string }): ReactElement {
  return (
    <div className="flex min-h-40 items-center justify-center p-8">
      <Spinner label={label} />
    </div>
  );
}
