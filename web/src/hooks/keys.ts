/**
 * React Query key factory.
 *
 * Keys are prefix-structured (`['apis', 'list', params]`) so a mutation can
 * invalidate a whole domain with `{ queryKey: queryKeys.apis.all }`.
 */

export const queryKeys = {
  branding: ['branding'] as const,
  captcha: ['captcha'] as const,
  health: ['health'] as const,
  edgeHealth: ['health', 'edge'] as const,

  catalog: {
    all: ['catalog'] as const,
    list: (params: unknown) => ['catalog', 'list', params] as const,
    detail: (slug: string) => ['catalog', 'detail', slug] as const,
    spec: (slug: string) => ['catalog', 'spec', slug] as const,
  },

  apis: {
    all: ['apis'] as const,
    list: (params: unknown) => ['apis', 'list', params] as const,
    detail: (id: string) => ['apis', 'detail', id] as const,
  },

  accessRequests: {
    all: ['access-requests'] as const,
    list: (params: unknown) => ['access-requests', 'list', params] as const,
  },

  grants: {
    all: ['grants'] as const,
    list: (params: unknown) => ['grants', 'list', params] as const,
  },

  credentials: {
    all: ['credentials'] as const,
    list: (params: unknown) => ['credentials', 'list', params] as const,
  },

  threads: {
    all: ['threads'] as const,
    list: (params: unknown) => ['threads', 'list', params] as const,
    detail: (id: string) => ['threads', 'detail', id] as const,
  },

  notifications: {
    all: ['notifications'] as const,
    list: (params: unknown) => ['notifications', 'list', params] as const,
  },

  users: {
    all: ['users'] as const,
    list: (params: unknown) => ['users', 'list', params] as const,
    me: ['users', 'me'] as const,
  },

  organizations: {
    all: ['organizations'] as const,
    list: (params: unknown) => ['organizations', 'list', params] as const,
  },

  adminSettings: ['admin', 'settings'] as const,
  emailTemplates: {
    all: ['admin', 'email-templates'] as const,
    detail: (key: string) => ['admin', 'email-templates', key] as const,
  },
  auditLogs: {
    all: ['admin', 'audit-logs'] as const,
    list: (params: unknown) => ['admin', 'audit-logs', 'list', params] as const,
  },
} as const;
