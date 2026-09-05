import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessRequest, Grant, ListQuery, Paginated } from '@ferrum-nexus/shared';
import { accessRequestsApi, grantsApi } from '../lib/api';
import { ToastProvider } from '../stores/toast';
import { GrantsTab, RequestsTab } from './ApiDetailPage';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

function request(index: number, status: AccessRequest['status']): AccessRequest {
  return {
    id: `request-${index}`,
    api_id: 'api-1',
    user_id: `user-${index}`,
    justification: `Request ${index}`,
    status,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, -index)).toISOString(),
    updated_at: CREATED_AT,
  };
}

function grant(index: number, status: Grant['status']): Grant {
  return {
    id: `grant-${index}`,
    api_id: 'api-1',
    user_id: `user-${index}`,
    access_request_id: `request-${index}`,
    acl_group: 'nexus:api:api-1:approved',
    status,
    granted_by: 'provider-1',
    revoked_by: null,
    revoked_at: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, -index)).toISOString(),
    updated_at: CREATED_AT,
  };
}

// Model the server contract: filter the whole collection before slicing, and
// return detached records so mutations cannot silently update the query cache.
function list<T extends { api_id: string; status: string }>(
  records: T[],
  query: ListQuery & { api_id?: string; status?: string },
): Paginated<T> {
  const matching = records.filter(
    (record) =>
      (!query.api_id || record.api_id === query.api_id) &&
      (!query.status || record.status === query.status),
  );
  const offset = query.offset ?? 0;
  return {
    items: matching.slice(offset, offset + (query.limit ?? 50)).map((record) => ({ ...record })),
    total: matching.length,
  };
}

const clients: QueryClient[] = [];

function renderTab(tab: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>{tab}</ToastProvider>
    </QueryClientProvider>,
  );
}

async function selectStatus(label: string, option: string): Promise<void> {
  fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

async function expectPage(total: number, page: number): Promise<void> {
  const pages = Math.max(1, Math.ceil(total / 50));
  await screen.findByText(`${total} total · Page ${page} of ${pages}`);
  // Cached pages render before their background refresh completes. Wait until
  // navigation is enabled before trying the next interaction.
  if (page < pages) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  } else if (page > 1) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled());
  }
}

function visibleUsers(): string[] {
  return screen.getAllByText(/^user-\d+$/).map((el) => el.textContent!);
}

async function confirm(action: string, userId: string): Promise<void> {
  const row = screen.getByText(userId).closest('li');
  expect(row).not.toBeNull();
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: action }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: action }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('provider access pagination', () => {
  let requests: AccessRequest[];
  let grants: Grant[];

  beforeEach(() => {
    // Radix scrolls the selected option into view; jsdom has no layout engine.
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    requests = [];
    grants = [];
    vi.spyOn(accessRequestsApi, 'list').mockImplementation(async (query = {}) =>
      list(requests, query),
    );
    vi.spyOn(grantsApi, 'list').mockImplementation(async (query = {}) => list(grants, query));
    vi.spyOn(accessRequestsApi, 'approve').mockImplementation(async (id) => {
      const record = requests.find((entry) => entry.id === id)!;
      record.status = 'approved';
      const issued = grant(Number(record.user_id.slice(5)), 'active');
      grants.push(issued);
      return { access_request: { ...record }, grant: { ...issued } };
    });
    vi.spyOn(accessRequestsApi, 'deny').mockImplementation(async (id) => {
      const record = requests.find((entry) => entry.id === id)!;
      record.status = 'denied';
      return { access_request: { ...record } };
    });
    vi.spyOn(grantsApi, 'revoke').mockImplementation(async (id) => {
      const record = grants.find((entry) => entry.id === id)!;
      record.status = 'revoked';
      return { grant: { ...record } };
    });
  });

  afterEach(() => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  it.each(['Approve', 'Deny'] as const)(
    'reaches an old pending request behind 51 decisions and can %s it',
    async (action) => {
      requests = Array.from({ length: 51 }, (_, index) =>
        request(index, index % 2 === 0 ? 'approved' : 'denied'),
      );
      requests.push(request(51, 'pending'));
      renderTab(<RequestsTab apiId="api-1" />);

      await expectPage(1, 1);
      expect(visibleUsers()).toEqual(['user-51']);
      expect(accessRequestsApi.list).toHaveBeenCalledWith({
        api_id: 'api-1',
        limit: 50,
        offset: 0,
        status: 'pending',
      });
      await selectStatus('Request status', 'All');
      await expectPage(52, 1);
      const first = visibleUsers();
      expect(first).toHaveLength(50);
      expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      await expectPage(52, 2);
      expect([...first, ...visibleUsers()]).toEqual(requests.map((entry) => entry.user_id));
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
      await expectPage(52, 1);
      expect(visibleUsers()).toEqual(first);
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      await expectPage(52, 2);
      await confirm(action, 'user-51');
      await expectPage(52, 2);
      await selectStatus('Request status', 'Pending');
      await expectPage(0, 1);
      expect(screen.getByText('No matching access requests')).toBeInTheDocument();
      await selectStatus('Request status', action === 'Approve' ? 'Approved' : 'Denied');
      await expectPage(action === 'Approve' ? 27 : 26, 1);
      expect(visibleUsers()).toContain('user-51');
    },
  );

  it.each(['Approve', 'Deny'] as const)(
    'steps back after %s removes the only pending request on page two',
    async (action) => {
      requests = Array.from({ length: 51 }, (_, index) => request(index, 'pending'));
      renderTab(<RequestsTab apiId="api-1" />);
      await expectPage(51, 1);
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      await expectPage(51, 2);
      await confirm(action, 'user-50');
      await expectPage(50, 1);
      expect(visibleUsers()).toEqual(requests.slice(0, 50).map((entry) => entry.user_id));
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    },
  );

  it('reaches and revokes an old active grant behind 51 revoked grants', async () => {
    grants = Array.from({ length: 51 }, (_, index) => grant(index, 'revoked'));
    grants.push(grant(51, 'active'));
    renderTab(<GrantsTab apiId="api-1" />);
    await expectPage(1, 1);
    expect(visibleUsers()).toEqual(['user-51']);
    expect(grantsApi.list).toHaveBeenCalledWith({
      api_id: 'api-1',
      limit: 50,
      offset: 0,
      status: 'active',
    });
    await selectStatus('Grant status', 'All');
    await expectPage(52, 1);
    const first = visibleUsers();
    expect(first).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await expectPage(52, 2);
    expect([...first, ...visibleUsers()]).toEqual(grants.map((entry) => entry.user_id));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    // Filtering from page two must reset the offset before fetching.
    await selectStatus('Grant status', 'Active');
    await expectPage(1, 1);
    await confirm('Revoke', 'user-51');
    await expectPage(0, 1);
    expect(screen.getByText('No matching grants')).toBeInTheDocument();
    await selectStatus('Grant status', 'Revoked');
    await expectPage(52, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await expectPage(52, 2);
    expect(visibleUsers()).toEqual(['user-50', 'user-51']);
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    await selectStatus('Grant status', 'All');
    await expectPage(52, 1);
  });

  it('steps back after revoking the only active grant on page two', async () => {
    grants = Array.from({ length: 51 }, (_, index) => grant(index, 'active'));
    renderTab(<GrantsTab apiId="api-1" />);
    await expectPage(51, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await expectPage(51, 2);
    await confirm('Revoke', 'user-50');
    await expectPage(50, 1);
    expect(visibleUsers()).toEqual(grants.slice(0, 50).map((entry) => entry.user_id));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});
