import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.js';
import { ThemeToggle } from './ThemeToggle.js';
import { NotificationBell } from './NotificationBell.js';
import { navigate } from '../App.js';
import { ClientDashboard } from '../pages/client/ClientDashboard.js';
import { CatalogPage } from '../pages/shared/CatalogPage.js';
import { ApiDetailPage } from '../pages/shared/ApiDetailPage.js';
import { ClientAccessPage } from '../pages/client/ClientAccessPage.js';
import { ClientCredentialsPage } from '../pages/client/ClientCredentialsPage.js';
import { ProviderDashboard } from '../pages/provider/ProviderDashboard.js';
import { ProviderPublishPage } from '../pages/provider/ProviderPublishPage.js';
import { ProviderApisPage } from '../pages/provider/ProviderApisPage.js';
import { ProviderRequestsPage } from '../pages/provider/ProviderRequestsPage.js';
import { AdminDashboard } from '../pages/admin/AdminDashboard.js';
import { AdminUsersPage } from '../pages/admin/AdminUsersPage.js';
import { AdminAuditPage } from '../pages/admin/AdminAuditPage.js';
import { AdminSettingsPage } from '../pages/admin/AdminSettingsPage.js';
import { AdminMassEmailPage } from '../pages/admin/AdminMassEmailPage.js';
import { AdminDriftPage } from '../pages/admin/AdminDriftPage.js';
import { MessagesPage } from '../pages/shared/MessagesPage.js';
import { ProfilePage } from '../pages/shared/ProfilePage.js';

interface NavItem {
  to: string;
  label: string;
  match?: (path: string) => boolean;
  roles?: ('client' | 'provider' | 'admin' | 'super_admin')[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', match: (p) => p === '/' },
  { to: '/catalog', label: 'Catalog', match: (p) => p.startsWith('/catalog') || p.startsWith('/apis/') },
  { to: '/client/access', label: 'My access', match: (p) => p.startsWith('/client/access'), roles: ['client'] },
  { to: '/client/credentials', label: 'Credentials', match: (p) => p.startsWith('/client/credentials'), roles: ['client'] },
  { to: '/provider/apis', label: 'My APIs', match: (p) => p.startsWith('/provider/apis'), roles: ['provider'] },
  { to: '/provider/publish', label: 'Publish', match: (p) => p === '/provider/publish', roles: ['provider'] },
  { to: '/provider/requests', label: 'Requests', match: (p) => p === '/provider/requests', roles: ['provider'] },
  { to: '/messages', label: 'Messages', match: (p) => p.startsWith('/messages') },
  { to: '/admin', label: 'Admin', match: (p) => p.startsWith('/admin'), roles: ['admin', 'super_admin'] },
];

export function AppShell() {
  const { user, logout, settings } = useAuth();
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const handler = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', handler);
    window.addEventListener('nexus:navigate', handler);
    return () => {
      window.removeEventListener('popstate', handler);
      window.removeEventListener('nexus:navigate', handler);
    };
  }, []);

  if (!user) return null;

  const visibleNav = NAV.filter((item) => {
    if (!item.roles) return true;
    return item.roles.some((role) => user.roles.includes(role));
  });

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
          <button
            type="button"
            className="flex items-center gap-2"
            onClick={() => navigate('/')}
          >
            {settings?.branding.logoUrl ? (
              <img
                src={settings.branding.logoUrl}
                alt=""
                className="h-8 w-8 rounded"
              />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded bg-brand-600 text-white">
                N
              </div>
            )}
            <span className="font-semibold">
              {settings?.branding.productName ?? 'Ferrum Nexus'}
            </span>
          </button>
          <nav className="ml-6 flex flex-1 flex-wrap items-center gap-1">
            {visibleNav.map((item) => {
              const active = item.match ? item.match(pathname) : pathname === item.to;
              return (
                <button
                  key={item.to}
                  type="button"
                  onClick={() => navigate(item.to)}
                  className={
                    'rounded px-3 py-1.5 text-sm ' +
                    (active
                      ? 'bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')
                  }
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
          <NotificationBell />
          <ThemeToggle />
          <div className="hidden text-sm sm:block">
            <button
              type="button"
              className="muted hover:text-slate-900 dark:hover:text-slate-50"
              onClick={() => navigate('/profile')}
            >
              {user.email}
            </button>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void logout();
              navigate('/');
            }}
          >
            Log out
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {renderRoute(pathname, user)}
      </main>
      <footer className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {settings?.branding.footerNotice ?? 'Powered by Ferrum Nexus.'}
      </footer>
    </div>
  );
}

function renderRoute(
  pathname: string,
  user: { roles: ('client' | 'provider' | 'admin' | 'super_admin')[] },
): JSX.Element {
  if (pathname === '/') {
    if (user.roles.includes('admin') || user.roles.includes('super_admin')) {
      return <AdminDashboard />;
    }
    if (user.roles.includes('provider')) return <ProviderDashboard />;
    return <ClientDashboard />;
  }
  if (pathname === '/catalog') return <CatalogPage />;
  if (pathname.startsWith('/apis/')) {
    const id = pathname.split('/')[2]!;
    return <ApiDetailPage id={id} />;
  }
  if (pathname === '/client/access') return <ClientAccessPage />;
  if (pathname === '/client/credentials') return <ClientCredentialsPage />;
  if (pathname === '/provider/apis') return <ProviderApisPage />;
  if (pathname === '/provider/publish') return <ProviderPublishPage />;
  if (pathname === '/provider/requests') return <ProviderRequestsPage />;
  if (pathname.startsWith('/messages')) {
    const id = pathname.split('/')[2];
    return <MessagesPage conversationId={id} />;
  }
  if (pathname === '/profile') return <ProfilePage />;
  if (pathname === '/admin') return <AdminDashboard />;
  if (pathname === '/admin/users') return <AdminUsersPage />;
  if (pathname === '/admin/audit') return <AdminAuditPage />;
  if (pathname === '/admin/settings') return <AdminSettingsPage />;
  if (pathname === '/admin/mass-email') return <AdminMassEmailPage />;
  if (pathname === '/admin/drift') return <AdminDriftPage />;
  return (
    <div className="card">
      <h2 className="text-lg font-semibold">Page not found</h2>
      <p className="muted mt-1">{pathname}</p>
    </div>
  );
}
