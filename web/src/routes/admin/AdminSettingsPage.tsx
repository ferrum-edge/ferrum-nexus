import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_LABELS,
  REGISTRABLE_ROLES,
  ROLE_LABELS,
  type AdminSettingsResponse,
  type CaptchaProvider,
  type EdgeNamespaceRouting,
  type EmailTemplateKey,
  type RegistrableRole,
} from '@ferrum-nexus/shared';
import {
  useAdminSettings,
  useEmailTemplate,
  useSmtpTest,
  useUpdateAdminSettings,
  useUpdateEmailTemplate,
} from '../../hooks/useAdminSettings';
import { useEdgeHealth } from '../../hooks/useHealth';
import {
  useReconcileGateway,
  useRepairGatewayReferences,
} from '../../hooks/useGatewayReconciliation';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';
import { CaptchaWidget } from '../../components/auth/CaptchaWidget';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '../../components/ui/Card';
import { Icon } from '../../components/ui/Icon';
import {
  Checkbox,
  Field,
  FieldGroup,
  Input,
  LabeledInput,
  LabeledTextarea,
} from '../../components/ui/Input';
import { LabeledSelect } from '../../components/ui/Select';
import { LoadingPanel } from '../../components/ui/Spinner';
import { Tabs } from '../../components/ui/Tabs';
import { FormNotice } from '../../components/auth/AuthShell';
import { BrandingTab } from './settings/BrandingTab';

/** The provider and site key an in-progress activation self-test belongs to. */
interface PendingChallenge {
  provider: CaptchaProvider;
  siteKey: string;
  /**
   * Bumped on every press of "Test this CAPTCHA configuration", and used as the
   * widget's React key, so asking again for the same provider and site key
   * remounts the vendor widget and mints a fresh token. Vendor tokens are
   * single-use and expire, so re-solving has to be possible without editing a
   * field first.
   */
  attempt: number;
}

const CAPTCHA_PROVIDERS: ReadonlyArray<{ value: CaptchaProvider; label: string }> = [
  { value: 'none', label: 'Disabled' },
  { value: 'turnstile', label: 'Cloudflare Turnstile' },
  { value: 'hcaptcha', label: 'hCaptcha' },
  { value: 'recaptcha', label: 'Google reCAPTCHA' },
];

/**
 * Shown in place of the save button on a section an ordinary `admin` may read
 * but not write.
 *
 * `PUT /api/admin/settings` refuses an `smtp`, `captcha`, or `gateway` section from anyone
 * below `super_admin` with a 403, because all three are escalation paths rather than
 * preferences: whoever owns the SMTP relay receives every verification and
 * password-reset link the portal sends, and whoever owns CAPTCHA owns the
 * registration brake, and whoever controls the gateway address can redirect
 * client credentials. The fields stay visible but disabled rather than hidden —
 * an admin is still allowed to *read* the configuration, and needs to when
 * diagnosing mail that is not arriving.
 */
function SuperAdminOnlyNotice({ what }: { what: string }): ReactElement {
  return (
    <p className="flex items-start gap-2 rounded-md border border-border bg-inset px-3 py-2.5 text-sm text-fg-muted">
      <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />
      <span>
        Only a <strong className="font-medium text-fg">super admin</strong> can change {what}. Ask
        one to make the change — these settings can be used to take over accounts, so they sit above
        the administrator role.
      </span>
    </p>
  );
}

/**
 * Prose the warning card closes with.
 *
 * Held as a constant rather than as JSX text so the repair's two hard limits —
 * credentials cannot come back, proxies have to be republished — are stated in
 * one place and read the same as the operations guide.
 */
const REPAIR_EXPLANATION =
  'Repairing recreates each account’s gateway consumer under the same identity and replays its ' +
  'approved access. Credentials cannot be recovered, because their secrets were only ever shown ' +
  'once, so the portal’s rows are revoked and each holder issues new ones. An API whose ' +
  'proxy is gone has the dead id cleared and must be published again by its provider.';

/**
 * The gateway-reference reconciliation warning.
 *
 * Retargeting `FERRUM_ADMIN_URL` at a fresh gateway, or rebuilding the one it
 * points at, leaves the portal holding consumer and proxy ids nothing answers
 * for: new accounts and new publishes keep working while every account and API
 * that predates the change breaks (issue #235). The server reports that on the
 * Edge health payload; this is the operator-facing half of it.
 *
 * The verdict comes from `GET /api/health/edge`, which reads a cached
 * background pass rather than probing — so re-checking is an explicit button,
 * and so is the repair.
 */
