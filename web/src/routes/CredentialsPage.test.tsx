import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type CredentialMetadata,
  type IssueCredentialResponse,
  type ShowOnceSecret,
} from '@ferrum-nexus/shared';
import { API, CREDENTIAL, GRANT } from '../../test/fixtures';
import { changeField, clearClients, deferred, renderPage } from '../../test/helpers';
import { queryKeys } from '../hooks/keys';
import { credentialsApi, grantsApi } from '../lib/api';
import { CredentialsPage } from './CredentialsPage';

vi.mock('../components/ui/Select', async () => {
  const { NativeLabeledSelect } = await import('../../test/helpers');
  return { LabeledSelect: NativeLabeledSelect };
});

let credentials: CredentialMetadata[];

beforeEach(() => {
  credentials = [];
  vi.spyOn(credentialsApi, 'list').mockImplementation(async (query = {}) => ({
    items: credentials.slice(query.offset ?? 0, (query.offset ?? 0) + DEFAULT_PAGE_SIZE),
    total: credentials.length,
  }));
  vi.spyOn(grantsApi, 'list').mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(credentialsApi, 'issue').mockImplementation(async (body) => {
    const credential = {
      ...CREDENTIAL,
      credential_type: body.credential_type,
      label: body.label ?? null,
    };
    credentials = [credential];
    const secrets: Record<CredentialMetadata['credential_type'], ShowOnceSecret> = {
      keyauth: { type: 'keyauth', key: 'test-only-issued-key-0001' },
      basicauth: {
        type: 'basicauth',
        username: 'nexus-user-user-1',
        password: 'test-only-issued-password-0001',
      },
      jwt: {
        type: 'jwt',
        jwt_key: 'nexus-user-user-1',
        jwt_secret: 'test-only-issued-signing-secret-0001',
      },
    };
    return {
      credential,
      consumer_username: 'nexus-user-user-1',
      secret: secrets[body.credential_type],
    };
  });
  vi.spyOn(credentialsApi, 'rotate').mockImplementation(async () => {
    const credential = {
      ...CREDENTIAL,
      id: 'credential-2',
      last4: '0002',
      rotated_from_id: CREDENTIAL.id,
      edge_ordinal: 1,
    };
    credentials = [credential];
    return {
      credential,
      previous: { ...CREDENTIAL, status: 'revoked' },
      consumer_username: 'nexus-user-user-1',
      secret: { type: 'keyauth', key: 'test-only-rotated-key-0002' },
    };
  });
  vi.spyOn(credentialsApi, 'remove').mockImplementation(async () => {
    credentials = [];
    return { ok: true };
  });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

function openIssue(): void {
  fireEvent.click(screen.getAllByRole('button', { name: 'Issue credential' })[0]!);
}

function acknowledge(): void {
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /I have saved these values/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
}

describe('credential management', () => {
  it.each([
    ['keyauth', 'API key', 'test-only-issued-key-0001'],
    ['basicauth', 'Password', 'test-only-issued-password-0001'],
    ['jwt', 'JWT signing secret', 'test-only-issued-signing-secret-0001'],
  ] as const)('shows each %s secret once', async (type, label, secret) => {
    const { client, unmount } = renderPage(<CredentialsPage />);
    await screen.findByText('No credentials yet');
    openIssue();
    changeField('Credential type', type);
    changeField('Label', '  Production worker  ');
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save your new credential' });
    expect(credentialsApi.issue).toHaveBeenCalledWith({
      credential_type: type,
      label: 'Production worker',
      // The identity defaults to the account itself, which is what every
      // credential issued before applications existed uses (issue #289).
      application_id: null,
    });
    expect(within(dialog).getByText(label, { exact: true })).toBeInTheDocument();
    expect(within(dialog).getByText(secret)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(dialog).toBeInTheDocument();
    acknowledge();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(await screen.findByText('••••0001')).toBeInTheDocument();
    const cached = client.getQueryData(
      queryKeys.credentials.list({ limit: DEFAULT_PAGE_SIZE, offset: 0 }),
    );
    expect(cached).toEqual({ items: credentials, total: 1 });
    expect(JSON.stringify(cached)).not.toContain(secret);
    openIssue();
    expect(screen.getByLabelText('Label')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    unmount();
    renderPage(<CredentialsPage />);
    await screen.findByText('••••0001');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });

  it('prevents duplicate issuance while waiting and uses null for a blank label', async () => {
    const pending = deferred<IssueCredentialResponse>();
    vi.mocked(credentialsApi.issue).mockImplementationOnce(() => pending.promise);
    renderPage(<CredentialsPage />);
    await screen.findByText('No credentials yet');
    openIssue();
    changeField('Label', '   ');
    const issue = screen.getByRole('button', { name: 'Issue' });
    fireEvent.click(issue);
    await waitFor(() => expect(credentialsApi.issue).toHaveBeenCalledTimes(1));
    expect(issue).toBeDisabled();
    fireEvent.click(issue);
    expect(credentialsApi.issue).toHaveBeenCalledTimes(1);
    expect(credentialsApi.issue).toHaveBeenCalledWith({
      credential_type: 'keyauth',
      label: null,
      application_id: null,
    });
    await act(async () => {
      pending.resolve({
        credential: CREDENTIAL,
        consumer_username: 'nexus-user-user-1',
        secret: { type: 'keyauth', key: 'test-only-pending-key' },
      });
    });
    expect(await screen.findByText('test-only-pending-key')).toBeInTheDocument();
  });

  it('retains the issue form after a failure without presenting a show-once secret', async () => {
    vi.mocked(credentialsApi.issue).mockRejectedValueOnce(new Error('Gateway unavailable'));
    renderPage(<CredentialsPage />);
    await screen.findByText('No credentials yet');
    openIssue();
    changeField('Label', 'Retry this credential');
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    await waitFor(() => expect(credentialsApi.issue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Issue' })).toBeEnabled());
    expect(screen.getByLabelText('Label')).toHaveValue('Retry this credential');
    expect(screen.queryByText('Save your new credential')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    await screen.findByRole('dialog', { name: 'Save your new credential' });
  });

  it('explains that rotation revokes the old secret as part of the operation', async () => {
    credentials = [CREDENTIAL];
    renderPage(<CredentialsPage />);
    expect(
      await screen.findByText(/revokes the previous value as part of the same operation/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/window to switch over/)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rotate credential' });
    expect(within(dialog).getByText(/revoked as part of this operation/)).toBeInTheDocument();
    expect(
      within(dialog).queryByText(/keeps working until the rotation is finalized/),
    ).not.toBeInTheDocument();
  });

  it('requires a fresh acknowledgement for rotation', async () => {
    renderPage(<CredentialsPage />);
    await screen.findByText('No credentials yet');
    openIssue();
    changeField('Label', CREDENTIAL.label!);
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    await screen.findByRole('dialog', { name: 'Save your new credential' });
    acknowledge();
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
    let dialog = await screen.findByRole('dialog', { name: 'Rotate credential' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(credentialsApi.rotate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    dialog = await screen.findByRole('dialog', { name: 'Rotate credential' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate' }));
    await screen.findByRole('dialog', { name: 'Save your rotated credential' });
    expect(credentialsApi.rotate).toHaveBeenCalledWith(CREDENTIAL.id, { label: CREDENTIAL.label });
    expect(screen.getByText('test-only-rotated-key-0002')).toBeInTheDocument();
    expect(screen.queryByText('test-only-issued-key-0001')).not.toBeInTheDocument();
    acknowledge();
    await screen.findByText('••••0002');
    expect(screen.queryByText('test-only-rotated-key-0002')).not.toBeInTheDocument();
  });

  it('confirms revocation and refreshes the list after success', async () => {
    credentials = [CREDENTIAL];
    renderPage(<CredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/401 responses immediately/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(credentialsApi.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await screen.findByText('Credential revoked');
    await screen.findByText('No credentials yet');
    expect(credentialsApi.remove).toHaveBeenCalledWith(CREDENTIAL.id);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['Rotate', 'Revoke'] as const)('keeps a failed %s open for retry', async (action) => {
    credentials = [CREDENTIAL];
    vi.mocked(credentialsApi.rotate).mockRejectedValue(new Error('Gateway unavailable'));
    vi.mocked(credentialsApi.remove).mockRejectedValue(new Error('Gateway unavailable'));
    renderPage(<CredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: action }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: action }));
    const mutation = action === 'Rotate' ? credentialsApi.rotate : credentialsApi.remove;
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: action })).toBeEnabled());
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByText('Save your rotated credential')).not.toBeInTheDocument();
    expect(screen.queryByText('Credential revoked')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('••••0001')).toBeInTheDocument();
  });

  it('paginates metadata and explains missing gateway addresses', async () => {
    credentials = Array.from({ length: DEFAULT_PAGE_SIZE + 1 }, (_, index) => ({
      ...CREDENTIAL,
      id: `credential-${index}`,
      label: index === DEFAULT_PAGE_SIZE ? null : `Worker ${index}`,
      last4: String(index).padStart(4, '0'),
    }));
    vi.mocked(grantsApi.list).mockResolvedValue({
      items: [
        GRANT,
        { ...GRANT, id: 'grant-2', api: { ...API, name: 'Offline API', invoke_url: null } },
        { ...GRANT, id: 'grant-3', api_id: 'api-without-details', api: undefined },
      ],
      total: 3,
    });
    renderPage(<CredentialsPage />);
    await screen.findByText('Worker 0');
    expect(await screen.findByText('Your API access')).toBeInTheDocument();
    expect(grantsApi.list).toHaveBeenCalledWith({
      mine: true,
      status: 'active',
      limit: MAX_PAGE_SIZE,
    });
    expect(screen.getByText(API.invoke_url!)).toBeInTheDocument();
    expect(screen.getByText(/Gateway address not published/)).toBeInTheDocument();
    expect(screen.getByText('api-without-details')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(`••••${String(DEFAULT_PAGE_SIZE).padStart(4, '0')}`);
    expect(credentialsApi.list).toHaveBeenLastCalledWith({
      limit: DEFAULT_PAGE_SIZE,
      offset: DEFAULT_PAGE_SIZE,
    });
    expect(screen.queryByText('Worker 0')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('Worker 0')).toBeInTheDocument();
  });
});
