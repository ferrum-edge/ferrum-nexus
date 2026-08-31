import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { BrandingResponse, CaptchaConfigResponse } from '@ferrum-nexus/shared';
import { authApi, brandingApi } from '../lib/api';
import { queryKeys } from './keys';

/** Public branding (portal name, logo, colours) — safe before authentication. */
export function useBranding(): UseQueryResult<BrandingResponse> {
  return useQuery({
    queryKey: queryKeys.branding,
    queryFn: () => brandingApi.get(),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Public CAPTCHA widget configuration for the login/register forms. */
export function useCaptchaConfig(): UseQueryResult<CaptchaConfigResponse> {
  return useQuery({
    queryKey: queryKeys.captcha,
    queryFn: () => authApi.captcha(),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
