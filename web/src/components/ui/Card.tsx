import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface CardProps {
  className?: string;
  children: ReactNode;
}

/** Standard surface container. */
export function Card({ className, children }: CardProps): ReactElement {
  return <div className={cn('fx-card', className)}>{children}</div>;
}

export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Title row inside a {@link Card}. */
export function CardHeader({
  title,
  description,
  actions,
  className,
}: CardHeaderProps): ReactElement {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Padded body inside a {@link Card}. */
export function CardBody({ className, children }: CardProps): ReactElement {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

/** Page-level heading block used at the top of every route. */
export function PageHeader({ title, description, actions }: PageHeaderProps): ReactElement {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Label/value pair used on detail pages. */
export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <dt className="w-48 shrink-0 text-xs tracking-wide text-fg-subtle uppercase">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-fg">{children}</dd>
    </div>
  );
}
