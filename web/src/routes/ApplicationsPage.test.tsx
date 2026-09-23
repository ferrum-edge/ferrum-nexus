import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAGE_SIZE, type Application } from '@ferrum-nexus/shared';
import { API } from '../../test/fixtures';
import { changeField, clearClients, renderPage } from '../../test/helpers';
import { applicationsApi } from '../lib/api';
import { ApplicationsPage } from './ApplicationsPage';

/**
 * The page's job beyond CRUD is to keep "identity" and "label" apart, and to
 * keep "disable" and "delete" apart (issue #289).
 */

vi.mock('../stores/auth', () => ({ useAuth: () => ({ hasRole: () => true }) }));

const APPLICATION: Application = {
  id: 'app-1',
  owner_user_id: API.owner_user_id,
  name: 'Billing worker',
  description: 'Invoicing integration',
  status: 'active',
  active_grants: 2,
  active_credentials: 1,
  created_at: API.created_at,
  updated_at: API.created_at,
};

beforeEach(() => {
  vi.spyOn(applicationsApi, 'list').mockResolvedValue({ items: [APPLICATION], total: 1 });
  vi.spyOn(applicationsApi, 'create').mockResolvedValue({ application: APPLICATION });
  vi.spyOn(applicationsApi, 'update').mockResolvedValue({
    application: { ...APPLICATION, status: 'disabled' },
  });
  vi.spyOn(applicationsApi, 'remove').mockResolvedValue({
    revoked_grants: 2,
    revoked_credentials: 1,
  });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

describe('applications', () => {
  it('lists them with their approved APIs and credentials', async () => {
    await renderPage(<ApplicationsPage />);
    expect(await screen.findByText('Billing worker')).toBeInTheDocument();
    expect(screen.getByText('Invoicing integration')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    // The distinction the page exists to make.
    expect(screen.getByText(/separate identity/)).toBeInTheDocument();
  });

  it('creates one', async () => {
    await renderPage(<ApplicationsPage />);
    await screen.findByText('Billing worker');
    fireEvent.click(screen.getByRole('button', { name: /New application/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New application' });
    changeField('Name', '  Mobile app  ');
    changeField('Description', 'iOS client');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await screen.findByText('Application created');
    expect(applicationsApi.create).toHaveBeenCalledWith({
      name: 'Mobile app',
      description: 'iOS client',
    });
  });

  it('says a disable revokes nothing', async () => {
    await renderPage(<ApplicationsPage />);
    await screen.findByText('Billing worker');
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await screen.findByText('Application disabled');
    expect(applicationsApi.update).toHaveBeenCalledWith('app-1', { status: 'disabled' });
    expect(screen.getByText(/Existing credentials keep working/)).toBeInTheDocument();
  });

  it('says a delete stops the credentials, and confirms by name', async () => {
    await renderPage(<ApplicationsPage />);
    await screen.findByText('Billing worker');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this application' });
    expect(within(dialog).getByText(/stop working immediately/)).toBeInTheDocument();

    const confirm = within(dialog).getByRole('button', { name: 'Delete application' });
    expect(confirm).toBeDisabled();
    changeField(/Type/, 'Billing worker');
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await screen.findByText('Application deleted');
    expect(applicationsApi.remove).toHaveBeenCalledWith('app-1');
  });

  it('pages through every application so each can be managed', async () => {
    // An owner's ceiling can exceed one page, or be unlimited (issue #310).
    const many = Array.from({ length: DEFAULT_PAGE_SIZE + 1 }, (_, index) => ({
      ...APPLICATION,
      id: `app-${index}`,
      name: `Integration ${index}`,
    }));
    vi.mocked(applicationsApi.list).mockImplementation(async (query = {}) => {
      const offset = query.offset ?? 0;
      return {
        items: many.slice(offset, offset + (query.limit ?? DEFAULT_PAGE_SIZE)),
        total: many.length,
      };
    });
    await renderPage(<ApplicationsPage />);
    expect(await screen.findByText('Integration 0')).toBeInTheDocument();
    expect(applicationsApi.list).toHaveBeenCalledWith({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
    expect(screen.queryByText(`Integration ${DEFAULT_PAGE_SIZE}`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText(`Integration ${DEFAULT_PAGE_SIZE}`)).toBeInTheDocument();
    expect(applicationsApi.list).toHaveBeenLastCalledWith({
      limit: DEFAULT_PAGE_SIZE,
      offset: DEFAULT_PAGE_SIZE,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this application' });
    changeField(/Type/, `Integration ${DEFAULT_PAGE_SIZE}`);
    const confirm = within(dialog).getByRole('button', { name: 'Delete application' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await screen.findByText('Application deleted');
    expect(applicationsApi.remove).toHaveBeenCalledWith(`app-${DEFAULT_PAGE_SIZE}`);
  });
});
