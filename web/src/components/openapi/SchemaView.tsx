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

export interface SchemaViewProps {
  schema: unknown;
  /** Document root, used to resolve local `$ref`s. */
  doc: SpecNode;
  /** Property name when this schema sits inside an object. */
  name?: string;
  required?: boolean;
  depth?: number;
  /** `$ref` pointers already expanded on this branch — the cycle guard. */
  seen?: readonly string[];
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
export function SchemaView({
  schema,
  doc,
  name,
  required = false,
  depth = 0,
  seen = [],
}: SchemaViewProps): ReactElement {
  const node = asRecord(schema);

  if (!node) {
    return <p className="text-xs text-fg-subtle">No schema.</p>;
  }

  const ref = asString(node.$ref);
  if (ref) {
    if (seen.includes(ref)) {
      return (
        <SchemaRow name={name} required={required} depth={depth}>
          <Badge tone="warning">circular → {refName(ref)}</Badge>
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
        <SchemaView schema={resolved} doc={doc} depth={depth} seen={[...seen, ref]} />
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

  return (
    <div>
      <SchemaRow name={name} required={required} depth={depth}>
        <TypeLine schema={node} />
      </SchemaRow>
      {description ? (
        <p className={cn('text-xs text-fg-muted', depth > 0 && 'pl-3')}>{description}</p>
      ) : null}

      {composition && composition.entries ? (
        <div className="mt-1 border-l border-border pl-3">
          <p className="text-xs font-medium text-fg-subtle">{composition.key}</p>
          {composition.entries.map((entry, index) => (
            <SchemaView key={index} schema={entry} doc={doc} depth={depth + 1} seen={seen} />
          ))}
        </div>
      ) : null}

      {items !== undefined ? (
        <div className="mt-1 border-l border-border pl-3">
          <p className="text-xs font-medium text-fg-subtle">items</p>
          <SchemaView schema={items} doc={doc} depth={depth + 1} seen={seen} />
        </div>
      ) : null}

      {properties ? (
        <div className="mt-1 flex flex-col gap-2 border-l border-border pl-3">
          {Object.entries(properties).map(([propertyName, propertySchema]) => (
            <SchemaView
              key={propertyName}
              schema={propertySchema}
              doc={doc}
              name={propertyName}
              required={requiredNames.has(propertyName)}
              depth={depth + 1}
              seen={seen}
            />
          ))}
        </div>
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
