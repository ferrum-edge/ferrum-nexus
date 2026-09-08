/**
 * The admin's route into somebody else's API workspace.
 *
 * The admin guide's remedy for an unresponsive provider is the ordinary route —
 * "any admin can approve, deny or revoke on any API… you do not need god mode"
 * — but the only click path from this inventory went to the read-only catalog
 * page, so the documented remedy was reachable only through god mode.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '@ferrum-nexus/shared';
import { apisApi } from '../../lib/api';
import { AdminApisPage } from './AdminApisPage';

const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../components/layout/RoleGuard', () => ({
  RoleGuard: ({ children }: { children: ReactNode }) => children,
}));

const foreign: Api = {
  id: 'api-9',
  name: 'Billing',
  slug: 'billing',
  description: null,
  owner_user_id: 'someone-else',
  ferrum_proxy_id: 'proxy-9',
  upstream_url: 'https://billing.example.com',
  namespace: 'nexus',
  listen_path: '/nexus/billing',
  invoke_url: null,
  version: '2.4.0',
  spec_format: 'openapi',
  requestable: true,
  auth_plugin: 'key_auth',
  rate_limit: null,
  cors: null,
  allowed_methods: null,
  timeouts: null,
  circuit_breaker: false,
  spec_enforcement: 'docs_only',
  status: 'published',
  visibility: 'public',
  created_at: '2026-09-07T12:00:00.000Z',
  updated_at: '2026-09-07T12:00:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('portal-wide API inventory', () => {
  it('opens the management workspace rather than the read-only catalog page', async () => {
    vi.spyOn(apisApi, 'list').mockResolvedValue({ items: [foreign], total: 1 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminApisPage />
      </QueryClientProvider>,
    );

    fireEvent.click((await screen.findByText('Billing')).closest('tr') as HTMLElement);
    expect(navigate).toHaveBeenCalledWith({ to: '/apis/$apiId', params: { apiId: foreign.id } });
  });
});
