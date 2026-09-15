/*
 * Theme flash prevention. Runs synchronously in <head> before the SPA loads.
 *
 * The storage keys are the literal values of THEME_STORAGE_KEY ('nexus:theme')
 * and THEME_DEFAULT_STORAGE_KEY ('nexus:theme-default') from
 * `@ferrum-nexus/shared`. They are hardcoded here because this file is a plain
 * static script served from public/ and cannot import modules. Keep them in
 * sync.
 *
 * Resolution order matches the theme store: the user's own choice, then the
 * portal's configured default (cached from the last branding payload), then
 * the OS preference.
 */
(function () {
  try {
    var stored = localStorage.getItem('nexus:theme');
    if (stored !== 'light' && stored !== 'dark' && stored !== 'system') {
      stored = localStorage.getItem('nexus:theme-default');
    }
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
