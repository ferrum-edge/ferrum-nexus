import type { ReactElement, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

/** Placeholder shown when a list has no rows. */
export function EmptyState({
  icon = 'stack',
  title,
  description,
  action,
}: EmptyStateProps): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-soft text-fg-subtle">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div>
        <p className="text-sm font-medium text-fg">{title}</p>
        {description ? (
          <p className="mx-auto mt-1 max-w-md text-sm text-fg-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
