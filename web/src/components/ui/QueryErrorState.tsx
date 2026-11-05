import type { ReactElement } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';

export interface QueryErrorStateProps {
  title?: string;
  description?: string;
  onRetry: () => unknown;
  retrying?: boolean;
  compact?: boolean;
}

/** Persistent failure state for a read query, with an in-place retry action. */
export function QueryErrorState({
  title = 'Could not load data',
  description = 'This data could not be loaded. Try again in a moment.',
  onRetry,
  retrying = false,
  compact = false,
}: QueryErrorStateProps): ReactElement {
  return (
    <div role="alert">
      <EmptyState
        icon="alert"
        title={title}
        description={description}
        tone="danger"
        compact={compact}
        action={
          <Button variant="secondary" loading={retrying} onClick={() => void onRetry()}>
            Retry
          </Button>
        }
      />
    </div>
  );
}

export interface StaleDataNoticeProps {
  description: string;
  onRetry: () => unknown;
  retrying?: boolean;
  className?: string;
}

/**
 * Inline notice for a background refetch that failed after the page loaded:
 * the page keeps showing the last good data (and anything typed into it)
 * instead of being replaced by an error state.
 */
export function StaleDataNotice({
  description,
  onRetry,
  retrying = false,
  className,
}: StaleDataNoticeProps): ReactElement {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning-soft p-3 text-sm text-fg',
        className,
      )}
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>{description}</span>
      </span>
      <Button size="sm" variant="secondary" loading={retrying} onClick={() => void onRetry()}>
        Retry
      </Button>
    </div>
  );
}
