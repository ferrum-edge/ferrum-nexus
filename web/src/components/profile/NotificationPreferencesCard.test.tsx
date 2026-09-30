import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPreferences } from '@ferrum-nexus/shared';
import { clearClients, renderPage } from '../../../test/helpers';
import { usersApi } from '../../lib/api';
import { NotificationPreferencesCard } from './NotificationPreferencesCard';

const IN_APP = 'Notify me in the portal when an API I use changes its specification';
const EMAIL = 'Email me when an API I use changes its specification';

let stored: NotificationPreferences;

beforeEach(() => {
  stored = { api_spec_updated_in_app: true, api_spec_updated_email: true };
  vi.spyOn(usersApi, 'notificationPreferences').mockImplementation(async () => ({
    preferences: stored,
  }));
  vi.spyOn(usersApi, 'updateNotificationPreferences').mockImplementation(async (body) => {
    stored = { ...stored, ...body };
    return { preferences: stored };
  });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

describe('notification preferences (issue #447)', () => {
  it('starts with both channels on and saves one change at a time', async () => {
    renderPage(<NotificationPreferencesCard />);
    const email = await screen.findByLabelText(EMAIL);
    expect(email).toBeChecked();
    expect(screen.getByLabelText(IN_APP)).toBeChecked();

    fireEvent.click(email);
    await waitFor(() => expect(screen.getByLabelText(EMAIL)).not.toBeChecked());
    expect(usersApi.updateNotificationPreferences).toHaveBeenCalledWith({
      api_spec_updated_email: false,
    });
    expect(screen.getByLabelText(IN_APP)).toBeChecked();
    expect(await screen.findByText('Notification preferences saved')).toBeInTheDocument();
  });

  it('shows a stored opt-out', async () => {
    stored = { api_spec_updated_in_app: false, api_spec_updated_email: true };
    renderPage(<NotificationPreferencesCard />);
    expect(await screen.findByLabelText(IN_APP)).not.toBeChecked();
    expect(screen.getByLabelText(EMAIL)).toBeChecked();
  });

  it('says when the preferences cannot be loaded', async () => {
    vi.mocked(usersApi.notificationPreferences).mockRejectedValue(new Error('Unavailable'));
    renderPage(<NotificationPreferencesCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  });
});
