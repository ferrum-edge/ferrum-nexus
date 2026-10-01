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
 * other way, is not a change and should not read as one. Folding follows
 * OpenAPI's inheritance rule (`mergeOpenApiParameters`, shared with the
 * documentation renderer): an operation parameter replaces a path-item one with
 * the same `(in, name)`, so removing an overridden, ineffective path-level
 * definition is not a change either. Parameters are compared as written — a
 * `$ref` is followed only to learn the parameter's identity, never to compare
 * its content — and one whose identity cannot be determined is kept as is,
 * never equated with another. Anything outside the known member list that
 * differs collapses to a single `other` label rather than leaking vendor
 * extension names into the UI.
 *
 * ## Bounded, whatever the documents hold
 *
 * Folding parameters is the one part of this comparison whose work a document
 * can multiply: a path item's parameters are merged under every operation
 * beneath it, and one component parameter may be referenced from every
 * operation. So each parameter object's identity is read once per document
 * however many lists reach it, a long name becomes a short digest
 * (`spec-keys.ts`) so merging and sorting by it costs the same whatever its
 * length, and the folding spends from a fixed budget,
 * {@link MAX_SPEC_DIFF_UNITS}. A comparison that runs out reports itself
 * incomplete (`complete: false`): it still lists the operations added and
 * removed, which cost nothing to find, but no changed ones, and it says
 * `changed`, since it could not rule a change out.
 */

import { isDeepStrictEqual } from 'node:util';

import {
  MAX_SPEC_RENDER_UNITS,
  createOpenApiParameterKeyer,
  createOpenApiRefResolver,
  keyOpenApiParameters,
  mergeOpenApiParameters,
  type ApiSpecSummary,
  type KeyedOpenApiParameter,
  type OpenApiResolveStats,
  type SpecDiff,
  type SpecInfoChange,
  type SpecOperationChange,
  type SpecOperationRef,
} from '@ferrum-nexus/shared';

import { compactSpecKey, createKeyTextCharge, type KeyTextCharge } from './spec-keys.js';

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

/**
 * Most work units one comparison may spend folding parameters: one per
 * operation, one per parameter entry keyed, one per entry merged into an
 * operation's effective list, and one per `SPEC_KEY_CODE_UNITS_PER_UNIT` code
 * units of parameter `in` and `name` keyed, each parameter object once and
 * charged on the comparison's running total.
 *
 * An accepted document fits {@link MAX_SPEC_RENDER_UNITS}, which charges a
 * path-item parameter under every operation beneath it. Its keying (each
 * operation's own list, and each path item's list once) and its merging (both
 * lists under every operation) therefore cost at most that ceiling each. Add
 * one unit per operation, at most `MAX_SPEC_OPERATIONS`, and its keyed text,
 * at most `MAX_SPEC_KEY_UNITS`: a pair of accepted documents costs
 * at most 2 × (3 000 + 2 × 100 000 + 16 384) = 438 768 units, whatever their
 * shape. Five times the ceiling, 500 000, covers that, so only a document that
 * was never checked can run out.
 */
export const MAX_SPEC_DIFF_UNITS = 5 * MAX_SPEC_RENDER_UNITS;

/** Work counters a test may pass in, to assert how much a comparison cost. */
export interface SpecDiffStats {
  /** Units spent against {@link MAX_SPEC_DIFF_UNITS}. */
  units: number;
}

/** Limits and counters a caller may pass to {@link diffSpecDocuments}. */
export interface SpecDiffOptions {
  /** Counts the reference-following work both documents cost. */
  resolveStats?: OpenApiResolveStats;
  /** Defaults to {@link MAX_SPEC_DIFF_UNITS}; a test lowers it to reach it. */
  unitLimit?: number;
  stats?: SpecDiffStats;
}

