// Run the root tests against an installed DSH instead of the development baseline the repository
// pins, as CI does for the other supported DSH release:
//   npm install --global --prefix <prefix> @deepseek-ai/dsh@<version>
//   DSH_HOST_ROOT=<prefix>/lib/node_modules/@deepseek-ai/dsh pnpm run test:installed-dsh
// Every @deepseek-ai/* import, subpaths included, resolves as if imported from that installation,
// and the real-host specs compose it through tests/helpers/installed-dsh.ts. Its packages are
// inlined, so a bare import they make that the installation lacks (zustand and clsx: DSH ships its
// client prebuilt) falls back to this repository's copy.
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import shared from '../vitest.config.ts'
import { dshHostPackages } from './dsh-host-packages.ts'

const configuredHost = process.env.DSH_HOST_ROOT
if (!configuredHost) throw new Error('Set DSH_HOST_ROOT to the @deepseek-ai/dsh package of an installed DSH')
// Vite canonicalizes importer paths (including macOS /tmp -> /private/tmp).
// Compare the same form so undeclared upstream UI dependencies can fall back.
const host = realpathSync(configuredHost)
const hostAnchor = join(host, 'package.json')
const hostPackages = dshHostPackages(hostAnchor)
if ((JSON.parse(readFileSync(hostAnchor, 'utf8')) as { name?: string }).name !== '@deepseek-ai/dsh') {
  throw new Error(`DSH_HOST_ROOT names no @deepseek-ai/dsh package: ${host}`)
}
const repoAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const bare = (id: string) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !/^[a-z]+:/u.test(id)

export default defineConfig({
  ...shared,
  plugins: [{
    name: 'installed-dsh',
    enforce: 'pre',
    async resolveId(id, importer, options) {
      if (!bare(id)) return null
      const inside = importer !== undefined && importer.startsWith(hostPackages.boundary + '/')
      if (id.startsWith('@deepseek-ai/')) return this.resolve(id, hostPackages.anchor(id) ?? (inside ? importer : hostAnchor), { ...options, skipSelf: true })
      if (!inside) return null
      return await this.resolve(id, importer, { ...options, skipSelf: true }) ?? this.resolve(id, repoAnchor, { ...options, skipSelf: true })
    },
  }, ...(shared.plugins ?? [])],
  test: {
    ...shared.test,
    dir: 'tests',
    // The published Starter activates under the installed DSH too.
    env: { MNEMON_BUNDLE_TEST_PROFILE: host },
    testTimeout: 60_000,
    server: { deps: { inline: [/@deepseek-ai\//u, ...(shared.test?.server?.deps?.inline ?? [])] } },
  },
})
