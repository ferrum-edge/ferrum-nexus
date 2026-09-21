/**
 * Structural comparison of two OpenAPI revisions — the "what am I about to
 * change?" a provider gets before replacing a specification or rolling one
 * back (issue #290).
 *
 * ## What it compares, and what it deliberately does not
 *
 * Paths, methods, and the shape of each operation: which operations appear,
 * which disappear, and which of a fixed set of operation members differ. That
 * is the layer the portal can speak about accurately from the documents alone,
 * and it is the layer `routes` enforcement acts on — Edge generates its
 * validator from exactly this path/method table, so a removed operation is a
 * `400` the moment the revision lands.
 *
 * It does **not** resolve `$ref`s, walk schemas, or reason about semantics. A
 * response schema can drop a required field and a parameter can narrow its
 * type with every path, method and member name identical, and this comparison
 * will report nothing. So the result never claims compatibility: it names
 * removed operations as `potentially_breaking`, and an empty list means "this
 * comparison found nothing", not "this change is safe". The UI carries the
 * same caveat in words.
 *
 * ## Operation members
 *
 * The labels are the OpenAPI 3.x Operation Object's own members, compared with
 * `isDeepStrictEqual` after the path item's shared `parameters` have been
 * folded in — a parameter moved from the path item onto the operation, or the
 * other way, is not a change and should not read as one. Anything outside the
 * known member list that differs collapses to a single `other` label rather
 * than leaking vendor extension names into the UI.
 */

import { isDeepStrictEqual } from 'node:util';

import type {
  ApiSpecSummary,
  SpecDiff,
  SpecInfoChange,
  SpecOperationChange,
  SpecOperationRef,
} from '@ferrum-nexus/shared';

/** HTTP methods an OpenAPI Path Item Object may carry, lowercase as written. */
const OPERATION_KEYS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

/**
 * Operation Object members worth naming in a review, in the order they are
 * reported. Everything else that differs is reported once, as `other`.
 */
const OPERATION_MEMBERS = [
  'summary',
  'description',
  'operationId',
  'tags',
  'parameters',
  'requestBody',
  'responses',
  'callbacks',
  'deprecated',
  'security',
  'servers',
] as const;

type Operation = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Every operation of a document, keyed `METHOD path`.
 *
 * The path item's own `parameters` are merged onto each operation ahead of its
 * own, which is what makes "the provider moved a shared `{id}` parameter down
 * onto the operation" read as no change at all. A non-object path item, or one
 * with no method key, contributes nothing — the same permissiveness the
 * publishing parser applies.
 */
function operationsOf(document: Record<string, unknown>): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  const paths = document.paths;
  if (!isRecord(paths)) return operations;
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const key of OPERATION_KEYS) {
      const operation = item[key];
      if (!isRecord(operation)) continue;
      const own = Array.isArray(operation.parameters) ? operation.parameters : [];
      operations.set(`${key.toUpperCase()} ${path}`, {
        ...operation,
        ...(shared.length > 0 || own.length > 0 ? { parameters: [...shared, ...own] } : {}),
      });
    }
  }
  return operations;
}

/** Path templates that carry at least one operation, in document order. */
function pathsOf(document: Record<string, unknown>): string[] {
  const paths = document.paths;
  if (!isRecord(paths)) return [];
  return Object.entries(paths)
    .filter(([, item]) => isRecord(item) && OPERATION_KEYS.some((key) => isRecord(item[key])))
    .map(([path]) => path);
}

/** `METHOD path` back into its two halves. */
function refOf(key: string): SpecOperationRef {
  const space = key.indexOf(' ');
  return { method: key.slice(0, space), path: key.slice(space + 1) };
}

/** Which named members of two operations differ. */
function memberChanges(before: Operation, after: Operation): string[] {
  const changes: string[] = [];
  for (const member of OPERATION_MEMBERS) {
    if (!isDeepStrictEqual(before[member], after[member])) changes.push(member);
  }
  const known = new Set<string>(OPERATION_MEMBERS);
  const extras = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of extras) {
    if (known.has(key)) continue;
    if (!isDeepStrictEqual(before[key], after[key])) {
      changes.push('other');
      break;
    }
  }
  return changes;
}

/** `info` fields that differ between two documents. */
function infoChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SpecInfoChange[] {
  const left = isRecord(before.info) ? before.info : {};
  const right = isRecord(after.info) ? after.info : {};
  const changes: SpecInfoChange[] = [];
  for (const field of ['title', 'version', 'description'] as const) {
    const from = stringOrNull(left[field]);
    const to = stringOrNull(right[field]);
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

/**
 * Compare two parsed OpenAPI documents.
 *
 * `from` is what the API is serving today and `to` is what it would serve —
 * so for a rollback, `from` is the current revision and `to` is the retained
 * one being restored, not the other way round.
 */
export function diffSpecDocuments(
  from: { document: Record<string, unknown>; summary: ApiSpecSummary | null },
  to: { document: Record<string, unknown>; summary: ApiSpecSummary | null },
): SpecDiff {
  const before = operationsOf(from.document);
  const after = operationsOf(to.document);

  const added: SpecOperationRef[] = [];
  const removed: SpecOperationRef[] = [];
  const changed: SpecOperationChange[] = [];

  // Document order of the *target* for additions and changes, of the source
  // for removals: each list then reads in the order of the document it is
  // describing, which is the order the provider wrote.
  for (const [key, operation] of after) {
    const previous = before.get(key);
    if (previous === undefined) {
      added.push(refOf(key));
      continue;
    }
    const changes = memberChanges(previous, operation);
    if (changes.length > 0) changed.push({ ...refOf(key), changes });
  }
  for (const key of before.keys()) {
    if (!after.has(key)) removed.push(refOf(key));
  }

  const beforePaths = pathsOf(from.document);
  const afterPaths = pathsOf(to.document);
  const addedPaths = afterPaths.filter((path) => !beforePaths.includes(path));
  const removedPaths = beforePaths.filter((path) => !afterPaths.includes(path));

  const info = infoChanges(from.document, to.document);
  const serversChanged = !isDeepStrictEqual(from.document.servers, to.document.servers);

  return {
    from: from.summary,
    to: to.summary,
    added_operations: added,
    removed_operations: removed,
    changed_operations: changed,
    added_paths: addedPaths,
    removed_paths: removedPaths,
    info_changes: info,
    servers_changed: serversChanged,
    // Removals only. A *changed* operation may well break a caller too, but
    // this comparison cannot tell a widened response from a narrowed one, and
    // a list that guessed would be worse than one that is honest about its
    // scope — see the module docstring.
    potentially_breaking: removed,
    changed:
      added.length > 0 ||
      removed.length > 0 ||
      changed.length > 0 ||
      info.length > 0 ||
      serversChanged,
  };
}
