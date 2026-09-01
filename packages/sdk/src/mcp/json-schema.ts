/**
 * The JSON Schema subset the MCP tools declare, and a validator for it.
 *
 * ## Why this is written here rather than pulled in
 *
 * An MCP tool declares its input and output shape as JSON Schema, and a model
 * reads that declaration to decide what to send. A declaration nothing enforces
 * is a promise, not a contract: the first tool that accepts an out-of-range
 * `limit` or emits an amount as a `number` has broken the schema its caller was
 * reasoning against, and nothing in the process notices. So the four tools in
 * this package validate every input against the schema they publish, and the
 * test suite validates every output against the schema they publish (task 16.3).
 *
 * The validator is 200 lines rather than a dependency because the schemas here
 * use ten keywords between them, this package adds no dependency for the MCP
 * surface, and a validator whose supported keyword set is visible in one file
 * cannot silently ignore a keyword a schema relies on. {@link validateJsonValue}
 * fails loudly on a keyword it does not implement instead of passing the value,
 * which is the property a hand-written validator has to have to be trustworthy.
 *
 * ## Everything returns a Result
 *
 * Nothing here throws, including on a malformed schema. A schema is authored in
 * this package, so a bad one is a bug rather than input, but a bug that surfaces
 * as an `INTERNAL` `Result` at a tool boundary is reported to the model as a
 * failed call, and a bug that surfaces as a thrown value takes the stdio
 * transport down with it.
 *
 * Requirements: 21.5, 25.1, 25.2
 */

import type { Result } from "@tabai/shared";
import { ok } from "@tabai/shared";

import { fail, validationError } from "../errors.js";

/** The seven JSON Schema primitive type names. */
export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/** Every keyword {@link validateJsonValue} understands. Anything else is a failure, not a pass. */
export const SUPPORTED_KEYWORDS = [
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "default",
  "examples",
] as const;

/**
 * One node of the schema subset.
 *
 * `type` may be an array, which is how a nullable field is declared here:
 * `{ type: ["string", "null"] }`. There is no `nullable` keyword, because that
 * one is OpenAPI's rather than JSON Schema's and a model reading the tool
 * declaration would be reading a keyword that does not mean what it says.
 */
export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: string | number | boolean | null;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
}

/** An object-typed schema, which is what every tool input and output is. */
export interface JsonObjectSchema extends JsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchema>>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const typeNameOf = (value: unknown): JsonSchemaType => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  return "object";
};

/**
 * Does a value satisfy one declared type name?
 *
 * `integer` accepts only a safe integer, and `number` accepts an integer too,
 * which is JSON Schema's own rule. A `bigint` matches nothing: an amount in
 * Asset base units crosses this boundary as a decimal string and never as a
 * JavaScript number, so a `bigint` that reached a tool payload is a bug in the
 * mapping and is reported rather than coerced.
 */
const matchesType = (value: unknown, declared: JsonSchemaType): boolean => {
  if (typeof value === "bigint") return false;
  const actual = typeNameOf(value);
  if (declared === "number") return actual === "number" || actual === "integer";
  if (declared === "integer") return actual === "integer" && Number.isSafeInteger(value);
  return actual === declared;
};

const declaredTypes = (schema: JsonSchema): readonly JsonSchemaType[] | undefined => {
  if (schema.type === undefined) return undefined;
  return typeof schema.type === "string" ? [schema.type] : schema.type;
};

/** A dotted path into the value, so a problem names the field a caller has to fix. */
const child = (path: string, segment: string): string => (path === "" ? segment : `${path}.${segment}`);

/** Every unsupported keyword found anywhere in a schema, deepest last. */
function unsupportedKeywords(schema: JsonSchema, path: string, found: string[]): void {
  for (const keyword of Object.keys(schema)) {
    if (!(SUPPORTED_KEYWORDS as readonly string[]).includes(keyword)) {
      found.push(`${path === "" ? "<root>" : path}: ${keyword}`);
    }
  }
  if (schema.properties !== undefined) {
    for (const [name, property] of Object.entries(schema.properties)) {
      unsupportedKeywords(property, child(path, name), found);
    }
  }
  if (schema.items !== undefined) unsupportedKeywords(schema.items, `${path}[]`, found);
}

function collect(schema: JsonSchema, value: unknown, path: string, problems: string[]): void {
  const where = path === "" ? "value" : path;

  const types = declaredTypes(schema);
  if (types !== undefined && !types.some((declared) => matchesType(value, declared))) {
    problems.push(`${where}: expected ${types.join(" or ")}, received ${typeNameOf(value)}`);
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    problems.push(`${where}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as string)) {
    problems.push(`${where}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      problems.push(`${where}: must match ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${where}: must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push(`${where}: must be at most ${schema.maxLength} characters`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${where}: must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${where}: must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${where}: must hold at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      problems.push(`${where}: must hold at most ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => collect(schema.items!, entry, `${where}[${index}]`, problems));
    }
  }

  if (isPlainObject(value)) {
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) problems.push(`${child(where, name)}: required`);
    }
    const properties = schema.properties;
    if (properties !== undefined) {
      for (const [name, property] of Object.entries(properties)) {
        // An absent optional property is absent, not null. `exactOptionalPropertyTypes`
        // holds the same line in the types, so the two agree.
        if (value[name] !== undefined) collect(property, value[name], child(where, name), problems);
      }
      if (schema.additionalProperties === false) {
        for (const name of Object.keys(value)) {
          if (!(name in properties)) problems.push(`${child(where, name)}: not a declared property`);
        }
      }
    }
  }
}

/**
 * Validates a value against a schema and returns it unchanged when it conforms.
 *
 * `code` names the failure so a caller can tell an input rejection from an
 * output-shape bug without parsing the message.
 */
export function validateJsonValue<T>(
  schema: JsonSchema,
  value: unknown,
  label: string,
  code = "SCHEMA_MISMATCH",
): Result<T> {
  const unsupported: string[] = [];
  unsupportedKeywords(schema, "", unsupported);
  if (unsupported.length > 0) {
    return fail(
      "INTERNAL",
      "SCHEMA_KEYWORD_UNSUPPORTED",
      `the ${label} schema uses keywords this validator does not implement, so nothing was checked: ${unsupported.join("; ")}`,
      { details: { label, unsupported: unsupported.join("; ") } },
    );
  }

  const problems: string[] = [];
  collect(schema, value, "", problems);
  if (problems.length > 0) {
    return validationError(code, `${label} does not match its declared schema: ${problems.join("; ")}`, {
      details: { label, problems: problems.join("; ") },
    });
  }
  return ok(value as T);
}

/**
 * Fills in the declared top-level defaults of an object schema.
 *
 * Only the top level, because that is where every default in this package's
 * schemas sits and a defaulting pass that reached into arrays would be inventing
 * entries a caller did not send. A non-object value is handed back untouched for
 * {@link validateJsonValue} to reject with a type problem, which is a better
 * message than one about defaults.
 */
export function applyJsonDefaults(schema: JsonSchema, value: unknown): unknown {
  const properties = schema.properties;
  if (properties === undefined || !isPlainObject(value)) return value;
  const filled: Record<string, unknown> = { ...value };
  for (const [name, property] of Object.entries(properties)) {
    if (filled[name] === undefined && property.default !== undefined) filled[name] = property.default;
  }
  return filled;
}
