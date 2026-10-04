import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_JUSTIFICATION_LENGTH,
  consumerUsernameForApplication,
  consumerUsernameForUser,
  emptySpecChangeReport,
  type AccessRequest,
  type ApiSpecChangeEntry,
  type Application,
  type ApplicationSummary,
  type CatalogDetailResponse,
  type CatalogIdentityAccessResponse,
  type CatalogListResponse,
  type CatalogSpecResponse,
  type Grant,
  type SpecChange,
} from '@ferrum-nexus/shared';
import {
  API,
  GRANT,
  RAW_SPEC,
  REQUEST,
  SPEC,
  THREAD_RESPONSE,
  catalogEntry,
} from '../../test/fixtures';
import { changeField, clearClients, deferred, renderPage, selectTab } from '../../test/helpers';
import { accessRequestsApi, applicationsApi, catalogApi, threadsApi } from '../lib/api';
import { CatalogDetailPage } from './CatalogDetailPage';
import { CatalogPage } from './CatalogPage';

const session = vi.hoisted(() => ({ canAdmin: false }));
const navigate = vi.hoisted(() => vi.fn());
/** The detail route's search params, e.g. `{ tab: 'changes' }` from a notification link. */
const search = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('@tanstack/react-router', async () => {
  const { TestLink } = await import('../../test/helpers');
  return {
    Link: TestLink,
    useParams: () => ({ slug: 'billing' }),
    useSearch: () => search.value,
    useNavigate: () => navigate,
  };
});
vi.mock('../stores/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, canAdmin: session.canAdmin }),
}));

let detail: CatalogDetailResponse;
/** Each identity's own standing, keyed by application id or `account`. */
let identities: Record<string, CatalogIdentityAccessResponse>;

const NO_ACCESS: CatalogIdentityAccessResponse = { application: null, request: null, grant: null };

