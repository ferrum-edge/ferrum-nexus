/**
 * The audience selector shared by the mass-email composer and the god-mode
 * broadcast panel.
 *
 * Both endpoints take the same {@link MassEmailAudience}, and the server has
 * always accepted several roles at once, an organization filter, a status and
 * an explicit list of recipients. The two composers used to emit exactly one
 * shape — `{ scope: 'filtered', roles: [oneRole], status: 'active' }` — with
 * two consequences worth spelling out:
 *
 * - the "Administrator" option meant `roles: ['admin']`, which does not match
 *   `super_admin`, so the audience an operator reaches for in an incident
 *   silently skipped the most privileged accounts;
 * - the guide's mandatory pre-send step — send to yourself first, with an
 *   explicit audience of one — was impossible, and organizations were
 *   unaddressable.
 *
 * Roles are therefore a multi-select with an "all administrative roles"
 * shortcut, and the `explicit` scope is a real recipient list.
 */

import { useState, type ReactElement } from 'react';
import {
  ELEVATED_ROLES,
  MAX_PAGE_SIZE,
  ROLE_LABELS,
  ROLE_ORDER,
  type MassEmailAudience,
  type Role,
  type UserStatus,
} from '@ferrum-nexus/shared';
import { useOrganizations, useUsers } from '../../hooks/useUsers';
import { Button } from '../ui/Button';
import { Checkbox, Field, FieldGroup, Input } from '../ui/Input';
import { LabeledSelect } from '../ui/Select';

/**
 * Sentinel for "no organization filter". A select item's value may not be the
 * empty string, so the unfiltered choice needs a value of its own.
 */
const ANY_ORG = '__any__';

/** One named recipient of an `explicit` audience. */
export interface RecipientChoice {
  id: string;
  label: string;
}

/** Everything the composer needs to build a {@link MassEmailAudience}. */
export interface AudienceDraft {
  scope: MassEmailAudience['scope'];
  roles: readonly Role[];
  status: UserStatus;
  orgId: string | null;
  /** Name of {@link AudienceDraft.orgId}, kept so the confirmation can say it. */
  orgName: string | null;
  recipients: readonly RecipientChoice[];
}

/** The default draft: every active account, exactly as before. */
export const EVERYONE: AudienceDraft = {
  scope: 'all',
  roles: [],
  status: 'active',
  orgId: null,
  orgName: null,
  recipients: [],
};

/** Translate the draft into the wire audience. */
export function audienceFrom(draft: AudienceDraft): MassEmailAudience {
  if (draft.scope === 'all') return { scope: 'all' };
  if (draft.scope === 'explicit') {
    return { scope: 'explicit', user_ids: draft.recipients.map((recipient) => recipient.id) };
  }
  return {
    scope: 'filtered',
    status: draft.status,
    // No role checked means "any role", which is what omitting the filter does.
    ...(draft.roles.length > 0 ? { roles: [...draft.roles] } : {}),
    ...(draft.orgId !== null ? { org_id: draft.orgId } : {}),
  };
}

/** False while the draft cannot be sent — an explicit audience with nobody in it. */
export function audienceReady(draft: AudienceDraft): boolean {
  return draft.scope !== 'explicit' || draft.recipients.length > 0;
}

/** One line naming the audience, for the confirmation dialog. */
export function describeAudience(draft: AudienceDraft): string {
  if (draft.scope === 'all') return 'every active account';
  if (draft.scope === 'explicit') {
    const names = draft.recipients.map((recipient) => recipient.label).join(', ');
    if (draft.recipients.length === 1) return names;
    return `${draft.recipients.length} accounts (${names})`;
  }
  const labels: string[] = [];
  for (const role of ROLE_ORDER) {
    if (draft.roles.includes(role)) labels.push(ROLE_LABELS[role]);
  }
  const roles = labels.length === 0 ? 'every role' : labels.join(', ');
  const status = draft.status === 'active' ? 'active' : 'disabled';
  const where = draft.orgName ? ` in ${draft.orgName}` : '';
  return `${status} accounts with ${roles}${where}`;
}

/** Spelled out because the omission it warns about is the defect this fixes. */
const ROLE_HINT =
  'Leave every box clear to reach all roles. Administrators are two separate roles — a send ' +
  'aimed at Admin alone does not reach a super admin.';

const SCOPES: ReadonlyArray<{
  value: MassEmailAudience['scope'];
  label: string;
  description: string;
}> = [
  { value: 'all', label: 'Everyone', description: 'Every active account, whatever their role.' },
  {
    value: 'filtered',
    label: 'Filtered',
    description: 'Combine roles, status and organization.',
  },
  {
    value: 'explicit',
    label: 'Specific accounts',
    description: 'A list you name, up to 5000 — this is how you send a test to yourself.',
  },
];

/** A native radio, so the group stays keyboard- and test-reachable. */
function Radio({
  id,
  name,
  label,
  description,
  checked,
  onSelect,
}: {
  id: string;
  name: string;
  label: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
}): ReactElement {
  return (
    <div className="flex items-start gap-2.5">
      <input
        type="radio"
        id={id}
        name={name}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
        checked={checked}
        onChange={onSelect}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        <p className="text-xs text-fg-subtle">{description}</p>
      </div>
    </div>
  );
}

/** One chosen recipient of an explicit audience, with the control that drops it. */
function RecipientChip({
  recipient,
  onRemove,
}: {
  recipient: RecipientChoice;
  onRemove: () => void;
}): ReactElement {
  return (
    <li className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-fg">
      {recipient.label}
      <Button size="sm" variant="ghost" onClick={onRemove}>
        {`Remove ${recipient.label}`}
      </Button>
    </li>
  );
}

