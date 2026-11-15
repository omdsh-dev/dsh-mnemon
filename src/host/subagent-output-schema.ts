/** The JSON Schema subset DSH structured-output tools compile, and the check of a captured result against a schema in it. */

const DSH_OUTPUT_SCHEMA_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minLength',
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment',
])

/** Rejects schema keywords that DSH structured-output tools cannot compile. */
export function assertDshOutputSchema(schema: unknown, path = 'schema'): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) throw new Error(`${path} must be an object`)
  const value = schema as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!DSH_OUTPUT_SCHEMA_KEYS.has(key)) throw new Error(`unsupported DSH output schema keyword: ${path}.${key}`)
  }
  if (value.minLength !== undefined && (typeof value.minLength !== 'number' || !Number.isInteger(value.minLength) || value.minLength < 0)) {
    throw new Error(`${path}.minLength must be a non-negative integer`)
  }
  if (typeof value.properties === 'object' && value.properties !== null && !Array.isArray(value.properties)) {
    for (const [name, child] of Object.entries(value.properties)) assertDshOutputSchema(child, `${path}.properties.${name}`)
  }
  if (value.items !== undefined) assertDshOutputSchema(value.items, `${path}.items`)
  if (Array.isArray(value.oneOf)) value.oneOf.forEach((child, index) => assertDshOutputSchema(child, `${path}.oneOf[${index}]`))
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Validate captured result-tool arguments independently of the host runtime. */
export function assertDshOutputValue(schema: unknown, candidate: unknown, path = 'result'): void {
  const value = schema as Record<string, unknown>
  if (Array.isArray(value.oneOf)) {
    const matches = value.oneOf.filter(option => {
      try {
        assertDshOutputValue(option, candidate, path)
        return true
      } catch {
        return false
      }
    })
    if (matches.length !== 1) throw new Error(`${path} must match exactly one schema variant`)
    return
  }
  if (Array.isArray(value.enum) && !value.enum.some(entry => jsonEqual(entry, candidate))) throw new Error(`${path} is not an allowed value`)
  if (Object.hasOwn(value, 'const') && !jsonEqual(value.const, candidate)) throw new Error(`${path} does not match its required constant`)

  switch (value.type) {
    case 'object': {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) throw new Error(`${path} must be an object`)
      const objectCandidate = candidate as Record<string, unknown>
      const properties = typeof value.properties === 'object' && value.properties !== null && !Array.isArray(value.properties)
        ? value.properties as Record<string, unknown>
        : {}
      for (const required of Array.isArray(value.required) ? value.required : []) {
        if (typeof required === 'string' && !Object.hasOwn(objectCandidate, required)) throw new Error(`${path}.${required} is required`)
      }
      for (const [name, child] of Object.entries(properties)) {
        if (Object.hasOwn(objectCandidate, name)) assertDshOutputValue(child, objectCandidate[name], `${path}.${name}`)
      }
      if (value.additionalProperties === false) {
        const unknown = Object.keys(objectCandidate).find(name => !Object.hasOwn(properties, name))
        if (unknown !== undefined) throw new Error(`${path}.${unknown} is not allowed`)
      }
      return
    }
    case 'array':
      if (!Array.isArray(candidate)) throw new Error(`${path} must be an array`)
      if (value.items !== undefined) candidate.forEach((entry, index) => assertDshOutputValue(value.items, entry, `${path}[${index}]`))
      return
    case 'string':
      if (typeof candidate !== 'string') throw new Error(`${path} must be a string`)
      if (typeof value.minLength === 'number' && candidate.length < value.minLength) {
        throw new Error(`${path} must contain at least ${value.minLength} characters`)
      }
      return
    case 'number':
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) throw new Error(`${path} must be a finite number`)
      return
    case 'integer':
      if (typeof candidate !== 'number' || !Number.isInteger(candidate)) throw new Error(`${path} must be an integer`)
      return
    case 'boolean':
      if (typeof candidate !== 'boolean') throw new Error(`${path} must be a boolean`)
      return
    case undefined:
      return
    default:
      throw new Error(`${path} uses unsupported schema type ${JSON.stringify(value.type)}`)
  }
}
