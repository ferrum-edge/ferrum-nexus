import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShowOnceSecret } from '@ferrum-nexus/shared';
import { ShowOnceSecretDialog } from './ShowOnceSecretDialog';

const writeText = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(cleanup);

const BASIC_SECRET: ShowOnceSecret = {
  type: 'basicauth',
  username: 'nexus-user-42',
  password: 'super-secret-value',
};

describe('ShowOnceSecretDialog', () => {
  it('renders every secret field for the credential type', () => {
    render(
      <ShowOnceSecretDialog
        open
        secret={BASIC_SECRET}
        consumerUsername="nexus-user-42"
        onAcknowledge={() => undefined}
      />,
    );

    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByText('Consumer')).toBeInTheDocument();
    expect(screen.getByText('super-secret-value')).toBeInTheDocument();
    // Fields belonging to other credential types are not rendered.
    expect(screen.queryByText('API key')).not.toBeInTheDocument();
    expect(screen.queryByText('JWT signing secret')).not.toBeInTheDocument();
  });

  it('renders key-auth and JWT secrets with their own labels', () => {
    const { unmount } = render(
      <ShowOnceSecretDialog
        open
        secret={{ type: 'keyauth', key: 'k-123' }}
        consumerUsername="nexus-user-42"
        onAcknowledge={() => undefined}
      />,
    );
    expect(screen.getByText('API key')).toBeInTheDocument();
    unmount();

    render(
      <ShowOnceSecretDialog
        open
        secret={{ type: 'jwt', jwt_key: 'iss-1', jwt_secret: 'sig' }}
        consumerUsername="nexus-user-42"
        onAcknowledge={() => undefined}
      />,
    );
    expect(screen.getByText('JWT key id (iss)')).toBeInTheDocument();
    expect(screen.getByText('JWT signing secret')).toBeInTheDocument();
  });

  it('copies a field to the clipboard', async () => {
    render(
      <ShowOnceSecretDialog
        open
        secret={BASIC_SECRET}
        consumerUsername="nexus-user-42"
        onAcknowledge={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy Password' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('super-secret-value'));
  });

  it('cannot be dismissed and only closes after the acknowledgement', () => {
    const onAcknowledge = vi.fn();
    render(
      <ShowOnceSecretDialog
        open
        secret={BASIC_SECRET}
        consumerUsername="nexus-user-42"
        onAcknowledge={onAcknowledge}
      />,
    );

    // No close affordance, and Escape does not dismiss a show-once dialog.
    expect(screen.queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onAcknowledge).not.toHaveBeenCalled();

    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    fireEvent.click(done);
    expect(onAcknowledge).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });
});
