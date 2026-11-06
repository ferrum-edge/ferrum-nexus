import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ApiUsageResponse } from '@ferrum-nexus/shared';

import { UsageDetails } from './ApiDetailPage';

const GATEWAY_METRICS_UNAVAILABLE = /Gateway metrics are unavailable/;
const CIRCUIT_BREAKER_CLOSED = /The circuit breaker is closed/;
const RATE_LIMITED_429 = /429 rate limited/;
const NO_TIMED_REQUESTS_YET = /No timed requests yet/;
const NO_TRAFFIC = /No traffic/;
const READ_REQUEST_METRICS = /read its request metrics/;

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
    expect(screen.getByText(GATEWAY_METRICS_UNAVAILABLE)).toHaveTextContent(
      usage.unavailable_reason!,
    );
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText(CIRCUIT_BREAKER_CLOSED)).toBeInTheDocument();
    expect(screen.queryByText('Requests')).not.toBeInTheDocument();
    expect(screen.queryByText(RATE_LIMITED_429)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_TIMED_REQUESTS_YET)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_TRAFFIC)).not.toBeInTheDocument();
  });

  it('names a refused metrics read and an unreadable backend state', () => {
    render(
      <UsageDetails
        usage={{
          ...usage,
          unavailable_code: 'refused',
          unavailable_reason:
            'The gateway did not allow this portal to read its request metrics. A portal ' +
            'operator can enable this.',
          backend: {
            status: 'unavailable',
            detail:
              'The gateway did not allow this portal to read its runtime metrics. A portal ' +
              'operator can enable this.',
          },
        }}
      />,
    );
    expect(screen.getByText(GATEWAY_METRICS_UNAVAILABLE)).toHaveTextContent(READ_REQUEST_METRICS);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    expect(screen.queryByText('Requests')).not.toBeInTheDocument();
  });

  it('displays explicitly measured zero traffic', () => {
    render(<UsageDetails usage={{ ...usage, available: true }} />);
    expect(screen.queryByText(GATEWAY_METRICS_UNAVAILABLE)).not.toBeInTheDocument();
    expect(screen.getByText('Requests').nextElementSibling).toHaveTextContent('0');
    expect(screen.getByText('429 rate limited 0')).toBeInTheDocument();
    expect(screen.getByText('No timed requests yet')).toBeInTheDocument();
  });
});
