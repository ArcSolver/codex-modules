import { z } from "zod/v4";

export type SchemaWarning = {
  path: string;
  message: string;
};

export type SchemaConversionResult =
  | { ok: true; schema: z.ZodTypeAny; warnings: SchemaWarning[] }
  | { ok: false; reason: string; path: string };

type JsonObject = Record<string, unknown>;

export function codexJsonSchemaToZod(schema: unknown): SchemaConversionResult {
  const result = convert(schema, "$", true);
  if (!result.ok) return result;
  return { ok: true, schema: result.schema, warnings: result.warnings };
}

function convert(schema: unknown, path: string, root = false): SchemaConversionResult {
  if (!isObject(schema)) return fail("schema must be an object", path);
  for (const key of ["$ref", "$defs", "definitions", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "patternProperties", "dependentSchemas"]) {
    if (key in schema) return fail(`${key} is not supported`, `${path}.${key}`);
  }
  if (isObject(schema.additionalProperties)) {
    return fail("schema additionalProperties is not supported", `${path}.additionalProperties`);
  }
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const warnings: SchemaWarning[] = [];
  let zod: z.ZodTypeAny;

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return fail("empty enum is not supported", `${path}.enum`);
    if (!schema.enum.every(isScalar)) return fail("enum values must be scalar", `${path}.enum`);
    const values = unique(schema.enum);
    if (values.length === 1) zod = z.literal(values[0] as never);
    else if (values.every((item) => typeof item === "string")) {
      zod = z.enum(values as [string, ...string[]]);
    } else {
      const literals = values.map((item) => z.literal(item as never));
      zod = z.union(literals as unknown as [z.ZodLiteral, z.ZodLiteral, ...z.ZodLiteral[]]);
    }
    return ok(describe(zod, description), warnings);
  }

  if ("const" in schema) {
    if (!isScalar(schema.const)) return fail("const value must be scalar", `${path}.const`);
    return ok(describe(z.literal(schema.const as never), description), warnings);
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((item) => item !== "null");
    if (nonNull.length === 1 && type.includes("null")) {
      const inner = convert({ ...schema, type: nonNull[0] }, path);
      if (!inner.ok) return inner;
      return ok(describe(inner.schema.nullable(), description), inner.warnings);
    }
    return fail("only single nullable unions are supported", `${path}.type`);
  }

  switch (type) {
    case "object": {
      const properties = isObject(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [name, child] of Object.entries(properties)) {
        const childResult = convert(child, `${path}.properties.${name}`);
        if (!childResult.ok) return childResult;
        warnings.push(...childResult.warnings);
        shape[name] = required.has(name) ? childResult.schema : childResult.schema.optional();
      }
      zod = z.object(shape).strict();
      break;
    }
    case "string":
      zod = z.string();
      break;
    case "number":
      zod = z.number();
      break;
    case "integer":
      zod = z.number().int();
      break;
    case "boolean":
      zod = z.boolean();
      break;
    case "array": {
      if (Array.isArray(schema.items)) return fail("tuple arrays are not supported", `${path}.items`);
      const itemSchema = schema.items ?? {};
      const childResult = convert(itemSchema, `${path}.items`);
      if (!childResult.ok) return childResult;
      warnings.push(...childResult.warnings);
      zod = z.array(childResult.schema);
      break;
    }
    default:
      return fail(`unsupported schema type ${String(type)}`, `${path}.type`);
  }

  if (root && type !== "object") return fail("root schema must be an object", path);
  return ok(describe(zod, description), warnings);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function describe(schema: z.ZodTypeAny, description: string | undefined): z.ZodTypeAny {
  return description ? schema.describe(description) : schema;
}

function ok(schema: z.ZodTypeAny, warnings: SchemaWarning[]): SchemaConversionResult {
  return { ok: true, schema, warnings };
}

function fail(reason: string, path: string): SchemaConversionResult {
  return { ok: false, reason, path };
}
