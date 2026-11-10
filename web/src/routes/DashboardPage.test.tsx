/**
 * The dashboard's panels and counts tell "nothing here" apart from "not
 * loaded yet" and "could not load", and count only live APIs.
 */

import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';

interface FakeQuery {
  data: { items: unknown[]; total: number } | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
}

const loaded = (items: unknown[] = []): FakeQuery => ({
  data: { items, total: items.length },
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
});
const loading = (): FakeQuery => ({
  data: undefined,
  isLoading: true,
  isError: false,
  isFetching: true,
  refetch: vi.fn(),
});
const failed = (): FakeQuery => ({
  data: undefined,
  isLoading: false,
  isError: true,
  isFetching: false,
  refetch: vi.fn(),
});

const state = vi.hoisted(() => ({
  session: { canProvider: true, canAdmin: true },
  queries: {} as Record<string, unknown>,
  apiQueries: [] as unknown[],
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../stores/auth', () => ({
  useAuth: () => ({ user: { display_name: 'Ada' }, ...state.session }),
}));
vi.mock('../hooks/useAccessRequests', () => ({
  useAccessRequests: (query: { mine?: boolean }) =>
    query.mine ? state.queries.myRequests : state.queries.providerRequests,
}));
vi.mock('../hooks/useGrants', () => ({ useGrants: () => state.queries.myGrants }));
vi.mock('../hooks/useCredentials', () => ({
  useCredentials: () => state.queries.myCredentials,
}));
vi.mock('../hooks/useApis', () => ({
  useApis: (query: unknown) => {
    state.apiQueries.push(query);
    return state.queries.allApis;
  },
  useMyApis: (query: unknown) => {
    state.apiQueries.push({ ...(query as object), mine: true });
    return state.queries.providerApis;
  },
}));
vi.mock('../hooks/useUsers', () => ({ useUsers: () => state.queries.allUsers }));
vi.mock('../hooks/useAuditLogs', () => ({ useAuditLogs: () => state.queries.recentAudit }));

beforeEach(() => {
  state.session = { canProvider: true, canAdmin: true };
  state.apiQueries = [];
  state.queries = {
    myRequests: loaded(),
    providerRequests: loaded(),
    myGrants: loaded(),
    myCredentials: loaded(),
    providerApis: loaded(),
    allUsers: loaded(),
    allApis: loaded(),
    recentAudit: loaded(),
  };
});

afterEach(cleanup);

it('shows an error with a retry, not "nothing waiting", when a panel query failed', () => {
  state.queries.providerRequests = failed();
  render(<DashboardPage />);
  expect(screen.queryByText('Nothing waiting on you')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load data');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

it('shows no empty state while a panel query is still loading', () => {
  state.session = { canProvider: false, canAdmin: false };
  state.queries.myCredentials = loading();
  render(<DashboardPage />);
  expect(screen.queryByText('No gateway credentials')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows the empty state once a panel query loaded no rows', () => {
  state.session = { canProvider: false, canAdmin: false };
  render(<DashboardPage />);
  expect(screen.getByText('No gateway credentials')).toBeInTheDocument();
  expect(screen.getByText('No access requests yet')).toBeInTheDocument();
});

it('shows a dash rather than zero for a count whose query failed', () => {
  state.queries.allUsers = failed();
  render(<DashboardPage />);
  expect(screen.getByText('Portal accounts').previousElementSibling).toHaveTextContent('—');
  expect(screen.getByText('Published APIs').previousElementSibling).toHaveTextContent('0');
});

it('counts only published APIs as live', () => {
  render(<DashboardPage />);
  expect(state.apiQueries).toContainEqual(expect.objectContaining({ status: 'published' }));
  expect(state.apiQueries).toContainEqual(
    expect.objectContaining({ mine: true, status: 'published' }),
  );
  expect(
    state.apiQueries.every((query) => (query as { status?: string }).status === 'published'),
  ).toBe(true);
});
