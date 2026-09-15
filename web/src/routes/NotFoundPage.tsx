import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { buttonClassName } from '../components/ui/Button';
import { Icon } from '../components/ui/Icon';

/** Fallback for unmatched routes. */
export function NotFoundPage(): ReactElement {
  return (
    <div className="fx-brand-gradient relative flex min-h-full flex-col items-center justify-center gap-4 overflow-hidden px-4 py-16 text-center">
      <div className="fx-dot-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent ring-1 ring-accent/20">
        <Icon name="help" className="h-7 w-7" />
      </span>
      <p className="relative font-mono text-xs font-semibold tracking-[0.2em] text-accent uppercase">
        404
      </p>
      <h1 className="relative text-2xl font-semibold tracking-tight text-fg">
        This page does not exist
      </h1>
      <p className="relative max-w-md text-sm leading-relaxed text-fg-muted">
        The link may be outdated, or you may not have access to this area of the portal.
      </p>
      <Link to="/" className={`relative mt-2 ${buttonClassName({ variant: 'primary' })}`}>
        <Icon name="arrow-left" />
        Back to dashboard
      </Link>
    </div>
  );
}