/** Unwinds a comparison that has spent its budget. */
class BudgetExhausted {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Every operation of a document, keyed `METHOD path`.
 *
 * Each operation's `parameters` become its effective list — the path item's
 * parameters it does not override plus its own — in a canonical order, which is
 * what makes "the provider moved a shared `{id}` parameter down onto the
 * operation" read as no change at all. An empty effective list is dropped, so
 * `parameters: []` and no `parameters` at all compare equal. A non-object path
 * item, or one with no method key, contributes nothing — the same
 * permissiveness the publishing parser applies.
 *
 * One resolver serves the whole document, so each distinct `$ref` is followed
 * once however many parameters use it, and one keyer, so each parameter object
 * is keyed once. The work is charged through `spend` and `keyText`, which throw
 * once the budget is gone.
 */
function operationsOf(
  document: Record<string, unknown>,
  stats: OpenApiResolveStats | undefined,
  spend: (units: number) => void,
  keyText: KeyTextCharge,
): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  const paths = document.paths;
  if (!isRecord(paths)) return operations;
  const resolver = createOpenApiRefResolver(document, { stats });
  const keyer = createOpenApiParameterKeyer({
    onKey: (codeUnits) => keyText.charge(codeUnits),
    compact: compactSpecKey,
  });
  const keyed = (parameters: unknown, inherited: boolean): KeyedOpenApiParameter[] => {
    const list = Array.isArray(parameters) ? parameters : [];
    spend(list.length);
    return keyOpenApiParameters(resolver, list, inherited, keyer);
  };
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    // Keyed at the first operation, so a path item without one costs nothing.
    let shared: KeyedOpenApiParameter[] | null = null;
    for (const key of OPERATION_KEYS) {
      const operation = item[key];
      if (!isRecord(operation)) continue;
      spend(1);
      shared ??= keyed(item.parameters, true);
      const { parameters: written, ...rest } = operation;
      const own = keyed(written, false);
      spend(shared.length + own.length);
      const effective = canonicalParameters(mergeOpenApiParameters(shared, own));
      // A `parameters` member that is not a list at all is compared as written.
      const normalized =
        effective.length > 0
          ? { ...rest, parameters: effective }
          : written === undefined || Array.isArray(written)
            ? rest
            : operation;
      operations.set(`${key.toUpperCase()} ${path}`, normalized);
    }
  }
  return operations;
}

/**
 * Every operation of a document, keyed `METHOD path`, as written: what a
 * comparison that ran out of budget can still afford to list.
 */
function operationKeysOf(document: Record<string, unknown>): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  const paths = document.paths;
  if (!isRecord(paths)) return operations;
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const key of OPERATION_KEYS) {
      const operation = item[key];
      if (isRecord(operation)) operations.set(`${key.toUpperCase()} ${path}`, operation);
    }
  }
  return operations;
}

/**
 * An effective parameter list in comparison order: parameters with an identity
 * sorted by it — OpenAPI gives their order no meaning — then those without one,
 * in declaration order, since nothing says which of them is which.
 */
function canonicalParameters(parameters: readonly KeyedOpenApiParameter[]): unknown[] {
  const keyed = parameters
    .filter((entry): entry is typeof entry & { key: string } => entry.key !== null)
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const unkeyed = parameters.filter((entry) => entry.key === null);
  return [...keyed, ...unkeyed].map((entry) => entry.parameter);
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
 * one being restored, not the other way round. See {@link SpecDiffOptions}.
 */
export function diffSpecDocuments(
  from: { document: Record<string, unknown>; summary: ApiSpecSummary | null },
  to: { document: Record<string, unknown>; summary: ApiSpecSummary | null },
  { resolveStats, unitLimit = MAX_SPEC_DIFF_UNITS, stats }: SpecDiffOptions = {},
): SpecDiff {
  let units = 0;
  const spend = (amount: number): void => {
    units += amount;
    if (stats) stats.units = units;
    if (units > unitLimit) throw new BudgetExhausted();
  };

  // One running total for both documents; see `MAX_SPEC_DIFF_UNITS`.
  const keyText = createKeyTextCharge(spend);
  let complete = true;
  let before: Map<string, Operation>;
  let after: Map<string, Operation>;
  try {
    before = operationsOf(from.document, resolveStats, spend, keyText);
    after = operationsOf(to.document, resolveStats, spend, keyText);
    keyText.settle();
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    complete = false;
    before = operationKeysOf(from.document);
    after = operationKeysOf(to.document);
  }

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
    // Unfolded operations cannot be compared: a moved parameter would read as
    // a change.
    if (!complete) continue;
    const changes = memberChanges(previous, operation);
    if (changes.length > 0) changed.push({ ...refOf(key), changes });
  }
  for (const key of before.keys()) {
    if (!after.has(key)) removed.push(refOf(key));
  }

  const beforePaths = pathsOf(from.document);
  const afterPaths = pathsOf(to.document);
  const beforePathSet = new Set(beforePaths);
  const afterPathSet = new Set(afterPaths);
  const addedPaths = afterPaths.filter((path) => !beforePathSet.has(path));
  const removedPaths = beforePaths.filter((path) => !afterPathSet.has(path));

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
    complete,
    // An incomplete comparison could not rule a change out.
    changed:
      !complete ||
      added.length > 0 ||
      removed.length > 0 ||
      changed.length > 0 ||
      info.length > 0 ||
      serversChanged,
  };
}
