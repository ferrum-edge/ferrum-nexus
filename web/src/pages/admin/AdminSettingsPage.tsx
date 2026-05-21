import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { BrandingSettings, CaptchaSettings } from '@ferrum-nexus/shared';

interface FullSettings {
  branding: BrandingSettings;
  captcha: CaptchaSettings;
  registrationEnabled: boolean;
  emailVerificationRequired: boolean;
  sender: {
    from: string;
    smtpHost: string | null;
    smtpPort: number | null;
    smtpUsername: string | null;
    smtpSecure: boolean;
    smtpPasswordConfigured: boolean;
  };
  captchaSecretConfigured: boolean;
}

export function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: async () => api<FullSettings>('/admin/settings'),
  });

  const [branding, setBranding] = useState<BrandingSettings | null>(null);
  const [captcha, setCaptcha] = useState<CaptchaSettings & { secret?: string }>({
    enabled: false,
    provider: null,
    siteKey: null,
  });
  const [sender, setSender] = useState({
    from: '',
    smtpHost: '',
    smtpPort: 587 as number | null,
    smtpUsername: '',
    smtpPassword: '',
    smtpSecure: false,
  });
  const [registration, setRegistration] = useState({
    registrationEnabled: true,
    emailVerificationRequired: true,
  });

  useEffect(() => {
    if (!data) return;
    setBranding(data.branding);
    setCaptcha({ ...data.captcha });
    setSender({
      from: data.sender.from,
      smtpHost: data.sender.smtpHost ?? '',
      smtpPort: data.sender.smtpPort,
      smtpUsername: data.sender.smtpUsername ?? '',
      smtpPassword: '',
      smtpSecure: data.sender.smtpSecure,
    });
    setRegistration({
      registrationEnabled: data.registrationEnabled,
      emailVerificationRequired: data.emailVerificationRequired,
    });
  }, [data]);

  const saveBranding = useMutation({
    mutationFn: async () =>
      api<void>('/admin/settings/branding', { method: 'PUT', json: branding }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-settings'] }),
  });
  const saveCaptcha = useMutation({
    mutationFn: async () =>
      api<void>('/admin/settings/captcha', { method: 'PUT', json: captcha }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-settings'] }),
  });
  const saveSender = useMutation({
    mutationFn: async () =>
      api<void>('/admin/settings/sender', {
        method: 'PUT',
        json: {
          ...sender,
          smtpHost: sender.smtpHost || null,
          smtpUsername: sender.smtpUsername || null,
          smtpPassword: sender.smtpPassword || undefined,
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-settings'] }),
  });
  const saveRegistration = useMutation({
    mutationFn: async () =>
      api<void>('/admin/settings/registration', { method: 'PUT', json: registration }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-settings'] }),
  });

  if (!branding) return <p className="muted">Loading…</p>;

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="card space-y-3">
        <h2 className="font-semibold">Branding</h2>
        <div>
          <label className="label">Product name</label>
          <input className="input" value={branding.productName} onChange={(e) => setBranding({ ...branding, productName: e.target.value })} />
        </div>
        <div>
          <label className="label">Logo URL</label>
          <input className="input" value={branding.logoUrl ?? ''} onChange={(e) => setBranding({ ...branding, logoUrl: e.target.value || null })} />
        </div>
        <div>
          <label className="label">Primary color (hex)</label>
          <input className="input" value={branding.primaryColor} onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value })} />
        </div>
        <div>
          <label className="label">Default theme</label>
          <select className="input" value={branding.defaultTheme} onChange={(e) => setBranding({ ...branding, defaultTheme: e.target.value as 'system' | 'light' | 'dark' })}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <div>
          <label className="label">Support email</label>
          <input className="input" value={branding.supportEmail ?? ''} onChange={(e) => setBranding({ ...branding, supportEmail: e.target.value || null })} />
        </div>
        <div>
          <label className="label">Footer notice</label>
          <input className="input" value={branding.footerNotice ?? ''} onChange={(e) => setBranding({ ...branding, footerNotice: e.target.value || null })} />
        </div>
        <button type="button" className="btn-primary" onClick={() => saveBranding.mutate()}>Save branding</button>
      </div>

      <div className="card space-y-3">
        <h2 className="font-semibold">CAPTCHA</h2>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={captcha.enabled} onChange={(e) => setCaptcha({ ...captcha, enabled: e.target.checked })} />
          <span className="text-sm">Enable CAPTCHA on registration</span>
        </label>
        <div>
          <label className="label">Provider</label>
          <select className="input" value={captcha.provider ?? ''} onChange={(e) => setCaptcha({ ...captcha, provider: (e.target.value || null) as CaptchaSettings['provider'] })}>
            <option value="">—</option>
            <option value="turnstile">Cloudflare Turnstile</option>
            <option value="recaptcha">Google reCAPTCHA</option>
            <option value="hcaptcha">hCaptcha</option>
          </select>
        </div>
        <div>
          <label className="label">Site key</label>
          <input className="input" value={captcha.siteKey ?? ''} onChange={(e) => setCaptcha({ ...captcha, siteKey: e.target.value || null })} />
        </div>
        <div>
          <label className="label">Secret (writes only)</label>
          <input className="input" type="password" placeholder={data?.captchaSecretConfigured ? '(already configured)' : ''} onChange={(e) => setCaptcha({ ...captcha, secret: e.target.value || undefined })} />
        </div>
        <button type="button" className="btn-primary" onClick={() => saveCaptcha.mutate()}>Save CAPTCHA</button>
      </div>

      <div className="card space-y-3">
        <h2 className="font-semibold">Email sender</h2>
        <div>
          <label className="label">From</label>
          <input className="input" value={sender.from} onChange={(e) => setSender({ ...sender, from: e.target.value })} />
        </div>
        <div>
          <label className="label">SMTP host</label>
          <input className="input" value={sender.smtpHost} onChange={(e) => setSender({ ...sender, smtpHost: e.target.value })} />
        </div>
        <div>
          <label className="label">SMTP port</label>
          <input className="input" type="number" value={sender.smtpPort ?? ''} onChange={(e) => setSender({ ...sender, smtpPort: Number(e.target.value) || null })} />
        </div>
        <div>
          <label className="label">SMTP username</label>
          <input className="input" value={sender.smtpUsername} onChange={(e) => setSender({ ...sender, smtpUsername: e.target.value })} />
        </div>
        <div>
          <label className="label">SMTP password</label>
          <input className="input" type="password" placeholder={data?.sender.smtpPasswordConfigured ? '(already configured)' : ''} onChange={(e) => setSender({ ...sender, smtpPassword: e.target.value })} />
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={sender.smtpSecure} onChange={(e) => setSender({ ...sender, smtpSecure: e.target.checked })} />
          <span className="text-sm">Use TLS</span>
        </label>
        <button type="button" className="btn-primary" onClick={() => saveSender.mutate()}>Save sender</button>
      </div>

      <div className="card space-y-3">
        <h2 className="font-semibold">Registration</h2>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={registration.registrationEnabled} onChange={(e) => setRegistration({ ...registration, registrationEnabled: e.target.checked })} />
          <span className="text-sm">Allow new registrations</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={registration.emailVerificationRequired} onChange={(e) => setRegistration({ ...registration, emailVerificationRequired: e.target.checked })} />
          <span className="text-sm">Require email verification</span>
        </label>
        <button type="button" className="btn-primary" onClick={() => saveRegistration.mutate()}>Save registration</button>
      </div>
    </section>
  );
}
