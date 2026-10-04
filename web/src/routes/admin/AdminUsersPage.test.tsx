import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayTeardownState, Organization, User } from '@ferrum-nexus/shared';
import { organizationsApi, usersApi } from '../../lib/api';
import { TooltipProvider } from '../../components/ui/Tooltip';
import { AdminUsersPage } from './AdminUsersPage';

vi.mock('../../components/layout/RoleGuard', () => ({
  RoleGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../stores/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
/** The signed-in administrator; each test may swap it. */
const session = vi.hoisted(() => ({
  user: { id: 'actor-1', role: 'super_admin' } as { id: string; role: string },
}));
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  useAuth: () => ({ user: session.user }),
}));
// Radix Select cannot be driven under jsdom (no layout, no pointer capture).
// Both pickers here are plain value pickers, so stand in native <select>s that
// keep the same props contract and accessible names.
vi.mock('../../components/ui/Select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ui/Select')>();
  function NativeSelect({
    label,
    value,
    onValueChange,
    options,
    'aria-label': ariaLabel,
  }: {
    label?: string;
    value: string;
    onValueChange: (value: never) => void;
    options: ReadonlyArray<{ value: string; label: string }>;
    'aria-label'?: string;
  }): ReactElement {
    return (
      <select
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onValueChange(event.target.value as never)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return { ...actual, Select: NativeSelect, LabeledSelect: NativeSelect };
});

const user: User = {
  id: 'disabled-user',
  email: 'disabled@example.test',
  display_name: 'Disabled user',
  role: 'client',
  org_id: null,
  company: null,
  phone: null,
  status: 'disabled',
  email_verified: true,
  last_login_at: null,
  created_at: '2026-09-07T12:00:00.000Z',
  updated_at: '2026-09-07T12:00:00.000Z',
};

function job(status: GatewayTeardownState['status']): GatewayTeardownState {
  return {
    status,
    attempts: 12,
    next_attempt_at: status === 'done' ? null : '2026-09-07T12:05:00.000Z',
    last_error: status === 'pending' ? 'Gateway unavailable' : null,
    updated_at: '2026-09-07T12:00:00.000Z',
    completed_at: status === 'done' ? '2026-09-07T12:00:00.000Z' : null,
  };
}

function renderUsers(organizations: Organization[] = []): void {
  vi.spyOn(organizationsApi, 'list').mockResolvedValue({
    items: organizations,
    total: organizations.length,
  });
  vi.spyOn(organizationsApi, 'get').mockImplementation(async (id) => {
    const organization = organizations.find((entry) => entry.id === id);
    if (!organization) throw new Error('Organization not found');
    return { organization };
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AdminUsersPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  session.user = { id: 'actor-1', role: 'super_admin' };
});

describe('gateway revocation visibility', () => {
  it.each(['pending', 'sending'] as const)('shows %s jobs with Retry', async (status) => {
    vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [user],
      total: 1,
      pending_gateway_teardowns: 1,
    });
    vi.spyOn(usersApi, 'get').mockResolvedValue({ user, gateway_teardown: job(status) });
    const retry = vi.spyOn(usersApi, 'retryGatewayTeardown').mockResolvedValue({
      gateway_teardown: 'pending',
      job: job('pending'),
    });
    renderUsers();
    expect(
      await screen.findByText(
        status === 'sending' ? 'Gateway revocation in progress' : 'Gateway revocation pending',
      ),
    ).toBeInTheDocument();
    // The tooltip explaining the badge needs a focusable DOM trigger: `Badge`
    // passes none of the trigger's props through, so it never opened.
    const badge = screen.getByText(
      status === 'sending' ? 'Gateway revocation in progress' : 'Gateway revocation pending',
    );
    expect(badge.parentElement).toHaveAttribute('tabindex', '0');
    const button = screen.getByRole('button', { name: 'Retry' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(retry).toHaveBeenCalledWith(user.id));
  });

  it.each([job('done'), null])('hides a completed or absent per-user job', async (teardown) => {
    // Another account can keep the portal-wide backlog non-zero.
    vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [user],
      total: 1,
      pending_gateway_teardowns: 1,
    });
    const detail = vi.spyOn(usersApi, 'get').mockResolvedValue({
      user,
      gateway_teardown: teardown,
    });
    renderUsers();
    await screen.findByText(user.email);
    await waitFor(() => expect(detail).toHaveBeenCalledWith(user.id));
    expect(screen.queryByText(/^Gateway revocation/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('clears the badge and Retry control once the backlog completes', async () => {
    const list = vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [user],
      total: 1,
      pending_gateway_teardowns: 1,
    });
    vi.spyOn(usersApi, 'get').mockResolvedValue({ user, gateway_teardown: job('sending') });
    vi.spyOn(usersApi, 'retryGatewayTeardown').mockImplementation(async () => {
      list.mockResolvedValue({ items: [user], total: 1, pending_gateway_teardowns: 0 });
      return { gateway_teardown: 'ok', job: job('done') };
    });
    renderUsers();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      expect(screen.queryByText(/^Gateway revocation/)).not.toBeInTheDocument();
    });
  });
});

