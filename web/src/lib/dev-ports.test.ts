import { describe, expect, it } from 'vitest';
import {
  DEFAULT_API_PROXY_TARGET,
  DEFAULT_WEB_PORT,
  parseApiProxyTarget,
  proxyHostFromBind,
  resolveDevServerPorts,
} from './dev-ports';

describe('resolveDevServerPorts', () => {
  it('keeps the documented single-stack defaults', () => {
    expect(resolveDevServerPorts({})).toEqual({
      webPort: DEFAULT_WEB_PORT,
      apiProxyTarget: DEFAULT_API_PROXY_TARGET,
    });
    expect(
      resolveDevServerPorts({
        NEXUS_WEB_PORT: '  ',
        VITE_DEV_PORT: '',
        NEXUS_PORT: '   ',
      }),
    ).toEqual({
      webPort: 5173,
      apiProxyTarget: 'http://127.0.0.1:8787',
    });
  });

  it('reads NEXUS_WEB_PORT and derives the proxy from NEXUS_PORT', () => {
    expect(
      resolveDevServerPorts({
        NEXUS_WEB_PORT: '5175',
        NEXUS_PORT: '8788',
      }),
    ).toEqual({
      webPort: 5175,
      apiProxyTarget: 'http://127.0.0.1:8788',
    });
  });

  it('falls back to VITE_DEV_PORT when NEXUS_WEB_PORT is unset', () => {
    expect(resolveDevServerPorts({ VITE_DEV_PORT: '5180' }).webPort).toBe(5180);
  });

  it('lets NEXUS_WEB_PORT win over VITE_DEV_PORT', () => {
    expect(resolveDevServerPorts({ NEXUS_WEB_PORT: '5175', VITE_DEV_PORT: '5180' }).webPort).toBe(
      5175,
    );
  });

  it('treats a wildcard API bind as loopback in the derived proxy URL', () => {
    expect(
      resolveDevServerPorts({ NEXUS_HOST: '0.0.0.0', NEXUS_PORT: '8788' }).apiProxyTarget,
    ).toBe('http://127.0.0.1:8788');
    expect(resolveDevServerPorts({ NEXUS_HOST: '[::]', NEXUS_PORT: '8788' }).apiProxyTarget).toBe(
      'http://127.0.0.1:8788',
    );
  });

  it('brackets an IPv6 API host in the derived proxy URL', () => {
    expect(resolveDevServerPorts({ NEXUS_HOST: '::1', NEXUS_PORT: '8788' }).apiProxyTarget).toBe(
      'http://[::1]:8788',
    );
  });

  it('lets NEXUS_API_PROXY_TARGET override the derived origin', () => {
    expect(
      resolveDevServerPorts({
        NEXUS_PORT: '8788',
        NEXUS_API_PROXY_TARGET: 'http://127.0.0.1:9001/',
      }).apiProxyTarget,
    ).toBe('http://127.0.0.1:9001');
  });

  it('names the offending variable when a port is invalid', () => {
    expect(() => resolveDevServerPorts({ NEXUS_WEB_PORT: 'nope' })).toThrow(
      /NEXUS_WEB_PORT must be an integer between 1 and 65535 \(got "nope"\)/,
    );
    expect(() => resolveDevServerPorts({ VITE_DEV_PORT: '0' })).toThrow(/VITE_DEV_PORT/);
    expect(() => resolveDevServerPorts({ NEXUS_PORT: '65536' })).toThrow(/NEXUS_PORT/);
    expect(() => resolveDevServerPorts({ NEXUS_WEB_PORT: '5173.5' })).toThrow(/NEXUS_WEB_PORT/);
  });

  it('does not parse NEXUS_PORT when an explicit proxy target is set', () => {
    expect(
      resolveDevServerPorts({
        NEXUS_PORT: 'not-a-port',
        NEXUS_API_PROXY_TARGET: 'https://api.example.test',
      }).apiProxyTarget,
    ).toBe('https://api.example.test');
  });
});

describe('parseApiProxyTarget', () => {
  it('accepts http and https origins and strips a trailing slash', () => {
    expect(parseApiProxyTarget('http://127.0.0.1:8788/')).toBe('http://127.0.0.1:8788');
    expect(parseApiProxyTarget(' https://nexus.example.test ')).toBe('https://nexus.example.test');
  });

  it('rejects anything that is not a bare origin', () => {
    const needle = new RegExp(
      'NEXUS_API_PROXY_TARGET must be an absolute http\\(s\\) URL with no path, ' +
        'query, credentials, or fragment',
    );
    for (const value of [
      'not a url',
      'ftp://127.0.0.1:8787',
      'http://127.0.0.1:8787/api',
      'http://127.0.0.1:8787?x=1',
      'http://127.0.0.1:8787#frag',
      'http://user:pass@127.0.0.1:8787',
    ]) {
      expect(() => parseApiProxyTarget(value)).toThrow(needle);
    }
  });
});

describe('proxyHostFromBind', () => {
  it('defaults empty values to loopback', () => {
    expect(proxyHostFromBind(undefined)).toBe('127.0.0.1');
    expect(proxyHostFromBind('  ')).toBe('127.0.0.1');
  });

  it('keeps a concrete bind address', () => {
    expect(proxyHostFromBind('127.0.0.1')).toBe('127.0.0.1');
    expect(proxyHostFromBind('localhost')).toBe('localhost');
  });
});
