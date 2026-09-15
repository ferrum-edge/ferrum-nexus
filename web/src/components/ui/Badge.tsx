import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Semantic tone of a badge. */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-neutral-soft text-fg-muted ring-fg-subtle/20',
  accent: 'bg-accent-soft text-accent ring-accent/25',
  success: 'bg-success-soft text-success ring-success/25',
  warning: 'bg-warning-soft text-warning ring-warning/25',
  danger: 'bg-danger-soft text-danger ring-danger/25',
  info: 'bg-info-soft text-info ring-info/25',
};

const DOTS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-fg-subtle',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

export interface BadgeProps {
  tone?: BadgeTone;
  /** Leading status dot in the tone colour. */
  dot?: boolean;
  /** Monospace text, for versions and identifiers. */
  mono?: boolean;
  className?: string;
  children: ReactNode;
}

/** Small inline label used for statuses, roles and counts. */
export function Badge({
  tone = 'neutral',
  dot = false,
  mono = false,
  className,
  children,
}: BadgeProps): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        mono && 'font-mono text-[0.7rem]',
        TONES[tone],
        className,
      )}
    >
      {dot ? (
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOTS[tone])} aria-hidden="true" />
      ) : null}
      {children}
    </span>
  );
}
