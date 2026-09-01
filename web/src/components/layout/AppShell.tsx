import { Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ReactElement } from 'react';
import { useBranding } from '../../hooks/useBranding';
import { useAuth } from '../../stores/auth';
import { Spinner } from '../ui/Spinner';
import { Icon } from '../ui/Icon';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

/** Banner shown while a signed-in account still has an unverified email. */
function VerifyEmailBanner(): ReactElement {
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 border-b border-warning/40 bg-warning-soft px-4 py-2.5 text-sm text-fg"
    >
      <Icon name="alert" className="mt-0.5 h-4 w-4 text-warning" />
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
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

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

  return (
    <div className="min-h-full">
      <Sidebar
        role={user.role}
        open={sidebarOpen}
        onNavigate={() => setSidebarOpen(false)}
        portalName={portalName}
        logoDataUrl={branding?.logo_data_url ?? null}
      />
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-overlay lg:hidden"
        />
      ) : null}
      <div className="lg:pl-64">
        <Header
          portalName={portalName}
          user={user}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
        />
        {needsEmailVerification ? <VerifyEmailBanner /> : null}
        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
