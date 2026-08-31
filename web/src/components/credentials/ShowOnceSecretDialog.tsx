import { useState, type ReactElement } from 'react';
import type { ShowOnceSecret } from '@ferrum-nexus/shared';
import { Button } from '../ui/Button';
import { CopyField } from '../ui/CopyField';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

/** Field labels for each credential flavour, in display order. */
const SECRET_FIELDS: ReadonlyArray<{ key: keyof ShowOnceSecret; label: string }> = [
  { key: 'key', label: 'API key' },
  { key: 'username', label: 'Username' },
  { key: 'password', label: 'Password' },
  { key: 'jwt_key', label: 'JWT key id (iss)' },
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
        <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning-soft p-3">
          <Icon name="alert" className="mt-0.5 h-4 w-4 text-warning" />
          <p className="text-sm text-fg">
            Copy these values into your secret store before closing this dialog.
          </p>
        </div>

        <CopyField label="Consumer" value={consumerUsername} />
        <CopyField label="Credential type" value={secret.type} mono={false} />
        {fields.map((field) => (
          <CopyField key={field.key} label={field.label} value={String(secret[field.key])} />
        ))}

        <label className="flex items-start gap-2.5 text-sm text-fg">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
          />
          I have saved these values somewhere safe.
        </label>
      </div>
    </Dialog>
  );
}
