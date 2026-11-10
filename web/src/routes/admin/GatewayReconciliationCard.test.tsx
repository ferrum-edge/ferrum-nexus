/**
 * The gateway-reference repair card through the second half of an incident.
 *
 * After "Repair all" the dead proxy ids are cleared but the APIs are still not
 * deployed, and the server keeps the verdict `orphaned` with both orphan counts
 * at zero and `awaiting_restore` above it. The card used to read only the two
 * orphan counts: it showed zeros, kept offering a repair with nothing left to
 * repair, and reported a re-check that found APIs awaiting a restore, and a
 * repair whose rows failed, as successes.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EdgeReconciliationHealth,
  GatewayReconciliationReport,
  RepairGatewayReferencesResponse,
} from '@ferrum-nexus/shared';
import { GatewayReconciliationCard, recheckToast, repairToast } from './AdminSettingsPage';

const state = vi.hoisted(() => ({
  reconciliation: null as unknown,
  repairResponse: null as unknown,
  push: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('../../hooks/useHealth', () => ({
  useEdgeHealth: () => ({ data: { reconciliation: state.reconciliation } }),
}));
vi.mock('../../hooks/useGatewayReconciliation', () => ({
  useReconcileGateway: () => ({ mutate: vi.fn(), isPending: false }),
  useRepairGatewayReferences: () => ({
    isPending: false,
    mutate: (_body: unknown, options: { onSuccess: (response: unknown) => void }) =>
      options.onSuccess(state.repairResponse),
  }),
}));
vi.mock('../../stores/auth', () => ({ useAuth: () => ({ canSuperAdmin: true }) }));
vi.mock('../../stores/toast', () => ({
  useToast: () => ({ push: state.push, success: vi.fn(), error: vi.fn() }),
}));

const health = (overrides: Partial<EdgeReconciliationHealth>): EdgeReconciliationHealth => ({
  status: 'orphaned',
  checked_at: '2026-11-10T12:00:00.000Z',
  orphaned_consumers: 0,
  orphaned_proxies: 0,
  awaiting_restore: 0,
  complete: true,
  ...overrides,
});

const report = (overrides: Partial<GatewayReconciliationReport>): GatewayReconciliationReport => ({
  status: 'orphaned',
  checked_at: '2026-11-10T12:00:00.000Z',
  namespace: 'nexus',
  consumers: { checked: 3, orphaned: 0, complete: true },
  proxies: { checked: 2, orphaned: 0, complete: true },
  orphaned_consumers: [],
  orphaned_proxies: [],
  awaiting_restore: 0,
  error: null,
  ...overrides,
});

beforeEach(() => {
  state.reconciliation = null;
  state.repairResponse = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GatewayReconciliationCard', () => {
  it('counts the APIs awaiting a restore and points at them once nothing is left to repair', () => {
    state.reconciliation = health({ awaiting_restore: 2 });
    render(<GatewayReconciliationCard />);

    expect(screen.getByText('APIs awaiting a restore').previousElementSibling).toHaveTextContent(
      '2',
    );
    expect(screen.queryByRole('button', { name: 'Repair all' })).not.toBeInTheDocument();
    expect(screen.getByText('Find the APIs to restore').closest('a')).toHaveAttribute(
      'href',
      '/admin/apis',
    );
    expect(screen.getByText(/rebuilds it with “Restore gateway deployment”/)).toBeInTheDocument();
  });

  it('offers the repair while orphaned references remain', () => {
    state.reconciliation = health({ orphaned_consumers: 1, awaiting_restore: 1 });
    render(<GatewayReconciliationCard />);

    expect(screen.getByRole('button', { name: 'Repair all' })).toBeInTheDocument();
    expect(screen.queryByText('Find the APIs to restore')).not.toBeInTheDocument();
  });

  it('reports a repair with a failed row as an error', () => {
    state.reconciliation = health({ orphaned_consumers: 2 });
    state.repairResponse = {
      report: report({}),
      consumers: [
        {
          user_id: 'u1',
          application_id: null,
          previous_ferrum_consumer_id: 'old-1',
          ferrum_consumer_id: 'new-1',
          credentials_requiring_reissue: 1,
          restored_groups: 1,
          error: null,
        },
        {
          user_id: 'u2',
          application_id: 'app-1',
          previous_ferrum_consumer_id: 'old-2',
          ferrum_consumer_id: null,
          credentials_requiring_reissue: 0,
          restored_groups: 0,
          error: 'gateway refused the consumer',
        },
      ],
      apis: [],
    } satisfies RepairGatewayReferencesResponse;
    render(<GatewayReconciliationCard />);

    fireEvent.click(screen.getByRole('button', { name: 'Repair all' }));
    expect(state.push).toHaveBeenCalledWith(
      '1 gateway reference(s) could not be repaired',
      expect.objectContaining({
        variant: 'error',
        description: expect.stringContaining('gateway refused the consumer'),
      }),
    );
  });
});

describe('repairToast', () => {
  it('is a success only when every row was repaired', () => {
    const toast = repairToast({
      report: report({}),
      consumers: [],
      apis: [
        { api_id: 'a1', previous_ferrum_proxy_id: 'p1', flagged: true, error: null },
        // A proxy that came back before the flag is left alone, not a failure.
        { api_id: 'a2', previous_ferrum_proxy_id: 'p2', flagged: false, error: null },
      ],
    });
    expect(toast.variant).toBe('success');
    expect(toast.description).toContain('1 API(s) marked for a gateway restore');
  });

  it('is an error when an API could not be flagged', () => {
    const toast = repairToast({
      report: report({}),
      consumers: [],
      apis: [{ api_id: 'a1', previous_ferrum_proxy_id: 'p1', flagged: false, error: 'locked' }],
    });
    expect(toast.variant).toBe('error');
    expect(toast.description).toContain('locked');
  });
});

describe('recheckToast', () => {
  it('names the APIs still awaiting a restore instead of "0 references"', () => {
    const toast = recheckToast(report({ awaiting_restore: 3 }));
    expect(toast.variant).toBe('info');
    expect(toast.title).toBe('3 API(s) await a gateway restore');
  });

  it('names both orphaned references and APIs awaiting a restore', () => {
    const toast = recheckToast(
      report({ consumers: { checked: 3, orphaned: 2, complete: true }, awaiting_restore: 1 }),
    );
    expect(toast.title).toBe('2 reference(s) are still orphaned; 1 API(s) await a gateway restore');
  });

  it('does not call an unfinished pass healthy', () => {
    const toast = recheckToast(report({ status: 'unknown', error: 'gateway unreachable' }));
    expect(toast.variant).toBe('error');
    expect(toast.description).toBe('gateway unreachable');
  });

  it('says so when every reference is live', () => {
    expect(recheckToast(report({ status: 'ok' })).variant).toBe('success');
  });
});
