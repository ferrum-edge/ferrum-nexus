import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Semantic tone of a badge. */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-neutral-soft text-fg-muted',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

export interface BadgeProps {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}

/** Small inline label used for statuses, roles and counts. */
export function Badge({ tone = 'neutral', className, children }: BadgeProps): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
