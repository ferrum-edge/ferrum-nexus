import { useLocation } from '@tanstack/react-router';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { NavPath } from './nav';

interface NavLocationContextValue {
  path: NavPath | null;
  setPath: (path: NavPath | null) => void;
}

const NavLocationContext = createContext<NavLocationContextValue | null>(null);

/**
 * Holds the nav entry the current page asks the header's location bar and the
 * sidebar to show as current, when that differs from what its URL implies.
 */
export function NavLocationProvider({ children }: { children: ReactNode }): ReactElement {
  const [path, setPath] = useState<NavPath | null>(null);
  const value = useMemo(() => ({ path, setPath }), [path]);
  return <NavLocationContext.Provider value={value}>{children}</NavLocationContext.Provider>;
}

/**
 * Show `path`'s nav entry as the current page while the calling component is
 * mounted — for a page whose URL sits in one section but whose content belongs
 * to another, such as an administrator managing somebody else's API under
 * `/apis/$apiId`. `null` leaves the location the URL implies.
 */
export function useNavLocationOverride(path: NavPath | null): void {
  const setPath = useContext(NavLocationContext)?.setPath;
  useEffect(() => {
    if (!setPath || path === null) return;
    setPath(path);
    return () => setPath(null);
  }, [setPath, path]);
}

/** The path the header and sidebar treat as current: a page's override, or the URL's. */
export function useNavPathname(): string {
  const { pathname } = useLocation();
  return useContext(NavLocationContext)?.path ?? pathname;
}