function GatewayReconciliationCard(): ReactElement | null {
  const health = useEdgeHealth();
  const { canSuperAdmin } = useAuth();
  const reconcile = useReconcileGateway();
  const repair = useRepairGatewayReferences();
  const toast = useToast();
  const state = health.data?.reconciliation;

  // Nothing to say while the first pass is still outstanding, and nothing to
  // say when the references are fine — an operator surface that reports “all
  // good” on every page load is one nobody reads when it stops saying that.
  if (!state || state.status !== 'orphaned') return null;

  const consumers = state.orphaned_consumers ?? 0;
  const apis = state.orphaned_proxies ?? 0;
  const checked = state.checked_at ? new Date(state.checked_at).toLocaleString() : 'unknown';
  const summary =
    `${consumers} account(s) have no gateway consumer and ${apis} published API(s) point at a ` +
    'proxy that no longer exists. Approvals and credential operations on those accounts fail, ' +
    `and those APIs serve nothing. Last checked ${checked}.`;

  return (
    <Card>
      <CardHeader
        title="Gateway references need repair"
        description="The gateway no longer holds objects this portal created — what a retargeted or rebuilt gateway looks like."
      />
      <CardBody className="flex flex-col gap-4">
        <p className="flex items-start gap-2 rounded-md border border-border bg-inset px-3 py-2.5 text-sm text-fg-muted">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />
          <span>{summary}</span>
        </p>
        {canSuperAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              loading={reconcile.isPending}
              onClick={() =>
                reconcile.mutate(undefined, {
                  onSuccess: (report) =>
                    toast.success(
                      report.status === 'orphaned'
                        ? `${report.consumers.orphaned + report.proxies.orphaned} references are still orphaned`
                        : 'Every stored gateway reference is live',
                    ),
                })
              }
            >
              Re-check now
            </Button>
            <Button
              variant="primary"
              loading={repair.isPending}
              onClick={() =>
                repair.mutate(
                  { all: true },
                  { onSuccess: () => toast.success('Gateway references repaired') },
                )
              }
            >
              Repair all
            </Button>
          </div>
        ) : (
          <SuperAdminOnlyNotice what="the portal’s gateway references" />
        )}
        <p className="text-sm text-fg-muted">{REPAIR_EXPLANATION}</p>
      </CardBody>
    </Card>
  );
}

/**
 * Where the gateway's proxy listener answers.
 *
 * Restricted to super admins because clients trust this origin with gateway
 * credentials. Until it is set, every API in the catalog reports a null invoke
 * URL and clients have to be told the address by hand.
 */
