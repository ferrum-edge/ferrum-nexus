import { useState, type ReactElement } from 'react';
import type { ShowOnceSecret } from '@ferrum-nexus/shared';
import { FormNotice } from '../auth/AuthShell';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CopyField } from '../ui/CopyField';
import { Dialog } from '../ui/Dialog';
import { Checkbox } from '../ui/Input';

/** Field labels for each credential flavour, in display order. */
const SECRET_FIELDS: ReadonlyArray<{ key: keyof ShowOnceSecret; label: string }> = [
  { key: 'key', label: 'API key' },
  { key: 'username', label: 'Username' },
  { key: 'password', label: 'Password' },
  { key: 'jwt_key', label: 'JWT subject (sub) / consumer username' },
  { key: 'jwt_secret', label: 'JWT signing secret' },
];

export interface ShowOnceSecretDialogProps {
  open: boolean;
  /** Called once the user acknowledges having saved the secret. */
  onAcknowledge: () => void;
  secret: ShowOnceSecret;
  /** Edge consumer username the credential belongs to. */
  consumerUsername: string;
  title?: string;
}

/**
 * Show-once credential display.
 *
 * The plaintext exists only in this response — the server keeps a fingerprint
 * and last4, nothing more. The dialog is therefore non-dismissible: Escape,
 * overlay clicks and the close button are all disabled until the user ticks the
 * acknowledgement.
 */
export function ShowOnceSecretDialog({
  open,
  onAcknowledge,
  secret,
  consumerUsername,
  title = 'Save your credential now',
}: ShowOnceSecretDialogProps): ReactElement {
  const [acknowledged, setAcknowledged] = useState(false);

  const fields = SECRET_FIELDS.filter((field) => typeof secret[field.key] === 'string');

  return (
    <Dialog
      open={open}
      onOpenChange={() => undefined}
      dismissible={false}
      title={title}
      description="This is the only time these values are shown. Nexus stores a fingerprint only — it cannot show or recover them again."
      footer={
        <Button
          variant="primary"
          className="w-full sm:w-auto"
          disabled={!acknowledged}
          onClick={() => {
            setAcknowledged(false);
            onAcknowledge();
          }}
        >
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <FormNotice tone="warning">
          <p className="font-medium text-fg">Copy these values before closing this dialog.</p>
          <p className="mt-0.5 text-fg-muted">
            They are never shown again, and nothing here can be recovered later.
          </p>
        </FormNotice>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-fg-subtle uppercase">
            Credential type
          </span>
          <Badge tone="accent" mono>
            {secret.type}
          </Badge>
        </div>

        <div className="flex flex-col gap-4 rounded-md border border-border bg-inset/50 p-4">
          <CopyField label="Consumer" value={consumerUsername} />
          {fields.map((field) => (
            <CopyField key={field.key} label={field.label} value={String(secret[field.key])} />
          ))}
        </div>

        {secret.type === 'jwt' ? (
          <p className="text-sm text-fg-muted">
            For Nexus-published JWT APIs, set sub to this username. Sign with the JWT secret.
          </p>
        ) : null}

        <div className="rounded-md border border-border bg-inset/60 p-3">
          <Checkbox
            label="I have saved these values somewhere safe."
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
        </div>
      </div>
    </Dialog>
  );
}
