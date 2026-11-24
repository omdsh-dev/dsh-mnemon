import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadMemoryClientArtifact } from '../src/sdk/testing.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)

const CLIENT_BUNDLES = [
  { id: 'dsh-mnemon', path: join(root, 'lib/client.js'), requiredExports: ['apply', 'inject', 'installMemorySourceUI', 'installMemoryComponentUI'] },
  { id: 'dsh-mnemon-source-memory-spaces', path: join(root, 'plugins/dsh-mnemon-source-memory-spaces/lib/client.js'), requiredExports: ['apply', 'inject', 'MemorySpacesSourcePage', 'MemorySpacesSettings', 'OverviewPage', 'ProviderIcon', 'NATIVE_PROVIDER_ID'] },
  { id: 'dsh-mnemon-source-skills', path: join(root, 'plugins/dsh-mnemon-source-skills/lib/client.js'), requiredExports: ['apply', 'inject'] },
  { id: 'dsh-mnemon-source-documents', path: join(root, 'plugins/dsh-mnemon-source-documents/lib/client.js'), requiredExports: ['apply', 'inject'] },
  { id: 'dsh-mnemon-source-runtime', path: join(root, 'plugins/dsh-mnemon-source-runtime/lib/client.js'), requiredExports: ['apply', 'inject'] },
] as const

const UNUSED_STARTER_GRAPH_MARKERS = [
  'data-source-kind',
  'data-ds-dark-theme',
  'getContext("2d")',
  "getContext('2d')",
  'memory-graph-3d',
] as const

const HOST_LEAK_MARKERS = [
  'require("node:',
  "require('node:",
  'https://registry.npmjs.org',
  'dsh-mnemon-update-backup-',
  'unsupported Source assistance operation',
  'login/device/code',
  'login/oauth/access_token',
  'api.github.com',
  'Ov23liq4i7n8UsylGRfb',
] as const

function readBuiltBundle(path: string): string {
  if (!existsSync(path)) throw new Error(`Build client bundle first: ${path}`)
  return readFileSync(path, 'utf8')
}

describe('built browser client bundles', () => {
  it('omits unused Memory Spaces graph components from the Starter client bundle while keeping them in Memory Spaces', () => {
    const starter = readBuiltBundle(CLIENT_BUNDLES[0].path)
    for (const marker of UNUSED_STARTER_GRAPH_MARKERS) expect(starter).not.toContain(marker)

    const spaces = readBuiltBundle(CLIENT_BUNDLES[1].path)
    expect(spaces).toContain('data-source-kind')
    expect(spaces).toContain('data-ds-dark-theme')
  })

  it.each(CLIENT_BUNDLES)('minifies $id without region banners or host leaks', ({ path }) => {
    const code = readBuiltBundle(path)
    expect(code).not.toContain('//#region ')
    expect(code.split('\n').length).toBeLessThan(100)
    for (const marker of HOST_LEAK_MARKERS) expect(code).not.toContain(marker)
  })

  it('loads the minified Starter and Source client bundles with their public exports intact', async () => {
    const sharedDependencies = {
      react: await import('react'),
      'react/jsx-runtime': await import('react/jsx-runtime'),
      'react-dom': await import('react-dom'),
      '@deepseek-ai/dsh-client-ui-primitives': await import('@deepseek-ai/dsh-client-ui-primitives'),
    }
    const starterExports = (require('./fixtures/dsh-mnemon-client-0.5.31-exports.json') as { exports: string[] }).exports
    const starter = loadMemoryClientArtifact<Record<string, unknown>>(CLIENT_BUNDLES[0].path, sharedDependencies)
    for (const name of [...CLIENT_BUNDLES[0].requiredExports, ...starterExports]) {
      expect(starter[name], `dsh-mnemon/client.${name}`).toBeDefined()
    }
    const sourceDependencies = { ...sharedDependencies, 'dsh-mnemon/client': starter }
    for (const entry of CLIENT_BUNDLES.slice(1)) {
      const loaded = loadMemoryClientArtifact<Record<string, unknown>>(entry.path, sourceDependencies)
      for (const name of entry.requiredExports) {
        expect(loaded[name], `${entry.id}/client.${name}`).toBeDefined()
      }
    }
  })
})
