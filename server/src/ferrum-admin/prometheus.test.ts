import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePrometheusText, type PrometheusSample } from './prometheus.js';

/**
 * A scrape shaped like Edge's, with everything the parser has to survive: HELP
 * and TYPE comments, two proxies, two namespaces, an unlabelled family, a
 * family Nexus has never heard of, escaped label values, a trailing comma, an
 * explicit timestamp, `+Inf`, and a couple of lines that are simply broken.
 */
const FIXTURE = [
  '# HELP ferrum_requests_total Total number of requests processed.',
  '# TYPE ferrum_requests_total counter',
  'ferrum_requests_total{proxy_id="nexus-billing",method="GET",status_code="200",namespace="nexus"} 1200',
  'ferrum_requests_total{proxy_id="nexus-billing",method="POST",status_code="201",namespace="nexus"} 40',
  'ferrum_requests_total{proxy_id="nexus-billing",method="GET",status_code="429",namespace="nexus"} 18',
  // Same proxy id, different tenant — must not be counted as ours.
  'ferrum_requests_total{proxy_id="nexus-billing",method="GET",status_code="200",namespace="other"} 999',
  // A different proxy in our namespace.
  'ferrum_requests_total{proxy_id="nexus-shipping",method="GET",status_code="200",namespace="nexus"} 7',
  '# TYPE ferrum_request_duration_ms histogram',
  'ferrum_request_duration_ms_bucket{proxy_id="nexus-billing",namespace="nexus",le="10"} 900',
  'ferrum_request_duration_ms_bucket{proxy_id="nexus-billing",namespace="nexus",le="100"} 1230',
  'ferrum_request_duration_ms_bucket{proxy_id="nexus-billing",namespace="nexus",le="+Inf"} 1258',
  'ferrum_request_duration_ms_sum{proxy_id="nexus-billing",namespace="nexus"} 48123.5',
  'ferrum_request_duration_ms_count{proxy_id="nexus-billing",namespace="nexus"} 1258',
  // A family Nexus does not read, with a trailing comma in the label block.
  'ferrum_mesh_cert_expiry_seconds{namespace="nexus",} 86400',
  // No labels at all, plus an explicit millisecond timestamp.
  'ferrum_rate_limit_exceeded_total 18 1711720800000',
  // Escapes: a quote, a backslash and a newline inside one label value.
  'ferrum_gateway_listener_failures_active{reason="bind \\"failed\\" on C:\\\\edge",protocol="tcp"} 1',
  // Scientific notation and the three non-finite spellings.
  'ferrum_overload_resource_limit{resource="memory"} 1.5e3',
  'ferrum_tls_cert_expiry_seconds{source="file"} +Inf',
  'ferrum_tls_inventory_snapshot_max_age_seconds NaN',
  '',
  '   ',
  '# a bare comment',
  // Broken lines: unterminated quote, missing value, a name that cannot start.
  'ferrum_broken_quote{proxy_id="unterminated} 5',
  'ferrum_missing_value{proxy_id="x"}',
  '9_not_a_name 1',
  'ferrum_requests_total{proxy_id="nexus-billing",method="DELETE",status_code="204",namespace="nexus"} 3',
].join('\n');

function find(samples: PrometheusSample[], name: string): PrometheusSample[] {
  return samples.filter((sample) => sample.name === name);
}

describe('parsePrometheusText', () => {
  it('parses every well-formed line and skips the broken ones', () => {
    const samples = parsePrometheusText(FIXTURE);

    // The three malformed lines and every comment are gone; nothing else is.
    assert.equal(samples.length, 17);
    assert.ok(!samples.some((sample) => sample.name.startsWith('ferrum_broken')));
    assert.ok(!samples.some((sample) => sample.name.startsWith('ferrum_missing')));
    assert.ok(!samples.some((sample) => sample.name.includes('not_a_name')));

    // A line after the broken ones still parses — one bad line is not fatal.
    const deletes = find(samples, 'ferrum_requests_total').filter(
      (sample) => sample.labels.method === 'DELETE',
    );
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]?.value, 3);
  });

  it('keeps label sets intact, including a repeated proxy across namespaces', () => {
    const requests = find(parsePrometheusText(FIXTURE), 'ferrum_requests_total');

    assert.equal(requests.length, 6);
    const ours = requests.filter(
      (sample) => sample.labels.namespace === 'nexus' && sample.labels.proxy_id === 'nexus-billing',
    );
    assert.equal(ours.length, 4);
    assert.deepEqual(
      ours.map((sample) => sample.value).sort((a, b) => a - b),
      [3, 18, 40, 1200],
    );

    // The same proxy id under another tenant is present but distinguishable.
    const theirs = requests.filter((sample) => sample.labels.namespace === 'other');
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0]?.value, 999);
  });

  it('decodes escaped label values', () => {
    const [sample] = find(parsePrometheusText(FIXTURE), 'ferrum_gateway_listener_failures_active');

    assert.equal(sample?.labels.reason, 'bind "failed" on C:\\edge');
    assert.equal(sample?.labels.protocol, 'tcp');
  });

  it('accepts a trailing comma, an unlabelled series and a timestamp', () => {
    const samples = parsePrometheusText(FIXTURE);

    const cert = find(samples, 'ferrum_mesh_cert_expiry_seconds')[0];
    assert.deepEqual(cert?.labels, { namespace: 'nexus' });
    assert.equal(cert?.value, 86_400);

    // The trailing timestamp is ignored, not folded into the value.
    const limited = find(samples, 'ferrum_rate_limit_exceeded_total')[0];
    assert.deepEqual(limited?.labels, {});
    assert.equal(limited?.value, 18);
  });

  it('reads +Inf, NaN and exponent notation', () => {
    const samples = parsePrometheusText(FIXTURE);

    assert.equal(find(samples, 'ferrum_overload_resource_limit')[0]?.value, 1_500);
    assert.equal(
      find(samples, 'ferrum_tls_cert_expiry_seconds')[0]?.value,
      Number.POSITIVE_INFINITY,
    );
    assert.ok(
      Number.isNaN(find(samples, 'ferrum_tls_inventory_snapshot_max_age_seconds')[0]?.value),
    );

    const infBucket = find(samples, 'ferrum_request_duration_ms_bucket').find(
      (sample) => sample.labels.le === '+Inf',
    );
    assert.equal(infBucket?.value, 1_258);
  });

  it('never throws, whatever it is handed', () => {
    for (const body of ['', '   ', '#', '{}', 'not a metric line at all', '\n\n\n', '\u0000']) {
      assert.deepEqual(parsePrometheusText(body), []);
    }
  });

  it('tolerates CRLF line endings', () => {
    const samples = parsePrometheusText(
      '# TYPE ferrum_requests_total counter\r\nferrum_requests_total{proxy_id="p"} 4\r\n',
    );
    assert.deepEqual(samples, [
      { name: 'ferrum_requests_total', labels: { proxy_id: 'p' }, value: 4 },
    ]);
  });
});
