import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BACKEND_READ_TIMEOUT_MS,
  DEFAULT_BACKEND_WRITE_TIMEOUT_MS,
  DEFAULT_PAGE_SIZE,
  MAX_CORS_ORIGINS,
  MAX_RATE_LIMIT_REQUESTS,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';
import { API, RAW_SPEC, SPEC } from '../../test/fixtures';
import { changeField, clearClients, deferred, renderPage } from '../../test/helpers';
import { apisApi } from '../lib/api';
import { ApiNewPage } from './ApiNewPage';
import { ApisPage } from './ApisPage';

const session = vi.hoisted(() => ({ allowed: true }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async () => {
  const { TestLink } = await import('../../test/helpers');
  return { Link: TestLink, useNavigate: () => navigate };
});
vi.mock('../stores/auth', () => ({ useAuth: () => ({ hasRole: () => session.allowed }) }));
vi.mock('../components/ui/Select', async () => {
  const { NativeLabeledSelect } = await import('../../test/helpers');
  return { LabeledSelect: NativeLabeledSelect };
});

beforeEach(() => {
  session.allowed = true;
  navigate.mockReset();
  vi.spyOn(apisApi, 'publish').mockResolvedValue({ api: API, spec: SPEC });
  vi.spyOn(apisApi, 'list').mockResolvedValue({ items: [], total: 0 });
});

describe('publishing entry points', () => {
  it('offers publication from the empty provider inventory', async () => {
    renderPage(<ApisPage />);
    await screen.findByText('You have not published an API yet');
    expect(screen.getByRole('link', { name: 'Publish an API' })).toHaveAttribute(
      'href',
      '/apis/new',
    );
    expect(apisApi.list).toHaveBeenCalledWith({ mine: true, limit: DEFAULT_PAGE_SIZE, offset: 0 });
  });

  it('paginates the provider inventory and opens an API by mouse or keyboard', async () => {
    vi.mocked(apisApi.list).mockImplementation(async (query = {}) => ({
      items: query.offset ? [{ ...API, id: 'api-2', name: 'Open API', requestable: false }] : [API],
      total: DEFAULT_PAGE_SIZE + 1,
    }));
    renderPage(<ApisPage />);
    const row = (await screen.findByText(API.name)).closest('tr')!;
    fireEvent.click(row);
    expect(navigate).toHaveBeenLastCalledWith({ to: '/apis/$apiId', params: { apiId: API.id } });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Open API');
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(apisApi.list).toHaveBeenLastCalledWith({
      mine: true,
      limit: DEFAULT_PAGE_SIZE,
      offset: DEFAULT_PAGE_SIZE,
    });
  });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

function fillIdentity(): void {
  changeField(/^Name/, '  Billing API  ');
  changeField(/^Upstream URL/, 'https://billing.example.test');
  changeField(/OpenAPI specification/, RAW_SPEC);
}

// Submit directly in validation tests so the handler's bounds are exercised
// independently of browser-native number-input validation.
function submitForm(): void {
  fireEvent.submit(screen.getByRole('button', { name: 'Publish API' }).closest('form')!);
}

describe('API publishing', () => {
  it('restricts publishing to providers', () => {
    session.allowed = false;
    renderPage(<ApiNewPage />);
    expect(screen.getByText('You do not have access to this area')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish API' })).not.toBeInTheDocument();
    expect(apisApi.publish).not.toHaveBeenCalled();
  });

  it('requires identity and a spec, derives the slug, and publishes with defaults', async () => {
    const pending = deferred<PublishApiResponse>();
    vi.mocked(apisApi.publish).mockImplementation(() => pending.promise);
    renderPage(<ApiNewPage />);
    const publish = screen.getByRole('button', { name: 'Publish API' });
    expect(publish).toBeDisabled();
    changeField(/^Name/, 'Billing API');
    expect(screen.getByLabelText(/^Slug/)).toHaveValue('billing-api');
    expect(publish).toBeDisabled();
    changeField(/^Upstream URL/, 'https://billing.example.test');
    expect(publish).toBeDisabled();
    changeField(/OpenAPI specification/, RAW_SPEC);
    expect(publish).toBeEnabled();
    expect(screen.getByText(/Request and response bodies are not validated/)).toBeInTheDocument();
    expect(screen.queryByText(/Changing this rebuilds/)).not.toBeInTheDocument();
    fireEvent.click(publish);
    await waitFor(() => expect(apisApi.publish).toHaveBeenCalledTimes(1));
    expect(publish).toBeDisabled();
    expect(navigate).not.toHaveBeenCalled();
    expect(apisApi.publish).toHaveBeenCalledWith({
      name: 'Billing API',
      slug: 'billing-api',
      description: null,
      version: '1.0.0',
      upstream_url: 'https://billing.example.test',
      spec: RAW_SPEC,
      auth_plugin: 'key_auth',
      requestable: true,
      visibility: 'public',
      rate_limit: null,
      cors: null,
      allowed_methods: null,
      timeouts: null,
      circuit_breaker: false,
      spec_enforcement: 'docs_only',
    });
    await act(async () => pending.resolve({ api: API, spec: SPEC }));
    expect(await screen.findByText('API published')).toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith({ to: '/apis/$apiId', params: { apiId: API.id } });
  });

  it('preserves a custom slug and publishes the selected runtime policy', async () => {
    renderPage(<ApiNewPage />);
    fillIdentity();
    changeField(/^Slug/, 'Custom Invoices!');
    changeField(/^Name/, '  Renamed billing  ');
    expect(screen.getByLabelText(/^Slug/)).toHaveValue('custom-invoices');
    changeField(/^Description/, '  Export invoice data  ');
    changeField(/^Version/, '2.0.0');
    changeField('Authentication', 'jwt_auth');
    changeField('Visibility', 'internal');
    fireEvent.click(screen.getByLabelText('Require an approved access request'));
    fireEvent.click(screen.getByLabelText('Enforce a rate limit'));
    changeField('Requests', '42');
    changeField('Window', '3600');
    changeField('CORS allowed origins', ' https://one.example.test, https://two.example.test\n');
    fireEvent.click(screen.getByLabelText('Allow credentials'));
    fireEvent.click(screen.getByLabelText('Enforce WebSocket origins'));
    changeField('Additional CORS request headers', 'X-Trace\n X-Client ');
    fireEvent.click(screen.getByRole('button', { name: 'Use the methods declared in the spec' }));
    expect(screen.getByLabelText('GET')).toBeChecked();
    expect(screen.getByLabelText('POST')).toBeChecked();
    fireEvent.click(screen.getByLabelText('POST'));
    fireEvent.click(screen.getByLabelText('DELETE'));
    changeField('Connect timeout (ms)', '500');
    fireEvent.click(screen.getByLabelText('Trip a circuit breaker when the backend fails'));
    changeField('OpenAPI enforcement', 'routes');
    expect(
      screen.getByRole('option', { name: 'Reject requests to paths and methods not in the spec' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Request and response bodies are not validated/)).toBeInTheDocument();
    expect(screen.queryByText(/Changing this rebuilds/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Publish API' }));
    await screen.findByText('API published');
    expect(apisApi.publish).toHaveBeenCalledWith({
      name: 'Renamed billing',
      slug: 'custom-invoices',
      description: 'Export invoice data',
      version: '2.0.0',
      upstream_url: 'https://billing.example.test',
      spec: RAW_SPEC,
      auth_plugin: 'jwt_auth',
      requestable: false,
      visibility: 'internal',
      rate_limit: { limit: 42, window_seconds: 3600 },
      cors: {
        allowed_origins: ['https://one.example.test', 'https://two.example.test'],
        allow_credentials: true,
        allowed_headers: ['X-Trace', 'X-Client'],
        enforce_websocket_origins: false,
      },
      allowed_methods: ['GET', 'DELETE'],
      timeouts: {
        connect_ms: 500,
        read_ms: DEFAULT_BACKEND_READ_TIMEOUT_MS,
        write_ms: DEFAULT_BACKEND_WRITE_TIMEOUT_MS,
      },
      circuit_breaker: true,
      spec_enforcement: 'routes',
    });
  });

  it('rejects an invalid document and permits correction', async () => {
    renderPage(<ApiNewPage />);
    fillIdentity();
    changeField(/OpenAPI specification/, 'not an OpenAPI document');
    submitForm();
    expect(screen.getByText(/Fix it before publishing/)).toBeInTheDocument();
    expect(apisApi.publish).not.toHaveBeenCalled();
    changeField(/OpenAPI specification/, RAW_SPEC);
    fireEvent.click(screen.getByRole('button', { name: 'Publish API' }));
    await screen.findByText('API published');
    expect(screen.queryByText(/Fix it before publishing/)).not.toBeInTheDocument();
  });

  it.each(['', '0', String(MAX_RATE_LIMIT_REQUESTS + 1)])(
    'rejects an out-of-range request limit (%s)',
    (value) => {
      renderPage(<ApiNewPage />);
      fillIdentity();
      fireEvent.click(screen.getByLabelText('Enforce a rate limit'));
      changeField('Requests', value);
      submitForm();
      expect(screen.getByRole('alert')).toHaveTextContent('The request limit must be');
      expect(apisApi.publish).not.toHaveBeenCalled();
    },
  );

  it('rejects too many CORS origins and invalid timeouts before publishing', () => {
    renderPage(<ApiNewPage />);
    fillIdentity();
    const origins = Array.from(
      { length: MAX_CORS_ORIGINS + 1 },
      (_, i) => `https://app${i}.example.test`,
    );
    changeField('CORS allowed origins', origins.join('\n'));
    submitForm();
    expect(screen.getByRole('alert')).toHaveTextContent('A CORS policy may list at most');
    changeField('CORS allowed origins', '');
    changeField('Read timeout (ms)', '0');
    submitForm();
    expect(screen.getByRole('alert')).toHaveTextContent('The read timeout must be');
    expect(apisApi.publish).not.toHaveBeenCalled();
  });

  it('retains a rejected draft and navigates after a successful retry', async () => {
    vi.mocked(apisApi.publish).mockRejectedValueOnce(new Error('Gateway unavailable'));
    renderPage(<ApiNewPage />);
    fillIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Publish API' }));
    await waitFor(() => expect(apisApi.publish).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish API' })).toBeEnabled());
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(RAW_SPEC);
    expect(screen.queryByText('API published')).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Publish API' }));
    await screen.findByText('API published');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('cancels back to the API list without publishing', () => {
    renderPage(<ApiNewPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/apis' });
    expect(apisApi.publish).not.toHaveBeenCalled();
  });
});
