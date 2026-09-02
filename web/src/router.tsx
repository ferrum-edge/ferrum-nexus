/**
 * Code-based TanStack Router tree.
 *
 * Public routes (login/register/verify-email/password recovery) sit directly
 * under the root; every
 * authenticated page hangs off a pathless layout route rendered by `AppShell`,
 * which doubles as the authentication guard. Each page is loaded lazily so the
 * initial bundle only carries the shell.
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from '@tanstack/react-router';
import { AppShell } from './components/layout/AppShell';
import { NotFoundPage } from './routes/NotFoundPage';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: NotFoundPage,
});

/* ── Public ─────────────────────────────────────────────────────────────── */

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  // `?reset` is how the reset page hands the "your password was changed"
  // notice over: the reset itself signs every session out, so the confirmation
  // has to be shown on the page the user is sent to next. The key is omitted
  // rather than set to `false`, which is what keeps every other `to="/login"`
  // link from having to spell it out.
  validateSearch: (search: Record<string, unknown>): { reset?: true } =>
    search.reset === true || search.reset === 'true' || search.reset === '1' ? { reset: true } : {},
  component: lazyRouteComponent(() => import('./routes/LoginPage'), 'LoginPage'),
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: lazyRouteComponent(() => import('./routes/RegisterPage'), 'RegisterPage'),
});

const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
  component: lazyRouteComponent(() => import('./routes/VerifyEmailPage'), 'VerifyEmailPage'),
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: lazyRouteComponent(() => import('./routes/ForgotPasswordPage'), 'ForgotPasswordPage'),
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
  component: lazyRouteComponent(() => import('./routes/ResetPasswordPage'), 'ResetPasswordPage'),
});

/* ── Authenticated shell ────────────────────────────────────────────────── */

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  component: AppShell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: lazyRouteComponent(() => import('./routes/DashboardPage'), 'DashboardPage'),
});

const catalogRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/catalog',
  component: lazyRouteComponent(() => import('./routes/CatalogPage'), 'CatalogPage'),
});

const catalogDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/catalog/$slug',
  component: lazyRouteComponent(() => import('./routes/CatalogDetailPage'), 'CatalogDetailPage'),
});

const credentialsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/credentials',
  component: lazyRouteComponent(() => import('./routes/CredentialsPage'), 'CredentialsPage'),
});

const messagesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/messages',
  component: lazyRouteComponent(() => import('./routes/MessagesPage'), 'MessagesPage'),
});

const messageThreadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/messages/$threadId',
  component: lazyRouteComponent(() => import('./routes/MessageThreadPage'), 'MessageThreadPage'),
});

const profileRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/profile',
  component: lazyRouteComponent(() => import('./routes/ProfilePage'), 'ProfilePage'),
});

const apisRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/apis',
  component: lazyRouteComponent(() => import('./routes/ApisPage'), 'ApisPage'),
});

const apiNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/apis/new',
  component: lazyRouteComponent(() => import('./routes/ApiNewPage'), 'ApiNewPage'),
});

const apiDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/apis/$apiId',
  component: lazyRouteComponent(() => import('./routes/ApiDetailPage'), 'ApiDetailPage'),
});

const adminUsersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/users',
  component: lazyRouteComponent(() => import('./routes/admin/AdminUsersPage'), 'AdminUsersPage'),
});

const adminOrgsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/orgs',
  component: lazyRouteComponent(() => import('./routes/admin/AdminOrgsPage'), 'AdminOrgsPage'),
});

const adminApisRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/apis',
  component: lazyRouteComponent(() => import('./routes/admin/AdminApisPage'), 'AdminApisPage'),
});

const adminAuditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/audit',
  component: lazyRouteComponent(() => import('./routes/admin/AdminAuditPage'), 'AdminAuditPage'),
});

const adminSettingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/settings',
  component: lazyRouteComponent(
    () => import('./routes/admin/AdminSettingsPage'),
    'AdminSettingsPage',
  ),
});

const adminMassEmailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/mass-email',
  component: lazyRouteComponent(
    () => import('./routes/admin/AdminMassEmailPage'),
    'AdminMassEmailPage',
  ),
});

const adminGodRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/god',
  component: lazyRouteComponent(() => import('./routes/admin/AdminGodPage'), 'AdminGodPage'),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  registerRoute,
  verifyEmailRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  shellRoute.addChildren([
    dashboardRoute,
    catalogRoute,
    catalogDetailRoute,
    credentialsRoute,
    messagesRoute,
    messageThreadRoute,
    profileRoute,
    apisRoute,
    apiNewRoute,
    apiDetailRoute,
    adminUsersRoute,
    adminOrgsRoute,
    adminApisRoute,
    adminAuditRoute,
    adminSettingsRoute,
    adminMassEmailRoute,
    adminGodRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultNotFoundComponent: NotFoundPage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
