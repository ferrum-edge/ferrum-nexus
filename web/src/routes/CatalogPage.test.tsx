import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_JUSTIFICATION_LENGTH,
  type CatalogDetailResponse,
  type CatalogListResponse,
  type CatalogSpecResponse,
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
import { accessRequestsApi, catalogApi, threadsApi } from '../lib/api';
import { CatalogDetailPage } from './CatalogDetailPage';
import { CatalogPage } from './CatalogPage';

const session = vi.hoisted(() => ({ canAdmin: false }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async () => {
  const { TestLink } = await import('../../test/helpers');
  return { Link: TestLink, useParams: () => ({ slug: 'billing' }), useNavigate: () => navigate };
});
vi.mock('../stores/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, canAdmin: session.canAdmin }),
}));

let detail: CatalogDetailResponse;

beforeEach(() => {
  session.canAdmin = false;
  navigate.mockReset();
  detail = { api: catalogEntry(), spec: SPEC, my_request: null, my_grant: null };
  vi.spyOn(catalogApi, 'list').mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(catalogApi, 'detail').mockImplementation(async () => detail);
  vi.spyOn(catalogApi, 'spec').mockResolvedValue({
    api_id: API.id,
    version: API.version,
    raw_spec: RAW_SPEC,
    content_type: 'application/json',
    parsed_title: SPEC.parsed_title,
    parsed_version: SPEC.parsed_version,
  });
  vi.spyOn(threadsApi, 'create').mockResolvedValue(THREAD_RESPONSE);
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

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

describe('catalog access', () => {
  it('validates a justification, submits it, and withdraws the pending request', async () => {
    vi.spyOn(accessRequestsApi, 'create').mockImplementation(async () => {
      detail = { ...detail, api: catalogEntry({ access_state: 'pending' }), my_request: REQUEST };
      return { access_request: REQUEST };
    });
    vi.spyOn(accessRequestsApi, 'cancel').mockImplementation(async () => {
      const cancelled = { ...REQUEST, status: 'cancelled' as const };
      detail = { ...detail, api: catalogEntry(), my_request: cancelled };
      return { access_request: cancelled };
    });
    await openDetail('Access');
    expect(screen.getByRole('button', { name: 'Request access' })).toBeDisabled();
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
    ['key_auth', 'X-API-Key: <your key>'],
    ['basic_auth', 'Authorization: Basic base64(nexus-user-user-1:<your password>)'],
    ['jwt_auth', 'Authorization: Bearer <token you sign>'],
  ] as const)('shows the %s recipe only after access is granted', async (authPlugin, recipe) => {
    detail = {
      ...detail,
      api: catalogEntry({ access_state: 'granted', auth_plugin: authPlugin }),
      my_grant: GRANT,
    };
    await openDetail('Access');
    expect(screen.getByText('Call this API')).toBeInTheDocument();
    expect(screen.getByText(recipe)).toBeInTheDocument();
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

  it('shows the last denial and permits a new request', async () => {
    detail = {
      ...detail,
      api: catalogEntry({ access_state: 'denied' }),
      my_request: { ...REQUEST, status: 'denied', decision_note: 'Explain your use case' },
      my_grant: { ...GRANT, status: 'revoked' },
    };
    await openDetail('Access');
    expect(screen.getByText(/Explain your use case/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeDisabled();
    expect(screen.queryByText('Call this API')).not.toBeInTheDocument();
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
