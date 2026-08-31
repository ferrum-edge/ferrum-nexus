import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AdminSettingsResponse,
  EmailTemplateKey,
  GetEmailTemplateResponse,
  ListEmailTemplatesResponse,
  MassEmailRequest,
  MassEmailResponse,
  SmtpTestRequest,
  SmtpTestResponse,
  UpdateEmailTemplateRequest,
  UpdateEmailTemplateResponse,
  UpdateSettingsRequest,
  UpdateSettingsResponse,
} from '@ferrum-nexus/shared';
import { adminApi } from '../lib/api';
import { queryKeys } from './keys';

/** Branding, CAPTCHA, SMTP and registration settings (admin only). */
export function useAdminSettings(enabled = true): UseQueryResult<AdminSettingsResponse> {
  return useQuery({
    queryKey: queryKeys.adminSettings,
    queryFn: () => adminApi.getSettings(),
    enabled,
  });
}

/** Persist a partial settings update; omitted sections are untouched. */
export function useUpdateAdminSettings(): UseMutationResult<
  UpdateSettingsResponse,
  Error,
  UpdateSettingsRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSettingsRequest) => adminApi.updateSettings(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminSettings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.branding });
      void queryClient.invalidateQueries({ queryKey: queryKeys.captcha });
    },
  });
}

/** Send a probe email through the configured SMTP relay. */
export function useSmtpTest(): UseMutationResult<SmtpTestResponse, Error, SmtpTestRequest> {
  return useMutation({ mutationFn: (body: SmtpTestRequest) => adminApi.smtpTest(body) });
}

/** All stored email templates plus the full key list. */
export function useEmailTemplates(enabled = true): UseQueryResult<ListEmailTemplatesResponse> {
  return useQuery({
    queryKey: queryKeys.emailTemplates.all,
    queryFn: () => adminApi.listEmailTemplates(),
    enabled,
  });
}

/** One template plus the placeholder names it may interpolate. */
export function useEmailTemplate(
  key: EmailTemplateKey,
  enabled = true,
): UseQueryResult<GetEmailTemplateResponse> {
  return useQuery({
    queryKey: queryKeys.emailTemplates.detail(key),
    queryFn: () => adminApi.getEmailTemplate(key),
    enabled,
  });
}

/** Save a template's subject and bodies. */
export function useUpdateEmailTemplate(): UseMutationResult<
  UpdateEmailTemplateResponse,
  Error,
  { key: EmailTemplateKey; body: UpdateEmailTemplateRequest }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: EmailTemplateKey; body: UpdateEmailTemplateRequest }) =>
      adminApi.updateEmailTemplate(key, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.emailTemplates.all });
    },
  });
}

/** Enqueue a mass email to an audience selector. */
export function useMassEmail(): UseMutationResult<MassEmailResponse, Error, MassEmailRequest> {
  return useMutation({ mutationFn: (body: MassEmailRequest) => adminApi.massEmail(body) });
}
