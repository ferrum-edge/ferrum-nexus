/**
 * Admin → Settings → Single sign-on.
 *
 * Two cards: the deployment-wide policy (which sign-in methods work, which
 * email domains single sign-on admits, whether losing every mapped role
 * disables the account) and the OpenID Connect providers with their claim
 * mappings. Every administrator can read both; only a super admin can save,
 * because a role mapping decides who becomes an `admin` — the server refuses
 * anyone else with a 403.
 *
 * Providers declared in `NEXUS_OIDC_PROVIDERS` are shown read-only. Client
 * secrets are write-only: the form says whether one is stored and sends a new
 * one only when typed.
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import {
  LOGIN_POLICIES,
  SSO_MAPPABLE_ROLES,
  ROLE_LABELS,
  type LoginPolicy,
  type SsoAdminSettingsResponse,
  type SsoMappableRole,
  type SsoOrgMapping,
  type SsoProviderAdminView,
  type SsoProviderInput,
  type SsoRoleMapping,
} from '@ferrum-nexus/shared';
import { FormNotice } from '../../../components/auth/AuthShell';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { CopyField } from '../../../components/ui/CopyField';
import { Icon } from '../../../components/ui/Icon';
import {
  Checkbox,
  FieldGroup,
  Input,
  LabeledInput,
  LabeledTextarea,
} from '../../../components/ui/Input';
import { LabeledSelect, Select } from '../../../components/ui/Select';
import { LoadingPanel } from '../../../components/ui/Spinner';
import { useAdminSso, useUpdateAdminSso } from '../../../hooks/useAdminSettings';
import { useAuth } from '../../../stores/auth';
import { useToast } from '../../../stores/toast';

const POLICY_LABELS: Readonly<Record<LoginPolicy, string>> = {
  local_and_sso: 'Passwords and single sign-on',
  local_only: 'Passwords only',
  sso_only: 'Single sign-on only',
};

const POLICY_OPTIONS = LOGIN_POLICIES.map((policy) => ({
  value: policy,
  label: POLICY_LABELS[policy],
}));

/** `none` stands for a `null` default role: no mapping, no access. */
type DefaultRoleChoice = SsoMappableRole | 'none';

const DEFAULT_ROLE_OPTIONS: ReadonlyArray<{ value: DefaultRoleChoice; label: string }> = [
  ...SSO_MAPPABLE_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
  { value: 'none', label: 'No access' },
];

const ROLE_OPTIONS = SSO_MAPPABLE_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }));

/** The provider settings the form shows as checkboxes. */
type ProviderFlag =
  | 'enabled'
  | 'jit_provisioning'
  | 'link_existing_accounts'
  | 'require_verified_email'
  | 'disable_local_password_for_linked'
  | 'sync_roles';

/** One settings provider as the form edits it. */
interface ProviderDraft {
  settings: SsoProviderInput;
  /** Space-separated scopes, parsed on save. */
  scopesText: string;
  /** The provider's own allowed email domains, one per line, parsed on save. */
  domainsText: string;
  /** A new secret typed into the form; empty keeps the stored one. */
  secret: string;
  clearSecret: boolean;
  secretSet: boolean;
  isNew: boolean;
}

function toDraft(provider: SsoProviderAdminView): ProviderDraft {
  const {
    source: _source,
    client_secret_set: secretSet,
    redirect_uri: _redirect,
    ...settings
  } = provider;
  return {
    settings,
    scopesText: settings.scopes.join(' '),
    domainsText: settings.allowed_email_domains.join('\n'),
    secret: '',
    clearSecret: false,
    secretSet,
    isNew: false,
  };
}

function newDraft(): ProviderDraft {
  return {
    settings: {
      id: '',
      display_name: '',
      issuer: '',
      client_id: '',
      scopes: ['openid', 'email', 'profile'],
      enabled: true,
      jit_provisioning: true,
      link_existing_accounts: true,
      require_verified_email: true,
      allowed_email_domains: [],
      disable_local_password_for_linked: false,
      sync_roles: true,
      default_role: 'client',
      role_mappings: [],
      org_mappings: [],
    },
    scopesText: 'openid email profile',
    domainsText: '',
    secret: '',
    clearSecret: false,
    secretSet: false,
    isNew: true,
  };
}

