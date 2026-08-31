/**
 * Authentication store.
 *
 * Bootstraps from `GET /api/auth/me`, owns login/register/logout, and exposes
 * role helpers derived through the shared `roleAtLeast` ordering. It installs
 * itself as the global 401 handler so a stale session tears state down exactly
 * once no matter which request noticed.
 */

import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  roleAtLeast,
  type Capabilities,
  type LoginRequest,
  type RegisterRequest,
  type RegisterResponse,
  type Role,
  type User,
} from '@ferrum-nexus/shared';
import { ApiError, authApi, setUnauthorizedHandler } from '../lib/api';

/** Lifecycle of the session bootstrap. */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  capabilities: Capabilities | null;
  /** True once the initial `GET /auth/me` probe has settled. */
  ready: boolean;
  /** Role rank helpers (`client` < `provider` < `admin` < `super_admin`). */
  canProvider: boolean;
  canAdmin: boolean;
  canSuperAdmin: boolean;
  /** True when the signed-in account still needs to verify its email. */
  needsEmailVerification: boolean;
  hasRole: (role: Role) => boolean;
  login: (body: LoginRequest) => Promise<User>;
  register: (body: RegisterRequest) => Promise<RegisterResponse>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Capabilities inferred from the role, used until the server sends its own. */
function capabilitiesForRole(role: Role): Capabilities {
  return {
    can_publish_apis: roleAtLeast(role, 'provider'),
    can_review_access_requests: roleAtLeast(role, 'provider'),
    can_manage_users: roleAtLeast(role, 'admin'),
    can_manage_settings: roleAtLeast(role, 'admin'),
    can_view_audit_log: roleAtLeast(role, 'admin'),
    can_use_god_mode: roleAtLeast(role, 'super_admin'),
  };
}

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const previousUserId = useRef<string | null>(null);

  const acceptUser = useCallback(
    (next: User, nextCapabilities: Capabilities | null) => {
      if (previousUserId.current && previousUserId.current !== next.id) {
        queryClient.clear();
      }
      previousUserId.current = next.id;
      setUser(next);
      setCapabilities(nextCapabilities ?? capabilitiesForRole(next.role));
      setStatus('authenticated');
    },
    [queryClient],
  );

  const clearLocalSession = useCallback(() => {
    previousUserId.current = null;
    setUser(null);
    setCapabilities(null);
    setStatus('unauthenticated');
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(clearLocalSession);
    return () => setUnauthorizedHandler(null);
  }, [clearLocalSession]);

  const refresh = useCallback(async () => {
    try {
      const me = await authApi.meSilent();
      acceptUser(me.user, me.capabilities);
    } catch (error) {
      if (ApiError.is(error) && error.status === 401) {
        previousUserId.current = null;
        setUser(null);
        setCapabilities(null);
        setStatus('unauthenticated');
        return;
      }
      // A transient failure with no prior principal is treated as signed out;
      // an already-authenticated session is kept so a blip does not log out.
      setStatus((current) => (current === 'authenticated' ? current : 'unauthenticated'));
    }
  }, [acceptUser]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (body: LoginRequest): Promise<User> => {
      const response = await authApi.login(body);
      acceptUser(response.user, null);
      // Pull the authoritative capability set right after the cookie lands.
      void authApi
        .meSilent()
        .then((me) => acceptUser(me.user, me.capabilities))
        .catch(() => undefined);
      return response.user;
    },
    [acceptUser],
  );

  const register = useCallback(
    (body: RegisterRequest): Promise<RegisterResponse> => authApi.register(body),
    [],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      clearLocalSession();
    }
  }, [clearLocalSession]);

  const value = useMemo<AuthContextValue>(() => {
    const role = user?.role ?? null;
    return {
      status,
      user,
      capabilities,
      ready: status !== 'loading',
      canProvider: role !== null && roleAtLeast(role, 'provider'),
      canAdmin: role !== null && roleAtLeast(role, 'admin'),
      canSuperAdmin: role !== null && roleAtLeast(role, 'super_admin'),
      needsEmailVerification: user !== null && !user.email_verified,
      hasRole: (required: Role) => role !== null && roleAtLeast(role, required),
      login,
      register,
      logout,
      refresh,
    };
  }, [status, user, capabilities, login, register, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Access the auth store; throws when used outside {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
