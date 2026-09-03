/**
 * Smoke test for the palette tab itself: the grouping, the "already on" state,
 * and the trigger editor appearing only where Edge accepts one.
 *
 * `PluginForm` has its own unit tests for the field/validation logic; this one
 * exists because the tab is where the static catalog meets the fetched state,
 * and a card that renders for the wrong plugin (or a trigger editor offered on
 * a plugin the gateway refuses to gate) is a bug no pure-component test sees.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_CATEGORY_LABELS,
  PROVIDER_PLUGINS,
  type Api,
  type ApiPlugin,
} from '@ferrum-nexus/shared';
import { ToastProvider } from '../../stores/toast';
import { PluginsTab } from './PluginsTab';

const API: Api = {
  id: 'api-1',
  name: 'Billing API',
  slug: 'billing',
  description: null,
  owner_user_id: 'user-1',
  ferrum_proxy_id: 'proxy-1',
  upstream_url: 'https://billing.example.com:443',
  namespace: 'nexus',
  version: '1.0.0',
  spec_format: 'openapi',
  requestable: true,
  auth_plugin: 'key_auth',
  rate_limit: null,
  cors: null,
  allowed_methods: null,
  timeouts: null,
  circuit_breaker: false,
  spec_enforcement: 'docs_only',
  status: 'published',
  visibility: 'public',
  listen_path: '/nexus/billing',
  invoke_url: 'https://gw.example.com/nexus/billing',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const SAVED: ApiPlugin = {
  plugin_name: 'ip_restriction',
  enabled: false,
  config: { allow: ['203.0.113.0/24'], mode: 'allow_first' },
  trigger: null,
  created_at: '2026-01-02T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

function stubPlugins(plugins: ApiPlugin[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ plugins }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PluginsTab api={API} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('<PluginsTab>', () => {
  beforeEach(() => stubPlugins([SAVED]));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders every palette plugin, grouped under its category heading', async () => {
    renderTab();
    for (const descriptor of PROVIDER_PLUGINS) {
      expect(await screen.findByText(descriptor.label)).toBeInTheDocument();
    }
    for (const category of new Set(PROVIDER_PLUGINS.map((plugin) => plugin.category))) {
      expect(screen.getByText(PLUGIN_CATEGORY_LABELS[category])).toBeInTheDocument();
    }
  });

  it('marks a saved-but-switched-off plugin as paused, and opens it configured', async () => {
    renderTab();
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    // Its saved allow-list is loaded into the form, not the empty default.
    expect(await screen.findByDisplayValue('203.0.113.0/24')).toBeInTheDocument();
    // …and a plugin that is not configured stays collapsed behind "Configure".
    expect(screen.getAllByRole('button', { name: 'Configure' }).length).toBeGreaterThan(0);
  });

  it('offers the trigger editor only where the gateway accepts one', async () => {
    renderTab();
    await screen.findByText('Paused');

    // `ip_restriction` is the one open card, and it does support a trigger.
    expect(screen.getAllByLabelText('Only run on some requests')).toHaveLength(1);

    // `security_headers` cannot be gated — Edge refuses a trigger on a plugin
    // that owns the initial response-header policy — so opening its card must
    // not add a second trigger editor.
    const card = screen.getByText('Security headers').closest('.fx-card');
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Configure' }));

    expect(within(card as HTMLElement).getByLabelText('Strict-Transport-Security')).toBeVisible();
    expect(within(card as HTMLElement).queryByLabelText('Only run on some requests')).toBeNull();
    expect(screen.getAllByLabelText('Only run on some requests')).toHaveLength(1);
  });

  it('points at the Settings tab for the first-class gateway controls', async () => {
    renderTab();
    await waitFor(() =>
      expect(screen.getByText(/Authentication, the access gate/)).toBeInTheDocument(),
    );
  });
});
