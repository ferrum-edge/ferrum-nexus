import { useEffect, useState } from 'react';

/** Read the same Tailwind theme token used by the layout's `lg:` utilities. */
function desktopQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  const breakpoint = getComputedStyle(document.documentElement)
    .getPropertyValue('--breakpoint-lg')
    .trim();
  // Fall back to Tailwind's default `lg` when the stylesheet has not exposed the
  // token (for example before it loads): a missing token must never leave the
  // desktop sidebar inert.
  return window.matchMedia(`(min-width: ${breakpoint || '64rem'})`);
}

export function useDesktopSidebar(): boolean {
  const [query] = useState(desktopQuery);
  const [isDesktop, setIsDesktop] = useState(() => query?.matches ?? false);

  useEffect(() => {
    if (!query) return;
    const onChange = (): void => setIsDesktop(query.matches);
    query.addEventListener('change', onChange);
    onChange();
    return () => query.removeEventListener('change', onChange);
  }, [query]);

  return isDesktop;
}
