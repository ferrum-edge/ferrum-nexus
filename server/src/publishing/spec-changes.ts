/**
 * What changed between two published OpenAPI revisions, as the API's
 * consumers are shown it (issues #447 and #448).
 *
 * `spec-diff.ts` answers the provider's question before a publish: which
 * operations would appear, disappear or differ. This answers the consumer's
 * after it: what about the operations I call is different now, and can it
 * break me? So it goes one level down, into the parts a caller depends on:
 *
 * - operations added, removed, deprecated and no longer deprecated;
 * - parameters added and removed, and a parameter becoming required or
 *   optional;
 * - request bodies added, removed, or becoming required or optional, and
 *   their media types;
 * - response status codes and their media types;
 * - the request and response schemas under all of those: type changes,
 *   properties added and removed, `required` changes, enum values, items and
 *   `oneOf`/`anyOf`/`allOf` entries, each reported at its path in the schema
 *   (`items[].status`).
 *
 * Each change is classified from the caller's side. A schema the caller
 * *sends* (a parameter or request body) breaks it when it accepts less; one it
 * *reads* (a response) breaks it when it may contain something new. Where the
 * comparison cannot tell which way a change goes, it says `breaking`. It does
 * not compare formats, patterns, numeric bounds, examples, security
 * requirements or anything else, and it cannot see how a provider's
 * implementation behaves, so an empty result means "this comparison found
 * nothing", not "this change is safe".
 *
 * ## Bounded, whatever the documents hold
 *
 * Both documents were accepted by the upload checks (`oas.ts`), so each fits
 * `MAX_SPEC_RENDER_UNITS`. The comparison is bounded the same way the render
 * count is, and never by trusting that:
 *
 * - **A `$ref` is never expanded where it occurs.** Where both revisions use a
 *   reference at the same place, the two targets are compared once per
 *   direction, however many operations reach them, and what differs is
 *   reported once under the reference (`#/components/schemas/Order`) rather
 *   than again at every use. Each document has one memoised resolver, so each
 *   distinct reference string is followed once.
 * - **Every other pair of schema objects is compared once** per direction,
 *   memoised by identity, so a YAML alias repeating a subtree costs nothing
 *   the second time.
 * - **Every step spends from one budget**, `MAX_SPEC_CHANGE_UNITS`: an
 *   operation, parameter, response, media type, schema pair or property, and
 *   enum and `required` entries by the sixteen. A comparison that reaches it
 *   stops where it is and reports itself incomplete.
 * - **Reference chains are walked from a queue**, not by recursion, so a chain
 *   of components as long as the document allows cannot exhaust the stack.
 *   Recursion follows only inline nesting, which `MAX_SPEC_DEPTH` bounds.
 * - **Output is bounded.** At most `MAX_SPEC_CHANGES_LISTED` changes are
 *   listed, breaking ones first, and every provider-written string in them is
 *   cut to `MAX_SPEC_CHANGE_TEXT`. Everything is still counted.
 *
 * ## Safe on hostile documents
 *
 * Document keys are only ever read, as own properties, and collected into
 * `Map`s and `Set`s; nothing is ever assigned to an object under a key the
 * document chose, so a key such as `__proto__` is just a name. The result
 * carries names, status codes, media types, types and enum values, which the
 * catalog already shows to whoever may read the API's documentation, and never
 * descriptions, examples, servers or extensions.
 *
 * The walk is deterministic: operations in the new document's order, then the
 * removed ones in the old document's order, then shared components in the
 * order they were first reached.
 */

import {
  MAX_OPENAPI_REF_LENGTH,
  MAX_SPEC_CHANGE_TEXT,
  MAX_SPEC_CHANGE_UNITS,
  MAX_SPEC_CHANGES_LISTED,
  OPENAPI_OPERATION_METHODS,
  createOpenApiRefResolver,
  emptySpecChangeReport,
  keyOpenApiParameters,
  mergeOpenApiParameters,
  type KeyedOpenApiParameter,
  type OpenApiRefResolver,
  type SpecChange,
  type SpecChangeCounts,
  type SpecChangeKind,
  type SpecChangeReport,
  type SpecChangeSection,
  type SpecChangeSeverity,
  type SpecInfoChange,
  type SpecOperationRef,
} from '@ferrum-nexus/shared';

