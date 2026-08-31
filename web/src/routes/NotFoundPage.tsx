import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

/** Fallback for unmatched routes. */
export function NotFoundPage(): ReactElement {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <p className="text-sm font-semibold tracking-wide text-accent uppercase">404</p>
      <h1 className="text-xl font-semibold text-fg">This page does not exist</h1>
      <p className="max-w-md text-sm text-fg-muted">
        The link may be outdated, or you may not have access to this area of the portal.
      </p>
      <Link
        to="/"
        className="mt-2 inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
