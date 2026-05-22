import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import type { PortalUser, AppPublicSettings } from '@ferrum-nexus/shared';

interface AuthContext {
  user: PortalUser | null;
  settings: AppPublicSettings | null;
  isLoading: boolean;
  login: (input: { email: string; password: string }) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name?: string;
    desiredRole: 'client' | 'provider';
    captchaToken?: string;
  }) => Promise<{ requiresVerification: boolean; requiresAdminApproval: boolean }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthContext | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<PortalUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ['public-settings'],
    queryFn: async () => api<AppPublicSettings>('/public/settings'),
  });

  useEffect(() => {
    api<{ user: PortalUser }>('/me')
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoaded(true));
  }, []);

  const loginMut = useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      const data = await api<{ user: PortalUser }>('/auth/login', { method: 'POST', json: input });
      return data.user;
    },
    onSuccess: (next) => {
      setUser(next);
      void queryClient.invalidateQueries();
    },
  });

  const registerMut = useMutation({
    mutationFn: async (input: {
      email: string;
      password: string;
      name?: string;
      desiredRole: 'client' | 'provider';
      captchaToken?: string;
    }) => {
      const data = await api<{
        user: PortalUser;
        requiresVerification: boolean;
        requiresAdminApproval: boolean;
      }>(
        '/auth/register',
        { method: 'POST', json: input },
      );
      return data;
    },
    onSuccess: (data) => {
      if (!data.requiresVerification && !data.requiresAdminApproval) setUser(data.user);
    },
  });

  const logoutMut = useMutation({
    mutationFn: async () => api<void>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      setUser(null);
      queryClient.clear();
    },
  });

  const value = useMemo<AuthContext>(
    () => ({
      user,
      settings: settingsQuery.data ?? null,
      isLoading: !loaded,
      login: async (input) => {
        await loginMut.mutateAsync(input);
      },
      register: async (input) => {
        const result = await registerMut.mutateAsync(input);
        return {
          requiresVerification: result.requiresVerification,
          requiresAdminApproval: result.requiresAdminApproval,
        };
      },
      logout: async () => {
        await logoutMut.mutateAsync();
      },
      refresh: async () => {
        try {
          const data = await api<{ user: PortalUser }>('/me');
          setUser(data.user);
        } catch {
          setUser(null);
        }
      },
    }),
    [user, settingsQuery.data, loaded, loginMut, registerMut, logoutMut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth used outside AuthProvider');
  return ctx;
}
