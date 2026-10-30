/** Private Schema declarations plus their exact, reversible argument projection.
 * No schema rewriting walks conversation business data. Complex JSON is explicitly
 * transported as JSON text where the private Schema subset cannot faithfully declare it. */
import { isRecord } from '../../auth/oauth_antigravity.ts'
const carriers = new WeakMap<object, 'value' | 'arguments'>()
const placeholders = new WeakMap<object, string>()
const JSON_ARGUMENTS = '__oasis_json'
/** Only the exact root declaration built for this request owns an argument envelope. */
export const isAntigravityArgumentCarrier = (schema: Record<string, unknown>): boolean => carriers.get(schema) === 'arguments'
const projected = (node: Record<string, unknown>): boolean => carriers.has(node) || placeholders.has(node)
  || (isRecord(node.properties) && Object.values(node.properties).some(v => isRecord(v) && projected(v)))
  || (isRecord(node.items) && projected(node.items))
  || (Array.isArray(node.anyOf) && node.anyOf.some(v => isRecord(v) && projected(v)))
export class AntigravityCarrierError extends Error {
  constructor() { super('Antigravity tool JSON carrier is malformed; expected exactly the declared JSON encoding'); this.name = 'AntigravityCarrierError' }
}

export function antigravityToolSchema(schema: Record<string, unknown>, claude: boolean): Record<string, unknown> {
  const carrier = (original: unknown, root: boolean): Record<string, unknown> => {
    const description = `JSON TEXT CARRIER (decoded before tool execution): send a STRING containing one complete valid JSON value, not a native object/array. Preserve every original value and key. Encode null as "null", false as "false", 0 as "0", and a JSON string with its JSON quotes. No markdown, duplicate keys or nonfinite numbers; maximum JSON nesting 128. Original schema (runtime validation remains authoritative): ${JSON.stringify(original)}. Local references use these definitions: ${JSON.stringify({ $defs: schema.$defs, definitions: schema.definitions })}`
    const out: Record<string, unknown> = root
      ? { type: 'OBJECT', properties: { [JSON_ARGUMENTS]: { type: 'STRING', description } }, required: [JSON_ARGUMENTS], description: 'Tool argument envelope: put the ENTIRE original argument object as JSON text in __oasis_json. Do not send any other envelope fields.' }
      : { type: 'STRING', description }
    carriers.set(out, root ? 'arguments' : 'value')
    return out
  }
  const walk = (raw: unknown, root = false, seen = new Set<string>()): Record<string, unknown> => {
    if (!isRecord(raw)) return carrier(raw, root)
    let node = { ...raw }
    if (typeof node.$ref === 'string') {
      const ref = node.$ref
      if (!ref.startsWith('#/') || seen.has(ref)) return carrier(node, root)
      let target: unknown = schema
      for (const key of ref.slice(2).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))) target = isRecord(target) && Object.hasOwn(target, key) ? target[key] : undefined
      if (!isRecord(target)) return carrier(node, root)
      const next = new Set(seen); next.add(ref)
      return walk({ ...target, ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== '$ref')) }, root, next)
    }
    for (const key of ['anyOf', 'oneOf']) if (Array.isArray(node[key])) {
      const branches = node[key] as unknown[]
      const nonNull = branches.filter(b => !isRecord(b) || b.type !== 'null')
      if (nonNull.length === 1 && isRecord(nonNull[0])) {
        // Re-enter ref resolution after projecting a nullable union, never flatten a $ref to STRING.
        const rest = Object.fromEntries(Object.entries(node).filter(([k]) => k !== key))
        return walk({ ...rest, ...nonNull[0], ...(nonNull.length < branches.length ? { nullable: true } : {}) }, root, seen)
      }
      if (!claude && key === 'anyOf' && nonNull.length > 1) {
        const native = nonNull.map(b => walk(b, false, seen))
        // Gemini can keep unions natively when none of their branches needs a codec.
        // A union with branch-specific carriers would make string decoding ambiguous.
        if (!native.some(projected)) return { anyOf: native, ...(nonNull.length < branches.length || node.nullable === true ? { nullable: true } : {}), ...(typeof node.description === 'string' ? { description: node.description } : {}) }
      }
      return carrier(node, root)
    }
    if (node.allOf || node.if || node.then || node.else || node.not || node.patternProperties || node.dependentSchemas || node.prefixItems) return carrier(node, root)
    let type = node.type
    if (Array.isArray(type)) {
      const types = type.filter(t => t !== 'null')
      if (types.length !== 1) return carrier(node, root)
      if (types.length < type.length) node.nullable = true
      type = types[0]
    }
    if (type === undefined && isRecord(node.properties)) type = 'object'
    if (typeof type !== 'string' || !['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(type.toLowerCase())) return carrier(node, root)
    const out: Record<string, unknown> = { type: type.toUpperCase() }
    if (node.nullable === true) out.nullable = true
    const hints: string[] = typeof node.description === 'string' ? [node.description] : []
    if (out.type === 'OBJECT') {
      // Absent additionalProperties means open. Never add/delete reserved keys in a map.
      if (node.additionalProperties !== false) return carrier(node, root)
      const properties = isRecord(node.properties) ? node.properties : {}
      const required = Array.isArray(node.required) ? node.required.filter(k => typeof k === 'string' && Object.hasOwn(properties, k)) : []
      if (claude && !required.length && Object.keys(properties).length) return carrier(node, root)
      out.properties = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, walk(v, false, seen)]))
      if (required.length) out.required = required
      if (claude && !Object.keys(properties).length) {
        if (!root || node.nullable === true) return carrier(node, root)
        // Only a proven closed, empty top-level argument object cannot contain this business key.
        out.properties = { __oasis_reason: { type: 'STRING', description: 'Brief explanation of why you are calling this empty-argument tool' } }
        out.required = ['__oasis_reason']
        placeholders.set(out, '__oasis_reason')
      }
    }
    if (out.type === 'ARRAY') {
      if (Array.isArray(node.items)) return carrier(node, root)
      out.items = walk(node.items ?? {}, false, seen)
    }
    for (const key of ['enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems']) if (key in node) hints.push(`${key}: ${JSON.stringify(node[key])}`)
    if (hints.length) out.description = hints.join('\n')
    return out
  }
  return walk(schema, true)
}

