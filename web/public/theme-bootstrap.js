/*
 * Theme flash prevention. Runs synchronously in <head> before the SPA loads.
 *
 * The storage key is the literal value of THEME_STORAGE_KEY from
 * `@ferrum-nexus/shared` ('nexus:theme'). It is hardcoded here because this
 * file is a plain static script served from public/ and cannot import modules.
 * Keep the two in sync.
 */
(function () {
  try {
    var stored = localStorage.getItem('nexus:theme');
    var resolved;
    if (stored === 'light' || stored === 'dark') {
      resolved = stored;
    } else {
      var prefersLight =
        typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
      resolved = prefersLight ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', resolved);
  } catch (_err) {
    /* Storage can be disabled; the CSS default (dark) remains usable. */
  }
})();
