import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ApiUsageResponse } from '@ferrum-nexus/shared';

import { UsageDetails } from './ApiDetailPage';

const usage: ApiUsageResponse = {
  available: false,
  unavailable_reason: 'The gateway has no request metrics for this API yet.',
  sampled_at: '2026-09-08T00:00:00.000Z',
  requests: {
    total: 0,
    by_status_class: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    by_status: {},
    by_method: {},
    rate_limited: 0,
    unauthorized: 0,
    forbidden: 0,
  },
  latency_ms: null,
  backend: { status: 'healthy', detail: 'The circuit breaker is closed.' },
};

afterEach(cleanup);

describe('API usage measurements', () => {
  it('shows the missing-series reason and backend state without fabricated zeros', () => {
    render(<UsageDetails usage={usage} />);
    expect(screen.getByText(/Gateway metrics are unavailable/)).toHaveTextContent(
      usage.unavailable_reason!,
    );
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText(/The circuit breaker is closed/)).toBeInTheDocument();
    expect(screen.queryByText('Requests')).not.toBeInTheDocument();
    expect(screen.queryByText(/429 rate limited/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No timed requests yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No traffic/)).not.toBeInTheDocument();
  });

  it('displays explicitly measured zero traffic', () => {
    render(<UsageDetails usage={{ ...usage, available: true }} />);
    expect(screen.queryByText(/Gateway metrics are unavailable/)).not.toBeInTheDocument();
    expect(screen.getByText('Requests').nextElementSibling).toHaveTextContent('0');
    expect(screen.getByText('429 rate limited 0')).toBeInTheDocument();
    expect(screen.getByText('No timed requests yet')).toBeInTheDocument();
  });
});
