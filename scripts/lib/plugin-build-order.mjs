/**
 * Public peers are build dependencies. The already-built Starter is deliberately
 * outside this graph: it installs the plugins that in turn consume its SDK.
 * @param {Array<{name:string, dependencies?:Record<string,string>, optionalDependencies?:Record<string,string>, peerDependencies?:Record<string,string>}>} manifests
 * @returns {string[][]}
 */
export function pluginBuildLayers(manifests) {
  const names = new Set(manifests.map(value => value.name))
  if (names.size !== manifests.length) throw new Error('Duplicate plugin package name')
  const pending = new Map(manifests.map(value => [value.name, new Set([...Object.keys(value.dependencies ?? {}), ...Object.keys(value.optionalDependencies ?? {}), ...Object.keys(value.peerDependencies ?? {})].filter(name => names.has(name)))]))
  const layers = [], built = new Set()
  while (pending.size) {
    const ready = [...pending].filter(([, dependencies]) => [...dependencies].every(name => built.has(name))).map(([name]) => name).sort()
    if (!ready.length) throw new Error('Cyclic plugin build dependencies: ' + [...pending.keys()].sort().join(', '))
    layers.push(ready)
    for (const name of ready) { pending.delete(name); built.add(name) }
  }
  return layers
}