function GatewayTab({ settings }: { settings: AdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSettings();
  const toast = useToast();
  const { canSuperAdmin } = useAuth();
  const [publicUrl, setPublicUrl] = useState(settings.gateway.public_url ?? '');
  const routing = useEdgeHealth().data?.namespace_routing;

  return (
    <div className="flex flex-col gap-5">
      <GatewayReconciliationCard />
      <Card>
        <CardHeader
          title="Gateway"
          description="The public address of the gateway's proxy listener, shown to clients in the catalog."
        />
        <CardBody className="flex flex-col gap-5">
          {update.error ? <FormNotice>{update.error.message}</FormNotice> : null}
          {routing?.unserved ? <NamespaceUnservedNotice routing={routing} /> : null}
          <LabeledInput
            label="Public gateway URL"
            placeholder="https://api.example.com"
            value={publicUrl}
            onChange={(event) => setPublicUrl(event.target.value)}
            disabled={!canSuperAdmin}
            hint="Scheme, host and port only — no path. This is where clients send API traffic, which is not this portal’s own address. Leave it blank to fall back to FERRUM_GATEWAY_PUBLIC_URL."
          />
          <p className="text-sm text-fg-muted">
            Each published API is called at this origin followed by its{' '}
            <code className="font-mono text-xs">/&lt;namespace&gt;/&lt;slug&gt;</code> listen path.
            While it is unset the catalog can only show the listen path.
          </p>
          {canSuperAdmin ? (
            <div>
              <Button
                variant="primary"
                loading={update.isPending}
                onClick={() =>
                  update.mutate(
                    { gateway: { public_url: publicUrl.trim() || null } },
                    { onSuccess: () => toast.success('Gateway address saved') },
                  )
                }
              >
                Save gateway
              </Button>
            </div>
          ) : (
            <SuperAdminOnlyNotice what="the public gateway URL" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * The gateway does not route the namespace this portal publishes into.
 *
 * The card next to it is the one that explains the `/<namespace>/<slug>` listen
 * path, and an admin is the only person who can fix this, so it belongs here
 * rather than behind a status page nobody opens. `active` is `null` for a
 * non-admin and for the header-only signal, where the gateway said which
 * namespace is wrong without saying which one is right.
 */
function NamespaceUnservedNotice({ routing }: { routing: EdgeNamespaceRouting }): ReactElement {
  const gateway =
    routing.active === null
      ? "read the gateway's own active namespace from its authenticated GET /health, field namespace.active"
      : `the gateway's data plane serves '${routing.active}'`;
  return (
    <FormNotice tone="danger">
      {`Published APIs are not reachable. This portal publishes into the Ferrum Edge namespace '${routing.configured}', which this gateway accepts and never routes — ${gateway}. Every API already published here answers 404 on the listener, and new publishes are refused until FERRUM_NAMESPACE matches on the portal and on the gateway.`}
    </FormNotice>
  );
}

/**
 * Who may create an account, and how.
 *
 * `allowed_roles` is bound to the stored policy rather than to the
 * `REGISTRABLE_ROLES` constant: the server enforces the stored list on every
 * registration and `GET /api/branding` publishes it to the sign-up form, so a
 * card that advertised the constant contradicted whichever administrator had
 * narrowed it. Exported for its test; rendered beneath the CAPTCHA card.
 */
export function RegistrationCard({ settings }: { settings: AdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSettings();
  const toast = useToast();
  const [openRegistration, setOpenRegistration] = useState(settings.registration.open_registration);
  const [requireVerification, setRequireVerification] = useState(
    settings.registration.require_email_verification,
  );
  const [allowedRoles, setAllowedRoles] = useState<RegistrableRole[]>(() =>
    REGISTRABLE_ROLES.filter((role) => settings.registration.allowed_roles.includes(role)),
  );
  const toggleRole = (role: RegistrableRole, checked: boolean): void => {
    setAllowedRoles((current) =>
      REGISTRABLE_ROLES.filter((value) => {
        if (value === role) return checked;
        return current.includes(value);
      }),
    );
  };

  return (
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
        <FieldGroup
          label="Self-selectable roles"
          hint="Which roles the sign-up form offers. Registration with any other role is refused with a 403."
        >
          <div className="flex flex-col gap-2">
            {REGISTRABLE_ROLES.map((role) => (
              <Checkbox
                key={role}
                label={ROLE_LABELS[role]}
                checked={allowedRoles.includes(role)}
                onChange={(event) => toggleRole(role, event.target.checked)}
              />
            ))}
          </div>
        </FieldGroup>
        {allowedRoles.length === 0 ? (
          <p className="text-sm text-danger" role="alert">
            With no self-selectable role, self-service registration cannot complete at all. Turn off
            open registration instead if that is what you mean.
          </p>
        ) : null}
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
                    allowed_roles: allowedRoles,
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
  );
}

/**
 * CAPTCHA configuration, with the activation self-test the server demands.
 *
 * Turning the challenge on — or moving its provider, site key or secret while
 * it is on — makes register *and login* require a token from every account,
 * this administrator included. So `PUT /api/admin/settings` refuses such a
 * patch unless it carries a `captcha_token` the **new** configuration verifies
 * (`400 CAPTCHA_SELF_TEST_FAILED`), and this card is where that token is
 * minted: the widget below is rendered from the values in the form, not from
 * the stored ones, so solving it proves the site key, the secret and the vendor
 * script all work together before anything is saved (ferrum-nexus#252).
 *
 * The challenge is frozen when "Test this CAPTCHA configuration" is pressed, so
 * typing in the site-key field does not re-render the vendor's widget on every
 * keystroke; editing either field afterwards drops the token and asks again.
 * Vendor tokens are single-use, so that button stays on screen until one has
 * been solved, and a failed save drops the spent token rather than offering it
 * again.
 *
 * Changing the provider also requires typing a secret key: the stored one
 * belongs to the previous vendor, and the server refuses to replay it against
 * another.
 *
 * Exported for its test.
 */
export function CaptchaCard({ settings }: { settings: AdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSettings();
  const toast = useToast();
  // This card is super_admin-only; the Registration card below it is not.
  const { canSuperAdmin } = useAuth();
  const [enabled, setEnabled] = useState(settings.captcha.enabled);
  const [provider, setProvider] = useState<CaptchaProvider>(settings.captcha.provider);
  const [siteKey, setSiteKey] = useState(settings.captcha.site_key ?? '');
  const [secretKey, setSecretKey] = useState('');
  /** The configuration the rendered widget belongs to; `null` before it is asked for. */
  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const onToken = useCallback((value: string | null) => setToken(value), []);

  const trimmedSiteKey = siteKey.trim();
  const trimmedSecretKey = secretKey.trim();
  // Trimmed on both sides of the comparison, as the server trims both: a stored
  // key with stray whitespace (reachable only from a legacy or direct-database
  // write) must not make this card ask for a challenge the server would not.
  const storedSiteKey = settings.captcha.site_key?.trim() ?? '';
  // The stored secret was issued by the stored provider, so the server refuses
  // a provider move that does not bring its own secret rather than replaying
  // the old one against the new vendor.
  const providerChangeNeedsSecret =
    enabled && provider !== settings.captcha.provider && trimmedSecretKey === '';
  const captchaIncomplete =
    enabled &&
    (provider === 'none' || !trimmedSiteKey || (!secretKey.trim() && !settings.captcha.secret_set));
  // The same four conditions the server checks before it demands a self-test.
  const selfTestRequired =
    enabled &&
    (!settings.captcha.enabled ||
      provider !== settings.captcha.provider ||
      trimmedSiteKey !== storedSiteKey ||
      trimmedSecretKey !== '');
  const challengeCurrent =
    challenge !== null && challenge.provider === provider && challenge.siteKey === trimmedSiteKey;
  // A token minted for a configuration the form has since moved away from would
  // be rejected by the server, so it is not offered to it.
  const provenToken = challengeCurrent ? token : null;
  const canSelfTest =
    canSuperAdmin && selfTestRequired && !captchaIncomplete && !providerChangeNeedsSecret;

  /** Freeze the values the widget below is rendered from, and drop any old token. */
  const startSelfTest = (): void => {
    setToken(null);
    setChallenge((previous) => ({
      provider,
      siteKey: trimmedSiteKey,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
  };

  /**
   * Forget the solved challenge.
   *
   * Vendor tokens are single-use, so a save that reached the self-test and then
   * failed for any other reason — a validation error elsewhere in the patch, a
   * `CONFLICT`, a transient database fault — has already spent this one.
   * Keeping it would let the next Save resend a burnt token and come back with
   * "the provider rejected the challenge", which reads as "your keys are
   * wrong" about a configuration that may be perfectly correct.
   */
  const forgetChallenge = (): void => {
    setToken(null);
    setChallenge(null);
  };

  return (
    <Card>
      <CardHeader
        title="CAPTCHA"
        description="Applied to sign-in and registration. The secret key is stored AES-256-GCM encrypted and never returned."
      />
      <CardBody className="grid gap-5 md:grid-cols-2">
        {settings.captcha.enforcement === 'disabled' ? (
          <div className="md:col-span-2">
            <FormNotice tone="warning">
              {`This server runs with NEXUS_CAPTCHA_ENFORCEMENT=disabled, so sign-in and registration accept every request whatever this card says. It is the break-glass setting for a portal locked out by a CAPTCHA it cannot verify: fix the configuration here, then remove that variable from the server environment and restart. Sessions created meanwhile are recorded in the audit log with captcha_bypassed: true.`}
            </FormNotice>
          </div>
        ) : null}
        <div className="md:col-span-2">
          <Checkbox
            label="Require a CAPTCHA challenge"
            checked={enabled}
            disabled={!canSuperAdmin}
            onChange={(event) => setEnabled(event.target.checked)}
          />
        </div>
        <LabeledSelect<CaptchaProvider>
          label="Provider"
          value={provider}
          disabled={!canSuperAdmin}
          onValueChange={setProvider}
          options={CAPTCHA_PROVIDERS.map((option) => ({ ...option }))}
        />
        <LabeledInput
          label="Site key"
          value={siteKey}
          disabled={!canSuperAdmin}
          onChange={(event) => setSiteKey(event.target.value)}
        />
        <LabeledInput
          className="md:col-span-2"
          label="Secret key"
          type="password"
          autoComplete="off"
          placeholder={settings.captcha.secret_set ? '•••••••• (stored)' : 'Not set'}
          value={secretKey}
          disabled={!canSuperAdmin}
          onChange={(event) => setSecretKey(event.target.value)}
          hint="Leave blank to keep the stored value."
        />
        {captchaIncomplete ? (
          <p className="text-sm text-danger md:col-span-2" role="alert">
            Choose a provider and enter a site key and secret key before enabling CAPTCHA.
          </p>
        ) : null}
        {!captchaIncomplete && providerChangeNeedsSecret ? (
          <p className="text-sm text-danger md:col-span-2" role="alert">
            Enter the secret key for the new provider. The stored one was issued by the previous
            provider and is never sent to another vendor.
          </p>
        ) : null}
        {canSelfTest ? (
          <div className="flex flex-col gap-3 md:col-span-2">
            <p className="text-sm text-fg-muted">
              This change makes every sign-in require a challenge, including yours. Solve one with
              the configuration above and the portal will save it only if the vendor accepts the
              answer.
            </p>
            {challenge !== null && challengeCurrent && provider !== 'none' ? (
              <CaptchaWidget
                key={challenge.attempt}
                config={{ enabled: true, provider, site_key: trimmedSiteKey }}
                onToken={onToken}
              />
            ) : null}
            {provenToken === null ? (
              <div>
                <Button onClick={startSelfTest}>Test this CAPTCHA configuration</Button>
              </div>
            ) : (
              <p className="text-sm text-success" role="status">
                Challenge solved. Save to apply this configuration.
              </p>
            )}
          </div>
        ) : null}
        <div className="md:col-span-2">
          {canSuperAdmin ? (
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={
                captchaIncomplete ||
                providerChangeNeedsSecret ||
                (selfTestRequired && provenToken === null)
              }
              onClick={() =>
                update.mutate(
                  {
                    captcha: {
                      enabled,
                      provider,
                      site_key: trimmedSiteKey || null,
                      // Trimmed, so a field holding only whitespace keeps the
                      // stored secret instead of being sent as an empty one,
                      // which the server reads as "enabled with no usable
                      // secret" and refuses.
                      ...(trimmedSecretKey ? { secret_key: trimmedSecretKey } : {}),
                      ...(provenToken ? { captcha_token: provenToken } : {}),
                    },
                  },
                  {
                    onSuccess: () => {
                      setSecretKey('');
                      forgetChallenge();
                      toast.success('CAPTCHA settings saved');
                    },
                    // The self-test runs before anything is written, so a save
                    // that failed afterwards has spent this token either way.
                    onError: forgetChallenge,
                  },
                )
              }
            >
              Save CAPTCHA settings
            </Button>
          ) : (
            <SuperAdminOnlyNotice what="the CAPTCHA settings" />
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function CaptchaTab({ settings }: { settings: AdminSettingsResponse }): ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <CaptchaCard settings={settings} />
      <RegistrationCard settings={settings} />
    </div>
  );
}

function EmailTab({ settings }: { settings: AdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSettings();
  const smtpTest = useSmtpTest();
  const toast = useToast();
  // The SMTP fields are super_admin-only. "Send test email" is not — it changes
  // nothing, and an admin diagnosing a delivery problem needs it.
  const { canSuperAdmin } = useAuth();
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
        <LabeledInput
          label="SMTP host"
          value={host}
          disabled={!canSuperAdmin}
          onChange={(e) => setHost(e.target.value)}
        />
        <LabeledInput
          label="Port"
          type="number"
          min={1}
          max={65535}
          value={port}
          disabled={!canSuperAdmin}
          onChange={(event) => setPort(event.target.value)}
        />
        <LabeledInput
          label="Username"
          autoComplete="off"
          value={username}
          disabled={!canSuperAdmin}
          onChange={(event) => setUsername(event.target.value)}
        />
        <LabeledInput
          label="Password"
          type="password"
          autoComplete="off"
          placeholder={settings.smtp.password_set ? '•••••••• (stored)' : 'Not set'}
          value={password}
          disabled={!canSuperAdmin}
          onChange={(event) => setPassword(event.target.value)}
          hint="Leave blank to keep the stored value."
        />
        <LabeledInput
          label="From address"
          type="email"
          value={fromAddress}
          disabled={!canSuperAdmin}
          onChange={(event) => setFromAddress(event.target.value)}
        />
        <div className="flex items-end">
          <Checkbox
            label="Use TLS (implicit)"
            checked={secure}
            disabled={!canSuperAdmin}
            onChange={(event) => setSecure(event.target.checked)}
          />
        </div>

        <div className="md:col-span-2">
          {canSuperAdmin ? (
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
          ) : (
            <SuperAdminOnlyNotice what="the SMTP settings" />
          )}
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
        { value: 'gateway', label: 'Gateway', content: <GatewayTab settings={settings} /> },
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
