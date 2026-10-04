/**
 * The deterministic upstream every end-to-end API is published against.
 *
 * Deliberately tiny and dependency-free: the point of this service is to be a
 * thing the gateway either reached or did not. It echoes back exactly what it
 * received, so a data-plane assertion can tell "the proxy forwarded" from "the
 * proxy answered" without reading gateway logs — and can check *what* was
 * forwarded, which is how the credential-stripping assertions work.
 *
 * Every response carries `x-upstream: ferrum-nexus-e2e`, which is the single
 * header the tests look for when they mean "this came from the backend".
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 9100);

/** Requests served since start — a restart test reads this to prove one. */
let served = 0;

/** Count every method/raw URL pair, including repeated requests and query strings. */
const servedByRoute = new Map();
const MAX_OBSERVED_ROUTES = 1024;
let observed = 0;
let overflow = false;

const server = createServer((request, response) => {
  served += 1;
  const route = `${request.method} ${request.url}`;
  // Only Compose's exact health probe and the exact snapshot read are noise.
  // Other methods, paths and query variants are observations, even if unknown.
  const control = route === 'GET /__e2e/requests';
  const excluded = control || route === 'GET /health';
  let routeServed = 0;
  if (!excluded) {
    observed += 1;
    routeServed = (servedByRoute.get(route) ?? 0) + 1;
    if (servedByRoute.has(route) || servedByRoute.size < MAX_OBSERVED_ROUTES) {
      servedByRoute.set(route, routeServed);
    } else {
      // Bound fixture memory without silently accepting an incomplete snapshot.
      overflow = true;
    }
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-upstream': 'ferrum-nexus-e2e',
    });
    if (control) {
      response.end(
        JSON.stringify({ total: observed, byRoute: Object.fromEntries(servedByRoute), overflow }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        served,
        routeServed,
        method: request.method,
        path: request.url,
        // Echoed so a test can assert the gateway stripped the credential it
        // was given — `hide_credentials` is part of the auth contract, and a
        // key that reaches the backend is a real finding.
        headers: request.headers,
        body,
      }),
    );
  });
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console -- the container's only liveness signal
  console.log(`e2e upstream listening on ${PORT}`);
});