/** Domains typed one per line (or comma-separated), as the API takes them. */
function parseDomains(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0);
}

/** The wire shape of one draft: the secret only when it changes. */
function toInput(draft: ProviderDraft): SsoProviderInput {
  const scopes = draft.scopesText.split(/\s+/).filter((scope) => scope.length > 0);
  const secret = draft.secret.trim();
  const domains = parseDomains(draft.domainsText);
  const input: SsoProviderInput = { ...draft.settings, scopes, allowed_email_domains: domains };
  // Omitted keeps the stored secret; `null` clears it.
  if (secret !== '') input.client_secret = secret;
  else if (draft.clearSecret) input.client_secret = null;
  else delete input.client_secret;
  return input;
}

/** The row a settings card ends with: its save control, or why there isn't one. */
function CardFooter({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border bg-inset/40 px-5 py-3">
      {children}
    </div>
  );
}

const SUPER_ADMIN_ONLY =
  'Only a super admin can change single sign-on: its role mappings decide who becomes an administrator.';

const BREAK_GLASS_HELP =
  'Set with NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN in the server environment. When on, super admins can still use a password under “Single sign-on only”.';

const ENVIRONMENT_PROVIDER_NOTE =
  'Declared in NEXUS_OIDC_PROVIDERS; change it in the server environment.';

function SuperAdminOnly(): ReactElement {
  return (
    <p role="status" className="flex items-start gap-2.5 text-sm text-fg-muted">
      <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-info" />
      <span>{SUPER_ADMIN_ONLY}</span>
    </p>
  );
}

