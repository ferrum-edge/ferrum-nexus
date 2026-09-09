import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/Badge';
import {
  asArray,
  asRecord,
  asString,
  refName,
  resolveRef,
  UNRESOLVED_REF,
  type SpecNode,
} from './parse';

/** Hard stop for pathological documents that nest without a `$ref` cycle. */
const MAX_DEPTH = 12;

/**
 * Hard stop on total rendered nodes for one page of documentation.
 *
 * Depth alone does not bound the tree: every level fans out across
 * `properties`, `items` and `oneOf`/`anyOf`/`allOf`, so a document that is
 * merely 14 levels deep with a handful of `$ref`ing properties each expands to
 * billions of nodes and hangs the tab. Specs are attacker-authored (any
 * provider can publish one), so the budget is a safety limit, not a nicety.
 *
 * The allowance is spent across an **entire page render**, not per call: an
 * operation renders one schema per parameter, per request media type and per
 * response media type, and a per-call allowance would multiply by every one of
 * them. {@link OpenApiView} divides this allowance between the operations a
 * viewer has expanded and hands each one its slice.
 */
export const MAX_PAGE_NODES = 4000;

/**
 * Mutable node allowance threaded through one render pass.
 *
 * It is consumed while React elements are *constructed*, which is why every
 * holder creates it inside its own render body: a budget object is never shared
 * across component boundaries, so a component rendered twice for one commit
 * (React's development-mode double invoke) spends a fresh allowance each time
 * rather than draining a shared one.
 */
export interface RenderBudget {
  remaining: number;
}

/** A budget for one render pass; `limit` is a slice of {@link MAX_PAGE_NODES}. */
export function createRenderBudget(limit: number = MAX_PAGE_NODES): RenderBudget {
  return { remaining: Math.max(0, Math.floor(limit)) };
}

/**
 * Spend one node from `budget`, reporting whether there was one to spend.
 *
 * Rows that mount no schema — a parameter, a media type, a response entry —
 * still cost DOM, so they charge through here rather than riding free.
 */
