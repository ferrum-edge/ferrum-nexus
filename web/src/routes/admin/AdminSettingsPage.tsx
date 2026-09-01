import { useEffect, useState, type ChangeEvent, type ReactElement } from 'react';
import {
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_LABELS,
  REGISTRABLE_ROLES,
  ROLE_LABELS,
  type AdminSettingsResponse,
  type CaptchaProvider,
  type EmailTemplateKey,
  type ThemePreference,
} from '@ferrum-nexus/shared';
import {
  useAdminSettings,
  useEmailTemplate,
  useSmtpTest,
  useUpdateAdminSettings,
  useUpdateEmailTemplate,
} from '../../hooks/useAdminSettings';
import { useToast } from '../../stores/toast';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '../../components/ui/Card';
import { Checkbox, Field, Input, LabeledInput, LabeledTextarea } from '../../components/ui/Input';
import { LabeledSelect } from '../../components/ui/Select';
import { LoadingPanel } from '../../components/ui/Spinner';
import { Tabs } from '../../components/ui/Tabs';

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Follow the visitor’s system setting' },
];

const CAPTCHA_PROVIDERS: ReadonlyArray<{ value: CaptchaProvider; label: string }> = [
  { value: 'none', label: 'Disabled' },
  { value: 'turnstile', label: 'Cloudflare Turnstile' },
  { value: 'hcaptcha', label: 'hCaptcha' },
  { value: 'recaptcha', label: 'Google reCAPTCHA' },
];

