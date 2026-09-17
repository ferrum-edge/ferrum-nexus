import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../ui/Tooltip';
import { AppShell } from './AppShell';

vi.mock('../../stores/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: {
      id: 'admin',
      display_name: 'Test Admin',
      email: 'admin@example.test',
      role: 'super_admin',
    },
    needsEmailVerification: false,
  }),
}));
vi.mock('../../hooks/useBranding', () => ({
  useBranding: () => ({ data: { portal_name: 'Test portal' } }),
}));
vi.mock('../../stores/theme', () => ({
  useTheme: () => ({ resolved: 'dark', toggle: vi.fn() }),
}));
vi.mock('./NotificationsBell', () => ({ NotificationsBell: () => null }));

/** jsdom has no layout engine; drive the browser's media-query change event. */
function stubDesktopMode(initialMatches: boolean): (matches: boolean) => void {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return matches;
    },
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return (nextMatches) => {
    act(() => {
      matches = nextMatches;
      listeners.forEach((listener) => listener());
    });
  };
}

async function renderShell(path = '/'): Promise<void> {
  const root = createRootRoute({ component: AppShell });
  const routes = [
    { path: '/', title: 'Dashboard page' },
    { path: '/apis', title: 'API management page' },
    { path: '/profile', title: 'Profile page' },
  ].map(({ path, title }) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <h1>{title}</h1>,
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  );
  await act(async () => {
    await router.load();
  });
  await screen.findByRole('button', { name: 'Toggle navigation' });
}

function navigationToggle(): HTMLElement {
  return screen.getByRole('button', { name: 'Toggle navigation' });
}

function drawer(): HTMLElement {
  const sidebar = document.getElementById(navigationToggle().getAttribute('aria-controls') ?? '');
  expect(sidebar).not.toBeNull();
  return sidebar!;
}

beforeEach(() => {
  // Use a different value to catch a JS breakpoint hard-coded independently of CSS.
  document.documentElement.style.setProperty('--breakpoint-lg', '72rem');
  stubDesktopMode(false);
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--breakpoint-lg');
  vi.unstubAllGlobals();
});

describe('mobile navigation drawer', () => {
  it.each(['/', '/apis'])('makes the closed drawer inert on %s', async (path) => {
    await renderShell(path);

    expect(drawer()).toHaveAttribute('inert');
    expect(drawer()).toHaveAttribute('aria-hidden', 'true');
    expect(navigationToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('complementary', { name: 'Primary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Test Admin/ })).not.toBeInTheDocument();
    // Inert is the native tab-order exclusion; jsdom does not implement inert tabbing.
    for (const link of within(drawer()).getAllByRole('link', { hidden: true })) {
      expect(link.closest('[inert]')).toBe(drawer());
    }
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 72rem)');
  });

  it('opens an accessible drawer and focuses its first link', async () => {
    const user = userEvent.setup();
    await renderShell();

    navigationToggle().focus();
    await user.keyboard('{Enter}');

    expect(navigationToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(drawer()).not.toHaveAttribute('inert');
    expect(drawer()).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('complementary', { name: 'Primary' })).toBe(drawer());
    expect(within(drawer()).getAllByRole('link')[0]).toHaveFocus();
  });

  it('closes with Escape and restores focus to the toggle', async () => {
    const user = userEvent.setup();
    await renderShell();
    await user.click(navigationToggle());
    await user.keyboard('{Escape}');

    expect(drawer()).toHaveAttribute('inert');
    expect(drawer()).toHaveAttribute('aria-hidden', 'true');
    expect(navigationToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(navigationToggle()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument();
  });

  it.each(['Close navigation', 'Toggle navigation'])('restores focus after %s', async (name) => {
    const user = userEvent.setup();
    await renderShell();
    await user.click(navigationToggle());
    await user.click(screen.getByRole('button', { name }));

    expect(drawer()).toHaveAttribute('inert');
    expect(navigationToggle()).toHaveFocus();
  });

  it('keeps account navigation working and restores focus when it closes the drawer', async () => {
    const user = userEvent.setup();
    await renderShell('/apis');
    await user.click(navigationToggle());
    await user.click(within(drawer()).getByRole('link', { name: /Test Admin/ }));

    expect(await screen.findByRole('heading', { name: 'Profile page' })).toBeInTheDocument();
    expect(drawer()).toHaveAttribute('inert');
    expect(navigationToggle()).toHaveFocus();
  });

  it('leaves desktop links available and does not move focus on Escape or navigation', async () => {
    stubDesktopMode(true);
    const user = userEvent.setup();
    await renderShell();
    const sidebar = screen.getByRole('complementary', { name: 'Primary' });
    const link = within(sidebar).getByRole('link', { name: 'My APIs' });

    expect(sidebar).not.toHaveAttribute('inert');
    expect(sidebar).not.toHaveAttribute('aria-hidden');
    link.focus();
    await user.keyboard('{Escape}');
    expect(link).toHaveFocus();
    await user.click(link);

    expect(await screen.findByRole('heading', { name: 'API management page' })).toBeInTheDocument();
    expect(link).toHaveFocus();
    expect(sidebar).not.toHaveAttribute('inert');
  });

  it('updates the closed drawer on resize and rescues focus when it becomes hidden', async () => {
    const setDesktop = stubDesktopMode(false);
    await renderShell();
    expect(drawer()).toHaveAttribute('inert');

    setDesktop(true);
    expect(drawer()).not.toHaveAttribute('inert');
    expect(drawer()).not.toHaveAttribute('aria-hidden');
    within(drawer()).getByRole('link', { name: 'My APIs' }).focus();

    setDesktop(false);
    expect(drawer()).toHaveAttribute('inert');
    expect(drawer()).toHaveAttribute('aria-hidden', 'true');
    expect(navigationToggle()).toHaveFocus();
  });

  it('keeps an open drawer available on desktop without focusing the hidden toggle', async () => {
    const setDesktop = stubDesktopMode(false);
    const user = userEvent.setup();
    await renderShell();
    await user.click(navigationToggle());
    const link = within(drawer()).getByRole('link', { name: 'My APIs' });
    link.focus();

    setDesktop(true);
    expect(drawer()).not.toHaveAttribute('inert');
    expect(drawer()).not.toHaveAttribute('aria-hidden');
    expect(link).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(link).toHaveFocus();

    setDesktop(false);
    expect(drawer()).not.toHaveAttribute('inert');
    expect(navigationToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(within(drawer()).getAllByRole('link')[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(drawer()).toHaveAttribute('inert');
    expect(navigationToggle()).toHaveFocus();
  });

  it('removes its media-query subscription when the shell unmounts', async () => {
    await renderShell();
    const query = window.matchMedia('(min-width: 72rem)');
    cleanup();

    expect(query.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