export interface AudienceFieldsProps {
  value: AudienceDraft;
  onChange: (next: AudienceDraft) => void;
  /**
   * The signed-in account, offered as a one-click explicit recipient. Omitted
   * by the broadcast panel, which excludes its sender from every send.
   */
  self?: RecipientChoice | null;
  /** Distinguishes the radio groups when two composers share a page. */
  name?: string;
}

/** Audience controls for `POST /api/admin/mass-email` and the god broadcast. */
export function AudienceFields({
  value,
  onChange,
  self = null,
  name = 'audience',
}: AudienceFieldsProps): ReactElement {
  const [search, setSearch] = useState('');
  const term = search.trim();
  const organizations = useOrganizations({ limit: MAX_PAGE_SIZE }, value.scope === 'filtered');
  const matches = useUsers(
    { q: term, limit: 10, status: 'active' },
    value.scope === 'explicit' && term.length > 0,
  );
  const orgs = organizations.data?.items ?? [];
  const chosen = new Set(value.recipients.map((recipient) => recipient.id));

  const toggleRole = (role: Role, checked: boolean): void => {
    onChange({
      ...value,
      roles: ROLE_ORDER.filter((entry) => {
        if (entry === role) return checked;
        return value.roles.includes(entry);
      }),
    });
  };

  const addRecipient = (recipient: RecipientChoice): void => {
    if (chosen.has(recipient.id)) return;
    onChange({ ...value, recipients: [...value.recipients, recipient] });
  };

  const removeRecipient = (id: string): void => {
    onChange({ ...value, recipients: value.recipients.filter((entry) => entry.id !== id) });
  };

  const chooseOrg = (next: string): void => {
    if (next === ANY_ORG) {
      onChange({ ...value, orgId: null, orgName: null });
      return;
    }
    const org = orgs.find((entry) => entry.id === next);
    onChange({ ...value, orgId: next, orgName: org?.name ?? next });
  };

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup label="Audience">
        <div className="flex flex-col gap-2">
          {SCOPES.map((scope) => (
            <Radio
              key={scope.value}
              id={`${name}-${scope.value}`}
              name={name}
              label={scope.label}
              description={scope.description}
              checked={value.scope === scope.value}
              onSelect={() => onChange({ ...value, scope: scope.value })}
            />
          ))}
        </div>
      </FieldGroup>

      {value.scope === 'filtered' ? (
        <div className="flex flex-col gap-4 rounded-md border border-border bg-inset p-4">
          <FieldGroup label="Roles" hint={ROLE_HINT}>
            <div className="flex flex-col gap-2">
              {ROLE_ORDER.map((role) => (
                <Checkbox
                  key={role}
                  label={ROLE_LABELS[role]}
                  checked={value.roles.includes(role)}
                  onChange={(event) => toggleRole(role, event.target.checked)}
                />
              ))}
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onChange({ ...value, roles: [...ELEVATED_ROLES] })}
                >
                  All administrative roles
                </Button>
              </div>
            </div>
          </FieldGroup>
          <FieldGroup label="Account status">
            <div className="flex flex-col gap-2">
              <Radio
                id={`${name}-status-active`}
                name={`${name}-status`}
                label="Active accounts"
                description="The usual choice; an Everyone send never mails a disabled account."
                checked={value.status === 'active'}
                onSelect={() => onChange({ ...value, status: 'active' })}
              />
              <Radio
                id={`${name}-status-disabled`}
                name={`${name}-status`}
                label="Disabled accounts"
                description="Reaches accounts that can no longer sign in."
                checked={value.status === 'disabled'}
                onSelect={() => onChange({ ...value, status: 'disabled' })}
              />
            </div>
          </FieldGroup>
          <LabeledSelect
            label="Organization"
            value={value.orgId ?? ANY_ORG}
            onValueChange={chooseOrg}
            options={[
              { value: ANY_ORG, label: 'Every organization' },
              ...orgs.map((org) => ({ value: org.id, label: org.name })),
            ]}
          />
        </div>
      ) : null}

      {value.scope === 'explicit' ? (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-inset p-4">
          {self ? (
            <div>
              <Button size="sm" variant="secondary" onClick={() => addRecipient(self)}>
                Add myself
              </Button>
            </div>
          ) : null}
          <Field
            label="Find an account"
            htmlFor={`${name}-recipient-search`}
            hint="Search by name or email, then add each recipient."
          >
            <Input
              id={`${name}-recipient-search`}
              placeholder="Search by name or email"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
          {term.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {(matches.data?.items ?? []).map((user) => (
                <li key={user.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm text-fg-muted">
                    {user.display_name} <span className="text-fg-subtle">{user.email}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={chosen.has(user.id)}
                    onClick={() => addRecipient({ id: user.id, label: user.display_name })}
                  >
                    {chosen.has(user.id) ? 'Added' : `Add ${user.display_name}`}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <FieldGroup label="Recipients">
            {value.recipients.length === 0 ? (
              <p className="text-sm text-fg-subtle">Nobody selected yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {value.recipients.map((recipient) => (
                  <RecipientChip
                    key={recipient.id}
                    recipient={recipient}
                    onRemove={() => removeRecipient(recipient.id)}
                  />
                ))}
              </ul>
            )}
          </FieldGroup>
        </div>
      ) : null}
    </div>
  );
}
