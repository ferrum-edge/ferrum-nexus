import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { useCreateThread } from '../../hooks/useThreads';
import { useToast } from '../../stores/toast';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { LabeledInput, LabeledTextarea } from '../ui/Input';

export interface StartThreadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Counterparty; omit to address the platform administrators. */
  recipientUserId?: string | null;
  apiId?: string | null;
  defaultSubject?: string;
  /** Copy describing who will receive the message. */
  recipientLabel?: string;
}

/** Opens a new conversation and navigates to it. */
export function StartThreadDialog({
  open,
  onOpenChange,
  recipientUserId = null,
  apiId = null,
  defaultSubject = '',
  recipientLabel,
}: StartThreadDialogProps): ReactElement {
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState('');
  const createThread = useCreateThread();
  const navigate = useNavigate();
  const toast = useToast();

  const submit = (): void => {
    createThread.mutate(
      {
        subject: subject.trim() || defaultSubject || 'New conversation',
        body: body.trim(),
        recipient_user_id: recipientUserId,
        api_id: apiId,
      },
      {
        onSuccess: (response) => {
          toast.success('Message sent');
          onOpenChange(false);
          setBody('');
          void navigate({ to: '/messages/$threadId', params: { threadId: response.thread.id } });
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Start a conversation"
      description={recipientLabel ? `This message goes to ${recipientLabel}.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={createThread.isPending}
            disabled={body.trim().length === 0}
            onClick={submit}
          >
            Send
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <LabeledInput
          label="Subject"
          required
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
        <LabeledTextarea
          label="Message"
          required
          rows={6}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
    </Dialog>
  );
}
