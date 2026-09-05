import { useMemo, useState, type ReactElement } from 'react';
import { cn } from '../../lib/cn';
import { Badge, type BadgeTone } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { SchemaView } from './SchemaView';
import {
  asRecord,
  asString,
  parseSpecText,
  type HttpMethod,
  type ParsedSpec,
  type SpecNode,
  type SpecOperation,
  type SpecTagGroup,
} from './parse';

const METHOD_TONES: Readonly<Record<HttpMethod, BadgeTone>> = {
  get: 'info',
  post: 'success',
  put: 'warning',
  patch: 'accent',
  delete: 'danger',
  head: 'neutral',
  options: 'neutral',
  trace: 'neutral',
};

function statusTone(status: string): BadgeTone {
  if (status.startsWith('2')) return 'success';
  if (status.startsWith('3')) return 'info';
  if (status.startsWith('4')) return 'warning';
  if (status.startsWith('5')) return 'danger';
  return 'neutral';
}

function ParameterTable({
  parameters,
  doc,
}: {
  parameters: SpecNode[];
  doc: SpecNode;
}): ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="py-1.5 pr-3 text-left text-xs text-fg-subtle uppercase">
              Name
            </th>
            <th scope="col" className="py-1.5 pr-3 text-left text-xs text-fg-subtle uppercase">
              In
            </th>
            <th scope="col" className="py-1.5 pr-3 text-left text-xs text-fg-subtle uppercase">
              Required
            </th>
            <th scope="col" className="py-1.5 text-left text-xs text-fg-subtle uppercase">
              Schema
            </th>
          </tr>
        </thead>
        <tbody>
          {parameters.map((parameter, index) => (
            <tr
              key={`${asString(parameter.name) ?? 'param'}-${index}`}
              className="border-b border-border last:border-b-0"
            >
              <td className="py-2 pr-3 align-top">
                <code className="font-mono text-xs text-fg">{asString(parameter.name) ?? '—'}</code>
                {asString(parameter.description) ? (
                  <p className="mt-0.5 text-xs text-fg-muted">{asString(parameter.description)}</p>
                ) : null}
              </td>
              <td className="py-2 pr-3 align-top text-xs text-fg-muted">
                {asString(parameter.in) ?? '—'}
              </td>
              <td className="py-2 pr-3 align-top text-xs">
                {parameter.required === true ? (
                  <span className="text-danger">required</span>
                ) : (
                  <span className="text-fg-subtle">optional</span>
                )}
              </td>
              <td className="py-2 align-top">
                {parameter.schema !== undefined ? (
                  <SchemaView schema={parameter.schema} doc={doc} />
                ) : (
                  <span className="text-xs text-fg-subtle">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContentSchemas({
  content,
  doc,
}: {
  content: unknown;
  doc: SpecNode;
}): ReactElement | null {
  const record = asRecord(content);
  if (!record) return null;
  const entries = Object.entries(record);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {entries.map(([mediaType, value]) => {
        const media = asRecord(value);
        return (
          <div key={mediaType}>
            <p className="mb-1 font-mono text-xs text-fg-subtle">{mediaType}</p>
            {media && media.schema !== undefined ? (
              <SchemaView schema={media.schema} doc={doc} />
            ) : (
              <p className="text-xs text-fg-subtle">No schema declared.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OperationCard({
  operation,
  doc,
}: {
  operation: SpecOperation;
  doc: SpecNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const panelId = `op-panel-${operation.id}`;

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-inset"
      >
        <Icon name="chevron-right" className={cn('text-fg-subtle', open && 'rotate-90')} />
        <Badge tone={METHOD_TONES[operation.method]} className="w-16 justify-center uppercase">
          {operation.method}
        </Badge>
        <code className="font-mono text-sm text-fg">{operation.path}</code>
        {operation.summary ? (
          <span className="hidden min-w-0 flex-1 truncate text-sm text-fg-muted md:block">
            {operation.summary}
          </span>
        ) : null}
        {operation.deprecated ? <Badge tone="warning">deprecated</Badge> : null}
      </button>

      {open ? (
        <div
          id={panelId}
          className="flex flex-col gap-5 border-t border-border bg-inset/40 px-4 py-4"
        >
          {operation.description ? (
            <p className="text-sm whitespace-pre-line text-fg-muted">{operation.description}</p>
          ) : null}
          {operation.operationId ? (
            <p className="text-xs text-fg-subtle">
              operationId: <code className="font-mono">{operation.operationId}</code>
            </p>
          ) : null}

          {operation.parameters.length > 0 ? (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
                Parameters
              </h4>
              <ParameterTable parameters={operation.parameters} doc={doc} />
            </section>
          ) : null}

          {operation.requestBody ? (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
                Request body
              </h4>
              {asString(operation.requestBody.description) ? (
                <p className="mb-2 text-sm text-fg-muted">
                  {asString(operation.requestBody.description)}
                </p>
              ) : null}
              <ContentSchemas content={operation.requestBody.content} doc={doc} />
            </section>
          ) : null}

          {operation.responses.length > 0 ? (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
                Responses
              </h4>
              <div className="flex flex-col gap-3">
                {operation.responses.map(([status, response]) => (
                  <div key={status} className="rounded-md border border-border bg-surface p-3">
                    <div className="mb-1.5 flex items-center gap-2">
                      <Badge tone={statusTone(status)}>{status}</Badge>
                      <span className="text-sm text-fg-muted">
                        {asString(response.description) ?? ''}
                      </span>
                    </div>
                    <ContentSchemas content={response.content} doc={doc} />
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface OpenApiViewProps {
  /** The document exactly as uploaded (JSON or YAML text). */
  text: string;
}

/**
 * Self-contained OpenAPI documentation renderer — no swagger-ui.
 *
 * Renders info, servers and tag-grouped operations with collapsible details;
 * a document that fails to parse renders an error panel instead of throwing.
 */
export function OpenApiView({ text }: OpenApiViewProps): ReactElement {
  const result = useMemo(() => parseSpecText(text), [text]);

  if (!result.ok) {
    return (
      <div className="fx-card border-danger/50 p-5" role="alert">
        <div className="flex items-start gap-2.5">
          <Icon name="alert" className="mt-0.5 h-4 w-4 text-danger" />
          <div>
            <p className="text-sm font-semibold text-fg">
              This specification could not be rendered
            </p>
            <p className="mt-1 text-sm text-fg-muted">{result.error}</p>
          </div>
        </div>
      </div>
    );
  }

  return <ParsedSpecView spec={result.spec} />;
}

/**
 * How many grouped operation entries to mount initially and add per click.
 *
 * A spec is provider-authored and may declare tens of thousands of operations
 * within the server's size limit; mounting a card for each one synchronously
 * freezes the viewer's tab. The rest are one click away.
 */
const OPERATIONS_PAGE = 200;

function ParsedSpecView({ spec }: { spec: ParsedSpec }): ReactElement {
  const [visibleCount, setVisibleCount] = useState(OPERATIONS_PAGE);

  // Page the complete grouped-entry sequence so every tag presentation is preserved.
  // Both the budget and remaining count include each appearance of a multi-tag operation.
  const visibleGroups = useMemo(() => {
    let remaining = visibleCount;
    const groups: { group: SpecTagGroup; operations: SpecOperation[] }[] = [];
    for (const group of spec.groups) {
      if (remaining <= 0) break;
      const operations = group.operations.slice(0, remaining);
      remaining -= operations.length;
      groups.push({ group, operations });
    }
    return groups;
  }, [spec.groups, visibleCount]);

  const shownCount = visibleGroups.reduce((total, entry) => total + entry.operations.length, 0);
  const totalEntries = spec.groups.reduce((total, group) => total + group.operations.length, 0);
  const hiddenCount = totalEntries - shownCount;
  const entryLabel = totalEntries === spec.operationCount ? 'operations' : 'operation entries';

  return (
    <div className="flex flex-col gap-6">
      <header className="fx-card p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-fg">{spec.title}</h2>
          {spec.version ? <Badge tone="accent">v{spec.version}</Badge> : null}
          {spec.specVersion ? <Badge>OpenAPI {spec.specVersion}</Badge> : null}
          <Badge>
            {spec.operationCount} operation{spec.operationCount === 1 ? '' : 's'}
          </Badge>
        </div>
        {spec.description ? (
          <p className="mt-2 text-sm whitespace-pre-line text-fg-muted">{spec.description}</p>
        ) : null}
        {spec.servers.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">
              Servers
            </h3>
            <ul className="mt-1.5 flex flex-col gap-1">
              {spec.servers.map((server) => (
                <li key={server.url} className="flex flex-wrap items-center gap-2">
                  <code className="rounded-sm bg-inset px-2 py-0.5 font-mono text-xs text-fg">
                    {server.url}
                  </code>
                  {server.description ? (
                    <span className="text-xs text-fg-muted">{server.description}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </header>

      {spec.groups.length === 0 ? (
        <p className="text-sm text-fg-muted">This specification declares no operations.</p>
      ) : (
        visibleGroups.map(({ group, operations }) => (
          <section key={group.name} className="fx-card overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-fg">{group.name}</h3>
              {group.description ? (
                <p className="mt-0.5 text-sm text-fg-muted">{group.description}</p>
              ) : null}
            </div>
            {operations.map((operation) => (
              <OperationCard key={operation.id} operation={operation} doc={spec.doc} />
            ))}
          </section>
        ))
      )}

      {hiddenCount > 0 ? (
        <div className="fx-card flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-fg-muted">
            Showing {shownCount} of {totalEntries} {entryLabel}.
          </p>
          <button
            type="button"
            className="fx-btn fx-btn-secondary"
            onClick={() => setVisibleCount((count) => count + OPERATIONS_PAGE)}
          >
            Show {Math.min(OPERATIONS_PAGE, hiddenCount)} more
          </button>
        </div>
      ) : null}
    </div>
  );
}
