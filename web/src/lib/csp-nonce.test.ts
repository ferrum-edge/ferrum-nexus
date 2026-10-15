import { getNonce } from 'get-nonce';
import { afterEach, describe, expect, it } from 'vitest';

import { cspNonce, installCspNonce } from './csp-nonce';

afterEach(() => {
  document.head.innerHTML = '';
});

describe('installCspNonce', () => {
  it("reads the shell's csp-nonce meta and hands it to the style injectors", () => {
    document.head.innerHTML = '<meta property="csp-nonce" nonce="abc123">';
    expect(installCspNonce()).toBe('abc123');
    expect(cspNonce()).toBe('abc123');
    // react-style-singleton (Radix's scroll lock) takes its nonce from here.
    expect(getNonce()).toBe('abc123');
  });

  it('leaves the nonce unset when the shell has none', () => {
    expect(installCspNonce()).toBeUndefined();
    expect(cspNonce()).toBeUndefined();
  });
});
