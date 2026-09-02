import { RouterProvider } from '@tanstack/react-router';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { ERROR_CODES } from '@ferrum-nexus/shared';
import { ApiError } from './lib/api';
import { router } from './router';
import { AuthProvider } from './stores/auth';
import { ThemeProvider } from './stores/theme';
import { ToastProvider, emitToast } from './stores/toast';
import { TooltipProvider } from './components/ui/Tooltip';
import { BrandingStyles } from './components/layout/BrandingStyles';

/**
 * Error codes that always have a dedicated in-page treatment, so a toast would
 * only duplicate what the user already sees.
 */
const LOCALLY_HANDLED = new Set<string>([
  ERROR_CODES.UNAUTHORIZED,
  ERROR_CODES.VALIDATION_FAILED,
  ERROR_CODES.CAPTCHA_FAILED,
  ERROR_CODES.EMAIL_NOT_VERIFIED,
]);

/** True when a failure should surface as a global toast. */
function shouldToast(error: unknown, meta: Record<string, unknown> | undefined): boolean {
  if (meta?.silent === true) return false;
  if (!ApiError.is(error)) return true;
  if (LOCALLY_HANDLED.has(error.code)) return false;
  const handled = meta?.handledCodes;
  if (Array.isArray(handled) && handled.includes(error.code)) return false;
  return true;
}

/**
 * Text shown in the failure toast.
 *
 * An `EDGE_ERROR` from a gateway validation refusal (400/409/422) carries
 * `details.gateway_message` — the gateway's own reason, e.g.
 * "FERRUM_BASIC_AUTH_HMAC_SECRET must be set…". A provider cannot act on
 * "the gateway rejected the request" alone, so the reason is appended when the
 * message does not already contain it.
 */
export function describeError(error: unknown): string {
  if (!ApiError.is(error)) {
    return error instanceof Error ? error.message : 'Unexpected error';
  }
  const details = error.details;
  const gatewayMessage =
    details !== null && typeof details === 'object' && 'gateway_message' in details
      ? (details as { gateway_message?: unknown }).gateway_message
      : undefined;
  if (typeof gatewayMessage !== 'string' || gatewayMessage === '') return error.message;
  return error.message.includes(gatewayMessage)
    ? error.message
    : `${error.message} — ${gatewayMessage}`;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 300_000,
      retry: (failureCount, error) => !ApiError.is(error) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
  },
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (shouldToast(error, query.meta)) {
        emitToast('Could not load data', { description: describeError(error), variant: 'error' });
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (shouldToast(error, mutation.meta)) {
        emitToast('Request failed', { description: describeError(error), variant: 'error' });
      }
    },
  }),
});

/**
 * Provider composition. Order matters: `AuthProvider` lives inside
 * `QueryClientProvider` because it clears the cache on identity change, and the
 * router mounts last so no page renders before auth has bootstrapped.
 */
export function App(): ReactElement {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <TooltipProvider>
              <BrandingStyles />
              <RouterProvider router={router} />
            </TooltipProvider>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
