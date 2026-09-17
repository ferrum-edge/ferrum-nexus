import { Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { useBranding } from '../../hooks/useBranding';
import { useAuth } from '../../stores/auth';
import { Spinner } from '../ui/Spinner';
import { BrandingFooter } from '../auth/AuthShell';
import { Icon } from '../ui/Icon';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { useDesktopSidebar } from './useDesktopSidebar';

/** Banner shown while a signed-in account still has an unverified email. */
function VerifyEmailBanner(): ReactElement {
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 border-b border-warning/30 bg-warning-soft px-4 py-2.5 text-sm text-fg sm:px-6"
    >
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <p>
        <span className="font-medium">Verify your email address.</span> Some actions stay locked
        until you open the verification link we sent you. Check your inbox and spam folder.
      </p>
    </div>
  );
}

/**
 * Authenticated layout: sidebar + header + routed content.
 *
 * It also acts as the authentication guard — no child route ever mounts for an
 * unauthenticated visitor.
 */
export function AppShell(): ReactElement {
  const { status, user, needsEmailVerification } = useAuth();
  const { data: branding } = useBranding();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isDesktop = useDesktopSidebar();
  const mobileOpen = sidebarOpen && !isDesktop;
  const sidebarId = useId();
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const wasMobileOpen = useRef(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    const focusWasInSidebar = sidebar?.contains(document.activeElement);
    if (mobileOpen && sidebar) {
      (sidebar.querySelector<HTMLElement>('a[href]') ?? sidebar).focus({ preventScroll: true });
    } else if (!isDesktop && (wasMobileOpen.current || focusWasInSidebar)) {
      // Also rescue focus when a desktop link becomes part of the closed drawer.
      sidebarToggleRef.current?.focus({ preventScroll: true });
    }
    wasMobileOpen.current = mobileOpen;
  }, [mobileOpen, isDesktop]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        setSidebarOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  // Redirect imperatively rather than rendering <Navigate>: this component
  // stays mounted while the lazy /login chunk loads, and <Navigate> re-fires on
  // every render because it compares its props by identity.
  useEffect(() => {
    if (status === 'unauthenticated') void navigate({ to: '/login', replace: true });
  }, [status, navigate]);

  if (status !== 'authenticated' || user === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label={status === 'loading' ? 'Loading portal' : 'Redirecting to sign in'} />
      </div>
    );
  }

  const portalName = branding?.portal_name ?? 'Ferrum Nexus';
  const supportEmail = branding?.support_email ?? null;
  const footerText = branding?.footer_text ?? null;
  const footerLinks = branding?.footer_links ?? [];

  return (
    <div className="min-h-full">
      <Sidebar
        id={sidebarId}
        sidebarRef={sidebarRef}
        role={user.role}
        open={sidebarOpen}
        isDesktop={isDesktop}
        onNavigate={() => setSidebarOpen(false)}
        portalName={portalName}
        logoDataUrl={branding?.logo_data_url ?? null}
        user={user}
      />
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
          className="animate-fade-in fixed inset-0 z-30 bg-overlay backdrop-blur-[2px] lg:hidden"
        />
      ) : null}
      <div className="flex min-h-full flex-col lg:pl-64">
        <Header
          portalName={portalName}
          sidebarId={sidebarId}
          sidebarOpen={mobileOpen}
          sidebarToggleRef={sidebarToggleRef}
          user={user}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
        />
        {needsEmailVerification ? <VerifyEmailBanner /> : null}
        <main
          key={location.pathname}
          className="animate-fade-in mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          <Outlet />
        </main>
        <footer className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4 text-xs text-fg-subtle sm:px-6 lg:px-8">
          <BrandingFooter text={footerText ?? portalName} links={footerLinks} />
          {supportEmail ? (
            <a className="transition-colors hover:text-fg" href={`mailto:${supportEmail}`}>
              Support: {supportEmail}
            </a>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
