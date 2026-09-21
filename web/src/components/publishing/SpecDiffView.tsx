import type { ReactElement } from 'react';
import type { SpecDiff, SpecOperationRef } from '@ferrum-nexus/shared';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';

/**
 * A structural comparison of two OpenAPI revisions, rendered for review.
 *
 * ## The caveat is part of the component
 *
 * This comparison reads paths, methods and the shape of each operation. It
 * does not resolve `$ref`s or walk schemas, so a response that quietly drops a
 * required field shows up — if at all — as "responses changed", and an empty
 * breaking-change list is not evidence of compatibility. A reviewer who read
 * "no breaking changes" and shipped a narrowed schema would have been misled
 * by the UI, not by the data, so the caveat is rendered alongside the counts
 * rather than left to documentation (issue #290).
 */

function OperationList({
  operations,
  tone,
}: {
  operations: SpecOperationRef[];
  tone: 'success' | 'danger' | 'warning';
}): ReactElement {
  return (
    <ul className="flex flex-col gap-1">
      {operations.map((operation) => (
        <li key={`${operation.method} ${operation.path}`} className="flex items-center gap-2">
          <Badge tone={tone} mono>
            {operation.method}
          </Badge>
          <code className="font-mono text-xs break-all">{operation.path}</code>
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactElement;
}): ReactElement | null {
  if (count === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        {title} ({count})
      </h4>
      {children}
    </div>
  );
}

/** Render one {@link SpecDiff}. */
export function SpecDiffView({ diff }: { diff: SpecDiff }): ReactElement {
  if (!diff.changed) {
    return (
      <p className="text-sm text-fg-muted">
        This document declares the same paths, methods and operations as the current revision.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {diff.potentially_breaking.length > 0 ? (
        <div className="flex items-start gap-3 rounded-md border border-danger/40 bg-danger-soft/40 p-3">
          <span className="mt-0.5 text-danger">
            <Icon name="alert" className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg">
              {diff.potentially_breaking.length} operation
              {diff.potentially_breaking.length === 1 ? '' : 's'} would stop being served
            </p>
            <p className="mt-1 text-sm leading-relaxed text-fg-muted">
              Callers using these today will stop working. Under <code>routes</code> enforcement the
              gateway rejects them outright; under <code>docs_only</code> they stop being documented
              while the proxy keeps forwarding them.
            </p>
            <div className="mt-2">
              <OperationList operations={diff.potentially_breaking} tone="danger" />
            </div>
          </div>
        </div>
      ) : null}

      <Section title="Added operations" count={diff.added_operations.length}>
        <OperationList operations={diff.added_operations} tone="success" />
      </Section>

      <Section title="Changed operations" count={diff.changed_operations.length}>
        <ul className="flex flex-col gap-1">
          {diff.changed_operations.map((operation) => (
            <li
              key={`${operation.method} ${operation.path}`}
              className="flex flex-wrap items-center gap-2"
            >
              <Badge tone="warning" mono>
                {operation.method}
              </Badge>
              <code className="font-mono text-xs break-all">{operation.path}</code>
              <span className="text-xs text-fg-muted">{operation.changes.join(', ')}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Metadata" count={diff.info_changes.length + (diff.servers_changed ? 1 : 0)}>
        <ul className="flex flex-col gap-1 text-sm">
          {diff.info_changes.map((change) => (
            <li key={change.field} className="text-fg-muted">
              <span className="font-medium text-fg">{change.field}</span>: {change.from ?? '—'} →{' '}
              {change.to ?? '—'}
            </li>
          ))}
          {diff.servers_changed ? (
            <li className="text-fg-muted">
              <span className="font-medium text-fg">servers</span>: the declared server list
              differs. The proxy backend only follows it when the API is still pointed at the
              previous revision&rsquo;s server.
            </li>
          ) : null}
        </ul>
      </Section>

      <p className="border-t border-border pt-3 text-xs leading-relaxed text-fg-muted">
        This is a structural comparison of paths, methods and operation members. It does not read
        schemas or resolve <code>$ref</code>s, so it cannot tell you a change is backward compatible
        &mdash; an empty list above means this comparison found nothing, not that callers are safe.
      </p>
    </div>
  );
}
