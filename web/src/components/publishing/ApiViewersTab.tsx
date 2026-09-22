import { useState, type FormEvent, type ReactElement } from 'react';
import type { Api } from '@ferrum-nexus/shared';
import { formatDateTime } from '../../lib/format';
import { useApiViewers, useAuthorizeApiViewer, useRevokeApiViewer } from '../../hooks/useApis';
import { useToast } from '../../stores/toast';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { LabeledInput } from '../ui/Input';
import { LoadingPanel } from '../ui/Spinner';

/**
 * Who may read a private API's documentation (issue #288).
 *
 * The wording here does a job. "Authorize" and "grant" are two different
 * things in this portal, and the one word providers reach for covers both — so
 * every surface in this tab says which one it is, and the empty state and the
 * confirmation both name what an authorization does *not* do. A provider who
 * wants a partner to be able to call the API has to approve an access request,
 * and should find that out here rather than in an incident.
 */

const PAGE_SIZE = 20;

/** The note explaining that reading the docs is not permission to call. */
function NotAGrantNotice(): ReactElement {
  return (
    <p className="text-sm leading-relaxed text-fg-muted">
      Authorizing someone lets them find this API in the catalog and read its specification. It does{' '}
      <strong className="font-semibold text-fg">not</strong> let them call it — for that they still
      request access and you approve it, exactly as for any other client.
    </p>
  );
}

export function ApiViewersTab({ api }: { api: Api }): ReactElement {
  const [page, setPage] = useState(0);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ userId: string; label: string } | null>(null);

  const query = useApiViewers(api.id, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const authorize = useAuthorizeApiViewer();
  const revoke = useRevokeApiViewer();
  const toast = useToast();

  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    const address = email.trim();
    if (address === '') {
      setError('Enter the email address of the account to authorize.');
      return;
    }
    authorize.mutate(
      { id: api.id, body: { email: address, note: note.trim() || null } },
      {
        onSuccess: () => {
          setEmail('');
          setNote('');
          toast.success('Viewer authorized');
        },
        onError: (mutationError: Error) => setError(mutationError.message),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {api.visibility === 'private' ? null : (
        <Card>
          <CardBody className="flex items-start gap-3">
            <span className="mt-0.5 text-fg-muted">
              <Icon name="info" className="h-4 w-4" />
            </span>
            <p className="text-sm leading-relaxed text-fg-muted">
              This API&rsquo;s visibility is{' '}
              <strong className="font-semibold text-fg">
                {api.visibility === 'public' ? 'Public' : 'Internal (unlisted)'}
              </strong>
              , so this list is not enforcing anything right now
              {api.visibility === 'public'
                ? ' — every signed-in user can already read it.'
                : ' — anyone with the link can already read it. Unlisted is not private.'}{' '}
              The list is kept, and takes effect if you switch this API to Private.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          icon="users"
          title="Authorize a viewer"
          description="By the email address of their portal account."
        />
        <CardBody>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <NotAGrantNotice />
            <div className="grid gap-4 sm:grid-cols-2">
              <LabeledInput
                label="Email address"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="partner@example.com"
              />
              <LabeledInput
                label="Note (optional)"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Design partner"
              />
            </div>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <div>
              <Button type="submit" variant="primary" loading={authorize.isPending}>
                <Icon name="plus" />
                Authorize
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          icon="eye"
          title="Authorized viewers"
          description="Accounts that can read this API's documentation."
        />
        {query.isLoading ? (
          <LoadingPanel label="Loading viewers" />
        ) : query.isError ? (
          <CardBody>
            <p className="text-sm text-danger">The viewer list could not be loaded.</p>
          </CardBody>
        ) : total === 0 ? (
          <EmptyState
            icon="users"
            title="Nobody is authorized yet"
            description="Owners, administrators and approved clients can always read this API. Authorize anyone else who needs to see the documentation."
          />
        ) : (
          <>
            <ul className="flex flex-col">
              {query.data?.items.map((viewer) => (
                <li
                  key={viewer.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-fg">
                        {viewer.user?.display_name ?? viewer.user_id}
                      </span>
                      {viewer.user ? (
                        <span className="text-xs text-fg-muted">{viewer.user.email}</span>
                      ) : null}
                      <Badge tone="info">Docs only</Badge>
                    </span>
                    <span className="text-xs text-fg-muted">
                      Authorized {formatDateTime(viewer.created_at)}
                      {viewer.note ? ` · ${viewer.note}` : ''}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setRevoking({
                        userId: viewer.user_id,
                        label: viewer.user?.email ?? viewer.user_id,
                      })
                    }
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
            {pages > 1 ? (
              <div className="flex items-center justify-between gap-2 border-t border-border bg-inset/40 px-5 py-3">
                <span className="text-xs text-fg-muted tabular-nums">
                  Page {page + 1} of {pages} · {total} viewers
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    disabled={page === 0}
                    onClick={() => setPage((value) => Math.max(0, value - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={page + 1 >= pages}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </Card>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => {
          if (!next) setRevoking(null);
        }}
        title="Revoke documentation access"
        description={
          revoking
            ? `${revoking.label} will no longer find or read this API. Any access grant they hold is left alone — revoke that from the Grants tab if you need to.`
            : ''
        }
        confirmLabel="Revoke"
        danger
        loading={revoke.isPending}
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(
            { id: api.id, userId: revoking.userId },
            {
              onSuccess: () => {
                toast.success('Documentation access revoked');
                setRevoking(null);
              },
              onError: (mutationError: Error) =>
                toast.error('Revoke failed', mutationError.message),
            },
          );
        }}
      />
    </div>
  );
}
