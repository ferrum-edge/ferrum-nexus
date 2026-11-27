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
 * unbounded; every value Alloy writes for them is far shorter. The fields
 * Alloy's edge export writes into Edge resources carry Edge's own limits in
 * the pinned schema (`contracts-edge-0.9.21`, ferrum-contracts#74), and those
 * always win.
 */
export const DEFAULT_STRING_MAX_LENGTH = 2048;

/** Characters, not UTF-16 code units: the unit JSON Schema `maxLength` counts. */
export function characterLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** Compile only this closed contract's vocabulary; schema drift fails startup. */
function compile(node: SchemaNode): z.ZodType {
  if (Object.keys(node).some((key) => !KEYWORDS.has(key))) {
    throw new Error('Unsupported service manifest schema keyword');
  }
  let validator: z.ZodType = z.unknown();
  if (node.const !== undefined) validator = z.literal(node.const);
  else if (node.enum) validator = z.enum(node.enum);
  else if (node.type === 'object' || node.properties || node.required) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, property] of Object.entries(node.properties ?? {})) {
      const field = compile(property);
      shape[key] = node.required?.includes(key) ? field : field.optional();
    }
    validator =
      node.additionalProperties === false ? z.strictObject(shape) : z.object(shape).passthrough();
  } else if (node.type === 'array') {
    if (!node.items) throw new Error('Missing service manifest item schema');
    validator = z
      .array(compile(node.items))
      .min(node.minItems ?? 0)
      .max(32);
  } else if (node.type === 'string') {
    // The schema's own bound, unclipped; otherwise the Nexus default.
    const maxLength = node.maxLength ?? DEFAULT_STRING_MAX_LENGTH;
    validator = z.string().refine((value) => characterLength(value) <= maxLength);
  } else if (node.type === 'integer' || node.type === 'number') {
    let numeric = node.type === 'integer' ? z.number().int() : z.number();
    if (node.minimum !== undefined) numeric = numeric.min(node.minimum);
    if (node.maximum !== undefined) numeric = numeric.max(node.maximum);
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
    const validators = node.allOf.map((item) => compile(item));
    validator = validator.refine((value) =>
      validators.every((item) => item.safeParse(value).success),
    );
  }
  if (node.anyOf) {
    const validators = node.anyOf.map((item) => compile(item));
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
    const condition = compile(node.if);
    const consequent = compile(node.then);
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
  // Schema keywords only: annotations such as `x-contract` never raise it.
  const visit = (node: SchemaNode): void => {
    if (node.maxLength !== undefined) longest = Math.max(longest, node.maxLength);
    for (const child of Object.values(node.properties ?? {})) visit(child);
    if (node.items) visit(node.items);
    for (const child of [...(node.allOf ?? []), ...(node.anyOf ?? [])]) visit(child);
    if (node.if) visit(node.if);
    if (node.then) visit(node.then);
  };
  visit(manifestSchema);
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
