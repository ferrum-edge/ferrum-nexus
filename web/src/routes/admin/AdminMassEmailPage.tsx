import { useState, type ReactElement } from 'react';
import { ROLE_LABELS, type MassEmailAudience, type Role } from '@ferrum-nexus/shared';
import { useMassEmail } from '../../hooks/useAdminSettings';
import { useToast } from '../../stores/toast';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LabeledInput, LabeledTextarea } from '../../components/ui/Input';
import { LabeledSelect } from '../../components/ui/Select';

type AudienceChoice = 'all' | 'client' | 'provider' | 'admin';

const AUDIENCE_OPTIONS: ReadonlyArray<{
  value: AudienceChoice;
  label: string;
  description: string;
}> = [
  { value: 'all', label: 'Everyone', description: 'All portal accounts, whatever their role.' },
  { value: 'client', label: ROLE_LABELS.client, description: 'Accounts with the client role.' },
  {
    value: 'provider',
    label: ROLE_LABELS.provider,
    description: 'Accounts with the provider role.',
  },
  { value: 'admin', label: ROLE_LABELS.admin, description: 'Administrators only.' },
];

function audienceFor(choice: AudienceChoice): MassEmailAudience {
  if (choice === 'all') return { scope: 'all' };
  return { scope: 'filtered', roles: [choice as Role], status: 'active' };
}

function Composer(): ReactElement {
  const send = useMassEmail();
  const toast = useToast();
  const [choice, setChoice] = useState<AudienceChoice>('all');
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const submit = (): void => {
    send.mutate(
      {
        subject: subject.trim(),
        body_text: bodyText,
        body_html: bodyHtml.trim() || `<p>${bodyText.replace(/\n/g, '<br />')}</p>`,
        audience: audienceFor(choice),
        idempotency_key: `mass-${subject.trim()}-${choice}`,
      },
      {
        onSuccess: (response) => {
          setConfirmOpen(false);
          toast.success(
            'Mass email queued',
            `${response.enqueued} of ${response.recipients} recipients enqueued.`,
          );
        },
      },
    );
  };

  return (
    <>
      <Card>
        <CardHeader
          title="Compose"
          description="One outbox row is enqueued per recipient; the idempotency key makes a repeated send at-most-once."
        />
        <CardBody className="flex flex-col gap-5">
          <LabeledSelect<AudienceChoice>
            label="Audience"
            value={choice}
            onValueChange={setChoice}
            options={AUDIENCE_OPTIONS.map((option) => ({ ...option }))}
          />
          <LabeledInput
            label="Subject"
            required
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
          <LabeledTextarea
            label="Plain-text body"
            required
            rows={8}
            value={bodyText}
            onChange={(event) => setBodyText(event.target.value)}
            hint="Sent as the text alternative; also used to build the HTML body when you leave it blank."
          />
          <LabeledTextarea
            label="HTML body"
            mono
            rows={8}
            value={bodyHtml}
            onChange={(event) => setBodyHtml(event.target.value)}
          />
          <div>
            <Button
              variant="primary"
              disabled={subject.trim().length === 0 || bodyText.trim().length === 0}
              onClick={() => setConfirmOpen(true)}
            >
              Review and send
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Send this mass email?"
        description={`Audience: ${AUDIENCE_OPTIONS.find((option) => option.value === choice)?.label}. This cannot be recalled once the outbox worker picks it up.`}
        confirmLabel="Send"
        loading={send.isPending}
        onConfirm={submit}
      />
    </>
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
