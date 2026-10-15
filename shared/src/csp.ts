/**
 * The placeholder Vite writes as every `nonce` attribute in the built SPA
 * shell (`html.cspNonce`), including `<meta property="csp-nonce">`. The server
 * replaces it with a fresh nonce per response, the same one the shell's
 * `style-src` names (issue #587).
 */
export const CSP_NONCE_PLACEHOLDER = '__FERRUM_NEXUS_CSP_NONCE__';