export function chargeNode(budget: RenderBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

/**
 * The one affordance an exhausted branch renders.
 *
 * Exhaustion stops *mounting*, not just recursing: the caller that sees it
 * abandons the remaining siblings, so a hostile document costs a bounded DOM
 * instead of a linear one.
 */
export function TruncationNotice(): ReactElement {
  return (
    <p className="text-xs text-fg-subtle">
      …truncated — download the specification to read the rest.
    </p>
  );
}

export interface SchemaViewProps {
  schema: unknown;
  /** Document root, used to resolve local `$ref`s. */
  doc: SpecNode;
  /**
   * The page allowance this schema draws on. Required — every caller shares one
   * budget per render pass, which is the whole point of the limit.
   */
  budget: RenderBudget;
  /** Property name when this schema sits inside an object. */
  name?: string;
  required?: boolean;
  depth?: number;
  /** `$ref` pointers already expanded on this branch — the cycle guard. */
  seen?: readonly string[];
}

interface RenderArgs {
  schema: unknown;
  doc: SpecNode;
  name?: string | undefined;
  required?: boolean | undefined;
  depth: number;
  seen: readonly string[];
}

function TypeLine({ schema }: { schema: SpecNode }): ReactElement | null {
  const type = asString(schema.type);
  const format = asString(schema.format);
  const enumValues = asArray(schema.enum);
  const parts: string[] = [];
  if (type) parts.push(type);
  if (format) parts.push(`<${format}>`);
  if (schema.nullable === true) parts.push('| null');

  if (parts.length === 0 && !enumValues) return null;

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {parts.length > 0 ? (
        <code className="font-mono text-xs text-info">{parts.join(' ')}</code>
      ) : null}
      {enumValues ? (
        <span className="flex flex-wrap gap-1">
          {enumValues.slice(0, 12).map((value, index) => (
            <code
              key={`${String(value)}-${index}`}
              className="rounded-xs bg-neutral-soft px-1 font-mono text-[0.7rem] text-fg-muted"
            >
              {typeof value === 'string' ? value : JSON.stringify(value)}
            </code>
          ))}
          {enumValues.length > 12 ? (
            <span className="text-xs text-fg-subtle">+{enumValues.length - 12} more</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Recursive JSON Schema renderer.
 *
 * `$ref`s are resolved against the document root; a pointer already expanded on
 * the current branch renders as a "circular" marker rather than recursing, so
 * self-referential schemas (`Node.children: Node[]`) terminate.
 */
export function SchemaView(props: SchemaViewProps): ReactElement {
  return renderSchema(props);
}

/**
 * The same renderer as a plain function.
 *
 * {@link OpenApiView} calls this rather than mounting {@link SchemaView} as a
 * component: the budget is spent while elements are *constructed*, so a caller
 * that owns a budget has to construct every schema inside its own render body
 * instead of handing the same budget object to children React may invoke on its
 * own schedule.
 */
export function renderSchema({
  schema,
  doc,
  budget,
  name,
  required = false,
  depth = 0,
  seen = [],
}: SchemaViewProps): ReactElement {
  // The whole subtree is produced synchronously inside this one call, so the
  // caller's allowance is consumed in a single deterministic pass; what is left
  // of it is what the caller's next schema gets.
  return renderNode({ schema, doc, name, required, depth, seen }, budget);
}

function renderNode(
  { schema, doc, name, required = false, depth, seen }: RenderArgs,
  budget: RenderBudget,
): ReactElement {
  const node = asRecord(schema);

  if (!node) {
    return <p className="text-xs text-fg-subtle">No schema.</p>;
  }

  if (budget.remaining <= 0) {
    return <TruncationNotice />;
  }
  budget.remaining -= 1;

  const ref = asString(node.$ref);
  if (ref) {
    if (seen.includes(ref)) {
      return (
        <SchemaRow name={name} required={required} depth={depth}>
          <Badge tone="warning">circular → {refName(ref)}</Badge>
        </SchemaRow>
      );
    }
    if (depth > MAX_DEPTH) {
      return (
        <SchemaRow name={name} required={required} depth={depth}>
          <span className="text-xs text-fg-subtle">…nested further</span>
        </SchemaRow>
      );
    }
    const resolved = resolveRef(doc, ref);
    if (resolved === UNRESOLVED_REF) {
      return (
        <SchemaRow name={name} required={required} depth={depth}>
          <Badge tone="danger">unresolved $ref {ref}</Badge>
        </SchemaRow>
      );
    }
    return (
      <div>
        <SchemaRow name={name} required={required} depth={depth}>
          <Badge tone="accent">{refName(ref)}</Badge>
        </SchemaRow>
        {/* depth + 1: indirection must cost depth, or a chain of `$ref`s
            nests without limit. */}
        {renderNode({ schema: resolved, doc, depth: depth + 1, seen: [...seen, ref] }, budget)}
      </div>
    );
  }

  if (depth > MAX_DEPTH) {
    return (
      <SchemaRow name={name} required={required} depth={depth}>
        <span className="text-xs text-fg-subtle">…nested further</span>
      </SchemaRow>
    );
  }

  const description = asString(node.description);
  const properties = asRecord(node.properties);
  const requiredNames = new Set(
    (asArray(node.required) ?? []).map(asString).filter((entry): entry is string => entry !== null),
  );
  const items = node.items;
  const composition =
    (asArray(node.oneOf) && { key: 'oneOf', entries: asArray(node.oneOf) }) ??
    (asArray(node.anyOf) && { key: 'anyOf', entries: asArray(node.anyOf) }) ??
    (asArray(node.allOf) && { key: 'allOf', entries: asArray(node.allOf) }) ??
    null;

  // Children are built before the tree is returned, and each loop abandons its
  // remaining siblings the moment the budget is gone: exhaustion has to stop
  // *mounting*, not merely stop recursing, or a wide document still costs one
  // rendered row per entry.
  const compositionRows: ReactElement[] = [];
  for (const entry of composition?.entries ?? []) {
    if (budget.remaining <= 0) {
      compositionRows.push(<TruncationNotice key="__truncated" />);
      break;
    }
    compositionRows.push(
      <div key={compositionRows.length}>
        {renderNode({ schema: entry, doc, depth: depth + 1, seen }, budget)}
      </div>,
    );
  }

  const itemsRow =
    items !== undefined ? renderNode({ schema: items, doc, depth: depth + 1, seen }, budget) : null;

  const propertyRows: ReactElement[] = [];
  for (const [propertyName, propertySchema] of Object.entries(properties ?? {})) {
    if (budget.remaining <= 0) {
      propertyRows.push(<TruncationNotice key="__truncated" />);
      break;
    }
    propertyRows.push(
      <div key={propertyName}>
        {renderNode(
          {
            schema: propertySchema,
            doc,
            name: propertyName,
            required: requiredNames.has(propertyName),
            depth: depth + 1,
            seen,
          },
          budget,
        )}
      </div>,
    );
  }

  return (
    <div>
      <SchemaRow name={name} required={required} depth={depth}>
        <TypeLine schema={node} />
      </SchemaRow>
      {description ? (
        <p className={cn('text-xs text-fg-muted', depth > 0 && 'pl-3')}>{description}</p>
      ) : null}

      {composition && compositionRows.length > 0 ? (
        <div className="mt-1 border-l border-border pl-3">
          <p className="text-xs font-medium text-fg-subtle">{composition.key}</p>
          {compositionRows}
        </div>
      ) : null}

      {itemsRow ? (
        <div className="mt-1 border-l border-border pl-3">
          <p className="text-xs font-medium text-fg-subtle">items</p>
          {itemsRow}
        </div>
      ) : null}

      {propertyRows.length > 0 ? (
        <div className="mt-1 flex flex-col gap-2 border-l border-border pl-3">{propertyRows}</div>
      ) : null}
    </div>
  );
}

function SchemaRow({
  name,
  required,
  depth,
  children,
}: {
  name?: string | undefined;
  required?: boolean | undefined;
  depth: number;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', depth > 0 && 'pl-0')}>
      {name ? <code className="font-mono text-xs font-semibold text-fg">{name}</code> : null}
      {required ? (
        <span className="text-[0.65rem] font-medium tracking-wide text-danger uppercase">
          required
        </span>
      ) : null}
      {children}
    </div>
  );
}
