import type { Context } from '@deepseek-ai/cordis'

/** One plugin row of the DSH profile, as a Provider may read it: values under secret-looking keys left out. */
export interface MemorySpaceProviderProfileRow {
  id: string
  packageName: string
  /** Effective: the row or a group above it is switched off. */
  disabled: boolean
  /** The row's plugin is loaded and running. */
  running: boolean
  /** Plain configured values; `!!js` expressions and secret-looking keys are not included. */
  config?: Readonly<Record<string, unknown>>
}

/**
 * What a Provider may read of the DSH profile it runs in, to recognize its vendor's own plugin.
 * Everything is read only: a service's methods cannot be called through it and nothing can be set.
 */
export interface MemorySpaceProviderProfile {
  /** A running service by name, as a read-only view; undefined when none runs. */
  service(name: string): unknown
  /** The profile's plugin rows, the home-level ones included. */
  rows(): readonly MemorySpaceProviderProfileRow[]
}

const SECRET_KEY = /key|secret|token|password|passwd|credential|authorization|bearer|cookie/iu
const MAX_DEPTH = 6

/** A view of a value that reads like it and refuses everything else: no call, no write, no new property. */
export function readOnlyView<T>(value: T): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value
  return new Proxy(value as object, {
    get(target, key) {
      const child = Reflect.get(target, key) as unknown
      // A proxy must return a frozen property as it is; a frozen value cannot be changed anyway.
      const own = Reflect.getOwnPropertyDescriptor(target, key)
      if (own !== undefined && own.configurable === false && own.writable === false) return child
      if (typeof child === 'function') return () => { throw new Error('A vendor service is read only to Memory Space Providers') }
      return readOnlyView(child)
    },
    apply() { throw new Error('A vendor service is read only to Memory Space Providers') },
    construct() { throw new Error('A vendor service is read only to Memory Space Providers') },
    set() { return false },
    defineProperty() { return false },
    deleteProperty() { return false },
    setPrototypeOf() { return false },
  }) as T
}

/** Plain configured values only, without secret-looking keys or `!!js` expressions. */
function plain(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (depth >= MAX_DEPTH || typeof value !== 'object') return undefined
  if (Array.isArray(value)) return value.slice(0, 100).map(item => plain(item, depth + 1)).filter(item => item !== undefined)
  if (Object.hasOwn(value, '__jsExpr')) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value).slice(0, 200)) {
    if (SECRET_KEY.test(key)) continue
    const kept = plain(child, depth + 1)
    if (kept !== undefined) out[key] = kept
  }
  return out
}

interface LoaderEntry {
  id?: string
  disabled?: boolean
  fiber?: { state?: number }
  options?: { id?: string; name?: string; config?: unknown }
}

/** The profile as the Memory Spaces Source's own context sees it. */
export function createProviderProfile(ctx: Context): MemorySpaceProviderProfile {
  return Object.freeze({
    service: (name: string) => {
      const value = ctx.get(name) as unknown
      return value === undefined ? undefined : readOnlyView(value)
    },
    rows: () => {
      const loader = ctx.get('loader', false) as { entries?(): Iterable<LoaderEntry> } | undefined
      const rows: MemorySpaceProviderProfileRow[] = []
      for (const entry of loader?.entries?.() ?? []) {
        const id = entry.options?.id ?? entry.id
        const packageName = entry.options?.name
        if (typeof id !== 'string' || typeof packageName !== 'string') continue
        const config = plain(entry.options?.config, 0)
        rows.push(Object.freeze({
          id, packageName, disabled: entry.disabled === true,
          // Cordis FiberState.ACTIVE.
          running: entry.fiber?.state === 2,
          ...(typeof config === 'object' && config !== null && !Array.isArray(config) ? { config: Object.freeze(config as Record<string, unknown>) } : {}),
        }))
      }
      return Object.freeze(rows)
    },
  })
}