/**
 * The way a schema travels. `parameter` and `request` are sent by the caller,
 * `response` is read by it; see {@link sends}.
 */
type Direction = Exclude<SpecChangeSection, 'operation'>;

/** Where a change is being reported. */
interface Place {
  operation: SpecOperationRef | null;
  section: SpecChangeSection;
  location: string | null;
}

/** Work counters a test may pass in, to assert how much a comparison cost. */
export interface SpecChangeStats {
  /** Units spent against the budget. */
  units: number;
  /** Pairs of schema objects compared. */
  schemaPairs: number;
  /** Pairs of referenced components compared. */
  componentPairs: number;
}

/** Limits a test may lower, to reach them with a small document. */
export interface SpecChangeOptions {
  /** Defaults to `MAX_SPEC_CHANGE_UNITS`. */
  unitLimit?: number;
  /** Defaults to `MAX_SPEC_CHANGES_LISTED`. */
  listLimit?: number;
  stats?: SpecChangeStats;
}

/** Unwinds a comparison that has spent its budget. */
class BudgetExhausted {}

/** Enum and `required` entries one unit pays for. */
const ENTRIES_PER_UNIT = 16;

/** Enum values named in one change before the rest are counted. */
const ENUM_VALUES_NAMED = 5;

/** Longest single enum value quoted in a change. */
const ENUM_VALUE_TEXT = 60;

const INFO_FIELDS = ['title', 'version', 'description'] as const;

