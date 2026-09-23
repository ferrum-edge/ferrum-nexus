import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Organization } from '@ferrum-nexus/shared';
import { organizationsApi } from '../../lib/api';
import { AudienceFields, EVERYONE, type AudienceDraft } from './AudienceFields';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('filtered audience organization selector', () => {
  it('searches and selects an organization beyond the first page', async () => {
    const late: Organization = {
      id: 'org-201',
      name: 'Zeta 201',
      description: null,
      created_at: '2026-09-07T12:00:00.000Z',
      updated_at: '2026-09-07T12:00:00.000Z',
    };
    const list = vi.spyOn(organizationsApi, 'list').mockImplementation(async (query = {}) => ({
      items: query.q === late.name ? [late] : [],
      total: query.q === late.name ? 1 : 0,
    }));
    const value: AudienceDraft = { ...EVERYONE, scope: 'filtered' };
    const onChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AudienceFields value={value} onChange={onChange} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Organization' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Organization' }), {
      target: { value: late.name },
    });
    fireEvent.click(await screen.findByRole('option', { name: late.name }));
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: late.name })),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: late.id, orgName: late.name }),
    );
  });
});
