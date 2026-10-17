/**
 * A tiny JSON Schema (2020-12 subset) evaluator for tests, because the project adds no
 * validator dependency. It throws on any keyword it does not implement, so the schema under
 * test cannot silently use something that is being ignored.
 */
type Json = Record<string, unknown>;

const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "title", "description"]);
const IMPLEMENTED = new Set([
  "$ref", "type", "const", "enum", "properties", "required", "additionalProperties", "propertyNames", "items",
  "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
  "minProperties", "maxProperties", "allOf", "anyOf", "oneOf", "not", "if", "then", "else"
]);

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case "object": return isObject(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    default: throw new Error(`unsupported type ${type}`);
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function schemaAccepts(schema: unknown, value: unknown, root: Json = schema as Json): boolean {
  if (schema === true) return true;
  if (schema === false) return false;
  if (!isObject(schema)) throw new Error("schema must be an object");
  for (const key of Object.keys(schema)) {
    if (!IMPLEMENTED.has(key) && !ANNOTATIONS.has(key)) throw new Error(`unsupported keyword ${key}`);
  }
  const sub = (s: unknown, v: unknown) => schemaAccepts(s, v, root);

  if (typeof schema.$ref === "string") {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m ? (root.$defs as Json | undefined)?.[m[1]!] : undefined;
    if (!target) throw new Error(`unresolved ${schema.$ref}`);
    if (!sub(target, value)) return false;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => typeOk(t, value))) return false;
  }
  if ("const" in schema && !same(schema.const, value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value))) return false;

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && Array.from(value).length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && Array.from(value).length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items !== undefined && !value.every((v) => sub(schema.items, v))) return false;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) return false;
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) return false;
    if (Array.isArray(schema.required) && !schema.required.every((k) => Object.prototype.hasOwnProperty.call(value, k as string))) return false;
    const props = isObject(schema.properties) ? schema.properties : {};
    for (const [k, s] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, k) && !sub(s, value[k])) return false;
    }
    if (schema.propertyNames !== undefined && !keys.every((k) => sub(schema.propertyNames, k))) return false;
    if (schema.additionalProperties !== undefined) {
      for (const k of keys) {
        if (k in props) continue;
        if (!sub(schema.additionalProperties, value[k])) return false;
      }
    }
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every((s) => sub(s, value))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => sub(s, value))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((s) => sub(s, value)).length !== 1) return false;
  if (schema.not !== undefined && sub(schema.not, value)) return false;
  if (schema.if !== undefined) {
    if (sub(schema.if, value)) {
      if (schema.then !== undefined && !sub(schema.then, value)) return false;
    } else if (schema.else !== undefined && !sub(schema.else, value)) return false;
  }
  return true;
}