const ACME: Organization = {
  id: 'org-1',
  name: 'Acme',
  description: null,
  created_at: '2026-09-07T12:00:00.000Z',
  updated_at: '2026-09-07T12:00:00.000Z',
};

const GLOBEX: Organization = { ...ACME, id: 'org-2', name: 'Globex' };

const member: User = {
  ...user,
  id: 'member-1',
  email: 'member@example.test',
  display_name: 'Ada Member',
  status: 'active',
  org_id: ACME.id,
};

/**
 * The admin guide's organization procedure is "create an organization, then
 * assign accounts by editing the user's org_id", and its account section
 * promises filters by status and organization. Neither had a control:
 * `org_id` appeared nowhere in this page.
 */
describe('organization and status management', () => {
  const page = { items: [member], total: 1, pending_gateway_teardowns: 0 };

  it('shows the organization each account belongs to', async () => {
    vi.spyOn(usersApi, 'list').mockResolvedValue(page);
    renderUsers([ACME, GLOBEX]);
    // The organization filter also lists "Acme" as an option; the directory
    // row is the non-option rendering.
    const acme = await screen.findAllByText('Acme');
    expect(acme.some((element) => element.tagName !== 'OPTION')).toBe(true);
  });

  it('filters the directory by organization and by status', async () => {
    const list = vi.spyOn(usersApi, 'list').mockResolvedValue(page);
    renderUsers([ACME, GLOBEX]);
    await screen.findByText(member.email);

    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: { value: 'disabled' },
    });
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ status: 'disabled' })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Filter by organization' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Filter by organization' }), {
      target: { value: GLOBEX.name },
    });
    fireEvent.click(await screen.findByRole('option', { name: GLOBEX.name }));
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ org_id: GLOBEX.id })),
    );
  });

  it('assigns an account to another organization and renames it', async () => {
    const actor = userEvent.setup();
    vi.spyOn(usersApi, 'list').mockResolvedValue(page);
    const update = vi.spyOn(usersApi, 'update').mockResolvedValue({ user: member });
    renderUsers([ACME, GLOBEX]);

    await actor.click(await screen.findByRole('button', { name: 'Edit Ada Member' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit Ada Member' }));
    await waitFor(() =>
      expect(dialog.getByRole('button', { name: 'Organization' })).toHaveTextContent(ACME.name),
    );
    fireEvent.change(dialog.getByLabelText(/^Display name/), { target: { value: 'Ada Lovelace' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Organization' }));
    fireEvent.change(dialog.getByRole('searchbox', { name: 'Search Organization' }), {
      target: { value: GLOBEX.name },
    });
    fireEvent.click(await dialog.findByRole('option', { name: GLOBEX.name }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(member.id, {
        display_name: 'Ada Lovelace',
        org_id: GLOBEX.id,
      }),
    );
  });

  it('clears an organization from an account', async () => {
    const actor = userEvent.setup();
    vi.spyOn(usersApi, 'list').mockResolvedValue(page);
    const update = vi.spyOn(usersApi, 'update').mockResolvedValue({ user: member });
    renderUsers([ACME, GLOBEX]);

    await actor.click(await screen.findByRole('button', { name: 'Edit Ada Member' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit Ada Member' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Organization' }));
    fireEvent.click(await dialog.findByRole('option', { name: 'No organization' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(member.id, {
        display_name: member.display_name,
        org_id: null,
      }),
    );
  });

  it('searches beyond the first organization page and resolves an out-of-page org id', async () => {
    const actor = userEvent.setup();
    const late = { ...GLOBEX, id: 'org-201', name: 'Zeta 201' };
    const assigned = { ...member, org_id: late.id };
    vi.spyOn(usersApi, 'list').mockResolvedValue({ ...page, items: [assigned] });
    const update = vi.spyOn(usersApi, 'update').mockResolvedValue({ user: assigned });
    renderUsers([late]);
    const listOrganizations = vi
      .spyOn(organizationsApi, 'list')
      .mockImplementation(async (query = {}) => ({
        items: query.q === 'Zeta 201' ? [late] : [],
        total: query.q === 'Zeta 201' ? 1 : 0,
      }));
    expect(await screen.findByText(late.name)).toBeInTheDocument();
    await waitFor(() => expect(organizationsApi.get).toHaveBeenCalledWith(late.id));

    fireEvent.click(screen.getByRole('button', { name: 'Filter by organization' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Filter by organization' }), {
      target: { value: late.name },
    });
    fireEvent.click(await screen.findByRole('option', { name: late.name }));
    await waitFor(() =>
      expect(usersApi.list).toHaveBeenCalledWith(expect.objectContaining({ org_id: late.id })),
    );
    expect(listOrganizations).toHaveBeenCalledWith(expect.objectContaining({ q: late.name }));

    await actor.click(await screen.findByRole('button', { name: 'Edit Ada Member' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit Ada Member' }));
    expect(dialog.getByRole('button', { name: 'Organization' })).toHaveTextContent(late.name);
    fireEvent.click(dialog.getByRole('button', { name: 'Organization' }));
    fireEvent.change(dialog.getByRole('searchbox', { name: 'Search Organization' }), {
      target: { value: late.name },
    });
    fireEvent.click(await dialog.findByRole('option', { name: late.name }));
    expect(dialog.getByRole('button', { name: 'Organization' })).toHaveTextContent(late.name);
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(assigned.id, {
        display_name: assigned.display_name,
        org_id: late.id,
      }),
    );
  });
});

/**
 * The role column showed a badge *and* a select naming the same role. It now
 * shows one control: the select where the change can succeed, and the badge
 * alone where the server would refuse it.
 */
describe('role and status controls', () => {
  const founder: User = {
    ...member,
    id: 'actor-1',
    email: 'root@example.test',
    display_name: 'Riley Root',
    role: 'super_admin',
    org_id: null,
  };
  const admin: User = {
    ...member,
    id: 'admin-2',
    email: 'admin@example.test',
    display_name: 'Ari Admin',
    role: 'admin',
    org_id: null,
  };
  const client: User = { ...member, org_id: null };

  /** Rendered text outside the native `<option>`s the select mock renders. */
  const visible = (text: string): HTMLElement[] =>
    screen.queryAllByText(text).filter((element) => element.tagName !== 'OPTION');

  it('shows a changeable role as a select only, without a duplicate badge', async () => {
    vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [client],
      total: 1,
      pending_gateway_teardowns: 0,
    });
    renderUsers();
    const select = await screen.findByLabelText('Change role for Ada Member');
    expect(select).toHaveValue('client');
    expect(visible('Client')).toHaveLength(0);
  });

  it('shows the last active super admin as a badge, and offers no disable', async () => {
    const list = vi
      .spyOn(usersApi, 'list')
      .mockImplementation(async (query = {}) =>
        query.role === 'super_admin'
          ? { items: [founder], total: 1, pending_gateway_teardowns: 0 }
          : { items: [founder, client], total: 2, pending_gateway_teardowns: 0 },
      );
    renderUsers();
    await waitFor(() => expect(visible('Super Admin')).toHaveLength(1));
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'super_admin', status: 'active' }),
    );
    expect(screen.queryByLabelText('Change role for Riley Root')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Change role for Ada Member')).toBeInTheDocument();

    const [own, other] = screen.getAllByRole('button', { name: 'Disable' });
    expect(own).toBeDisabled();
    expect(own).toHaveAttribute('title', 'The last active super admin cannot be disabled.');
    expect(other).toBeEnabled();
  });

  it('keeps a super admin changeable while another one is active', async () => {
    const second: User = { ...founder, id: 'super-2', display_name: 'Sam Super' };
    vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [founder, second],
      total: 2,
      pending_gateway_teardowns: 0,
    });
    renderUsers();
    expect(await screen.findByLabelText('Change role for Sam Super')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Change role for Riley Root')).toBeInTheDocument(),
    );
    // Still not your own account, though.
    const [own, other] = screen.getAllByRole('button', { name: 'Disable' });
    expect(own).toHaveAttribute('title', 'You cannot disable your own account.');
    expect(other).toBeEnabled();
  });

  it('offers a plain admin only the roles it may assign, and locks administrators', async () => {
    session.user = { id: 'admin-9', role: 'admin' };
    vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [admin, client],
      total: 2,
      pending_gateway_teardowns: 0,
    });
    renderUsers();
    const select = await screen.findByLabelText('Change role for Ada Member');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Client', 'Provider']);
    expect(screen.queryByLabelText('Change role for Ari Admin')).not.toBeInTheDocument();
    expect(visible('Admin')).toHaveLength(1);
    const [adminRow, clientRow] = screen.getAllByRole('button', { name: 'Disable' });
    expect(adminRow).toBeDisabled();
    expect(adminRow).toHaveAttribute(
      'title',
      'Only a super admin can disable or re-enable an administrator.',
    );
    expect(clientRow).toBeEnabled();
  });

  it('labels every filter for assistive technology, and none visibly', async () => {
    vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [client],
      total: 1,
      pending_gateway_teardowns: 0,
    });
    renderUsers();
    await screen.findByText(client.email);
    expect(screen.getByRole('searchbox', { name: 'Search users' })).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by role')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter by organization' })).toBeInTheDocument();
    expect(screen.getByText('Filter by organization', { selector: 'label' })).toHaveClass(
      'sr-only',
    );
  });
});