beforeEach(() => {
  session.canAdmin = false;
  navigate.mockReset();
  search.value = {};
  detail = { api: catalogEntry(), spec: SPEC, my_request: null, my_grant: null };
  identities = {};
  vi.spyOn(catalogApi, 'list').mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(catalogApi, 'detail').mockImplementation(async () => detail);
  vi.spyOn(catalogApi, 'identityAccess').mockImplementation(
    async (_slug, applicationId) => identities[applicationId ?? 'account'] ?? NO_ACCESS,
  );
  vi.spyOn(catalogApi, 'spec').mockResolvedValue({
    api_id: API.id,
    version: API.version,
    raw_spec: RAW_SPEC,
    content_type: 'application/json',
    parsed_title: SPEC.parsed_title,
    parsed_version: SPEC.parsed_version,
  });
  vi.spyOn(threadsApi, 'create').mockResolvedValue(THREAD_RESPONSE);
  vi.spyOn(catalogApi, 'changes').mockResolvedValue({ items: [], total: 0 });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

/** The example request's text, exactly as shown and copied. */
function exampleRequest(): string {
  const code = screen.getByText(
    (_, element) => element?.tagName === 'CODE' && (element.textContent ?? '').startsWith('curl '),
  );
  return code.textContent ?? '';
}

async function openDetail(tab = 'Overview'): Promise<void> {
  renderPage(<CatalogDetailPage />);
  await screen.findByRole('heading', { name: API.name });
  if (tab !== 'Overview') selectTab(tab);
}

describe('catalog browsing', () => {
  it('shows loading, paginates results, and resets the page when searching', async () => {
    const first = deferred<CatalogListResponse>();
    vi.mocked(catalogApi.list).mockImplementationOnce(() => first.promise);
    renderPage(<CatalogPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading catalog');
    await act(async () => {
      first.resolve({ items: [catalogEntry()], total: DEFAULT_PAGE_SIZE + 1 });
    });
    expect(await screen.findByRole('link', { name: /Billing API/ })).toHaveAttribute(
      'href',
      '/catalog/billing',
    );
    expect(screen.getByText('by Billing team')).toBeInTheDocument();
    expect(screen.getByText('Requestable')).toBeInTheDocument();

    vi.mocked(catalogApi.list).mockResolvedValue({
      items: [
        catalogEntry({
          id: 'api-2',
          slug: 'reports',
          name: 'Reports',
          description: null,
          requestable: false,
          visibility: 'internal',
          owner: null,
          access_state: 'open',
        }),
      ],
      total: DEFAULT_PAGE_SIZE + 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByRole('heading', { name: 'Reports' });
    expect(catalogApi.list).toHaveBeenLastCalledWith({
      limit: DEFAULT_PAGE_SIZE,
      offset: DEFAULT_PAGE_SIZE,
    });
    expect(screen.getByText('No description provided.')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Open access')).toBeInTheDocument();
    // `internal` is unlisted, not secret, and the badge says the true thing:
    // calling it "Internal" was what made providers reach for it when they
    // wanted "Private" (issue #288).
    expect(screen.getByText('Unlisted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

    vi.mocked(catalogApi.list).mockResolvedValue({ items: [], total: 0 });
    changeField('Search the catalog', '  missing  ');
    await screen.findByText('No catalog entry matches your search.');
    expect(catalogApi.list).toHaveBeenLastCalledWith({
      limit: DEFAULT_PAGE_SIZE,
      offset: 0,
      q: 'missing',
    });
    changeField('Search the catalog', '');
    await screen.findByText('Nothing has been published to this portal yet.');
  });

  it('labels a non-requestable API as open access on the catalog card', async () => {
    vi.mocked(catalogApi.list).mockResolvedValue({
      items: [catalogEntry({ requestable: false, access_state: 'open' })],
      total: 1,
    });
    renderPage(<CatalogPage />);
    const card = await screen.findByRole('link', { name: /Billing API/ });
    expect(within(card).getByText('Open access')).toBeInTheDocument();
    expect(within(card).getByText('Open')).toBeInTheDocument();
    expect(within(card).queryByText('No access')).not.toBeInTheDocument();
  });

  it('labels a retired API on the catalog card', async () => {
    vi.mocked(catalogApi.list).mockResolvedValue({
      items: [catalogEntry({ status: 'retired' })],
      total: 1,
    });
    renderPage(<CatalogPage />);
    const card = await screen.findByRole('link', { name: /Billing API/ });
    expect(within(card).getByText('Retired')).toBeInTheDocument();
    expect(within(card).queryByText('Requestable')).not.toBeInTheDocument();
  });

  it('provides a catalog return link when an entry cannot be loaded', async () => {
    vi.mocked(catalogApi.detail).mockRejectedValue(new Error('Not found'));
    renderPage(<CatalogDetailPage />);
    expect(await screen.findByText('API not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to catalog' })).toHaveAttribute(
      'href',
      '/catalog',
    );
    expect(catalogApi.spec).not.toHaveBeenCalled();
  });

  it('renders runtime metadata and lazily loads the documentation', async () => {
    detail = { ...detail, api: catalogEntry({ rate_limit: { limit: 100, window_seconds: 60 } }) };
    const pendingSpec = deferred<CatalogSpecResponse>();
    vi.mocked(catalogApi.spec).mockImplementation(() => pendingSpec.promise);
    await openDetail();
    expect(screen.getByText(API.invoke_url!)).toBeInTheDocument();
    expect(screen.getByText('100 requests / 60s')).toBeInTheDocument();
    expect(screen.getByText('Billing specification (1.0.0)')).toBeInTheDocument();
    // The visibility reads as a label, not the raw `public` value.
    expect(screen.getByText('Public')).toBeInTheDocument();
    expect(screen.queryByText('public')).not.toBeInTheDocument();
    expect(catalogApi.spec).not.toHaveBeenCalled();
    selectTab('Documentation');
    expect(screen.getByRole('status')).toHaveTextContent('Loading specification');
    await act(async () => {
      pendingSpec.resolve({
        api_id: API.id,
        version: API.version,
        raw_spec: RAW_SPEC,
        content_type: 'application/json',
        parsed_title: SPEC.parsed_title,
        parsed_version: SPEC.parsed_version,
      });
    });
    expect(await screen.findByText('List invoices')).toBeInTheDocument();
    expect(catalogApi.spec).toHaveBeenCalledWith('billing');
  });

  it('explains a missing document without fetching it', async () => {
    detail = { ...detail, spec: null, api: catalogEntry({ invoke_url: null, description: null }) };
    await openDetail();
    expect(screen.getByText(/Not published — ask your administrator/)).toBeInTheDocument();
    expect(screen.getByText('None published')).toBeInTheDocument();
    selectTab('Documentation');
    expect(screen.getByText('No specification published')).toBeInTheDocument();
    expect(catalogApi.spec).not.toHaveBeenCalled();
  });

  it('reports a failed document request', async () => {
    vi.mocked(catalogApi.spec).mockRejectedValue(new Error('Unavailable'));
    await openDetail('Documentation');
    expect(await screen.findByText('Specification unavailable')).toBeInTheDocument();
  });
});

/** One recorded change summary, as `GET /api/catalog/:slug/changes` serves it. */
function changeEntry(overrides: Partial<ApiSpecChangeEntry> = {}): ApiSpecChangeEntry {
  return {
    id: 'change-1',
    api_id: API.id,
    revision_id: 'revision-2',
    previous_revision_id: 'revision-1',
    kind: 'update',
    version: '2.0.0',
    previous_version: '1.0.0',
    report: emptySpecChangeReport(),
    created_at: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

function change(overrides: Partial<SpecChange>): SpecChange {
  return {
    kind: 'operation_added',
    severity: 'non_breaking',
    operation: { method: 'GET', path: '/orders' },
    section: 'operation',
    location: null,
    schema_path: null,
    from: null,
    to: null,
    ...overrides,
  };
}

describe('catalog change history (issue #448)', () => {
  it('fetches nothing until opened, then shows the empty state', async () => {
    await openDetail();
    expect(catalogApi.changes).not.toHaveBeenCalled();
    selectTab('Changes');
    expect(await screen.findByText('No changes since it was first published')).toBeInTheDocument();
    expect(catalogApi.changes).toHaveBeenCalledWith('billing', { limit: 10, offset: 0 });
  });

  it('lists each revision, breaking changes first, as text', async () => {
    const hostilePath = '/orders/<img src=x onerror=alert(1)>';
    vi.mocked(catalogApi.changes).mockResolvedValue({
      total: 2,
      items: [
        changeEntry({
          id: 'change-2',
          kind: 'rollback',
          version: '1.0.0',
          previous_version: '2.0.0',
          report: {
            ...emptySpecChangeReport(),
            changed: true,
            changes: [
              change({
                kind: 'operation_removed',
                severity: 'breaking',
                operation: { method: 'DELETE', path: hostilePath },
              }),
              change({
                kind: 'schema_property_added',
                section: 'response',
                location: '200 application/json',
                schema_path: 'currency',
                to: 'optional',
              }),
            ],
            counts: {
              ...emptySpecChangeReport().counts,
              breaking: 1,
              non_breaking: 3,
              operations_removed: 1,
            },
            truncated: true,
            info_changes: ['version'],
          },
        }),
        changeEntry(),
      ],
    });
    await openDetail('Changes');
    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByText('Rollback');
    expect(within(panel).getByText('Update')).toBeInTheDocument();
    expect(within(panel).getByText(/replaced v2\.0\.0/)).toBeInTheDocument();
    expect(
      within(panel).getByText('Operation removed: requests to it may now fail'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('Response 200 application/json, field currency: added (optional)'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('1 breaking')).toBeInTheDocument();
    expect(within(panel).getByText('3 non-breaking')).toBeInTheDocument();
    expect(within(panel).getByText('Also changed: version')).toBeInTheDocument();
    expect(within(panel).getByText('…and 2 more changes not listed.')).toBeInTheDocument();
    // Provider-written names are text, never markup.
    expect(within(panel).getByText(hostilePath)).toBeInTheDocument();
    expect(panel.querySelector('img')).toBeNull();
    // The unchanged revision says so, and the caveat is always there.
    expect(within(panel).getByText(/No structural differences found/)).toBeInTheDocument();
    expect(within(panel).getByText(/structural comparison/)).toBeInTheDocument();
  });

  it('says when a comparison is incomplete instead of claiming nothing changed', async () => {
    vi.mocked(catalogApi.changes).mockResolvedValue({
      total: 1,
      items: [changeEntry({ report: emptySpecChangeReport(false) })],
    });
    await openDetail('Changes');
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText(/This comparison is incomplete/)).toBeInTheDocument();
    expect(within(panel).queryByText(/No structural differences found/)).not.toBeInTheDocument();
  });

  it('pages through a long history', async () => {
    vi.mocked(catalogApi.changes).mockResolvedValue({ total: 12, items: [changeEntry()] });
    await openDetail('Changes');
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() =>
      expect(catalogApi.changes).toHaveBeenLastCalledWith('billing', { limit: 10, offset: 10 }),
    );
  });

  it('opens the Changes tab directly from a link', async () => {
    search.value = { tab: 'changes' };
    renderPage(<CatalogDetailPage />);
    await screen.findByRole('heading', { name: API.name });
    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('No changes since it was first published')).toBeInTheDocument();
  });

  it('reports a failed history request', async () => {
    vi.mocked(catalogApi.changes).mockRejectedValue(new Error('Unavailable'));
    await openDetail('Changes');
    expect(await screen.findByText('Change history unavailable')).toBeInTheDocument();
  });
});

describe('catalog access', () => {
  it('validates a justification, submits it, and withdraws the pending request', async () => {
    vi.spyOn(accessRequestsApi, 'create').mockImplementation(async () => {
      detail = { ...detail, api: catalogEntry({ access_state: 'pending' }), my_request: REQUEST };
      identities.account = { ...NO_ACCESS, request: REQUEST };
      return { access_request: REQUEST };
    });
    vi.spyOn(accessRequestsApi, 'cancel').mockImplementation(async () => {
      const cancelled = { ...REQUEST, status: 'cancelled' as const };
      detail = { ...detail, api: catalogEntry(), my_request: cancelled };
      identities.account = { ...NO_ACCESS, request: cancelled };
      return { access_request: cancelled };
    });
    await openDetail('Access');
    expect(await screen.findByRole('button', { name: 'Request access' })).toBeDisabled();
    expect(screen.getByLabelText(/Why do you need access/)).toHaveAttribute(
      'maxlength',
      String(MAX_JUSTIFICATION_LENGTH),
    );
    changeField(/Why do you need access/, '   ');
    expect(screen.getByRole('button', { name: 'Request access' })).toBeDisabled();
    changeField(/Why do you need access/, '  Reconcile invoices  ');
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await screen.findByRole('button', { name: 'Withdraw request' });
    expect(accessRequestsApi.create).toHaveBeenCalledWith({
      api_id: API.id,
      justification: 'Reconcile invoices',
      requested_tools: null,
      // The identity defaults to the account itself, which is what every
      // request made before applications existed is (issue #289).
      application_id: null,
    });
    expect(screen.queryByText('Call this API')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request' }));
    await screen.findByText('Request withdrawn');
    expect(accessRequestsApi.cancel).toHaveBeenCalledWith(REQUEST.id);
    expect(await screen.findByRole('button', { name: 'Request access' })).toBeDisabled();
  });

  it('keeps the justification for retry when submission fails', async () => {
    vi.spyOn(accessRequestsApi, 'create').mockRejectedValue(new Error('Gateway unavailable'));
    await openDetail('Access');
    await screen.findByRole('button', { name: 'Request access' });
    changeField(/Why do you need access/, 'Reconcile invoices');
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await waitFor(() => expect(accessRequestsApi.create).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Request access' })).toBeEnabled(),
    );
    expect(screen.getByLabelText(/Why do you need access/)).toHaveValue('Reconcile invoices');
    expect(screen.queryByText('Access request submitted')).not.toBeInTheDocument();
  });

  it.each([
    ['key_auth', "-H 'X-API-Key: <your key>'"],
    ['basic_auth', "--user 'nexus-user-user-1:<your password>'"],
    ['jwt_auth', "-H 'Authorization: Bearer <token you sign>'"],
  ] as const)('shows the %s recipe only after access is granted', async (authPlugin, recipe) => {
    detail = {
      ...detail,
      api: catalogEntry({ access_state: 'granted', auth_plugin: authPlugin }),
      my_grant: GRANT,
    };
    identities.account = { ...NO_ACCESS, grant: GRANT };
    await openDetail('Access');
    await screen.findByText(/Access granted to your account/);
    expect(screen.getByText('Call this API')).toBeInTheDocument();
    expect(exampleRequest()).toContain(recipe);
    expect(exampleRequest()).not.toContain('base64(');
    expect(screen.getByText(GRANT.acl_group)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Manage your credentials/ })).toHaveAttribute(
      'href',
      '/credentials',
    );
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
  });

  it('labels a non-requestable API as open access beside the title', async () => {
    detail = {
      ...detail,
      api: catalogEntry({ requestable: false, access_state: 'open' }),
    };
    await openDetail();
    expect(screen.getAllByText('Open access').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Any portal account may call it')).toBeInTheDocument();
    expect(screen.queryByText('No access')).not.toBeInTheDocument();
  });

  it('shows the gateway path for an open API without a configured gateway origin', async () => {
    detail = {
      ...detail,
      api: catalogEntry({ requestable: false, access_state: 'open', invoke_url: null }),
    };
    await openDetail('Access');
    expect(screen.getByText(/No approval needed/)).toBeInTheDocument();
    expect(screen.getByText(/This portal has no gateway address configured/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy Invoke URL' })).not.toBeInTheDocument();
    expect(screen.queryByText('No access')).not.toBeInTheDocument();
  });

  it('keeps call instructions available when an open API is retired', async () => {
    detail = {
      ...detail,
      api: catalogEntry({ status: 'retired', requestable: false, access_state: 'open' }),
    };
    await openDetail('Access');
    expect(screen.getByText(/No approval needed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Calling as')).toBeInTheDocument();
    expect(screen.getByText('Call this API')).toBeInTheDocument();
    expect(exampleRequest()).toContain("-H 'X-API-Key: <your key>'");
    expect(screen.queryByLabelText('Access for')).not.toBeInTheDocument();
  });

  it('shows the last denial and permits a new request', async () => {
    detail = {
      ...detail,
      api: catalogEntry({ access_state: 'denied' }),
      my_request: { ...REQUEST, status: 'denied', decision_note: 'Explain your use case' },
      my_grant: { ...GRANT, status: 'revoked' },
    };
    identities.account = {
      ...NO_ACCESS,
      request: { ...REQUEST, status: 'denied', decision_note: 'Explain your use case' },
    };
    await openDetail('Access');
    expect(await screen.findByText(/Explain your use case/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeDisabled();
    expect(screen.queryByText('Call this API')).not.toBeInTheDocument();
  });

  it('shows the retired state instead of a new-request form for a denied request', async () => {
    detail = {
      ...detail,
      api: catalogEntry({ status: 'retired', access_state: 'denied' }),
      my_request: { ...REQUEST, status: 'denied', decision_note: 'Explain your use case' },
      my_grant: { ...GRANT, status: 'revoked' },
    };
    identities.account = {
      ...NO_ACCESS,
      request: { ...REQUEST, status: 'denied', decision_note: 'Explain your use case' },
    };
    await openDetail('Access');
    expect(
      await screen.findByText(/retired and is no longer accepting new access requests/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Explain your use case/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
    const accessLabel = screen.getByText('Access', { selector: 'span' });
    expect(within(accessLabel.parentElement!).getByText('Retired')).toBeInTheDocument();
  });

  it('keeps withdrawal available for a pending request on a retired API', async () => {
    detail = { ...detail, api: catalogEntry({ status: 'retired', access_state: 'pending' }) };
    identities.account = { ...NO_ACCESS, request: REQUEST };
    vi.spyOn(accessRequestsApi, 'cancel').mockResolvedValue({
      access_request: { ...REQUEST, status: 'cancelled' },
    });
    await openDetail('Access');
    expect(await screen.findByRole('button', { name: 'Withdraw request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request' }));
    await screen.findByText('Request withdrawn');
  });

  it('shows an existing application grant on a retired API', async () => {
    const app = {
      id: 'app-a',
      owner_user_id: 'user-1',
      name: 'Application A',
      description: null,
      status: 'active' as const,
      active_grants: 1,
      active_credentials: 0,
      created_at: API.created_at,
      updated_at: API.created_at,
    };
    const appGrant = { ...GRANT, application_id: 'app-a' };
    detail = {
      ...detail,
      api: catalogEntry({ status: 'retired', access_state: 'granted' }),
      my_grant: appGrant,
    };
    identities['app-a'] = {
      application: {
        id: app.id,
        name: app.name,
        owner_user_id: app.owner_user_id,
        status: app.status,
      },
      request: null,
      grant: appGrant,
    };
    vi.spyOn(applicationsApi, 'list').mockResolvedValue({ items: [app], total: 1 });
    await openDetail('Access');
    fireEvent.click(screen.getByLabelText('Access for'));
    fireEvent.click(await screen.findByRole('option', { name: 'Application A' }));
    await screen.findByText(/Access granted to Application A/);
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
  });

  it.each([false, true])('gives the owner a management link (admin: %s)', async (canAdmin) => {
    session.canAdmin = canAdmin;
    detail = { ...detail, api: catalogEntry({ access_state: 'owner' }) };
    await openDetail('Access');
    expect(screen.getByText('You publish this API')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Manage API' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Manage API' })).toHaveAttribute('href', '/apis/api-1');
    expect(screen.queryByRole('button', { name: 'Message provider' })).not.toBeInTheDocument();
  });

  it('lets an administrator manage another provider’s API', async () => {
    session.canAdmin = true;
    await openDetail();
    expect(screen.getByRole('link', { name: 'Manage API' })).toHaveAttribute('href', '/apis/api-1');
  });

  it('addresses a new conversation to the provider and the current API', async () => {
    await openDetail();
    expect(screen.queryByRole('link', { name: 'Manage API' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Message provider' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Subject/)).toHaveValue('Question about Billing API');
    changeField(/Message/, '  Please explain invoice exports  ');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(threadsApi.create).toHaveBeenCalledWith({
      subject: 'Question about Billing API',
      body: 'Please explain invoice exports',
      api_id: API.id,
      recipient_user_id: 'provider-1',
    });
    expect(navigate).toHaveBeenCalledWith({
      to: '/messages/$threadId',
      params: { threadId: 'thread-1' },
    });
  });
});

describe('per-identity catalog access (issue #314)', () => {
  const application = (id: string, name: string): Application => ({
    id,
    owner_user_id: 'user-1',
    name,
    description: null,
    status: 'active',
    active_grants: 0,
    active_credentials: 0,
    created_at: API.created_at,
    updated_at: API.created_at,
  });
  const summary = (item: Application): ApplicationSummary => ({
    id: item.id,
    name: item.name,
    owner_user_id: item.owner_user_id,
    status: item.status,
  });
  const APP_A = application('app-a', 'Application A');
  const APP_B = application('app-b', 'Application B');
  const requestFor = (item: Application): AccessRequest => ({
    ...REQUEST,
    id: `request-${item.id}`,
    application_id: item.id,
    application: summary(item),
  });
  const grantFor = (item: Application): Grant => ({
    ...GRANT,
    id: `grant-${item.id}`,
    application_id: item.id,
    application: summary(item),
  });

  beforeEach(() => {
    vi.spyOn(applicationsApi, 'list').mockResolvedValue({ items: [APP_A, APP_B], total: 2 });
    vi.spyOn(accessRequestsApi, 'create').mockResolvedValue({ access_request: REQUEST });
  });

  async function chooseIdentity(name: string, label = 'Requesting for'): Promise<void> {
    fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(await screen.findByRole('option', { name }));
  }

  it('shows A pending while B, and the account, can still request', async () => {
    // The account-wide representative is A's pending request — the very thing
    // that used to hide the form for every identity.
    detail = {
      ...detail,
      api: catalogEntry({ access_state: 'pending' }),
      my_request: requestFor(APP_A),
    };
    identities['app-a'] = { application: summary(APP_A), request: requestFor(APP_A), grant: null };
    identities['app-b'] = { ...NO_ACCESS, application: summary(APP_B) };
    await openDetail('Access');

    // The account has neither a request nor a grant of its own.
    expect(await screen.findByRole('button', { name: 'Request access' })).toBeInTheDocument();
    expect(catalogApi.identityAccess).toHaveBeenCalledWith('billing', null);

    await chooseIdentity('Application A');
    expect(
      await screen.findByText(/The request for Application A is awaiting review/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
    expect(catalogApi.identityAccess).toHaveBeenCalledWith('billing', 'app-a');
    // The picker searches the caller's own active applications on the server.
    expect(applicationsApi.list).toHaveBeenCalledWith({
      mine: true,
      status: 'active',
      limit: DEFAULT_PAGE_SIZE,
      offset: 0,
    });

    await chooseIdentity('Application B');
    fireEvent.change(await screen.findByLabelText(/Why do you need access/), {
      target: { value: 'Second integration' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await waitFor(() =>
      expect(accessRequestsApi.create).toHaveBeenCalledWith({
        api_id: API.id,
        justification: 'Second integration',
        application_id: 'app-b',
        requested_tools: null,
      }),
    );
  });

  it('shows A granted — on its credentials only — while B can still request', async () => {
    detail = {
      ...detail,
      api: catalogEntry({ access_state: 'granted' }),
      my_grant: grantFor(APP_A),
    };
    identities['app-a'] = { application: summary(APP_A), request: null, grant: grantFor(APP_A) };
    identities['app-b'] = { ...NO_ACCESS, application: summary(APP_B) };
    await openDetail('Access');

    // The account itself is not the grantee, so it may still ask.
    expect(await screen.findByRole('button', { name: 'Request access' })).toBeInTheDocument();
    expect(screen.queryByText(/Access granted to your account/)).not.toBeInTheDocument();

    await chooseIdentity('Application A');
    expect(await screen.findByText(/Access granted to Application A/)).toBeInTheDocument();
    expect(screen.getByText(/Only Application A’s gateway consumer carries/)).toBeInTheDocument();
    expect(
      screen.getByText(/credentials issued to your account or your other applications cannot/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();

    await chooseIdentity('Application B');
    expect(await screen.findByRole('button', { name: 'Request access' })).toBeInTheDocument();
    expect(screen.queryByText(/Access granted/)).not.toBeInTheDocument();
  });

  it('describes an account-level grant as reaching every account credential', async () => {
    detail = { ...detail, api: catalogEntry({ access_state: 'granted' }), my_grant: GRANT };
    identities.account = { ...NO_ACCESS, grant: GRANT };
    identities['app-a'] = { ...NO_ACCESS, application: summary(APP_A) };
    await openDetail('Access');

    expect(await screen.findByText(/Access granted to your account/)).toBeInTheDocument();
    expect(
      screen.getByText(/every credential issued to your account can call this API/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();

    // An application does not inherit the account's grant; it asks on its own.
    await chooseIdentity('Application A');
    expect(await screen.findByRole('button', { name: 'Request access' })).toBeInTheDocument();
  });

  it('pages and searches the identity picker on the server', async () => {
    const many = Array.from({ length: DEFAULT_PAGE_SIZE + 5 }, (_, index) =>
      application(`app-${index}`, `Integration ${index}`),
    );
    vi.mocked(applicationsApi.list).mockImplementation(async (query = {}) => {
      const matching = many.filter(
        (item) => query.q === undefined || item.name.toLowerCase().includes(query.q.toLowerCase()),
      );
      const offset = query.offset ?? 0;
      return {
        items: matching.slice(offset, offset + (query.limit ?? DEFAULT_PAGE_SIZE)),
        total: matching.length,
      };
    });
    await openDetail('Access');
    await screen.findByRole('button', { name: 'Request access' });

    fireEvent.click(screen.getByLabelText('Requesting for'));
    await screen.findByRole('option', { name: 'Integration 0' });
    expect(screen.queryByRole('option', { name: 'Integration 29' })).not.toBeInTheDocument();
    expect(screen.getByText(`1–${DEFAULT_PAGE_SIZE} of ${many.length}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More Requesting for results' }));
    expect(await screen.findByRole('option', { name: 'Integration 29' })).toBeInTheDocument();
    expect(applicationsApi.list).toHaveBeenLastCalledWith({
      mine: true,
      status: 'active',
      limit: DEFAULT_PAGE_SIZE,
      offset: DEFAULT_PAGE_SIZE,
    });

    fireEvent.change(screen.getByLabelText('Search Requesting for'), {
      target: { value: ' integration 7 ' },
    });
    await waitFor(() =>
      expect(applicationsApi.list).toHaveBeenLastCalledWith({
        mine: true,
        status: 'active',
        q: 'integration 7',
        limit: DEFAULT_PAGE_SIZE,
        offset: 0,
      }),
    );
    fireEvent.click(await screen.findByRole('option', { name: 'Integration 7' }));
    expect(
      await screen.findByText(/Approval adds this API to that application only/),
    ).toBeVisible();
    expect(catalogApi.identityAccess).toHaveBeenLastCalledWith('billing', 'app-7');
  });
  describe('call instructions follow the selected identity (issue #374)', () => {
    /** The consumer the account-level credential endpoint issues on. */
    const ACCOUNT_CONSUMER = consumerUsernameForUser('user-1');

    it('shows the agent badge and tool coverage only connects an approved identity', async () => {
      detail = {
        ...detail,
        api: catalogEntry({
          access_state: 'granted',
          auth_plugin: 'basic_auth',
          agents: {
            operations: [
              { path: '/invoices', method: 'GET', name: 'list', description: 'List invoices' },
            ],
          },
        }),
        my_grant: grantFor(APP_A),
      };
      identities['app-a'] = { application: summary(APP_A), request: null, grant: grantFor(APP_A) };
      await openDetail('Access');
      await screen.findByRole('button', { name: 'Request access' });
      expect(screen.getByText('AI agents')).toBeInTheDocument();
      expect(screen.queryByText('Connect an agent')).not.toBeInTheDocument();
      expect(
        screen.getByRole('region', { name: 'Tools available after approval' }),
      ).toBeInTheDocument();
      await chooseIdentity('Application A');
      await screen.findByText(/Access granted to Application A/);
      expect(screen.getByText('Connect an agent')).toBeInTheDocument();
      expect(
        screen.getByRole('region', { name: 'Tools covered by this grant' }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Base64-encode nexus-app-app-a/)).toBeInTheDocument();
      await chooseIdentity('My account');
      await screen.findByRole('button', { name: 'Request access' });
      expect(screen.queryByText('Connect an agent')).not.toBeInTheDocument();
    });

    /** The JWT `sub` the note tells the caller to sign. */
    function jwtSubject(): string {
      return screen.getByText(/claim must be/).querySelectorAll('code')[1]?.textContent ?? '';
    }

    it('calls as the account when only the account is approved', async () => {
      detail = {
        ...detail,
        api: catalogEntry({ access_state: 'granted', auth_plugin: 'basic_auth' }),
        my_grant: GRANT,
      };
      identities.account = { ...NO_ACCESS, grant: GRANT };
      identities['app-a'] = { ...NO_ACCESS, application: summary(APP_A) };
      await openDetail('Access');

      await screen.findByText(/Access granted to your account/);
      expect(exampleRequest()).toContain(`--user '${ACCOUNT_CONSUMER}:<your password>'`);

      // The account's grant does not reach the application, so there is
      // nothing to call as it until it is approved.
      await chooseIdentity('Application A');
      await screen.findByRole('button', { name: 'Request access' });
      expect(screen.queryByText('Call this API')).not.toBeInTheDocument();
    });

    it('calls as the approved application, never the unapproved account', async () => {
      detail = {
        ...detail,
        api: catalogEntry({ access_state: 'granted', auth_plugin: 'basic_auth' }),
        my_grant: grantFor(APP_A),
      };
      identities['app-a'] = { application: summary(APP_A), request: null, grant: grantFor(APP_A) };
      await openDetail('Access');

      // The account-wide state says "granted", but the account holds nothing.
      await screen.findByRole('button', { name: 'Request access' });
      expect(screen.queryByText('Call this API')).not.toBeInTheDocument();
      expect(screen.getByText('No access')).toBeInTheDocument();

      await chooseIdentity('Application A');
      await screen.findByText(/Access granted to Application A/);
      const example = exampleRequest();
      expect(example).toContain(
        `--user '${consumerUsernameForApplication('app-a')}:<your password>'`,
      );
      expect(example).not.toContain(ACCOUNT_CONSUMER);
      expect(screen.getByText(/to Application A from the credentials page/)).toBeInTheDocument();
    });

    it('switches the JWT subject between approved applications', async () => {
      detail = {
        ...detail,
        api: catalogEntry({ access_state: 'granted', auth_plugin: 'jwt_auth' }),
        my_grant: grantFor(APP_A),
      };
      identities['app-a'] = { application: summary(APP_A), request: null, grant: grantFor(APP_A) };
      identities['app-b'] = { application: summary(APP_B), request: null, grant: grantFor(APP_B) };
      await openDetail('Access');
      await screen.findByRole('button', { name: 'Request access' });

      await chooseIdentity('Application A');
      await screen.findByText(/Access granted to Application A/);
      expect(jwtSubject()).toBe(consumerUsernameForApplication('app-a'));

      await chooseIdentity('Application B');
      await screen.findByText(/Access granted to Application B/);
      expect(jwtSubject()).toBe(consumerUsernameForApplication('app-b'));
    });

    it('lets an API without approval be called as any identity', async () => {
      detail = {
        ...detail,
        api: catalogEntry({ requestable: false, access_state: 'open', auth_plugin: 'basic_auth' }),
      };
      await openDetail('Access');

      expect(await screen.findByText('Call this API')).toBeInTheDocument();
      expect(exampleRequest()).toContain(`--user '${ACCOUNT_CONSUMER}:<your password>'`);

      await chooseIdentity('Application B', 'Calling as');
      await waitFor(() =>
        expect(exampleRequest()).toContain(
          `--user '${consumerUsernameForApplication('app-b')}:<your password>'`,
        ),
      );
      // Open access has no per-identity grant to look up.
      expect(catalogApi.identityAccess).not.toHaveBeenCalled();
    });
  });
});
