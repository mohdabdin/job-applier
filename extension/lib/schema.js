// Strict JSON Schemas for structured output (every property required, no extra properties: what Anthropic's
// structured outputs need, and Gemini accepts), plus a checker for what comes back. Optional values are expressed
// as "" / [] / false, never by leaving a property out.

export const str = (description = "") => (description ? { type: "string", description } : { type: "string" });
export const bool = (description = "") => (description ? { type: "boolean", description } : { type: "boolean" });
export const oneOf = (values, description = "") => ({ type: "string", enum: values, ...(description && { description }) });
export const list = (items, description = "") => ({ type: "array", items, ...(description && { description }) });
export const obj = (properties, description = "") => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
  ...(description && { description }),
});

/** Throws if `value` doesn't fit `schema`; returns it otherwise. */
export function check(schema, value, path = "result") {
  const fail = (msg) => { throw new Error(`${path}: ${msg}`); };
  switch (schema.type) {
    case "object":
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
      for (const k of schema.required || []) if (!(k in value)) fail(`missing "${k}"`);
      for (const [k, s] of Object.entries(schema.properties || {})) if (k in value) check(s, value[k], `${path}.${k}`);
      return value;
    case "array":
      if (!Array.isArray(value)) fail("expected a list");
      value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`));
      return value;
    case "string":
      if (typeof value !== "string") fail("expected text");
      if (schema.enum && !schema.enum.includes(value)) fail(`"${value}" isn't one of ${schema.enum.join(", ")}`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") fail("expected true/false");
      return value;
    case "integer":
    case "number":
      if (typeof value !== "number") fail("expected a number");
      return value;
    default:
      return value;
  }
}
