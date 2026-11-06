import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

/** Source builds keep transitive packages in workspace siblings, unlike a flattened npm install. */
export function dshHostPackages(hostAnchor: string) {
  const host = dirname(realpathSync(hostAnchor))
  const source = resolve(host, '../..')
  const packages = new Map<string, string>()
  if (existsSync(join(source, 'pnpm-workspace.yaml')) && host === join(source, 'apps', 'cli')) {
    const directories = (path: string) => readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name))
    for (const path of [...directories(join(source, 'apps')), ...directories(join(source, 'packages')).flatMap(directories)]) {
      const file = join(path, 'package.json')
      if (!existsSync(file)) continue
      const { name } = JSON.parse(readFileSync(file, 'utf8')) as { name?: string }
      if (name?.startsWith('@deepseek-ai/')) packages.set(name, file)
    }
  }
  return {
    isSource: packages.size > 0,
    boundary: packages.size > 0 ? source : host,
    anchor(id: string): string | undefined { return packages.get(id.split('/').slice(0, 2).join('/')) },
  }
}

/** Do not let pnpm's NODE_PATH silently substitute this repo's older DSH for a source package. */
export function createDshHostRequire(hostAnchor: string): NodeJS.Require {
  const host = createRequire(hostAnchor)
  const packages = dshHostPackages(hostAnchor)
  const original = host.resolve
  host.resolve = Object.assign((id: string, options?: Parameters<typeof original>[1]) => {
    const anchor = packages.anchor(id)
    const resolved = anchor === undefined ? original(id, options) : createRequire(anchor).resolve(id, options)
    if (packages.isSource && id.startsWith('@deepseek-ai/dsh-') && !resolved.startsWith(packages.boundary + '/')) {
      throw Object.assign(new Error(`The selected DSH source workspace does not provide ${id}`), { code: 'MODULE_NOT_FOUND' })
    }
    return resolved
  }, { paths: original.paths })
  return host
}
