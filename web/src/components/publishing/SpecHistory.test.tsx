import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSpecSummary } from '@ferrum-nexus/shared';
import { API } from '../../../test/fixtures';
import { clearClients, renderPage } from '../../../test/helpers';
import { apisApi } from '../../lib/api';
import { SpecHistory } from './SpecHistory';

vi.mock('../../stores/auth', () => ({ useAuth: () => ({ user: { id: 'provider-1' } }) }));

const revision = (id: string, version: string, createdBy: string | null): ApiSpecSummary => ({
  id,
  api_id: API.id,
  version,
  parsed_title: null,
  parsed_version: version,
  is_current: id === 'rev-3',
  created_by: createdBy,
  rolled_back_from_id: null,
  created_at: API.created_at,
  updated_at: API.created_at,
});

beforeEach(() => {
  vi.spyOn(apisApi, 'revisions').mockResolvedValue({
    items: [
      revision('rev-3', '3.0.0', 'provider-1'),
      revision('rev-2', '2.0.0', 'admin-9f2c'),
      revision('rev-1', '1.0.0', null),
    ],
    total: 3,
  });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

describe('revision authors', () => {
  it('describes who published each revision without printing an account id', async () => {
    renderPage(<SpecHistory api={API} />);
    expect(await screen.findByText('by you')).toBeInTheDocument();
    expect(screen.getByText('by another account')).toBeInTheDocument();
    expect(screen.getByText('author not recorded')).toBeInTheDocument();
    expect(screen.queryByText(/admin-9f2c/)).not.toBeInTheDocument();
    expect(screen.queryByText(/provider-1/)).not.toBeInTheDocument();
  });
});
