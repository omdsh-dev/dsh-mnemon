export function appearanceClass(base: string | undefined, sidebar: string | undefined): string {
  return [base, sidebar].filter((value): value is string => value !== undefined && value !== '').join(' ')
}

export function mergeStyleMaps(
  ...maps: ReadonlyArray<Readonly<Record<string, string>>>
): Readonly<Record<string, string>> {
  return /* @__PURE__ */ new Proxy<Record<string, string>>({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      let resolved: string | undefined
      for (const map of maps) {
        if (Object.hasOwn(map, prop)) resolved = map[prop]
      }
      return resolved
    },
    has(_target, prop) {
      return typeof prop === 'string' && maps.some(map => Object.hasOwn(map, prop))
    },
    ownKeys() {
      const keys = new Set<string | symbol>()
      for (const map of maps) {
        for (const key of Reflect.ownKeys(map)) keys.add(key)
      }
      return Array.from(keys)
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== 'string') return undefined
      for (let index = maps.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(maps[index]!, prop)
        if (descriptor !== undefined) return { ...descriptor, configurable: true }
      }
      return undefined
    },
  })
}
