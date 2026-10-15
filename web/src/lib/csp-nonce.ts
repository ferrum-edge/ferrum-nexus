import { setNonce } from 'get-nonce';

/**
 * The per-response CSP nonce the server writes into the SPA shell (issue #587).
 *
 * The shell's policy has no `style-src 'unsafe-inline'`, so every <style>
 * element the UI injects at runtime must carry this nonce: Radix's scroll lock
 * behind Dialog, Select and DropdownMenu (through `react-style-singleton`,
 * which reads it from `get-nonce`) and the Select viewport (through its
 * `nonce` prop).
 */
let current: string | undefined;

/** Read the shell's nonce and hand it to the style injectors. Call once, before render. */
export function installCspNonce(doc: Document = document): string | undefined {
  const meta = doc.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]');
  // Browsers hide a nonce attribute's value from getAttribute once the policy
  // applies; the `nonce` property keeps it.
  current = meta?.nonce || meta?.getAttribute('nonce') || undefined;
  if (current) setNonce(current);
  return current;
}

/** The installed nonce, or undefined outside a templated shell (tests, no meta). */
export function cspNonce(): string | undefined {
  return current;
}
