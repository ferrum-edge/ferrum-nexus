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
    validator = z.string().max(Math.min(node.maxLength ?? 2048, 2048));
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
    const validators = node.allOf.map(compile);
    validator = validator.refine((value) =>
      validators.every((item) => item.safeParse(value).success),
    );
  }
  if (node.anyOf) {
    const validators = node.anyOf.map(compile);
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
