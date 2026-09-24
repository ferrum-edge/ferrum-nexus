import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CORS_ORIGINS,
  type Api,
  type GetApiSpecResponse,
  type SpecDiff,
  type UpdateApiResponse,
} from '@ferrum-nexus/shared';
import { API, CREDENTIAL, RAW_SPEC, SPEC } from '../../test/fixtures';
import { changeField, clearClients, deferred, renderPage, selectTab } from '../../test/helpers';
import { apisApi } from '../lib/api';
import { ApiDetailPage } from './ApiDetailPage';

const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async () => {
  const { TestLink } = await import('../../test/helpers');
  return { Link: TestLink, useParams: () => ({ apiId: 'api-1' }), useNavigate: () => navigate };
});
vi.mock('../stores/auth', () => ({ useAuth: () => ({ hasRole: () => true }) }));
vi.mock('../components/ui/Select', async () => {
  const { NativeLabeledSelect } = await import('../../test/helpers');
  return { LabeledSelect: NativeLabeledSelect };
});

let api: Api;
let rawSpec: string;

/** A comparison that found nothing — the default for tests not about the diff. */
const EMPTY_DIFF: SpecDiff = {
  from: SPEC,
  to: null,
  added_operations: [],
  removed_operations: [],
  changed_operations: [],
  added_paths: [],
  removed_paths: [],
  info_changes: [],
  servers_changed: false,
  potentially_breaking: [],
  changed: false,
};

