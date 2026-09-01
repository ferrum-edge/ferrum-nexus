/**
 * Inline SVG icon set — deliberately no icon-library dependency.
 *
 * Every glyph is a 24x24 stroked path that inherits `currentColor`, so icons
 * pick up the surrounding token colour in both themes.
 */

import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Every glyph available to {@link Icon}. */
export type IconName =
  | 'alert'
  | 'audit'
  | 'bell'
  | 'building'
  | 'catalog'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'copy'
  | 'dashboard'
  | 'download'
  | 'external'
  | 'grant'
  | 'key'
  | 'logout'
  | 'mail'
  | 'megaphone'
  | 'menu'
  | 'moon'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'send'
  | 'settings'
  | 'shield'
  | 'spec'
  | 'stack'
  | 'sun'
  | 'trash'
  | 'user'
  | 'users'
  | 'x';

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  alert: (
    <>
      <path d="M12 4 3 20h18L12 4Z" />
      <path d="M12 10v4" />
      <path d="M12 17.5v.5" />
    </>
  ),
  audit: (
    <>
      <path d="M5 4h9l5 5v11H5z" />
      <path d="M14 4v5h5" />
      <path d="M8 13h8M8 16.5h5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  building: (
    <>
      <path d="M4 20V6l7-3v17" />
      <path d="M11 10h6a2 2 0 0 1 2 2v8" />
      <path d="M7 8v.01M7 12v.01M7 16v.01M15 14v.01M15 17v.01" />
      <path d="M3 20h18" />
    </>
  ),
  catalog: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M11 4h7.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H11" />
      <path d="M14 9h3M14 13h3" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A1.5 1.5 0 0 0 5.5 15" />
    </>
  ),
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4 19h16" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  grant: (
    <>
      <path d="M12 3 4 6.5v5c0 4.5 3.3 8.2 8 9.5 4.7-1.3 8-5 8-9.5v-5Z" />
      <path d="m8.75 12 2.25 2.25L15.5 9.75" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9" />
      <path d="M17 12v3.5M20 12v2.5" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
      <path d="M15.5 8 20 12l-4.5 4" />
      <path d="M20 12H10" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 10v4a2 2 0 0 0 2 2h2l8 4V4L8 8H6a2 2 0 0 0-2 2Z" />
      <path d="M19 9.5a3.5 3.5 0 0 1 0 5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.5-5.8" />
      <path d="M20 4v5h-5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  send: (
    <>
      <path d="M20 4 3.5 10.5 10 13l2.5 6.5Z" />
      <path d="m10 13 10-9" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M17.9 6.1l-1.4 1.4M7.5 16.5l-1.4 1.4M17.9 17.9l-1.4-1.4M7.5 7.5 6.1 6.1" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4 6.5v5c0 4.5 3.3 8.2 8 9.5 4.7-1.3 8-5 8-9.5v-5Z" />
      <path d="M12 9v4M12 16v.5" />
    </>
  ),
  spec: (
    <>
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
      <path d="m13 11 3-3-3-3" />
      <path d="M20 8h-7" />
    </>
  ),
  stack: (
    <>
      <path d="m12 3 8 4.5-8 4.5-8-4.5Z" />
      <path d="m4 12 8 4.5 8-4.5" />
      <path d="m4 16.5 8 4.5 8-4.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.4 5.6 17 7M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9.5 7V5h5v2" />
      <path d="M6.5 7 7 20h10l.5-13" />
      <path d="M10.5 11v5M13.5 11v5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="8.5" r="3.5" />
      <path d="M3 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6" />
      <path d="M18 14.2A6.5 6.5 0 0 1 21 20" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
};

export interface IconProps {
  name: IconName;
  className?: string;
  /** Accessible label; when omitted the icon is hidden from assistive tech. */
  title?: string;
}

/** Render one glyph from the built-in set. */
export function Icon({ name, className, title }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-4 w-4 shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