function PolicyCard({ settings }: { settings: SsoAdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSso();
  const toast = useToast();
  const { canSuperAdmin } = useAuth();
  const [policy, setPolicy] = useState<LoginPolicy>(settings.policy);
  const [domains, setDomains] = useState(settings.allowed_email_domains.join('\n'));
  const [deprovision, setDeprovision] = useState(settings.deprovision_on_access_loss);
  const breakGlass = settings.break_glass_local_login;

  const save = (): void => {
    update.mutate(
      {
        policy,
        allowed_email_domains: parseDomains(domains),
        deprovision_on_access_loss: deprovision,
      },
      { onSuccess: () => toast.success('Sign-in policy saved') },
    );
  };

  return (
    <Card>
      <CardHeader
        icon="shield"
        title="Sign-in policy"
        description="Which sign-in methods this portal accepts, and what single sign-on admits."
      />
      <CardBody className="grid gap-5 md:grid-cols-2">
        {update.error ? (
          <div className="md:col-span-2">
            <FormNotice>{update.error.message}</FormNotice>
          </div>
        ) : null}
        <LabeledSelect<LoginPolicy>
          label="Login policy"
          value={policy}
          onValueChange={setPolicy}
          options={POLICY_OPTIONS}
          disabled={!canSuperAdmin}
          hint="Single sign-on only refuses passwords and self-registration. The founding registration with the bootstrap token always works."
        />
        <LabeledTextarea
          label="Allowed email domains"
          value={domains}
          onChange={(event) => setDomains(event.target.value)}
          disabled={!canSuperAdmin}
          rows={3}
          placeholder="example.com"
          hint="One per line. Every single sign-on must use an address the provider verified in one of them; leave empty to allow any."
        />
        <FieldGroup
          label="Losing access"
          hint="Checked at each sign-in; the portal receives no events from the identity provider."
        >
          <Checkbox
            label="Disable accounts whose claims no longer map to a role"
            description="Ends their sessions and revokes their gateway access, as disabling an account by hand does."
            checked={deprovision}
            onChange={(event) => setDeprovision(event.target.checked)}
            disabled={!canSuperAdmin}
          />
        </FieldGroup>
        <FieldGroup label="Break-glass password sign-in">
          <div className="flex items-start gap-2 text-sm text-fg-muted">
            <Badge tone={breakGlass ? 'warning' : 'neutral'}>{breakGlass ? 'On' : 'Off'}</Badge>
            <span>{BREAK_GLASS_HELP}</span>
          </div>
        </FieldGroup>
      </CardBody>
      <CardFooter>
        {canSuperAdmin ? (
          <Button variant="primary" loading={update.isPending} onClick={save}>
            Save sign-in policy
          </Button>
        ) : (
          <SuperAdminOnly />
        )}
      </CardFooter>
    </Card>
  );
}

function RoleMappingsEditor({
  mappings,
  onChange,
  disabled,
}: {
  mappings: SsoRoleMapping[];
  onChange: (next: SsoRoleMapping[]) => void;
  disabled: boolean;
}): ReactElement {
  const set = (index: number, patch: Partial<SsoRoleMapping>): void =>
    onChange(mappings.map((mapping, i) => (i === index ? { ...mapping, ...patch } : mapping)));
  return (
    <FieldGroup
      label="Role mappings"
      hint="When the claim equals the value, or is a list containing it, the account qualifies for the role. The highest role wins. Super admin cannot be mapped."
    >
      <div className="flex flex-col gap-2">
        {mappings.map((mapping, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_10rem_auto] items-center gap-2">
            <Input
              aria-label="Claim"
              placeholder="groups"
              value={mapping.claim}
              disabled={disabled}
              onChange={(event) => set(index, { claim: event.target.value })}
            />
            <Input
              aria-label="Value"
              placeholder="nexus-admins"
              value={mapping.value}
              disabled={disabled}
              onChange={(event) => set(index, { value: event.target.value })}
            />
            <Select<SsoMappableRole>
              aria-label="Role"
              value={mapping.role}
              options={ROLE_OPTIONS}
              disabled={disabled}
              onValueChange={(role) => set(index, { role })}
            />
            <Button
              variant="ghost-danger"
              size="icon"
              aria-label="Remove mapping"
              disabled={disabled}
              onClick={() => onChange(mappings.filter((_, i) => i !== index))}
            >
              <Icon name="trash" className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          className="self-start"
          disabled={disabled}
          onClick={() => onChange([...mappings, { claim: 'groups', value: '', role: 'client' }])}
        >
          <Icon name="plus" className="h-4 w-4" />
          Add role mapping
        </Button>
      </div>
    </FieldGroup>
  );
}

function OrgMappingsEditor({
  mappings,
  onChange,
  disabled,
}: {
  mappings: SsoOrgMapping[];
  onChange: (next: SsoOrgMapping[]) => void;
  disabled: boolean;
}): ReactElement {
  const set = (index: number, patch: Partial<SsoOrgMapping>): void =>
    onChange(mappings.map((mapping, i) => (i === index ? { ...mapping, ...patch } : mapping)));
  return (
    <FieldGroup
      label="Organization mappings"
      hint="The first matching rule sets the account's organization; no match clears it. With no rules, organizations are not managed from claims."
    >
      <div className="flex flex-col gap-2">
        {mappings.map((mapping, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
            <Input
              aria-label="Claim"
              placeholder="department"
              value={mapping.claim}
              disabled={disabled}
              onChange={(event) => set(index, { claim: event.target.value })}
            />
            <Input
              aria-label="Value"
              placeholder="payments"
              value={mapping.value}
              disabled={disabled}
              onChange={(event) => set(index, { value: event.target.value })}
            />
            <Input
              aria-label="Organization id"
              placeholder="Organization id"
              value={mapping.org_id}
              disabled={disabled}
              onChange={(event) => set(index, { org_id: event.target.value })}
            />
            <Button
              variant="ghost-danger"
              size="icon"
              aria-label="Remove mapping"
              disabled={disabled}
              onClick={() => onChange(mappings.filter((_, i) => i !== index))}
            >
              <Icon name="trash" className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          className="self-start"
          disabled={disabled}
          onClick={() => onChange([...mappings, { claim: 'groups', value: '', org_id: '' }])}
        >
          <Icon name="plus" className="h-4 w-4" />
          Add organization mapping
        </Button>
      </div>
    </FieldGroup>
  );
}

function ProviderEditor({
  draft,
  onChange,
  onRemove,
  disabled,
}: {
  draft: ProviderDraft;
  onChange: (next: ProviderDraft) => void;
  onRemove: () => void;
  disabled: boolean;
}): ReactElement {
  const settings = draft.settings;
  const set = (patch: Partial<SsoProviderInput>): void =>
    onChange({ ...draft, settings: { ...settings, ...patch } });
  const flag = (key: ProviderFlag, label: string): ReactElement => (
    <Checkbox
      label={label}
      checked={settings[key]}
      disabled={disabled}
      onChange={(event) => {
        const patch: Partial<SsoProviderInput> = {};
        patch[key] = event.target.checked;
        set(patch);
      }}
    />
  );

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-fg">
          {settings.display_name || settings.id || 'New provider'}
        </span>
        <Button variant="ghost-danger" size="sm" disabled={disabled} onClick={onRemove}>
          <Icon name="trash" className="h-4 w-4" />
          Remove
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <LabeledInput
          label="Provider id"
          value={settings.id}
          disabled={disabled || !draft.isNew}
          onChange={(event) => set({ id: event.target.value.trim().toLowerCase() })}
          hint="Lower-case letters, digits and hyphens. It is part of the redirect URI, so it cannot change once saved."
        />
        <LabeledInput
          label="Button label"
          value={settings.display_name}
          disabled={disabled}
          onChange={(event) => set({ display_name: event.target.value })}
        />
        <LabeledInput
          label="Issuer"
          placeholder="https://idp.example.com/realms/corp"
          value={settings.issuer}
          disabled={disabled}
          onChange={(event) => set({ issuer: event.target.value })}
          hint="Exactly as the provider's discovery document states it. HTTPS only."
        />
        <LabeledInput
          label="Client id"
          value={settings.client_id}
          disabled={disabled}
          onChange={(event) => set({ client_id: event.target.value })}
        />
        <LabeledInput
          label="Client secret"
          type="password"
          autoComplete="new-password"
          value={draft.secret}
          disabled={disabled || draft.clearSecret}
          placeholder={draft.secretSet ? 'Stored — type to replace' : 'None (public client)'}
          onChange={(event) => onChange({ ...draft, secret: event.target.value })}
        />
        <LabeledInput
          label="Scopes"
          value={draft.scopesText}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, scopesText: event.target.value })}
          hint="Space-separated; must include openid."
        />
        <LabeledTextarea
          label="Allowed email domains"
          value={draft.domainsText}
          disabled={disabled}
          rows={2}
          placeholder="example.com"
          onChange={(event) => onChange({ ...draft, domainsText: event.target.value })}
          hint="This provider only: one per line. Linking and account creation need a verified address in one of them, on top of the deployment-wide list. Empty allows any."
        />
      </div>
      {draft.secretSet ? (
        <Checkbox
          label="Clear the stored client secret"
          checked={draft.clearSecret}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, clearSecret: event.target.checked })}
        />
      ) : null}
      <FieldGroup label="Behaviour">
        <div className="grid gap-2 md:grid-cols-2">
          {flag('enabled', 'Enabled (shown on the sign-in page)')}
          {flag('jit_provisioning', 'Create accounts on first sign-in')}
          {flag('link_existing_accounts', 'Link existing non-admin accounts by proven address')}
          {flag('require_verified_email', 'Provision only verified addresses')}
          {flag('sync_roles', 'Re-apply the mapped role on every sign-in')}
          {flag(
            'disable_local_password_for_linked',
            'Disable password sign-in for accounts linked here',
          )}
        </div>
      </FieldGroup>
      <LabeledSelect<DefaultRoleChoice>
        label="Default role"
        value={settings.default_role ?? 'none'}
        options={DEFAULT_ROLE_OPTIONS}
        disabled={disabled}
        onValueChange={(choice) => set({ default_role: choice === 'none' ? null : choice })}
        hint="When no role mapping matches. No access refuses the sign-in."
      />
      <RoleMappingsEditor
        mappings={settings.role_mappings}
        disabled={disabled}
        onChange={(role_mappings) => set({ role_mappings })}
      />
      <OrgMappingsEditor
        mappings={settings.org_mappings}
        disabled={disabled}
        onChange={(org_mappings) => set({ org_mappings })}
      />
    </div>
  );
}

