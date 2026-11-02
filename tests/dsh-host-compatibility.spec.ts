import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

/**
 * The supported hosts: DSH 0.2.0 from 0.2.0-rc.2 and 0.2.x from 0.2.1-rc.1, finals included.
 * 0.2.1-rc.5 is the development baseline; installed-host CI also checks the 0.2.2 alpha track.
 */
const SUPPORTED_DSH_RUNTIMES = ['0.2.0-rc.2', '0.2.0', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.1', '0.2.2-alpha.2', '0.2.2']
/** Hosts the Starter no longer supports: DSH 0.1.7, 0.2.0-rc.1, the 0.2.1 alphas and DSH 0.3. */
const UNSUPPORTED_DSH_RUNTIMES = ['0.1.7-rc.2', '0.2.0-rc.1', '0.2.1-alpha.3', '0.2.1-alpha.5', '0.3.0-rc.1']

const root = join(import.meta.dirname, '..')
const manifests = [
  join(root, 'package.json'),
  ...readdirSync(join(root, 'plugins')).map(name => join(root, 'plugins', name, 'package.json')),
].map(path => JSON.parse(readFileSync(path, 'utf8')) as { name: string; version: string })
const starter = manifests[0]!

describe('DSH host compatibility', () => {
  // DSH refuses to install or load a plugin whose DSH requirements exclude its runtime; this is the check it runs.
  // DSH 0.2.1 reads `engines.dsh` alone, DSH 0.2.0 the @deepseek-ai/dsh* peers; both state the same range.
  it.each(manifests.map(manifest => [manifest.name, manifest] as const))('%s installs on every supported DSH runtime', (_name, manifest) => {
    for (const runtime of SUPPORTED_DSH_RUNTIMES) {
      expect(evaluatePluginCompatibility(manifest, {}, runtime), `${manifest.name} on DSH ${runtime}`).toBeUndefined()
    }
  })

  // The components install with the Starter, so the Starter alone states which DSH it runs on.
  it('refuses the Starter on hosts it no longer supports', () => {
    for (const runtime of UNSUPPORTED_DSH_RUNTIMES) {
      expect(evaluatePluginCompatibility(starter, {}, runtime), `dsh-mnemon on DSH ${runtime}`).toMatchObject({ name: 'dsh-mnemon', runtimeVersion: runtime })
    }
  })
})
