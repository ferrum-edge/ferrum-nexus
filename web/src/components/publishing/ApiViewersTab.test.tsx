import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api, ApiViewer } from '@ferrum-nexus/shared';
import { API } from '../../../test/fixtures';
import { changeField, clearClients, deferred, renderPage } from '../../../test/helpers';
import { apisApi } from '../../lib/api';
import { ApiViewersTab } from './ApiViewersTab';

/**
 * The tab has one job beyond CRUD: never letting a provider believe that
 * authorizing a viewer let them call the API (issue #288).
 */

const VIEWER: ApiViewer = {
  id: 'viewer-1',
  api_id: API.id,
  user_id: 'user-partner',
  user: {
    id: 'user-partner',
    email: 'partner@example.test',
    display_name: 'Partner Inc',
    role: 'client',
  },
  granted_by: API.owner_user_id,
  note: 'Design partner',
  created_at: API.created_at,
  updated_at: API.created_at,
};

let api: Api;

beforeEach(() => {
  api = { ...API, visibility: 'private' };
  vi.spyOn(apisApi, 'viewers').mockResolvedValue({ items: [VIEWER], total: 1 });
  vi.spyOn(apisApi, 'authorizeViewer').mockResolvedValue({ viewer: VIEWER });
  vi.spyOn(apisApi, 'revokeViewer').mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

describe('private API viewers', () => {
  it('lists authorized viewers and says what the authorization is not', async () => {
    await renderPage(<ApiViewersTab api={api} />);
    expect(await screen.findByText('Partner Inc')).toBeInTheDocument();
    expect(screen.getByText('partner@example.test')).toBeInTheDocument();
    expect(screen.getByText('Docs only')).toBeInTheDocument();
    // The sentence is broken by the emphasised "not", so match the fragment
    // that lives in one text node.
    expect(screen.getByText(/let them call it/)).toBeInTheDocument();
  });

  it('authorizes by email address', async () => {
    await renderPage(<ApiViewersTab api={api} />);
    await screen.findByText('Partner Inc');
    changeField('Email address', '  new-partner@example.test  ');
    changeField('Note (optional)', 'Second partner');
    fireEvent.click(screen.getByRole('button', { name: /Authorize/ }));
    await screen.findByText('Viewer authorized');
    expect(apisApi.authorizeViewer).toHaveBeenCalledWith(API.id, {
      email: 'new-partner@example.test',
      note: 'Second partner',
    });
  });

  it('surfaces the refusal when the address has no account', async () => {
    vi.mocked(apisApi.authorizeViewer).mockRejectedValue(
      new Error('No portal account uses that email address. Ask them to register first'),
    );
    await renderPage(<ApiViewersTab api={api} />);
    await screen.findByText('Partner Inc');
    changeField('Email address', 'nobody@example.test');
    fireEvent.click(screen.getByRole('button', { name: /Authorize/ }));
    expect(await screen.findByText(/register first/)).toBeInTheDocument();
  });

  it('says a revoke leaves the account’s grant alone', async () => {
    await renderPage(<ApiViewersTab api={api} />);
    await screen.findByText('Partner Inc');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke documentation access' });
    expect(within(dialog).getByText(/access grant they hold is left alone/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await screen.findByText('Documentation access revoked');
    expect(apisApi.revokeViewer).toHaveBeenCalledWith(API.id, 'user-partner');
  });

  it('steps back a page when a revocation empties the last one (issue #596)', async () => {
    let viewers: ApiViewer[] = Array.from({ length: 21 }, (_, index) => ({
      ...VIEWER,
      id: `viewer-${index}`,
      user_id: `user-${index}`,
      user: { ...VIEWER.user!, id: `user-${index}`, email: `viewer-${index}@example.test` },
    }));
    vi.mocked(apisApi.viewers).mockImplementation(async (_id, query = {}) => {
      const offset = query.offset ?? 0;
      return { items: viewers.slice(offset, offset + (query.limit ?? 20)), total: viewers.length };
    });
    vi.mocked(apisApi.revokeViewer).mockImplementation(async (_id, userId) => {
      viewers = viewers.filter((viewer) => viewer.user_id !== userId);
      return { ok: true };
    });
    await renderPage(<ApiViewersTab api={api} />);
    await screen.findByText('viewer-0@example.test');
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('viewer-20@example.test');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke documentation access' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await screen.findByText('Documentation access revoked');

    // The 20 remaining viewers are shown again, not an empty page.
    expect(await screen.findByText('viewer-0@example.test')).toBeInTheDocument();
    expect(screen.getByText('viewer-19@example.test')).toBeInTheDocument();
    expect(screen.queryByText('Nobody is authorized yet')).not.toBeInTheDocument();
    expect(apisApi.viewers).toHaveBeenLastCalledWith(API.id, { limit: 20, offset: 0 });
  });

  it('does not clamp on a stale cached total while the page refetches', async () => {
    const viewerAt = (index: number): ApiViewer => ({
      ...VIEWER,
      id: `viewer-${index}`,
      user_id: `user-${index}`,
      user: { ...VIEWER.user!, id: `user-${index}`, email: `viewer-${index}@example.test` },
    });
    let viewers: ApiViewer[] = Array.from({ length: 21 }, (_, index) => viewerAt(index));
    let held: ReturnType<typeof deferred<void>> | null = null;
    vi.mocked(apisApi.viewers).mockImplementation(async (_id, query = {}) => {
      const offset = query.offset ?? 0;
      if (offset > 0 && held) await held.promise;
      return { items: viewers.slice(offset, offset + (query.limit ?? 20)), total: viewers.length };
    });
    vi.mocked(apisApi.revokeViewer).mockImplementation(async (_id, userId) => {
      viewers = viewers.filter((viewer) => viewer.user_id !== userId);
      return { ok: true };
    });
    vi.mocked(apisApi.authorizeViewer).mockImplementation(async () => {
      const added = viewerAt(99);
      viewers = [...viewers, added];
      return { viewer: added };
    });
    await renderPage(<ApiViewersTab api={api} />);
    await screen.findByText('viewer-0@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('viewer-20@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke documentation access' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await screen.findByText('Documentation access revoked');
    await screen.findByText('viewer-0@example.test');

    // Back to 21: page 2's cache still says 20 until its refetch answers.
    changeField('Email address', 'viewer-99@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await screen.findByText('Viewer authorized');
    expect(await screen.findByText(/Page 1 of 2/)).toBeInTheDocument();
    held = deferred<void>();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(apisApi.viewers).toHaveBeenLastCalledWith(API.id, { limit: 20, offset: 20 }),
    );
    await act(async () => {
      held?.resolve();
    });
    expect(await screen.findByText('viewer-99@example.test')).toBeInTheDocument();
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();
  });

  it('keeps paging when the last page empties and several pages remain', async () => {
    let viewers: ApiViewer[] = Array.from({ length: 41 }, (_, index) => ({
      ...VIEWER,
      id: `viewer-${index}`,
      user_id: `user-${index}`,
      user: { ...VIEWER.user!, id: `user-${index}`, email: `viewer-${index}@example.test` },
    }));
    vi.mocked(apisApi.viewers).mockImplementation(async (_id, query = {}) => {
      const offset = query.offset ?? 0;
      return { items: viewers.slice(offset, offset + (query.limit ?? 20)), total: viewers.length };
    });
    vi.mocked(apisApi.revokeViewer).mockImplementation(async (_id, userId) => {
      viewers = viewers.filter((viewer) => viewer.user_id !== userId);
      return { ok: true };
    });
    await renderPage(<ApiViewersTab api={api} />);
    await screen.findByText('viewer-0@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('viewer-20@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('viewer-40@example.test');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke documentation access' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await screen.findByText('Documentation access revoked');

    expect(await screen.findByText('viewer-20@example.test')).toBeInTheDocument();
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
  });

  it('warns that the list enforces nothing while the API is unlisted', async () => {
    await renderPage(<ApiViewersTab api={{ ...API, visibility: 'internal' }} />);
    await waitFor(() => expect(screen.getByText(/Unlisted is not private/)).toBeInTheDocument());
  });

  it('says nothing of the sort once the API is private', async () => {
    await renderPage(<ApiViewersTab api={api} />);
    await screen.findByText('Partner Inc');
    expect(screen.queryByText(/Unlisted is not private/)).not.toBeInTheDocument();
  });
});
