import type { ReactElement, ReactNode } from 'react';
import { useBranding } from '../../hooks/useBranding';
import { cn } from '../../lib/cn';
import { ThemeToggle } from '../layout/Header';
import { BrandMark } from '../layout/Sidebar';
import { Icon, type IconName } from '../ui/Icon';

export interface AuthShellProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

const DEFAULT_TAGLINE = 'Publish, discover and consume the APIs behind your gateway.';

const FEATURES: ReadonlyArray<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'catalog',
    title: 'Browse the catalog',
    body: 'Every published API with rendered OpenAPI documentation and a ready-to-copy request.',
  },
  {
    icon: 'grant',
    title: 'Request access, get approved',
    body: 'Providers review requests; approvals flow straight to the gateway as ACL grants.',
  },
  {
    icon: 'key',
    title: 'Credentials you control',
    body: 'Issue, rotate and revoke API keys, basic auth and JWT secrets — shown once, never stored.',
  },
];

/**
 * Layout shared by the public login/register/verify pages: a branded hero on
 * wide screens beside the form, collapsing to a centred card on small ones.
 */
export function AuthShell({ title, description, children, footer }: AuthShellProps): ReactElement {
  const { data: branding } = useBranding();
  const portalName = branding?.portal_name ?? 'Ferrum Nexus';
  const logo = branding?.logo_data_url ?? null;
  const tagline = branding?.tagline ?? DEFAULT_TAGLINE;
  const supportEmail = branding?.support_email ?? null;

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      {/* Hero panel */}
      <section
        aria-hidden="true"
        className={cn(
          'fx-brand-gradient relative hidden overflow-hidden border-r border-border lg:flex lg:w-[46%] lg:max-w-2xl lg:flex-col lg:justify-between lg:p-12',
        )}
      >
        <div className="fx-dot-grid pointer-events-none absolute inset-0" />
        <div className="relative flex items-center gap-3">
          <BrandMark logoDataUrl={logo} portalName={portalName} className="h-10 w-10 text-base" />
          <div>
            <p className="text-base font-semibold text-fg">{portalName}</p>
            <p className="text-[0.7rem] tracking-[0.14em] text-fg-subtle uppercase">
              Developer portal
            </p>
          </div>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl leading-tight font-semibold tracking-tight text-fg text-balance">
            {tagline}
          </h2>
          <ul className="mt-10 flex flex-col gap-6">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="flex items-start gap-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent ring-1 ring-accent/20">
                  <Icon name={feature.icon} className="h-4.5 w-4.5" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-fg">{feature.title}</span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-fg-muted">
                    {feature.body}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-fg-subtle">
          {supportEmail ? <>Need help? {supportEmail}</> : <>Powered by Ferrum Nexus</>}
        </p>
      </section>

      {/* Form column */}
      <div className="flex min-h-full flex-1 flex-col">
        <div className="flex items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5 lg:invisible">
            <BrandMark logoDataUrl={logo} portalName={portalName} />
            <span className="text-sm font-semibold text-fg">{portalName}</span>
          </div>
          <ThemeToggle />
        </div>

        <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
          <div className="animate-slide-up w-full max-w-md">
            <div className="fx-card p-6 sm:p-8">
              <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
              {description ? (
                <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{description}</p>
              ) : null}
              <div className="mt-6">{children}</div>
            </div>
            {footer ? <div className="mt-5 text-center text-sm text-fg-muted">{footer}</div> : null}
            {supportEmail ? (
              <p className="mt-4 text-center text-xs text-fg-subtle lg:hidden">
                Need help? Contact{' '}
                <a className="text-accent hover:underline" href={`mailto:${supportEmail}`}>
                  {supportEmail}
                </a>
              </p>
            ) : null}
          </div>
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
  tone?: 'danger' | 'warning' | 'success' | 'info';
  children: ReactNode;
}): ReactElement {
  const styles = {
    danger: { box: 'border-danger/30 bg-danger-soft', icon: 'text-danger', name: 'alert' },
    warning: { box: 'border-warning/30 bg-warning-soft', icon: 'text-warning', name: 'alert' },
    success: { box: 'border-success/30 bg-success-soft', icon: 'text-success', name: 'check' },
    info: { box: 'border-info/30 bg-info-soft', icon: 'text-info', name: 'info' },
  } as const;
  const style = styles[tone];
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-md border p-3 text-sm text-fg ${style.box}`}
    >
      <Icon name={style.name} className={`mt-0.5 h-4 w-4 shrink-0 ${style.icon}`} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
