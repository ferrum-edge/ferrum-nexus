import type { ReactElement, ReactNode } from 'react';
import { useBranding } from '../../hooks/useBranding';
import { ThemeToggle } from '../layout/Header';

export interface AuthShellProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

/** Centred card layout shared by the public login/register/verify pages. */
export function AuthShell({ title, description, children, footer }: AuthShellProps): ReactElement {
  const { data: branding } = useBranding();
  const portalName = branding?.portal_name ?? 'Ferrum Nexus';

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          {branding?.logo_data_url ? (
            <img
              src={branding.logo_data_url}
              alt=""
              className="h-7 w-7 rounded-md object-contain"
            />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-fg">
              N
            </span>
          )}
          <span className="text-sm font-semibold text-fg">{portalName}</span>
        </div>
        <ThemeToggle />
      </div>

      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="fx-card p-6">
            <h1 className="text-lg font-semibold text-fg">{title}</h1>
            {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
            {branding?.tagline ? (
              <p className="mt-2 text-sm text-fg-subtle">{branding.tagline}</p>
            ) : null}
            <div className="mt-5">{children}</div>
          </div>
          {footer ? <div className="mt-4 text-center text-sm text-fg-muted">{footer}</div> : null}
          {branding?.support_email ? (
            <p className="mt-4 text-center text-xs text-fg-subtle">
              Need help? Contact{' '}
              <a className="text-accent hover:underline" href={`mailto:${branding.support_email}`}>
                {branding.support_email}
              </a>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Inline error/notice block used by the public forms. */
export function FormNotice({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'warning' | 'success';
  children: ReactNode;
}): ReactElement {
  const toneClass =
    tone === 'danger'
      ? 'border-danger/40 bg-danger-soft'
      : tone === 'warning'
        ? 'border-warning/40 bg-warning-soft'
        : 'border-success/40 bg-success-soft';
  return (
    <div role="alert" className={`rounded-md border p-3 text-sm text-fg ${toneClass}`}>
      {children}
    </div>
  );
}
