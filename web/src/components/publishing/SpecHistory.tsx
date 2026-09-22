import { useState, type ReactElement } from 'react';
import type { Api, ApiSpecSummary } from '@ferrum-nexus/shared';
import { formatDateTime } from '../../lib/format';
import {
  useApiRevision,
  useApiRevisionDiff,
  useApiRevisions,
  useRollbackApiSpec,
} from '../../hooks/useApis';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { LoadingPanel } from '../ui/Spinner';
import { SpecDiffView } from './SpecDiffView';

/**
 * The retained specification history of one API, with change review and
 * rollback (issue #290).
 *
 * Rollback is deliberately behind a review step rather than being one click on
 * a list row: restoring an earlier document can take operations away from live
 * callers, and under `routes` enforcement the gateway starts rejecting them
 * immediately. The dialog shows the comparison in the direction the change
 * would go — from what the API serves today to what it would serve — and names
 * the removals before it offers the button.
 */

const PAGE_SIZE = 20;

/** One revision's label: its parsed version, falling back to the stored one. */
function versionOf(revision: ApiSpecSummary): string {
  return revision.parsed_version ?? revision.version;
}

function RollbackDialog({
  api,
  revision,
  onClose,
}: {
  api: Api;
  revision: ApiSpecSummary;
  onClose: () => void;
}): ReactElement {
  const diff = useApiRevisionDiff(api.id, revision.id);
  const rollback = useRollbackApiSpec();
  const toast = useToast();

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Roll back to version ${versionOf(revision)}`}
      description="This publishes the earlier document as a new revision. Nothing in the history is rewritten, and the API keeps its id, slug, grants and gateway address."
      confirmLabel="Roll back"
      danger={(diff.data?.diff.potentially_breaking.length ?? 0) > 0}
      loading={rollback.isPending}
      confirmDisabled={diff.isLoading || diff.isError}
      onConfirm={() =>
        rollback.mutate(
          { id: api.id, revisionId: revision.id },
          {
            onSuccess: () => {
              toast.success(`Rolled back to version ${versionOf(revision)}`);
              onClose();
            },
            onError: (error: Error) => toast.error('Rollback failed', error.message),
          },
        )
      }
    >
      {diff.isLoading ? (
        <LoadingPanel label="Comparing revisions" />
      ) : diff.isError ? (
        <p className="text-sm text-danger">
          The comparison could not be loaded, so there is nothing to review. Try again before
          rolling back.
        </p>
      ) : diff.data ? (
        <SpecDiffView diff={diff.data.diff} />
      ) : null}
    </ConfirmDialog>
  );
}

/**
 * Who published a revision, in words.
 *
 * The summary carries an account id, not a name, and an id is not something to
 * show a person. "You" is the case that matters most — a provider reviewing
 * their own history — and anybody else is described rather than identified.
 */
function authorLabel(createdBy: string | null, viewerId: string | undefined): string {
  if (createdBy === null) return 'author not recorded';
  return createdBy === viewerId ? 'by you' : 'by another account';
}

function RevisionRow({
  api,
  revision,
  viewerId,
  onRollback,
}: {
  api: Api;
  revision: ApiSpecSummary;
  viewerId: string | undefined;
  onRollback: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const document = useApiRevision(api.id, open ? revision.id : null);

  return (
    <li className="flex flex-col gap-3 border-b border-border px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge mono>v{versionOf(revision)}</Badge>
          {revision.is_current ? <Badge tone="success">Current</Badge> : null}
          {revision.rolled_back_from_id ? <Badge tone="info">Rollback</Badge> : null}
          <span className="text-sm text-fg-muted">{formatDateTime(revision.created_at)}</span>
          <span className="text-xs text-fg-muted">
            {/* Never attributed to somebody we cannot name: an unrecorded or
                deleted author reads as unknown, not as the current user. */}
            {authorLabel(revision.created_by, viewerId)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setOpen((value) => !value)}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
            {open ? 'Hide document' : 'View document'}
          </Button>
          {revision.is_current ? null : (
            <Button variant="secondary" onClick={onRollback}>
              Review &amp; roll back
            </Button>
          )}
        </div>
      </div>
      {open ? (
        document.isLoading ? (
          <LoadingPanel label="Loading revision" />
        ) : document.isError ? (
          <p className="text-sm text-danger">
            This revision is no longer retained — publishing enough revisions drops the oldest.
          </p>
        ) : (
          <pre className="max-h-80 overflow-auto rounded-md bg-inset/60 p-3 font-mono text-xs whitespace-pre-wrap">
            {document.data?.raw_spec}
          </pre>
        )
      ) : null}
    </li>
  );
}

/** Retained revisions for one API, with review and rollback. */
export function SpecHistory({ api }: { api: Api }): ReactElement {
  const [page, setPage] = useState(0);
  const [target, setTarget] = useState<ApiSpecSummary | null>(null);
  const query = useApiRevisions(api.id, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const { user } = useAuth();

  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon="clock"
        title="Revision history"
        description="Every retained revision of this API's specification, newest first. Rolling one back publishes it as a new revision."
      />
      {query.isLoading ? (
        <LoadingPanel label="Loading revision history" />
      ) : query.isError ? (
        <CardBody>
          <p className="text-sm text-danger">The revision history could not be loaded.</p>
        </CardBody>
      ) : total === 0 ? (
        <EmptyState
          icon="spec"
          title="No revisions yet"
          description="Publishing a specification records the first revision."
        />
      ) : (
        <>
          <ul className="flex flex-col">
            {query.data?.items.map((revision) => (
              <RevisionRow
                key={revision.id}
                api={api}
                revision={revision}
                viewerId={user?.id}
                onRollback={() => setTarget(revision)}
              />
            ))}
          </ul>
          {pages > 1 ? (
            <div className="flex items-center justify-between gap-2 border-t border-border bg-inset/40 px-5 py-3">
              <span className="text-xs text-fg-muted tabular-nums">
                Page {page + 1} of {pages} · {total} revisions
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
      {target ? (
        <RollbackDialog api={api} revision={target} onClose={() => setTarget(null)} />
      ) : null}
    </Card>
  );
}
