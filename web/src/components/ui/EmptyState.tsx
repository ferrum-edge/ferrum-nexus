import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Tighter padding for use inside small panels and dropdowns. */
  compact?: boolean;
  /** Tone of the icon ring; `danger` for error states. */
  tone?: 'neutral' | 'accent' | 'danger';
}

const TONES = {
  neutral: 'bg-neutral-soft text-fg-subtle ring-border',
  accent: 'bg-accent-soft text-accent ring-accent/20',
  danger: 'bg-danger-soft text-danger ring-danger/20',
} as const;

/** Placeholder shown when a list has no rows. */
export function EmptyState({
  icon = 'inbox',
  title,
  description,
  action,
  compact = false,
  tone = 'neutral',
}: EmptyStateProps): ReactElement {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 text-center',
        compact ? 'py-8' : 'py-14',
      )}
    >
      <span
        className={cn(
          'flex items-center justify-center rounded-full ring-1 ring-inset',
          compact ? 'h-10 w-10' : 'h-12 w-12',
          TONES[tone],
        )}
      >
        <Icon name={icon} className={compact ? 'h-4.5 w-4.5' : 'h-5 w-5'} />
      </span>
      <div>
        <p className="text-sm font-semibold text-fg">{title}</p>
        {description ? (
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>
      ) : null}
    </div>
  );
}