describe('squatted address recovery', () => {
  it('requires reviewed link removal before releasing the disabled account address', async () => {
    const released: User = {
      ...user,
      email: 'released-1@released.nexus.invalid',
      email_verified: false,
    };
    const list = vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [user],
      total: 1,
      pending_gateway_teardowns: 0,
    });
    vi.spyOn(usersApi, 'get').mockResolvedValue({ user, gateway_teardown: job('done') });
    const identities = vi.spyOn(usersApi, 'identities').mockResolvedValue({
      items: [
        {
          id: 'identity-1',
          user_id: user.id,
          provider_id: 'partner',
          issuer: 'https://partner.example.test',
          subject: 'old-subject',
          provisioned: true,
          email: user.email,
          last_login_at: null,
          created_at: user.created_at,
          updated_at: user.updated_at,
        },
      ],
    });
    const unlink = vi.spyOn(usersApi, 'unlinkIdentity').mockImplementation(async () => {
      identities.mockResolvedValue({ items: [] });
      return { ok: true };
    });
    const release = vi.spyOn(usersApi, 'releaseAddress').mockImplementation(async () => {
      list.mockResolvedValue({ items: [released], total: 1, pending_gateway_teardowns: 0 });
      return { user: released };
    });
    renderUsers();
    await userEvent.click(await screen.findByRole('button', { name: 'Release address' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release email address' });
    const submit = within(dialog).getByRole('button', { name: 'Release address' });
    expect(submit).toBeDisabled();
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(unlink).toHaveBeenCalledWith(user.id, 'identity-1'));
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    await waitFor(() => expect(release).toHaveBeenCalledWith(user.id, { email: user.email }));
    expect(await screen.findByText(released.email)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Release address' })).not.toBeInTheDocument();
  });

  it('keeps release unavailable when recovery reads fail', async () => {
    vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [user],
      total: 1,
      pending_gateway_teardowns: 0,
    });
    vi.spyOn(usersApi, 'get').mockResolvedValue({ user, gateway_teardown: job('done') });
    vi.spyOn(usersApi, 'identities').mockRejectedValue(new Error('Unavailable'));
    const release = vi.spyOn(usersApi, 'releaseAddress');
    renderUsers();
    await userEvent.click(await screen.findByRole('button', { name: 'Release address' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release email address' });
    expect(await within(dialog).findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Release address' })).toBeDisabled();
    expect(release).not.toHaveBeenCalled();
  });

  it('shows the release operation only to super admins', async () => {
    session.user = { id: 'plain-admin', role: 'admin' };
    vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [user],
      total: 1,
      pending_gateway_teardowns: 0,
    });
    renderUsers();
    await screen.findByText(user.email);
    expect(screen.queryByRole('button', { name: 'Release address' })).not.toBeInTheDocument();
  });
});
