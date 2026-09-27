import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

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
  /** Optional leading glyph, tinted with the accent. */
  icon?: IconName;
  /**
   * Keep `actions` on the title line at every width, truncating the title
   * instead of wrapping the actions below it — for a one-line header whose
   * action is a short link ("View all").
   */
  inlineActions?: boolean;
  className?: string;
}

/** Title row inside a {@link Card}. */
export function CardHeader({
  title,
  description,
  actions,
  icon,
  inlineActions = false,
  className,
}: CardHeaderProps): ReactElement {
  return (
    <div
      className={cn(
        'flex justify-between gap-3 border-b border-border px-5 py-4',
        inlineActions ? 'items-center' : 'flex-wrap items-start',
        className,
      )}
    >
      <div className={cn('flex min-w-0 gap-3', inlineActions ? 'items-center' : 'items-start')}>
        {icon ? (
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text',
              !inlineActions && 'mt-0.5',
            )}
          >
            <Icon name={icon} className="h-4 w-4" />
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 className={cn('text-sm font-semibold text-fg', inlineActions && 'truncate')}>
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Padded body inside a {@link Card}. */
export function CardBody({ className, children }: CardProps): ReactElement {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

/** One crumb in a {@link PageHeader} trail. */
export interface Crumb {
  label: string;
  /** Router path; the last crumb is usually the current page and has none. */
  to?: '/' | '/catalog' | '/credentials' | '/messages' | '/apis' | '/admin/users' | '/admin/apis';
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small uppercase label above the title (the section the page belongs to). */
  eyebrow?: ReactNode;
  /** Breadcrumb trail rendered above the title on detail pages. */
  breadcrumbs?: Crumb[];
  /** Badges or metadata rendered inline after the title. */
  meta?: ReactNode;
}

/** Page-level heading block used at the top of every route. */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  breadcrumbs,
  meta,
}: PageHeaderProps): ReactElement {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-x-6">
      {/* A 20rem basis, not 0: with a zero basis a wide set of actions never
          wraps and squeezes the title into a narrow column instead. */}
      <div className="min-w-0 flex-1 sm:basis-80">
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <nav aria-label="Breadcrumb" className="mb-2">
            <ol className="flex flex-wrap items-center gap-1 text-xs text-fg-subtle">
              {breadcrumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {index > 0 ? <Icon name="chevron-right" className="h-3 w-3" /> : null}
                  {crumb.to ? (
                    <Link to={crumb.to} className="transition-colors hover:text-fg">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="text-fg-muted">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : eyebrow ? (
          <p className="mb-1.5 text-[0.7rem] font-semibold tracking-[0.12em] text-accent-text uppercase">
            {eyebrow}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          {meta ? <div className="flex flex-wrap items-center gap-1.5">{meta}</div> : null}
        </div>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-fg-muted">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>
      ) : null}
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
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
      <dt className="w-44 shrink-0 pt-0.5 text-xs font-medium tracking-wide text-fg-subtle uppercase">
        {label}
      </dt>
      <dd className="min-w-0 text-sm break-words text-fg">{children}</dd>
    </div>
  );
}

export interface StatCardProps {
  icon: IconName;
  label: string;
  value: ReactNode;
  /** Secondary line under the label (a hint or a delta). */
  hint?: ReactNode;
  /** Router destination; the whole card becomes a link when set. */
  to?: '/catalog' | '/credentials' | '/apis' | '/admin/users' | '/admin/apis' | '/admin/audit';
  /** Tone of the icon tile. */
  tone?: 'accent' | 'info' | 'success' | 'warning';
  loading?: boolean;
  /** Placement in the parent grid (a column span). */
  className?: string;
}

const STAT_TONES = {
  accent: 'bg-accent-soft text-accent-text',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
} as const;

/**
 * Headline number with an icon tile, used on the dashboard.
 *
 * The card lays itself out by its own width, not the viewport's: in a narrow
 * grid cell (a phone's two columns) the icon and arrow share the top row and
 * the number sits under them, and from `@3xs` (16rem) up it is one row with
 * the hint. So the same card stays compact in a half-width cell and reads in
 * full wherever it spans the row.
 */
export function StatCard({
  icon,
  label,
  value,
  hint,
  to,
  tone = 'accent',
  loading = false,
  className,
}: StatCardProps): ReactElement {
  const body = (
    <span className="grid h-full grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 p-3 [grid-template-areas:'icon_arrow'_'text_text'] @3xs:grid-cols-[auto_1fr_auto] @3xs:p-4 @3xs:[grid-template-areas:'icon_text_arrow']">
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg [grid-area:icon] @3xs:h-10 @3xs:w-10',
          STAT_TONES[tone],
        )}
      >
        <Icon name={icon} className="h-4 w-4 @3xs:h-5 @3xs:w-5" />
      </span>
      <span className="min-w-0 [grid-area:text]">
        {loading ? (
          <span className="fx-skeleton block h-7 w-12" />
        ) : (
          <span className="block text-xl font-semibold tracking-tight text-fg tabular-nums @3xs:text-2xl">
            {value}
          </span>
        )}
        <span className="block truncate text-sm text-fg-muted">{label}</span>
        {hint ? (
          <span className="mt-0.5 hidden truncate text-xs text-fg-subtle @3xs:block">{hint}</span>
        ) : null}
      </span>
      {to ? (
        <Icon
          name="arrow-right"
          className="h-4 w-4 justify-self-end text-fg-subtle transition-transform [grid-area:arrow] group-hover:translate-x-0.5 group-hover:text-fg"
        />
      ) : null}
    </span>
  );
  const classes = cn('fx-card group block @container', className);
  if (to) {
    return (
      <Link to={to} className={cn(classes, 'fx-card-interactive')}>
        {body}
      </Link>
    );
  }
  return <div className={classes}>{body}</div>;
}
