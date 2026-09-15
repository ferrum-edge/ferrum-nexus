import { useRef, useState, type ReactElement } from 'react';
import { useMassEmail } from '../../hooks/useAdminSettings';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';
import {
  AudienceFields,
  EVERYONE,
  audienceFrom,
  audienceReady,
  describeAudience,
  type AudienceDraft,
} from '../../components/admin/AudienceFields';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { FormNotice } from '../../components/auth/AuthShell';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Icon } from '../../components/ui/Icon';
import { LabeledInput, LabeledTextarea } from '../../components/ui/Input';

/** What the last completed send reached, kept so the page can report it. */
interface SendSummary {
  enqueued: number;
  recipients: number;
}

/** One number from the outcome summary. */
function OutcomeTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: 'send' | 'users';
  label: string;
  value: number;
  tone: 'success' | 'neutral';
}): ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3">
      <span
        className={
          tone === 'success'
            ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-success-soft text-success'
            : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-neutral-soft text-fg-muted'
        }
      >
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-xl font-semibold text-fg tabular-nums">{value}</span>
        <span className="block truncate text-xs text-fg-subtle">{label}</span>
      </span>
    </div>
  );
}

function Composer(): ReactElement {
  const send = useMassEmail();
  const toast = useToast();
  const { user } = useAuth();
  const [audience, setAudience] = useState<AudienceDraft>(EVERYONE);
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [summary, setSummary] = useState<SendSummary | null>(null);
  const campaign = useRef<{ id: string; content: string } | null>(null);
  const submitting = useRef(false);

  const submit = (): void => {
    if (submitting.current) return;
    const request = {
      subject: subject.trim(),
      body_text: bodyText,
      body_html: bodyHtml.trim() || `<p>${bodyText.replace(/\n/g, '<br />')}</p>`,
      audience: audienceFrom(audience),
    };
    // Keep the failed submission's ID until its content changes or it succeeds.
    const content = JSON.stringify(request);
    const isRetry = campaign.current?.content === content;
    if (!isRetry) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      campaign.current = {
        id: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        content,
      };
    }
    const id = campaign.current?.id;
    if (!id) return;
    submitting.current = true;
    send.mutate(
      {
        ...request,
        idempotency_key: id,
      },
      {
        onSuccess: (response) => {
          setConfirmOpen(false);
          campaign.current = null;
          if (response.enqueued === 0 && response.recipients > 0) {
            if (isRetry) {
              toast.push('Mass email already queued', {
                description: 'This campaign was already queued. No duplicate messages were added.',
              });
            } else {
              toast.error(
                'Mass email unexpectedly deduplicated',
                'No messages were added for this new campaign. Check the audit log before resending.',
              );
            }
            return;
          }
          setSummary({ enqueued: response.enqueued, recipients: response.recipients });
          toast.success(
            'Mass email queued',
            `${response.enqueued} of ${response.recipients} recipients enqueued.`,
          );
        },
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  const canSend =
    subject.trim().length > 0 && bodyText.trim().length > 0 && audienceReady(audience);

  return (
    <div className="flex flex-col gap-5">
      {summary ? (
        <div className="flex flex-col gap-3">
          <FormNotice tone="success">
            Queued for the outbox worker. Delivery failures are retried with backoff and recorded in
            the audit log.
          </FormNotice>
          <div className="grid gap-3 sm:grid-cols-2">
            <OutcomeTile
              icon="send"
              label="Messages enqueued"
              value={summary.enqueued}
              tone="success"
            />
            <OutcomeTile
              icon="users"
              label="Recipients in the audience"
              value={summary.recipients}
              tone="neutral"
            />
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader
          icon="megaphone"
          title="Compose"
          description="Retry unchanged submissions to avoid duplicates. Each completed send starts a new campaign."
        />
        <CardBody className="flex flex-col gap-5">
          <AudienceFields
            value={audience}
            onChange={setAudience}
            self={user ? { id: user.id, label: user.display_name } : null}
          />
          <LabeledInput
            label="Subject"
            required
            maxLength={300}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            hint="Shown in the recipient's inbox; up to 300 characters."
          />
          <div className="grid gap-5 md:grid-cols-2">
            <LabeledTextarea
              label="Plain-text body"
              required
              rows={10}
              value={bodyText}
              onChange={(event) => setBodyText(event.target.value)}
              hint="Sent as the text alternative; also used to build the HTML body when you leave it blank."
            />
            <LabeledTextarea
              label="HTML body"
              mono
              rows={10}
              value={bodyHtml}
              onChange={(event) => setBodyHtml(event.target.value)}
              hint="Optional. Leave blank to wrap the plain-text body in paragraphs."
            />
          </div>
        </CardBody>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-inset/40 px-5 py-3">
          <p className="text-xs text-fg-subtle">
            Goes to <span className="text-fg-muted">{describeAudience(audience)}</span>.
          </p>
          <Button variant="primary" disabled={!canSend} onClick={() => setConfirmOpen(true)}>
            Review and send
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Send this mass email?"
        description={`This goes to ${describeAudience(audience)}. It cannot be recalled once the outbox worker picks it up.`}
        confirmLabel="Send"
        loading={send.isPending}
        onConfirm={submit}
      />
    </div>
  );
}

/** Mass email composer. */
export function AdminMassEmailPage(): ReactElement {
  return (
    <RoleGuard minRole="admin">
      <PageHeader
        title="Mass email"
        description="Send an announcement to a slice of the portal's accounts."
      />
      <Composer />
    </RoleGuard>
  );
}