/** Check duplicate members and finite numbers as well as JSON syntax; never echo carrier data. */
function parseCarrier(text: unknown): unknown {
  if (typeof text !== 'string') throw new AntigravityCarrierError()
  let i = 0
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '\x00')) i++ }
  const string = (): string => {
    const start = i++
    for (; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue }
      if (text[i] === '"') { i++; return JSON.parse(text.slice(start, i)) as string }
    }
    throw new AntigravityCarrierError()
  }
  const value = (depth: number): void => {
    if (depth > 128) throw new AntigravityCarrierError()
    ws()
    if (text[i] === '"') { string(); return }
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i++] === '{', close = object ? '}' : ']'
      const keys = new Set<string>(); ws()
      if (text[i] === close) { i++; return }
      for (;;) {
        if (object) { ws(); if (text[i] !== '"') throw new AntigravityCarrierError(); const key = string(); if (keys.has(key)) throw new AntigravityCarrierError(); keys.add(key); ws(); if (text[i++] !== ':') throw new AntigravityCarrierError() }
        value(depth + 1); ws()
        if (text[i] === close) { i++; return }
        if (text[i++] !== ',') throw new AntigravityCarrierError()
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))?.[0]
    if (!token) throw new AntigravityCarrierError()
    if (/^-?\d/.test(token) && !Number.isFinite(Number(token))) throw new AntigravityCarrierError()
    if (/^-?\d+$/.test(token) && BigInt(Number(token)) !== BigInt(token)) throw new AntigravityCarrierError()
    i += token.length
  }
  try { value(0); ws(); if (i !== text.length) throw new AntigravityCarrierError(); return JSON.parse(text) } catch { throw new AntigravityCarrierError() }
}

/** Decode ONLY exact nodes marked while building this request's declarations. */
export function originalToolArguments(value: unknown, schema: Record<string, unknown>): unknown {
  const mode = carriers.get(schema)
  if (mode) {
    if (mode === 'arguments' && (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, JSON_ARGUMENTS))) throw new AntigravityCarrierError()
    const decoded = parseCarrier(mode === 'arguments' ? (value as Record<string, unknown>)[JSON_ARGUMENTS] : value)
    if (mode === 'arguments' && !isRecord(decoded)) throw new AntigravityCarrierError()
    return decoded
  }
  if (Array.isArray(value)) return value.map(v => originalToolArguments(v, isRecord(schema.items) ? schema.items : {}))
  if (!isRecord(value)) return value
  const placeholder = placeholders.get(schema)
  const properties = isRecord(schema.properties) ? schema.properties : {}
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== placeholder).map(([key, v]) => [key, originalToolArguments(v, isRecord(properties[key]) ? properties[key] : {})]))
}

function requireJson(value: unknown, depth = 0): void {
  if (depth > 128) throw new AntigravityCarrierError()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) requireJson(value[i], depth + 1); return }
  if (isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const v of Object.values(value)) requireJson(v, depth + 1)
    return
  }
  throw new AntigravityCarrierError()
}

/** Portable history uses original execution arguments. Signed, same-route wire_args bypass this. */
export function wireToolArguments(value: unknown, schema: Record<string, unknown>): unknown {
  const mode = carriers.get(schema)
  if (mode) {
    requireJson(value)
    const text = JSON.stringify(value)
    parseCarrier(text)
    if (mode === 'arguments') { if (!isRecord(value)) throw new AntigravityCarrierError(); return { [JSON_ARGUMENTS]: text } }
    return text
  }
  if (Array.isArray(value)) return value.map(v => wireToolArguments(v, isRecord(schema.items) ? schema.items : {}))
  if (!isRecord(value)) return value
  const properties = isRecord(schema.properties) ? schema.properties : {}
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, wireToolArguments(v, isRecord(properties[key]) ? properties[key] : {})]))
}
