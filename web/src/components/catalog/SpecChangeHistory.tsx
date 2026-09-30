import { useState, type ReactElement } from 'react';
import {
  describeSpecChange,
  type ApiSpecChangeEntry,
  type SpecChange,
  type SpecChangeReport,
} from '@ferrum-nexus/shared';
import { useCatalogSpecChanges } from '../../hooks/useCatalog';
import { formatDateTime } from '../../lib/format';
import { FormNotice } from '../auth/AuthShell';
import { Badge } from '../ui/Badge';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { PaginationBar } from '../ui/DataTable';
import { EmptyState } from '../ui/EmptyState';
import { LoadingPanel } from '../ui/Spinner';

/**
 * What each published revision of an API's specification changed, for the
 * people who call it (issue #448).
 *
 * Every summary was recorded when its revision was published, so the history
 * outlives the documents themselves. Provider-written names are rendered as
 * text, never as markup.
 *
 * The caveat is part of the component, as on the provider's review: this is a
 * structural comparison, and a consumer who read "nothing listed" as "safe"
 * would have been misled by the page rather than by the data.
 */

/** Revisions shown per page. */
export const CHANGE_HISTORY_PAGE_SIZE = 10;

function ChangeRow({ change }: { change: SpecChange }): ReactElement {
  const breaking = change.severity === 'breaking';
  return (
    <li className="flex flex-wrap items-start gap-2 text-sm">
      <Badge tone={breaking ? 'danger' : 'neutral'}>{breaking ? 'Breaking' : 'Non-breaking'}</Badge>
      {change.operation ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <Badge mono tone="info">
            {change.operation.method}
          </Badge>
          <code className="font-mono text-xs break-all">{change.operation.path}</code>
        </span>
      ) : null}
      <span className="min-w-0 break-words text-fg-muted">{describeSpecChange(change)}</span>
    </li>
  );
}

function RevisionReport({ report }: { report: SpecChangeReport }): ReactElement {
  const unlisted = report.counts.breaking + report.counts.non_breaking - report.changes.length;
  return (
    <div className="flex flex-col gap-3">
      {report.complete ? null : (
        <FormNotice tone="warning">
          This comparison is incomplete: the two revisions could not be compared in full, so only
          what was found before it stopped is listed.
        </FormNotice>
      )}
      {report.changed ? (
        <>
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Badge tone={report.counts.breaking > 0 ? 'danger' : 'neutral'}>
              {report.counts.breaking} breaking
            </Badge>
            <Badge>{report.counts.non_breaking} non-breaking</Badge>
            {report.info_changes.length > 0 ? (
              <span>Also changed: {report.info_changes.join(', ')}</span>
            ) : null}
          </p>
          {report.changes.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {report.changes.map((change, index) => (
                <ChangeRow key={index} change={change} />
              ))}
            </ul>
          ) : null}
          {report.truncated && unlisted > 0 ? (
            <p className="text-xs text-fg-subtle">
              …and {unlisted} more change{unlisted === 1 ? '' : 's'} not listed.
            </p>
          ) : null}
        </>
      ) : report.complete ? (
        <p className="text-sm text-fg-muted">
          No differences found: this revision declares the same operations, parameters and schemas
          as the one before it.
        </p>
      ) : null}
    </div>
  );
}

function RevisionEntry({ entry }: { entry: ApiSpecChangeEntry }): ReactElement {
  const replaced = entry.previous_version ? ` · replaced v${entry.previous_version}` : '';
  return (
    <li>
      <Card>
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              <Badge mono tone="accent">
                v{entry.version}
              </Badge>
              {entry.kind === 'rollback' ? (
                <Badge tone="warning">Rollback</Badge>
              ) : (
                <Badge tone="info">Update</Badge>
              )}
            </span>
          }
          description={`${formatDateTime(entry.created_at)}${replaced}`}
        />
        <CardBody>
          <RevisionReport report={entry.report} />
        </CardBody>
      </Card>
    </li>
  );
}

/** The Changes tab of a catalog entry. */
export function SpecChangeHistory({ slug }: { slug: string }): ReactElement {
  const [offset, setOffset] = useState(0);
  const query = useCatalogSpecChanges(slug, { limit: CHANGE_HISTORY_PAGE_SIZE, offset });

  if (query.isLoading) {
    return (
      <Card>
        <LoadingPanel label="Loading change history" />
      </Card>
    );
  }
  if (query.isError || !query.data) {
    return (
      <Card>
        <EmptyState
          icon="alert"
          tone="danger"
          title="Change history unavailable"
          description="The change history could not be loaded. Try again in a moment."
        />
      </Card>
    );
  }

  const { items, total } = query.data;
  if (total === 0) {
    return (
      <Card>
        <EmptyState
          icon="clock"
          title="No changes since it was first published"
          description="Each time the provider publishes a new revision of this API's specification, what it changed is listed here."
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-4" aria-label="Specification revisions">
        {items.map((entry) => (
          <RevisionEntry key={entry.id} entry={entry} />
        ))}
      </ol>
      {total > CHANGE_HISTORY_PAGE_SIZE ? (
        <Card>
          <PaginationBar
            offset={offset}
            limit={CHANGE_HISTORY_PAGE_SIZE}
            total={total}
            onOffsetChange={setOffset}
          />
        </Card>
      ) : null}
      <p className="text-xs leading-relaxed text-fg-muted">
        This is a structural comparison of operations, parameters, request bodies, responses and
        their schemas. It cannot see how the API behaves, so an empty list means the comparison
        found nothing, not that a change is safe for you.
      </p>
    </div>
  );
}