const COMPOSITIONS = ['oneOf', 'anyOf', 'allOf'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value[key]` when `value` owns it, never an inherited property. */
function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/** An own member that is an object, or `null`. */
function ownRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const member = own(value, key);
  return isRecord(member) ? member : null;
}

/** An own member that is an array, or `null`. */
function ownArray(value: Record<string, unknown>, key: string): unknown[] | null {
  const member = own(value, key);
  return Array.isArray(member) ? member : null;
}

/** The own entries of an object, as a `Map`, so no key is special. */
function entriesOf(value: Record<string, unknown> | null): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  if (value === null) return entries;
  for (const key of Object.keys(value)) entries.set(key, value[key]);
  return entries;
}

/**
 * A provider-written string cut to {@link MAX_SPEC_CHANGE_TEXT}, never
 * splitting a surrogate pair.
 */
export function clipSpecText(text: string, limit = MAX_SPEC_CHANGE_TEXT): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** A `$ref` string worth following, or `null` for a value that is not a reference. */
function refOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const ref = own(value, '$ref');
  return typeof ref === 'string' ? ref : null;
}

/** Whether a direction's schemas are sent by the caller rather than read by it. */
function sends(direction: Direction): boolean {
  return direction !== 'response';
}

/**
 * The types a schema allows, sorted: `type` as written, `null` when OpenAPI
 * 3.0's `nullable` says so, and `object` or `array` when the schema declares
 * only `properties` or `items`, which is what an untyped schema with them is
 * read as. An empty list means any type.
 */
function typesOf(schema: Record<string, unknown>): string[] {
  const written = own(schema, 'type');
  const types = new Set<string>();
  if (typeof written === 'string') {
    types.add(written);
  } else if (Array.isArray(written)) {
    for (const entry of written) if (typeof entry === 'string') types.add(entry);
  }
  if (types.size === 0) {
    if (ownRecord(schema, 'properties')) types.add('object');
    else if (own(schema, 'items') !== undefined) types.add('array');
  }
  if (types.size > 0 && own(schema, 'nullable') === true) types.add('null');
  return [...types].sort();
}

/** Whether every type of `from` is allowed by `to`; an integer is a number. */
function covers(to: readonly string[], from: readonly string[]): boolean {
  if (to.length === 0) return true;
  if (from.length === 0) return false;
  return from.every((type) => to.includes(type) || (type === 'integer' && to.includes('number')));
}

/** An enum value as a comparison key, or `null` for one that is not a primitive. */
function enumKey(value: unknown): string | null {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return `s${value}`;
    case 'number':
      return `n${String(value)}`;
    case 'boolean':
      return `b${String(value)}`;
    default:
      return null;
  }
}

/** One primitive enum value as a change names it, or `null` for any other value. */
function enumText(value: unknown): string | null {
  // Cut before quoting, so a long value is never serialized whole.
  if (typeof value === 'string') return JSON.stringify(clipSpecText(value, ENUM_VALUE_TEXT));
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/** A few primitive enum values for display, then how many more. */
function enumList(values: readonly unknown[]): string {
  const named: string[] = [];
  let total = 0;
  for (const value of values) {
    const text = enumText(value);
    if (text === null) continue;
    total += 1;
    if (named.length < ENUM_VALUES_NAMED) named.push(text);
  }
  if (named.length === 0) return 'non-primitive values';
  const rest = total - named.length;
  return clipSpecText(rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', '));
}

/** `path` extended by one property name. */
function childPath(path: string, name: string): string {
  return path === '' ? name : `${path}.${name}`;
}

/** Every operation of a document, keyed `METHOD path`, in document order. */
function operationsOf(document: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const operations = new Map<string, Record<string, unknown>>();
  for (const [path, item] of entriesOf(ownRecord(document, 'paths'))) {
    if (!isRecord(item)) continue;
    for (const method of OPENAPI_OPERATION_METHODS) {
      const operation = ownRecord(item, method);
      if (operation) operations.set(`${method.toUpperCase()} ${path}`, operation);
    }
  }
  return operations;
}

/** The path item an operation key belongs to. */
function pathItemOf(document: Record<string, unknown>, path: string): Record<string, unknown> {
  const paths = ownRecord(document, 'paths');
  return (paths && ownRecord(paths, path)) ?? {};
}

/** `METHOD path` back into its two halves, the path cut for display. */
function operationRef(key: string): SpecOperationRef {
  const space = key.indexOf(' ');
  return { method: key.slice(0, space), path: clipSpecText(key.slice(space + 1)) };
}

/**
 * Compare two parsed OpenAPI documents: `before` is the revision being
 * replaced, `after` the one replacing it (for a rollback, the restored one).
 */
export function compareSpecRevisions(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options: SpecChangeOptions = {},
): SpecChangeReport {
  const unitLimit = options.unitLimit ?? MAX_SPEC_CHANGE_UNITS;
  const listLimit = options.listLimit ?? MAX_SPEC_CHANGES_LISTED;
  const stats = options.stats;

  const beforeRefs = createOpenApiRefResolver(before);
  const afterRefs = createOpenApiRefResolver(after);

  const counts: SpecChangeCounts = emptySpecChangeReport().counts;
  const breaking: SpecChange[] = [];
  const nonBreaking: SpecChange[] = [];
  const changedOperations = new Set<SpecOperationRef>();
  let units = 0;

  const spend = (amount: number): void => {
    units += amount;
    if (stats) stats.units = units;
    if (units > unitLimit) throw new BudgetExhausted();
  };

  const record = (
    place: Place,
    kind: SpecChangeKind,
    severity: SpecChangeSeverity,
    detail: { schemaPath?: string | null; from?: string | null; to?: string | null } = {},
  ): void => {
    if (severity === 'breaking') counts.breaking += 1;
    else counts.non_breaking += 1;
    if (kind === 'operation_added') counts.operations_added += 1;
    else if (kind === 'operation_removed') counts.operations_removed += 1;
    else if (place.operation) {
      if (kind === 'operation_deprecated') counts.operations_deprecated += 1;
      // By identity: one reference object per operation, so two long paths
      // that clip to the same text are still two operations.
      if (!changedOperations.has(place.operation)) {
        changedOperations.add(place.operation);
        counts.operations_changed += 1;
      }
    }
    const list = severity === 'breaking' ? breaking : nonBreaking;
    if (list.length >= listLimit) return;
    const schemaPath = detail.schemaPath ?? null;
    list.push({
      kind,
      severity,
      operation: place.operation,
      section: place.section,
      location: place.location === null ? null : clipSpecText(place.location),
      schema_path: schemaPath === null ? null : clipSpecText(schemaPath),
      from: detail.from ?? null,
      to: detail.to ?? null,
    });
  };

  /* ── Schemas ───────────────────────────────────────────────────────── */

  // Pairs of schema objects already compared, per direction.
  const comparedPairs = new WeakMap<object, WeakMap<object, Set<Direction>>>();
  // Pairs of references already queued, keyed by direction and both strings.
  const queuedComponents = new Set<string>();
  const pendingComponents: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    direction: Direction;
    location: string;
  }[] = [];

  /** Mark a pair compared, answering whether it already was. */
  const alreadyCompared = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    direction: Direction,
  ): boolean => {
    let byRight = comparedPairs.get(left);
    if (!byRight) {
      byRight = new WeakMap();
      comparedPairs.set(left, byRight);
    }
    let directions = byRight.get(right);
    if (!directions) {
      directions = new Set();
      byRight.set(right, directions);
    }
    if (directions.has(direction)) return true;
    directions.add(direction);
    return false;
  };

  const typeChangeSeverity = (
    from: readonly string[],
    to: readonly string[],
    direction: Direction,
  ): SpecChangeSeverity => {
    const accepted = sends(direction) ? covers(to, from) : covers(from, to);
    return accepted ? 'non_breaking' : 'breaking';
  };

  const describeTypes = (types: readonly string[]): string =>
    types.length === 0 ? 'any' : clipSpecText(types.join(' | '));

  /** A schema that is not an object: an OpenAPI 3.1 boolean schema, or junk. */
  const describeValue = (value: unknown): string => {
    const ref = refOf(value);
    if (ref !== null) return clipSpecText(`$ref ${ref}`);
    if (typeof value === 'boolean') return value ? 'any' : 'nothing';
    if (isRecord(value)) return describeTypes(typesOf(value));
    return 'invalid';
  };

  const compareEnums = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    place: Place,
    path: string,
    direction: Direction,
  ): void => {
    const from = ownArray(left, 'enum');
    const to = ownArray(right, 'enum');
    if (from === null && to === null) return;
    spend(1 + Math.ceil(((from?.length ?? 0) + (to?.length ?? 0)) / ENTRIES_PER_UNIT));
    const narrowing: SpecChangeSeverity = sends(direction) ? 'breaking' : 'non_breaking';
    const widening: SpecChangeSeverity = sends(direction) ? 'non_breaking' : 'breaking';
    if (from === null && to !== null) {
      // An enum where there was none restricts the values.
      record(place, 'schema_enum_values_added', narrowing, {
        schemaPath: path,
        from: 'any value',
        to: enumList(to),
      });
      return;
    }
    if (from !== null && to === null) {
      record(place, 'schema_enum_values_removed', widening, {
        schemaPath: path,
        from: enumList(from),
        to: 'any value',
      });
      return;
    }
    // Only primitive values are compared; an object or array value names
    // nothing a caller switches on, and keying it would mean serializing it.
    const keysOf = (values: readonly unknown[]): Set<string> => {
      const keys = new Set<string>();
      for (const value of values) {
        const key = enumKey(value);
        if (key !== null) keys.add(key);
      }
      return keys;
    };
    const fromKeys = keysOf(from!);
    const toKeys = keysOf(to!);
    const missing = (values: readonly unknown[], present: Set<string>): unknown[] => {
      const seen = new Set<string>();
      const result: unknown[] = [];
      for (const value of values) {
        const key = enumKey(value);
        if (key === null || present.has(key) || seen.has(key)) continue;
        seen.add(key);
        result.push(value);
      }
      return result;
    };
    const removed = missing(from!, toKeys);
    const added = missing(to!, fromKeys);
    if (removed.length > 0) {
      record(place, 'schema_enum_values_removed', narrowing, {
        schemaPath: path,
        from: enumList(removed),
      });
    }
    if (added.length > 0) {
      record(place, 'schema_enum_values_added', widening, {
        schemaPath: path,
        to: enumList(added),
      });
    }
  };

  const requiredOf = (schema: Record<string, unknown>): Set<string> => {
    const required = ownArray(schema, 'required');
    const names = new Set<string>();
    if (required === null) return names;
    spend(Math.ceil(required.length / ENTRIES_PER_UNIT));
    for (const name of required) if (typeof name === 'string') names.add(name);
    return names;
  };

  /** Compare two schema objects that are not references. */
  const compareResolved = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    place: Place,
    path: string,
    direction: Direction,
  ): void => {
    if (alreadyCompared(left, right, direction)) return;
    if (stats) stats.schemaPairs += 1;
    // What accepting fewer values, or more, does to a caller in this direction.
    const narrowing: SpecChangeSeverity = sends(direction) ? 'breaking' : 'non_breaking';
    const widening: SpecChangeSeverity = sends(direction) ? 'non_breaking' : 'breaking';

    const fromTypes = typesOf(left);
    const toTypes = typesOf(right);
    const sameTypes =
      fromTypes.length === toTypes.length && fromTypes.every((type, i) => type === toTypes[i]);
    if (!sameTypes) {
      record(place, 'schema_type_changed', typeChangeSeverity(fromTypes, toTypes, direction), {
        schemaPath: path,
        from: describeTypes(fromTypes),
        to: describeTypes(toTypes),
      });
    }

    compareEnums(left, right, place, path, direction);

    for (const composition of COMPOSITIONS) {
      const from = ownArray(left, composition) ?? [];
      const to = ownArray(right, composition) ?? [];
      if (from.length === 0 && to.length === 0) continue;
      spend(1);
      if (from.length !== to.length) {
        // More alternatives accept more; more `allOf` members accept less.
        const accepts = composition === 'allOf' ? to.length < from.length : to.length > from.length;
        record(place, 'schema_composition_changed', accepts ? widening : narrowing, {
          schemaPath: path,
          from: `${composition} of ${from.length}`,
          to: `${composition} of ${to.length}`,
        });
      }
      const shared = Math.min(from.length, to.length);
      for (let index = 0; index < shared; index += 1) {
        compareSchema(
          from[index],
          to[index],
          place,
          childPath(path, `${composition}[${index}]`),
          direction,
        );
      }
    }

    const fromItems = own(left, 'items');
    const toItems = own(right, 'items');
    if (fromItems !== undefined && toItems !== undefined) {
      compareSchema(fromItems, toItems, place, `${path}[]`, direction);
    }

    const fromProperties = entriesOf(ownRecord(left, 'properties'));
    const toProperties = entriesOf(ownRecord(right, 'properties'));
    if (fromProperties.size === 0 && toProperties.size === 0) return;
    spend(fromProperties.size + toProperties.size);
    const fromRequired = requiredOf(left);
    const toRequired = requiredOf(right);
    for (const [name, schema] of toProperties) {
      const at = childPath(path, name);
      if (!fromProperties.has(name)) {
        const required = toRequired.has(name);
        record(place, 'schema_property_added', required ? narrowing : 'non_breaking', {
          schemaPath: at,
          to: required ? 'required' : 'optional',
        });
        continue;
      }
      const wasRequired = fromRequired.has(name);
      const isRequired = toRequired.has(name);
      if (!wasRequired && isRequired) {
        record(place, 'schema_property_required', narrowing, { schemaPath: at });
      } else if (wasRequired && !isRequired) {
        record(place, 'schema_property_optional', widening, { schemaPath: at });
      }
      compareSchema(fromProperties.get(name), schema, place, at, direction);
    }
    for (const name of fromProperties.keys()) {
      if (toProperties.has(name)) continue;
      // A caller that goes on sending it is at worst ignored; one that reads
      // it stops finding it.
      record(place, 'schema_property_removed', widening, { schemaPath: childPath(path, name) });
    }
  };

  /** Compare two schemas as written, references and all. */
  const compareSchema = (
    left: unknown,
    right: unknown,
    place: Place,
    path: string,
    direction: Direction,
  ): void => {
    if (left === undefined && right === undefined) return;
    spend(1);
    const fromRef = refOf(left);
    const toRef = refOf(right);
    if (fromRef !== null && toRef !== null) {
      // Both are references: the targets are compared once per direction, as
      // a component, never expanded here.
      const key = `${direction}\u0000${fromRef}\u0000${toRef}`;
      if (!queuedComponents.has(key)) {
        queuedComponents.add(key);
        pendingComponents.push({
          before: left as Record<string, unknown>,
          after: right as Record<string, unknown>,
          direction,
          location: toRef,
        });
      }
      return;
    }
    const from = resolveSchema(beforeRefs, left);
    const to = resolveSchema(afterRefs, right);
    if (from === null || to === null) {
      const fromText = describeValue(left);
      const toText = describeValue(right);
      if (fromText !== toText) {
        record(place, 'schema_type_changed', 'breaking', {
          schemaPath: path,
          from: fromText,
          to: toText,
        });
      }
      return;
    }
    compareResolved(from, to, place, path, direction);
  };

  /** Drain the queue of referenced components, breadth first. */
  const compareComponents = (): void => {
    for (let index = 0; index < pendingComponents.length; index += 1) {
      const pending = pendingComponents[index]!;
      spend(1);
      if (stats) stats.componentPairs += 1;
      const place: Place = {
        operation: null,
        section: pending.direction,
        location: pending.location,
      };
      const from = resolveSchema(beforeRefs, pending.before);
      const to = resolveSchema(afterRefs, pending.after);
      if (from === null || to === null) {
        const fromText = describeValue(from ?? pending.before);
        const toText = describeValue(to ?? pending.after);
        if (fromText !== toText) {
          record(place, 'schema_type_changed', 'breaking', {
            schemaPath: '',
            from: fromText,
            to: toText,
          });
        }
        continue;
      }
      compareResolved(from, to, place, '', pending.direction);
    }
  };

  /* ── Operations ────────────────────────────────────────────────────── */

  const compareContent = (
    left: Record<string, unknown> | null,
    right: Record<string, unknown> | null,
    place: Place,
    prefix: string | null,
    direction: Direction,
  ): void => {
    const from = entriesOf(left && ownRecord(left, 'content'));
    const to = entriesOf(right && ownRecord(right, 'content'));
    spend(from.size + to.size);
    const at = (media: string): string => (prefix === null ? media : `${prefix} ${media}`);
    for (const [media, value] of to) {
      const mediaPlace: Place = { ...place, location: at(media) };
      if (!from.has(media)) {
        record(mediaPlace, 'media_type_added', 'non_breaking');
        continue;
      }
      const previous = from.get(media);
      if (isRecord(previous) && isRecord(value)) {
        compareSchema(own(previous, 'schema'), own(value, 'schema'), mediaPlace, '', direction);
      }
    }
    for (const media of from.keys()) {
      if (!to.has(media)) {
        record({ ...place, location: at(media) }, 'media_type_removed', 'breaking');
      }
    }
  };

  const compareParameters = (
    operation: SpecOperationRef,
    left: readonly KeyedOpenApiParameter[],
    right: readonly KeyedOpenApiParameter[],
  ): void => {
    spend(left.length + right.length);
    // Parameters without an identity cannot be matched with anything, so they
    // are left out rather than reported as a removal and an addition.
    const byKey = (
      list: readonly KeyedOpenApiParameter[],
    ): Map<string, Record<string, unknown>> => {
      const keyed = new Map<string, Record<string, unknown>>();
      for (const entry of list) {
        const { key, resolution } = entry;
        if (key === null || keyed.has(key) || resolution === null || !resolution.ok) continue;
        keyed.set(key, resolution.value);
      }
      return keyed;
    };
    const from = byKey(left);
    const to = byKey(right);
    const placeOf = (parameter: Record<string, unknown>): Place => ({
      operation,
      section: 'parameter',
      location: `${String(own(parameter, 'in'))} ${String(own(parameter, 'name'))}`,
    });
    const requiredOf = (parameter: Record<string, unknown>): boolean =>
      own(parameter, 'required') === true || own(parameter, 'in') === 'path';
    for (const [key, parameter] of to) {
      const place = placeOf(parameter);
      const previous = from.get(key);
      if (previous === undefined) {
        const required = requiredOf(parameter);
        record(place, 'parameter_added', required ? 'breaking' : 'non_breaking', {
          to: required ? 'required' : 'optional',
        });
        continue;
      }
      const wasRequired = requiredOf(previous);
      const isRequired = requiredOf(parameter);
      if (!wasRequired && isRequired) record(place, 'parameter_required', 'breaking');
      else if (wasRequired && !isRequired) record(place, 'parameter_optional', 'non_breaking');
      compareSchema(own(previous, 'schema'), own(parameter, 'schema'), place, '', 'parameter');
    }
    for (const [key, parameter] of from) {
      if (!to.has(key)) record(placeOf(parameter), 'parameter_removed', 'breaking');
    }
  };

  const compareRequestBody = (
    operation: SpecOperationRef,
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ): void => {
    const from = resolveSchema(beforeRefs, own(left, 'requestBody'));
    const to = resolveSchema(afterRefs, own(right, 'requestBody'));
    if (from === null && to === null) return;
    spend(1);
    const place: Place = { operation, section: 'request', location: null };
    if (from === null) {
      const severity = own(to!, 'required') === true ? 'breaking' : 'non_breaking';
      record(place, 'request_body_added', severity);
      return;
    }
    if (to === null) {
      record(place, 'request_body_removed', 'breaking');
      return;
    }
    const wasRequired = own(from, 'required') === true;
    const isRequired = own(to, 'required') === true;
    if (!wasRequired && isRequired) record(place, 'request_body_required', 'breaking');
    else if (wasRequired && !isRequired) record(place, 'request_body_optional', 'non_breaking');
    compareContent(from, to, place, null, 'request');
  };

  const compareResponses = (
    operation: SpecOperationRef,
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ): void => {
    const from = entriesOf(ownRecord(left, 'responses'));
    const to = entriesOf(ownRecord(right, 'responses'));
    spend(from.size + to.size);
    for (const [status, response] of to) {
      const place: Place = { operation, section: 'response', location: status };
      if (!from.has(status)) {
        record(place, 'response_added', 'non_breaking');
        continue;
      }
      compareContent(
        resolveSchema(beforeRefs, from.get(status)),
        resolveSchema(afterRefs, response),
        place,
        status,
        'response',
      );
    }
    for (const status of from.keys()) {
      if (to.has(status)) continue;
      // A caller handling a success it will no longer get is broken; one that
      // handled an error it will no longer get is not.
      const success = /^2/.test(status);
      record(
        { operation, section: 'response', location: status },
        'response_removed',
        success ? 'breaking' : 'non_breaking',
      );
    }
  };

  const parametersOf = (
    resolver: OpenApiRefResolver,
    document: Record<string, unknown>,
    path: string,
    operation: Record<string, unknown>,
  ): KeyedOpenApiParameter[] => {
    const item = pathItemOf(document, path);
    const shared = keyOpenApiParameters(resolver, ownArray(item, 'parameters') ?? [], true);
    const declared = keyOpenApiParameters(resolver, ownArray(operation, 'parameters') ?? [], false);
    return mergeOpenApiParameters(shared, declared);
  };

  const fromOperations = operationsOf(before);
  const toOperations = operationsOf(after);
  let complete = true;

  try {
    for (const [key, operation] of toOperations) {
      spend(1);
      const ref = operationRef(key);
      const opPlace: Place = { operation: ref, section: 'operation', location: null };
      const previous = fromOperations.get(key);
      if (previous === undefined) {
        record(opPlace, 'operation_added', 'non_breaking');
        continue;
      }
      const wasDeprecated = own(previous, 'deprecated') === true;
      const isDeprecated = own(operation, 'deprecated') === true;
      if (!wasDeprecated && isDeprecated) {
        record(opPlace, 'operation_deprecated', 'non_breaking');
      } else if (wasDeprecated && !isDeprecated) {
        record(opPlace, 'operation_undeprecated', 'non_breaking');
      }
      const path = key.slice(key.indexOf(' ') + 1);
      compareParameters(
        ref,
        parametersOf(beforeRefs, before, path, previous),
        parametersOf(afterRefs, after, path, operation),
      );
      compareRequestBody(ref, previous, operation);
      compareResponses(ref, previous, operation);
    }
    for (const key of fromOperations.keys()) {
      if (toOperations.has(key)) continue;
      spend(1);
      record(
        { operation: operationRef(key), section: 'operation', location: null },
        'operation_removed',
        'breaking',
      );
    }
    compareComponents();
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    complete = false;
  }

  const fromInfo = ownRecord(before, 'info') ?? {};
  const toInfo = ownRecord(after, 'info') ?? {};
  const info: SpecInfoChange['field'][] = INFO_FIELDS.filter((field) => {
    const from = own(fromInfo, field);
    const to = own(toInfo, field);
    return (typeof from === 'string' ? from : null) !== (typeof to === 'string' ? to : null);
  });

  const listed = [...breaking, ...nonBreaking].slice(0, listLimit);
  const total = counts.breaking + counts.non_breaking;
  return {
    changed: total > 0 || info.length > 0,
    complete,
    changes: listed,
    counts,
    truncated: listed.length < total,
    info_changes: info,
  };
}

/**
 * A schema, request body or response as the object it names, or `null` when
 * it is a reference that cannot be followed (or is too long to be), or is not
 * an object at all.
 */
function resolveSchema(
  resolver: OpenApiRefResolver,
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const ref = refOf(value);
  if (ref !== null && ref.length > MAX_OPENAPI_REF_LENGTH) return null;
  const resolution = resolver.resolve(value);
  return resolution.ok ? resolution.value : null;
}
