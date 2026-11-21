import { readFileSync } from 'node:fs';
import { z } from 'zod';

interface SchemaNode {
  type?: string;
  const?: string;
  enum?: [string, ...string[]];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: SchemaNode;
  pattern?: string;
  maxLength?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  allOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  dependentRequired?: Record<string, string[]>;
  if?: SchemaNode;
  then?: SchemaNode;
  default?: unknown;
}

// Fixed immutable asset, never a path supplied by an intake caller.
export const manifestSchema: SchemaNode = JSON.parse(
  readFileSync(
    new URL(
      '../../../contracts/ferrum-contracts/schemas/service-manifest/v1.schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const KEYWORDS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'x-contract',
  'type',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'pattern',
  'maxLength',
  'minItems',
  'minimum',
  'maximum',
  'allOf',
  'anyOf',
  'dependentRequired',
  'if',
  'then',
  'default',
]);

/**
 * The longest string a schema string without its own `maxLength` may hold. A
 * Nexus presentation bound, narrower than v1, which leaves those strings
 * unbounded; every value Alloy writes for them is far shorter.
 */
export const DEFAULT_STRING_MAX_LENGTH = 2048;

/**
 * Ferrum Edge's own limits on the fields Alloy's edge export writes from the
 * manifest (Edge `src/config/types.rs`: `MAX_LISTEN_PATH_LENGTH`,
 * `MAX_BACKEND_PATH_LENGTH`, `MAX_BACKEND_HOST_LENGTH`, `MAX_TIMEOUT_MS`,
 * `MAX_HEALTH_CHECK_INTERVAL`), keyed by schema location. ferrum-contracts
 * `main` publishes the same bounds in the v1 schema (ferrum-contracts#74), but
 * no tag carries them yet, so the pinned `contracts-edge-0.9.20` schema does
 * not. A bound the vendored schema declares itself always wins. Lengths count
 * characters, as JSON Schema `maxLength` does; Edge counts UTF-8 bytes, so for
 * non-ASCII text Edge itself is stricter.
 */
export const EDGE_FIELD_BOUNDS: Readonly<Record<string, { maxLength?: number; maximum?: number }>> =
  {
    '/properties/api/properties/public_path': { maxLength: 500 },
    // backend_path is service_base_path without its trailing `/`: 2048 + 1.
    '/properties/api/properties/service_base_path': { maxLength: 2049 },
    '/properties/upstream/properties/host': { maxLength: 255 },
    '/properties/health/properties/path': { maxLength: 2048 },
    '/properties/health/properties/interval_seconds': { maximum: 3600 },
    '/properties/health/properties/timeout_ms': { maximum: 86_400_000 },
    '/properties/timeouts/properties/connect_ms': { maximum: 86_400_000 },
    '/properties/timeouts/properties/read_ms': { maximum: 86_400_000 },
    '/properties/timeouts/properties/write_ms': { maximum: 86_400_000 },
  };

/** Characters, not UTF-16 code units: the unit JSON Schema `maxLength` counts. */
export function characterLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** Compile only this closed contract's vocabulary; schema drift fails startup. */
function compile(node: SchemaNode, location = ''): z.ZodType {
  if (Object.keys(node).some((key) => !KEYWORDS.has(key))) {
    throw new Error('Unsupported service manifest schema keyword');
  }
  let validator: z.ZodType = z.unknown();
  if (node.const !== undefined) validator = z.literal(node.const);
  else if (node.enum) validator = z.enum(node.enum);
  else if (node.type === 'object' || node.properties || node.required) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, property] of Object.entries(node.properties ?? {})) {
      const field = compile(property, `${location}/properties/${key}`);
      shape[key] = node.required?.includes(key) ? field : field.optional();
    }
    validator =
      node.additionalProperties === false ? z.strictObject(shape) : z.object(shape).passthrough();
  } else if (node.type === 'array') {
    if (!node.items) throw new Error('Missing service manifest item schema');
    validator = z
      .array(compile(node.items, `${location}/items`))
      .min(node.minItems ?? 0)
      .max(32);
  } else if (node.type === 'string') {
    // The schema's own bound, unclipped; then Edge's; then the Nexus default.
    const maxLength =
      node.maxLength ?? EDGE_FIELD_BOUNDS[location]?.maxLength ?? DEFAULT_STRING_MAX_LENGTH;
    validator = z.string().refine((value) => characterLength(value) <= maxLength);
  } else if (node.type === 'integer' || node.type === 'number') {
    let numeric = node.type === 'integer' ? z.number().int() : z.number();
    const maximum = node.maximum ?? EDGE_FIELD_BOUNDS[location]?.maximum;
    if (node.minimum !== undefined) numeric = numeric.min(node.minimum);
    if (maximum !== undefined) numeric = numeric.max(maximum);
    validator = numeric;
  } else if (node.type === 'boolean') validator = z.boolean();
  else if (node.type !== undefined) throw new Error('Unsupported service manifest schema type');
  if (node.required) {
    const required = node.required;
    validator = validator.refine((value) =>
      Boolean(
        value && typeof value === 'object' && required.every((key) => Object.hasOwn(value, key)),
      ),
    );
  }
  if (node.pattern) {
    const pattern = new RegExp(node.pattern);
    validator = validator.refine((value) => typeof value !== 'string' || pattern.test(value));
  }
  if (node.allOf) {
    const validators = node.allOf.map((item) => compile(item, location));
    validator = validator.refine((value) =>
      validators.every((item) => item.safeParse(value).success),
    );
  }
  if (node.anyOf) {
    const validators = node.anyOf.map((item) => compile(item, location));
    validator = validator.refine((value) =>
      validators.some((item) => item.safeParse(value).success),
    );
  }
  if (node.dependentRequired) {
    const dependencies = node.dependentRequired;
    validator = validator.refine((value) =>
      Boolean(
        value &&
        typeof value === 'object' &&
        Object.entries(dependencies).every(
          ([key, required]) =>
            !Object.hasOwn(value, key) ||
            required.every((dependency) => Object.hasOwn(value, dependency)),
        ),
      ),
    );
  }
  if (node.if) {
    if (!node.then) throw new Error('Missing service manifest conditional schema');
    const condition = compile(node.if, location);
    const consequent = compile(node.then, location);
    validator = validator.refine(
      (value) => !condition.safeParse(value).success || consequent.safeParse(value).success,
    );
  }
  return validator;
}
export const manifestValidator = compile(manifestSchema);

/** The longest string any manifest field accepts: the pre-validation budget. */
export const longestManifestString: number = (() => {
  let longest = DEFAULT_STRING_MAX_LENGTH;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'maxLength' && typeof value === 'number') longest = Math.max(longest, value);
        else visit(value);
      }
    }
  };
  visit(manifestSchema);
  for (const bound of Object.values(EDGE_FIELD_BOUNDS)) {
    longest = Math.max(longest, bound.maxLength ?? 0);
  }
  return longest;
})();

export function manifestDefaults(node: SchemaNode, value: unknown): unknown {
  if (!node.properties || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value } as Record<string, unknown>;
  for (const [key, property] of Object.entries(node.properties)) {
    if (!Object.hasOwn(result, key) && property.default !== undefined) {
      result[key] = structuredClone(property.default);
    }
    if (Object.hasOwn(result, key)) result[key] = manifestDefaults(property, result[key]);
  }
  return result;
}