function BrandingTab({ settings }: { settings: AdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSettings();
  const toast = useToast();
  const [portalName, setPortalName] = useState(settings.branding.portal_name);
  const [tagline, setTagline] = useState(settings.branding.tagline ?? '');
  const [supportEmail, setSupportEmail] = useState(settings.branding.support_email ?? '');
  const [primaryColor, setPrimaryColor] = useState(settings.branding.primary_color);
  const [accentColor, setAccentColor] = useState(settings.branding.accent_color);
  const [defaultTheme, setDefaultTheme] = useState<ThemePreference>(
    settings.branding.default_theme,
  );
  const [logo, setLogo] = useState<string | null>(settings.branding.logo_data_url);
  const [logoError, setLogoError] = useState<string | null>(null);

  const onLogo = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 256 * 1024) {
      setLogoError('Logos must be smaller than 256 KB.');
      return;
    }
    setLogoError(null);
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') setLogo(reader.result);
    });
    reader.readAsDataURL(file);
  };

  return (
    <Card>
      <CardHeader title="Branding" description="Shown on the sign-in page, the shell and emails." />
      <CardBody className="grid gap-5 md:grid-cols-2">
        <LabeledInput
          label="Portal name"
          value={portalName}
          onChange={(event) => setPortalName(event.target.value)}
        />
        <LabeledInput
          label="Support email"
          type="email"
          value={supportEmail}
          onChange={(event) => setSupportEmail(event.target.value)}
        />
        <LabeledTextarea
          className="md:col-span-2"
          label="Tagline"
          rows={2}
          value={tagline}
          onChange={(event) => setTagline(event.target.value)}
        />
        <Field label="Primary colour" htmlFor="primary-color" hint="Used for the accent tokens.">
          <div className="flex items-center gap-2">
            <Input
              id="primary-color"
              type="color"
              className="h-9 w-16 p-1"
              value={primaryColor}
              onChange={(event) => setPrimaryColor(event.target.value)}
            />
            <Input
              aria-label="Primary colour hex value"
              value={primaryColor}
              onChange={(event) => setPrimaryColor(event.target.value)}
            />
          </div>
        </Field>
        <Field label="Accent colour" htmlFor="accent-color">
          <div className="flex items-center gap-2">
            <Input
              id="accent-color"
              type="color"
              className="h-9 w-16 p-1"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value)}
            />
            <Input
              aria-label="Accent colour hex value"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value)}
            />
          </div>
        </Field>
        <LabeledSelect<ThemePreference>
          label="Default theme"
          value={defaultTheme}
          onValueChange={setDefaultTheme}
          options={THEME_OPTIONS.map((option) => ({ ...option }))}
        />
        <Field
          label="Logo"
          htmlFor="logo-upload"
          error={logoError}
          hint="PNG or SVG, under 256 KB."
        >
          <div className="flex items-center gap-3">
            {logo ? (
              <img src={logo} alt="Current logo" className="h-10 w-10 rounded-md object-contain" />
            ) : (
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-fg">
                N
              </span>
            )}
            <Input id="logo-upload" type="file" accept="image/*" onChange={onLogo} />
            {logo ? (
              <Button variant="ghost" size="sm" onClick={() => setLogo(null)}>
                Remove
              </Button>
            ) : null}
          </div>
        </Field>

        <div className="md:col-span-2">
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                {
                  branding: {
                    portal_name: portalName.trim(),
                    tagline: tagline.trim() || null,
                    support_email: supportEmail.trim() || null,
                    primary_color: primaryColor,
                    accent_color: accentColor,
                    default_theme: defaultTheme,
                    logo_data_url: logo,
                  },
                },
                { onSuccess: () => toast.success('Branding saved') },
              )
            }
          >
            Save branding
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function CaptchaTab({ settings }: { settings: AdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSettings();
  const toast = useToast();
  const [enabled, setEnabled] = useState(settings.captcha.enabled);
  const [provider, setProvider] = useState<CaptchaProvider>(settings.captcha.provider);
  const [siteKey, setSiteKey] = useState(settings.captcha.site_key ?? '');
  const [secretKey, setSecretKey] = useState('');
  const [openRegistration, setOpenRegistration] = useState(settings.registration.open_registration);
  const [requireVerification, setRequireVerification] = useState(
    settings.registration.require_email_verification,
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="CAPTCHA"
          description="Applied to sign-in and registration. The secret key is stored AES-256-GCM encrypted and never returned."
        />
        <CardBody className="grid gap-5 md:grid-cols-2">
          <div className="md:col-span-2">
            <Checkbox
              label="Require a CAPTCHA challenge"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
          </div>
          <LabeledSelect<CaptchaProvider>
            label="Provider"
            value={provider}
            onValueChange={setProvider}
            options={CAPTCHA_PROVIDERS.map((option) => ({ ...option }))}
          />
          <LabeledInput
            label="Site key"
            value={siteKey}
            onChange={(event) => setSiteKey(event.target.value)}
          />
          <LabeledInput
            className="md:col-span-2"
            label="Secret key"
            type="password"
            autoComplete="off"
            placeholder={settings.captcha.secret_set ? '•••••••• (stored)' : 'Not set'}
            value={secretKey}
            onChange={(event) => setSecretKey(event.target.value)}
            hint="Leave blank to keep the stored value."
          />
          <div className="md:col-span-2">
            <Button
              variant="primary"
              loading={update.isPending}
              onClick={() =>
                update.mutate(
                  {
                    captcha: {
                      enabled,
                      provider,
                      site_key: siteKey.trim() || null,
                      ...(secretKey ? { secret_key: secretKey } : {}),
                    },
                  },
                  {
                    onSuccess: () => {
                      setSecretKey('');
                      toast.success('CAPTCHA settings saved');
                    },
                  },
                )
              }
            >
              Save CAPTCHA settings
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Registration" description="Who may create an account, and how." />
        <CardBody className="flex flex-col gap-4">
          <Checkbox
            label="Allow self-service registration"
            checked={openRegistration}
            onChange={(event) => setOpenRegistration(event.target.checked)}
          />
          <Checkbox
            label="Require email verification before sign-in"
            checked={requireVerification}
            onChange={(event) => setRequireVerification(event.target.checked)}
          />
          <p className="text-sm text-fg-muted">
            Self-selectable roles:{' '}
            {REGISTRABLE_ROLES.map((role) => (
              <Badge key={role} className="mr-1">
                {ROLE_LABELS[role]}
              </Badge>
            ))}
          </p>
          <div>
            <Button
              variant="primary"
              loading={update.isPending}
              onClick={() =>
                update.mutate(
                  {
                    registration: {
                      open_registration: openRegistration,
                      require_email_verification: requireVerification,
                    },
                  },
                  { onSuccess: () => toast.success('Registration settings saved') },
                )
              }
            >
              Save registration settings
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function EmailTab({ settings }: { settings: AdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSettings();
  const smtpTest = useSmtpTest();
  const toast = useToast();
  const [host, setHost] = useState(settings.smtp.host ?? '');
  const [port, setPort] = useState(String(settings.smtp.port));
  const [secure, setSecure] = useState(settings.smtp.secure);
  const [username, setUsername] = useState(settings.smtp.username ?? '');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState(settings.smtp.from_address ?? '');
  const [testTo, setTestTo] = useState('');

  return (
    <Card>
      <CardHeader
        title="Email delivery"
        description="Transactional mail is queued in the outbox and sent by the worker; the password is stored encrypted."
      />
      <CardBody className="grid gap-5 md:grid-cols-2">
        <LabeledInput label="SMTP host" value={host} onChange={(e) => setHost(e.target.value)} />
        <LabeledInput
          label="Port"
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(event) => setPort(event.target.value)}
        />
        <LabeledInput
          label="Username"
          autoComplete="off"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <LabeledInput
          label="Password"
          type="password"
          autoComplete="off"
          placeholder={settings.smtp.password_set ? '•••••••• (stored)' : 'Not set'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint="Leave blank to keep the stored value."
        />
        <LabeledInput
          label="From address"
          type="email"
          value={fromAddress}
          onChange={(event) => setFromAddress(event.target.value)}
        />
        <div className="flex items-end">
          <Checkbox
            label="Use TLS (implicit)"
            checked={secure}
            onChange={(event) => setSecure(event.target.checked)}
          />
        </div>

        <div className="md:col-span-2">
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                {
                  smtp: {
                    host: host.trim() || null,
                    port: Number.parseInt(port, 10) || 587,
                    secure,
                    username: username.trim() || null,
                    from_address: fromAddress.trim() || null,
                    ...(password ? { password } : {}),
                  },
                },
                {
                  onSuccess: () => {
                    setPassword('');
                    toast.success('Email settings saved');
                  },
                },
              )
            }
          >
            Save email settings
          </Button>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-4 md:col-span-2">
          <LabeledInput
            label="Send a test email to"
            type="email"
            placeholder="Defaults to your own address"
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
          />
          <div>
            <Button
              variant="secondary"
              loading={smtpTest.isPending}
              onClick={() =>
                smtpTest.mutate(testTo.trim() ? { to_email: testTo.trim() } : {}, {
                  onSuccess: (response) => {
                    if (response.ok) toast.success('Test email sent');
                    else toast.error('Test email failed', response.error ?? undefined);
                  },
                })
              }
            >
              Send test email
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function TemplatesTab(): ReactElement {
  const [key, setKey] = useState<EmailTemplateKey>('verification');
  const query = useEmailTemplate(key);
  const update = useUpdateEmailTemplate();
  const toast = useToast();

  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [bodyText, setBodyText] = useState('');

  useEffect(() => {
    if (query.data) {
      setSubject(query.data.template.subject);
      setBodyHtml(query.data.template.body_html);
      setBodyText(query.data.template.body_text);
    }
  }, [query.data]);

  return (
    <Card>
      <CardHeader
        title="Email templates"
        description="Placeholders are interpolated by the email service when the message is enqueued."
      />
      <CardBody className="flex flex-col gap-5">
        <LabeledSelect<EmailTemplateKey>
          label="Template"
          value={key}
          onValueChange={setKey}
          options={EMAIL_TEMPLATE_KEYS.map((value) => ({
            value,
            label: EMAIL_TEMPLATE_LABELS[value],
          }))}
        />

        {query.isLoading ? (
          <LoadingPanel />
        ) : (
          <>
            {query.data && query.data.available_variables.length > 0 ? (
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-fg-muted">
                Available variables:
                {query.data.available_variables.map((variable) => (
                  <code
                    key={variable}
                    className="rounded-xs bg-neutral-soft px-1.5 py-0.5 font-mono text-xs"
                  >
                    {`{{${variable}}}`}
                  </code>
                ))}
              </p>
            ) : null}

            <LabeledInput
              label="Subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
            <LabeledTextarea
              label="HTML body"
              mono
              rows={10}
              value={bodyHtml}
              onChange={(event) => setBodyHtml(event.target.value)}
            />
            <LabeledTextarea
              label="Plain-text body"
              mono
              rows={6}
              value={bodyText}
              onChange={(event) => setBodyText(event.target.value)}
            />
            <div>
              <Button
                variant="primary"
                loading={update.isPending}
                onClick={() =>
                  update.mutate(
                    { key, body: { subject, body_html: bodyHtml, body_text: bodyText } },
                    { onSuccess: () => toast.success('Template saved') },
                  )
                }
              >
                Save template
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SettingsTabs(): ReactElement {
  const query = useAdminSettings();
  const [tab, setTab] = useState('branding');

  if (query.isLoading || !query.data) return <LoadingPanel label="Loading settings" />;
  const settings = query.data;

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      tabs={[
        { value: 'branding', label: 'Branding', content: <BrandingTab settings={settings} /> },
        { value: 'captcha', label: 'CAPTCHA', content: <CaptchaTab settings={settings} /> },
        { value: 'email', label: 'Email', content: <EmailTab settings={settings} /> },
        { value: 'templates', label: 'Templates', content: <TemplatesTab /> },
      ]}
    />
  );
}

/** Portal configuration: branding, CAPTCHA, email and templates. */
export function AdminSettingsPage(): ReactElement {
  return (
    <RoleGuard minRole="admin">
      <PageHeader
        title="Settings"
        description="Portal-wide configuration. Encrypted values are write-only and never returned by the API."
      />
      <SettingsTabs />
    </RoleGuard>
  );
}
