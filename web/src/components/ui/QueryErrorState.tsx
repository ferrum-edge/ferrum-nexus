import type { ReactElement } from 'react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

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