function EnvironmentProvider({ provider }: { provider: SsoProviderAdminView }): ReactElement {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-fg">{provider.display_name}</span>
        <Badge mono>{provider.id}</Badge>
        <Badge tone="info">Environment</Badge>
        {provider.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}
      </div>
      <p className="text-sm text-fg-muted">{ENVIRONMENT_PROVIDER_NOTE}</p>
      <CopyField label="Issuer" value={provider.issuer} />
      <CopyField label="Redirect URI" value={provider.redirect_uri} />
    </div>
  );
}

function ProvidersCard({ settings }: { settings: SsoAdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSso();
  const toast = useToast();
  const { canSuperAdmin } = useAuth();
  const environment = settings.providers.filter((provider) => provider.source === 'environment');
  const [drafts, setDrafts] = useState<ProviderDraft[]>(() =>
    settings.providers.filter((provider) => provider.source === 'settings').map(toDraft),
  );
  const redirects = new Map(
    settings.providers.map((provider): [string, string] => [provider.id, provider.redirect_uri]),
  );

  const save = (): void => {
    update.mutate(
      { providers: drafts.map(toInput) },
      {
        onSuccess: (saved) => {
          setDrafts(
            saved.providers.filter((provider) => provider.source === 'settings').map(toDraft),
          );
          toast.success('Single sign-on providers saved');
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader
        icon="key"
        title="Identity providers"
        description="OpenID Connect providers users can sign in with. Register each redirect URI with its provider."
      />
      <CardBody className="flex flex-col gap-4">
        {update.error ? <FormNotice>{update.error.message}</FormNotice> : null}
        {settings.shadowed_provider_ids.length > 0 ? (
          <FormNotice tone="warning">
            {`Stored provider ${settings.shadowed_provider_ids.join(', ')} has the id of an environment provider, which is the one in force. Save the providers to remove it; the environment provider's links are kept.`}
          </FormNotice>
        ) : null}
        {environment.map((provider) => (
          <EnvironmentProvider key={provider.id} provider={provider} />
        ))}
        {drafts.map((draft, index) => (
          <div
            key={draft.isNew ? `new-${index}` : draft.settings.id}
            className="flex flex-col gap-2"
          >
            <ProviderEditor
              draft={draft}
              disabled={!canSuperAdmin}
              onChange={(next) =>
                setDrafts((current) => current.map((item, i) => (i === index ? next : item)))
              }
              onRemove={() => setDrafts((current) => current.filter((_, i) => i !== index))}
            />
            {!draft.isNew && redirects.has(draft.settings.id) ? (
              <CopyField label="Redirect URI" value={redirects.get(draft.settings.id) ?? ''} />
            ) : null}
          </div>
        ))}
        {environment.length === 0 && drafts.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No provider is configured, so the sign-in page offers passwords only.
          </p>
        ) : null}
      </CardBody>
      <CardFooter>
        {canSuperAdmin ? (
          <>
            <Button onClick={() => setDrafts((current) => [...current, newDraft()])}>
              <Icon name="plus" className="h-4 w-4" />
              Add provider
            </Button>
            <Button variant="primary" loading={update.isPending} onClick={save}>
              Save providers
            </Button>
          </>
        ) : (
          <SuperAdminOnly />
        )}
      </CardFooter>
    </Card>
  );
}

/** The single sign-on settings tab. */
export function SsoTab(): ReactElement {
  const query = useAdminSso();
  if (query.isLoading || !query.data) return <LoadingPanel label="Loading single sign-on" />;
  return (
    <div className="flex flex-col gap-6">
      <PolicyCard settings={query.data} />
      <ProvidersCard settings={query.data} />
    </div>
  );
}
