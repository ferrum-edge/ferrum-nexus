import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuditLog } from '@ferrum-nexus/shared';
import { AdminAuditPage } from './AdminAuditPage';
import { DashboardPage } from '../DashboardPage';

const entries: AuditLog[] = [
  {
    id: 'named',
    actor_user_id: 'user-id',
    actor_role: 'client',
    actor: { id: 'user-id', email: 'ada@example.test', display_name: 'Ada', role: 'client' },
    action: 'access.request',
    target_type: 'access_request',
    target_id: 'request-id',
    details: {},
    ip: null,
    created_at: '2026-09-08T01:46:15.000Z',
  },
];
entries.push(
  { ...entries[0]!, id: 'unknown', actor_user_id: 'deleted-id', actor: null },
  { ...entries[0]!, id: 'system', actor_user_id: null, actor_role: null, actor: null },
);

vi.mock('../../components/layout/RoleGuard', () => ({
  RoleGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../hooks/useAuditLogs', () => ({
  useAuditLogs: () => ({ data: { items: entries, total: entries.length }, isLoading: false }),
}));
vi.mock('../../hooks/useAccessRequests', () => ({ useAccessRequests: () => ({}) }));
vi.mock('../../hooks/useApis', () => ({ useApis: () => ({}), useMyApis: () => ({}) }));
vi.mock('../../hooks/useCredentials', () => ({ useCredentials: () => ({}) }));
vi.mock('../../hooks/useGrants', () => ({ useGrants: () => ({}) }));
vi.mock('../../hooks/useUsers', () => ({ useUsers: () => ({}) }));
vi.mock('../../stores/auth', () => ({
  useAuth: () => ({ user: { display_name: 'Admin' }, canAdmin: true, canProvider: false }),
}));

afterEach(cleanup);

it('renders named, unknown and system actors distinctly in the audit table', () => {
  render(<AdminAuditPage />);
  expect(screen.getByText('Ada')).toBeInTheDocument();
  expect(screen.getByText('Unknown user (deleted-id)')).toBeInTheDocument();
  expect(screen.getByText('system')).toBeInTheDocument();
});

it('attributes dashboard activity to the actor without calling unknown users system', () => {
  render(<DashboardPage />);
  expect(screen.getByText('Ada · access_request')).toBeInTheDocument();
  expect(screen.getByText('Unknown user (deleted-id) · access_request')).toBeInTheDocument();
  expect(screen.getByText('system · access_request')).toBeInTheDocument();
});