beforeEach(() => {
  api = { ...API };
  rawSpec = RAW_SPEC;
  navigate.mockReset();
  vi.spyOn(apisApi, 'get').mockImplementation(async () => ({
    api,
    spec: SPEC,
    stats: { pending_requests: 2, active_grants: 3, total_requests: 5 },
  }));
  vi.spyOn(apisApi, 'spec').mockImplementation(async () => ({
    api_id: api.id,
    version: api.version,
    raw_spec: rawSpec,
    content_type: 'application/json',
    parsed_title: SPEC.parsed_title,
    parsed_version: SPEC.parsed_version,
  }));
  vi.spyOn(apisApi, 'usage').mockRejectedValue(new Error('Usage unavailable'));
  vi.spyOn(apisApi, 'update').mockImplementation(async (_id, body) => {
    // The request shape mirrors the record for every field these tests send;
    // only the CORS request alias differs, and no test here patches CORS.
    api = { ...api, ...body } as Api;
    return { api };
  });
  vi.spyOn(apisApi, 'updateSpec').mockImplementation(async (_id, body) => {
    rawSpec = body.spec;
    return { api, spec: SPEC };
  });
  vi.spyOn(apisApi, 'remove').mockResolvedValue({ ok: true });
  vi.spyOn(apisApi, 'diffSpec').mockResolvedValue({ diff: EMPTY_DIFF });
  vi.spyOn(apisApi, 'revisions').mockResolvedValue({ items: [SPEC], total: 1 });
  vi.spyOn(apisApi, 'revisionDiff').mockResolvedValue({ diff: EMPTY_DIFF });
  vi.spyOn(apisApi, 'rollbackSpec').mockImplementation(async () => ({ api, spec: SPEC }));
  vi.spyOn(apisApi, 'createTestConsumer').mockResolvedValue({
    credential: CREDENTIAL,
    consumer_username: 'nexus-test-api-1',
    secret: { type: 'keyauth', key: 'test-only-sandbox-key' },
  });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

async function openTab(tab: string): Promise<void> {
  renderPage(<ApiDetailPage />);
  await screen.findByRole('heading', { name: API.name });
  selectTab(tab);
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
}

describe('provider API workspace', () => {
  it('shows the overview counters, catalog destination, and unavailable usage', async () => {
    renderPage(<ApiDetailPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading API');
    await screen.findByText('Usage could not be loaded for this API.');
    expect(screen.getByRole('link', { name: 'View in catalog' })).toHaveAttribute(
      'href',
      '/catalog/billing',
    );
    expect(screen.getByText('Active grants').nextElementSibling).toHaveTextContent('3');
    const allRequests = screen.getByText('Access requests (all time)');
    expect(allRequests.nextElementSibling).toHaveTextContent('5');
    expect(screen.getByText(API.listen_path)).toBeInTheDocument();
  });

  it('offers a return link when the API is missing', async () => {
    vi.mocked(apisApi.get).mockRejectedValue(new Error('Not found'));
    renderPage(<ApiDetailPage />);
    await screen.findByText('API not found');
    expect(screen.getByRole('link', { name: 'Back to my APIs' })).toHaveAttribute('href', '/apis');
    expect(apisApi.usage).not.toHaveBeenCalled();
  });

  it('warns about a routes-enforcement rebuild and clears the warning when restored', async () => {
    await openTab('Settings');
    expect(screen.getByLabelText('OpenAPI enforcement')).toHaveValue('docs_only');
    expect(screen.queryByText(/Changing this rebuilds/)).not.toBeInTheDocument();
    changeField('OpenAPI enforcement', 'routes');
    expect(screen.getByText(/Changing this rebuilds/)).toHaveTextContent('briefly unreachable');
    expect(screen.getByText(/Request and response bodies are not validated/)).toBeInTheDocument();
    changeField('OpenAPI enforcement', 'docs_only');
    expect(screen.queryByText(/Changing this rebuilds/)).not.toBeInTheDocument();
    changeField('OpenAPI enforcement', 'routes');
    save();
    await screen.findByText('API settings saved');
    expect(apisApi.update).toHaveBeenCalledWith(
      API.id,
      expect.objectContaining({ spec_enforcement: 'routes' }),
    );
    await waitFor(() => {
      expect(screen.queryByText(/Changing this rebuilds/)).not.toBeInTheDocument();
    });
  });

  it('omits untouched proxy controls while saving identity changes', async () => {
    api = {
      ...api,
      allowed_methods: ['GET'],
      timeouts: { connect_ms: 500, read_ms: 600, write_ms: 700 },
      circuit_breaker: true,
    };
    await openTab('Settings');
    expect(screen.getByLabelText('GET')).toBeChecked();
    expect(screen.getByLabelText('Read timeout (ms)')).toHaveValue(600);
    changeField(/^Name/, '  Updated billing  ');
    changeField(/^Description/, '  New description  ');
    changeField(/^Version/, '2.0.0');
    save();
    await screen.findByText('API settings saved');
    expect(apisApi.update).toHaveBeenCalledWith(API.id, {
      name: 'Updated billing',
      description: 'New description',
      version: '2.0.0',
      auth_plugin: 'key_auth',
      visibility: 'public',
      status: 'published',
      requestable: true,
      rate_limit: null,
      cors: null,
      spec_enforcement: 'docs_only',
    });
  });

  it('saves changed controls and omits them from subsequent unrelated saves', async () => {
    await openTab('Settings');
    await screen.findByRole('button', { name: 'Use the methods declared in the spec' });
    fireEvent.click(screen.getByRole('button', { name: 'Use the methods declared in the spec' }));
    fireEvent.click(screen.getByLabelText('GET'));
    fireEvent.click(screen.getByLabelText('POST'));
    changeField('Connect timeout (ms)', '500');
    changeField('Read timeout (ms)', '600');
    changeField('Write timeout (ms)', '700');
    fireEvent.click(screen.getByLabelText('Trip a circuit breaker when the backend fails'));
    changeField(/^Upstream URL/, 'https://new.example.test');
    changeField('Visibility', 'internal');
    changeField('Status', 'retired');
    fireEvent.click(screen.getByLabelText('Require an approved access request'));
    fireEvent.click(screen.getByLabelText('Enforce a rate limit'));
    changeField('Requests', '50');
    changeField('Window', '1');
    changeField('CORS allowed origins', ' https://app.example.test\n');
    changeField('Additional CORS request headers', 'X-Trace, X-Client');
    fireEvent.click(screen.getByLabelText('Allow credentials'));
    fireEvent.click(screen.getByLabelText('Enforce WebSocket origins'));
    save();
    await screen.findByText('API settings saved');
    expect(apisApi.update).toHaveBeenLastCalledWith(
      API.id,
      expect.objectContaining({
        allowed_methods: null,
        timeouts: { connect_ms: 500, read_ms: 600, write_ms: 700 },
        circuit_breaker: true,
        upstream_url: 'https://new.example.test',
        visibility: 'internal',
        status: 'retired',
        requestable: false,
        rate_limit: { limit: 50, window_seconds: 1 },
        cors: {
          allowed_origins: ['https://app.example.test'],
          allowed_headers: ['X-Trace', 'X-Client'],
          allow_credentials: true,
          enforce_websocket_origins: false,
        },
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
    });
    save();
    await waitFor(() => expect(apisApi.update).toHaveBeenCalledTimes(2));
    const body = vi.mocked(apisApi.update).mock.calls[1]![1];
    expect(body).not.toHaveProperty('allowed_methods');
    expect(body).not.toHaveProperty('timeouts');
    expect(body).not.toHaveProperty('circuit_breaker');
  });

  it('keeps proxy edits made during an in-flight save for the next submission', async () => {
    const pending = deferred<UpdateApiResponse>();
    vi.mocked(apisApi.update).mockImplementationOnce(() => pending.promise);
    await openTab('Settings');
    fireEvent.click(screen.getByLabelText('GET'));
    changeField('Connect timeout (ms)', '500');
    fireEvent.click(screen.getByLabelText('Trip a circuit breaker when the backend fails'));
    save();
    await waitFor(() => expect(apisApi.update).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText('POST'));
    changeField('Connect timeout (ms)', '900');
    fireEvent.click(screen.getByLabelText('Trip a circuit breaker when the backend fails'));
    await act(async () => pending.resolve({ api }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
    });
    save();
    await waitFor(() => expect(apisApi.update).toHaveBeenCalledTimes(2));
    expect(apisApi.update).toHaveBeenLastCalledWith(
      API.id,
      expect.objectContaining({
        allowed_methods: ['GET', 'POST'],
        timeouts: expect.objectContaining({ connect_ms: 900 }),
        circuit_breaker: false,
      }),
    );
  });

  it('includes the acknowledgement flag when confirming an authentication swap', async () => {
    await openTab('Settings');
    changeField('Authentication', 'basic_auth');
    expect(screen.getByText(/Everyone holding access with a credential/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Cut off everyone using the old method/)).not.toBeChecked();
    fireEvent.click(screen.getByLabelText(/Cut off everyone using the old method/));
    save();
    await screen.findByText('API settings saved');
    expect(apisApi.update).toHaveBeenCalledWith(
      API.id,
      expect.objectContaining({ auth_plugin: 'basic_auth', confirm_access_disruption: true }),
    );
    await waitFor(() => {
      const acknowledgement = screen.queryByLabelText(/Cut off everyone using the old method/);
      expect(acknowledgement).not.toBeInTheDocument();
    });
  });

  it('rejects invalid runtime settings without sending an update', async () => {
    await openTab('Settings');
    const form = screen.getByRole('button', { name: 'Save settings' }).closest('form')!;
    fireEvent.click(screen.getByLabelText('Enforce a rate limit'));
    changeField('Requests', '0');
    fireEvent.submit(form);
    await screen.findByText('Rate limit out of range');
    changeField('Requests', '100');
    const origins = Array.from(
      { length: MAX_CORS_ORIGINS + 1 },
      (_, i) => `https://app${i}.example.test`,
    );
    changeField('CORS allowed origins', origins.join('\n'));
    fireEvent.submit(form);
    await screen.findByText('Too many CORS origins');
    changeField('CORS allowed origins', '');
    changeField('Write timeout (ms)', '0');
    fireEvent.submit(form);
    await screen.findByText('Timeout out of range');
    expect(apisApi.update).not.toHaveBeenCalled();
  });

  it('gates deletion on the API slug and allows cancellation', async () => {
    await openTab('Settings');
    fireEvent.click(screen.getByRole('button', { name: 'Delete API' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(apisApi.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete API' }));
    dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete API' });
    expect(confirm).toBeDisabled();
    changeField(/Type billing to confirm/, 'wrong-api');
    expect(confirm).toBeDisabled();
    changeField(/Type billing to confirm/, 'billing');
    fireEvent.click(confirm);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/apis' }));
    expect(apisApi.remove).toHaveBeenCalledWith(API.id);
  });
});

describe('provider specification and sandbox credentials', () => {
  it('loads, validates, discards, and publishes specification revisions', async () => {
    const pending = deferred<GetApiSpecResponse>();
    vi.mocked(apisApi.spec).mockImplementationOnce(() => pending.promise);
    await openTab('Specification');
    expect(screen.getByRole('status')).toHaveTextContent('Loading specification');
    await act(async () => {
      pending.resolve({
        api_id: API.id,
        version: API.version,
        raw_spec: RAW_SPEC,
        content_type: 'application/json',
        parsed_title: SPEC.parsed_title,
        parsed_version: SPEC.parsed_version,
      });
    });
    expect(await screen.findByLabelText(/OpenAPI specification/)).toHaveValue(RAW_SPEC);
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeDisabled();
    changeField(/OpenAPI specification/, 'invalid');
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(screen.getByText('The OpenAPI document could not be parsed.')).toBeInTheDocument();
    expect(apisApi.diffSpec).not.toHaveBeenCalled();
    expect(apisApi.updateSpec).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(RAW_SPEC);

    // A revision is reviewed before it replaces anything: the diff is fetched,
    // shown, and only the confirmation publishes.
    const revision = RAW_SPEC.replace('1.0.0', '2.0.0');
    changeField(/OpenAPI specification/, revision);
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this revision' });
    expect(apisApi.diffSpec).toHaveBeenCalledWith(API.id, { spec: revision });
    expect(apisApi.updateSpec).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish revision' }));

    await screen.findByText('Specification updated');
    expect(apisApi.updateSpec).toHaveBeenCalledWith(API.id, { spec: revision });
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(revision);
    });
  });

  it('names the operations a revision would stop serving before publishing it', async () => {
    vi.mocked(apisApi.diffSpec).mockResolvedValue({
      diff: {
        ...EMPTY_DIFF,
        removed_operations: [{ method: 'POST', path: '/invoices' }],
        potentially_breaking: [{ method: 'POST', path: '/invoices' }],
        changed: true,
      },
    });
    await openTab('Specification');
    await screen.findByLabelText(/OpenAPI specification/);
    changeField(/OpenAPI specification/, RAW_SPEC.replace('1.0.0', '2.0.0'));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));

    const dialog = await screen.findByRole('dialog', { name: 'Publish this revision' });
    expect(within(dialog).getByText(/would stop being served/)).toBeInTheDocument();
    expect(within(dialog).getByText('/invoices')).toBeInTheDocument();
    // …and the comparison never claims the rest of the change is safe.
    expect(within(dialog).getByText(/cannot tell you a change is backward/)).toBeInTheDocument();
  });

  it('keeps a rejected specification revision editable for retry', async () => {
    vi.mocked(apisApi.updateSpec).mockRejectedValue(new Error('Gateway unavailable'));
    await openTab('Specification');
    await screen.findByLabelText(/OpenAPI specification/);
    const revision = RAW_SPEC.replace('1.0.0', '2.0.0');
    changeField(/OpenAPI specification/, revision);
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this revision' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish revision' }));
    await waitFor(() => expect(apisApi.updateSpec).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Review changes' })).toBeEnabled(),
    );
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(revision);
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeEnabled();
    expect(screen.queryByText('Specification updated')).not.toBeInTheDocument();
  });

  it('publishes exactly the reviewed document and keeps newer edits (issue #330)', async () => {
    const comparison = deferred<{ diff: SpecDiff }>();
    vi.mocked(apisApi.diffSpec).mockImplementationOnce(() => comparison.promise);
    await openTab('Specification');
    await screen.findByLabelText(/OpenAPI specification/);
    const reviewed = RAW_SPEC.replace('1.0.0', '2.0.0');
    const newer = RAW_SPEC.replace('1.0.0', '3.0.0');
    changeField(/OpenAPI specification/, reviewed);
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    await waitFor(() => expect(apisApi.diffSpec).toHaveBeenCalledWith(API.id, { spec: reviewed }));

    // The provider keeps typing while the comparison is still in flight.
    changeField(/OpenAPI specification/, newer);
    await act(async () => {
      comparison.resolve({ diff: EMPTY_DIFF });
    });

    const dialog = await screen.findByRole('dialog', { name: 'Publish this revision' });
    expect(within(dialog).getByText(/editor changed after this comparison/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish revision' }));

    await screen.findByText('Specification updated');
    expect(apisApi.updateSpec).toHaveBeenCalledTimes(1);
    expect(apisApi.updateSpec).toHaveBeenCalledWith(API.id, { spec: reviewed });
    // The unreviewed edit is neither published nor discarded.
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(newer);
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeEnabled();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('lists revision history and rolls one back after reviewing it', async () => {
    const earlier = {
      ...SPEC,
      id: 'spec-0',
      version: '0.9.0',
      parsed_version: '0.9.0',
      is_current: false,
    };
    vi.mocked(apisApi.revisions).mockResolvedValue({ items: [SPEC, earlier], total: 2 });
    vi.mocked(apisApi.revisionDiff).mockResolvedValue({
      diff: {
        ...EMPTY_DIFF,
        removed_operations: [{ method: 'GET', path: '/receipts' }],
        potentially_breaking: [{ method: 'GET', path: '/receipts' }],
        changed: true,
      },
    });
    await openTab('Specification');
    await screen.findByText('Revision history');
    expect(await screen.findByText('v0.9.0')).toBeInTheDocument();
    // The current revision is not offered for rollback.
    expect(screen.getAllByRole('button', { name: /Review & roll back/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /Review & roll back/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Roll back to version 0.9.0' });
    await waitFor(() => expect(apisApi.revisionDiff).toHaveBeenCalledWith(API.id, 'spec-0'));
    expect(within(dialog).getByText(/would stop being served/)).toBeInTheDocument();
    expect(apisApi.rollbackSpec).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await screen.findByText('Rolled back to version 0.9.0');
    expect(apisApi.rollbackSpec).toHaveBeenCalledWith(API.id, 'spec-0');
  });

  it('creates a sandbox credential and forgets its display after acknowledgement', async () => {
    await openTab('Test consumer');
    expect(screen.getByText('nexus-test-api-1')).toBeInTheDocument();
    changeField('Label', '  Manual smoke check  ');
    fireEvent.click(screen.getByRole('button', { name: 'Create test credential' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save your test credential' });
    expect(apisApi.createTestConsumer).toHaveBeenCalledWith(API.id, {
      label: 'Manual smoke check',
    });
    expect(within(dialog).getByText('test-only-sandbox-key')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('test-only-sandbox-key')).not.toBeInTheDocument();
  });
});

/**
 * The gateway deployment is gone — the state issue #284 added, and the one a
 * provider has to be able to see and act on without reading the audit log.
 */
describe('restoring a missing gateway deployment', () => {
  beforeEach(() => {
    api = { ...API, gateway_state: 'repair_required', ferrum_proxy_id: null };
    vi.spyOn(apisApi, 'restoreGateway').mockImplementation(async () => {
      api = { ...api, gateway_state: 'deployed', ferrum_proxy_id: 'proxy-restored' };
      return { api, spec: SPEC, proxy_id: 'proxy-restored' };
    });
  });

  it('shows the condition and restores on demand', async () => {
    await renderPage(<ApiDetailPage />);
    await screen.findByRole('heading', { name: 'Gateway deployment missing' });
    // The distinction the banner exists to make: published, and not serving.
    expect(screen.getByText('Not deployed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Restore gateway deployment/ }));
    await screen.findByText('Gateway deployment restored');
    expect(apisApi.restoreGateway).toHaveBeenCalledWith(API.id);
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Gateway deployment missing' }),
      ).not.toBeInTheDocument();
    });
  });

  it('keeps the banner and reports why when the restore fails', async () => {
    vi.mocked(apisApi.restoreGateway).mockRejectedValue(new Error('Gateway unavailable'));
    await renderPage(<ApiDetailPage />);
    await screen.findByRole('heading', { name: 'Gateway deployment missing' });
    fireEvent.click(screen.getByRole('button', { name: /Restore gateway deployment/ }));
    await screen.findByText('Gateway unavailable');
    expect(screen.getByRole('heading', { name: 'Gateway deployment missing' })).toBeInTheDocument();
  });

  it('offers nothing to restore while the API is deployed', async () => {
    api = { ...API };
    await renderPage(<ApiDetailPage />);
    await screen.findByRole('heading', { name: API.name });
    expect(
      screen.queryByRole('heading', { name: 'Gateway deployment missing' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Not deployed')).not.toBeInTheDocument();
  });
});
