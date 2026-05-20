import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './lib/auth.js';
import { LoginPage } from './pages/auth/LoginPage.js';
import { RegisterPage } from './pages/auth/RegisterPage.js';
import { VerifyEmailPage } from './pages/auth/VerifyEmailPage.js';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage.js';
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage.js';
import { AppShell } from './components/AppShell.js';
import { initThemeFromDefault } from './lib/theme.js';

export function App() {
  return (
    <AuthProvider>
      <Bootstrapped />
    </AuthProvider>
  );
}

function Bootstrapped() {
  const { user, settings, isLoading } = useAuth();
  const [route, setRoute] = useState(getRoute);

  useEffect(() => {
    const handler = () => setRoute(getRoute());
    window.addEventListener('popstate', handler);
    window.addEventListener('nexus:navigate', handler);
    return () => {
      window.removeEventListener('popstate', handler);
      window.removeEventListener('nexus:navigate', handler);
    };
  }, []);

  useEffect(() => {
    if (settings?.branding.defaultTheme) {
      initThemeFromDefault(settings.branding.defaultTheme);
    }
  }, [settings?.branding.defaultTheme]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-600 dark:text-slate-300">
        Loading…
      </div>
    );
  }

  if (!user) {
    switch (route.pathname) {
      case '/register':
        return <RegisterPage />;
      case '/verify-email':
        return <VerifyEmailPage token={route.params.get('token')} />;
      case '/forgot-password':
        return <ForgotPasswordPage />;
      case '/reset-password':
        return <ResetPasswordPage token={route.params.get('token')} />;
      default:
        return <LoginPage />;
    }
  }

  return <AppShell />;
}

function getRoute() {
  const { pathname, search } = window.location;
  return { pathname, params: new URLSearchParams(search) };
}

export function navigate(to: string): void {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new Event('nexus:navigate'));
}
