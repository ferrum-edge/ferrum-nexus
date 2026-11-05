import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearClients, renderPage } from '../../../../test/helpers';
import { adminApi } from '../../../lib/api';
import { SsoTab } from './SsoTab';

vi.mock('../../../stores/auth', () => ({ useAuth: () => ({ canSuperAdmin: true }) }));

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

describe('<SsoTab>', () => {
  it('reports a failed first load with a retry instead of spinning forever', async () => {
    vi.spyOn(adminApi, 'getSso').mockRejectedValue(new Error('Bad gateway'));
    renderPage(<SsoTab />);

    expect(await screen.findByText('Single sign-on settings unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Loading single sign-on')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(adminApi.getSso).toHaveBeenCalledTimes(2));
  });
});
