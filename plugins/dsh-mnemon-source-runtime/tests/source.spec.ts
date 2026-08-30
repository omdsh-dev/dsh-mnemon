import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as plugin from '../src/index.ts'

const strategy = {
  inject: ['mnemonMemory'],
  apply(ctx: Context) {
    installMemory(ctx, { strategies: [defineMemoryStrategy({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'test',
        packageName: 'test-strategy', deterministic: true, supportedSourceRoles: ['working-context'],
        maxSources: 4, maxRoutes: 4, maxActions: 4 },
      compose: (_request, sources) => ({ strategyTypeId: 'test', explanation: 'Test only.',
        sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey,
          projection: { mode: 'eager', maxCharacters: 2048 }, routeIds: source.routeIds, actionIds: source.actionIds })) }),
    })] })
  },
}

describe('standalone runtime Source', () => {
  it('owns storage and composes two independent configured instances with no private Host binding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-runtime-plugin-'))
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'work', config: { dataDir: join(directory, 'work') } })
      await runner.mount(plugin, { instanceId: 'personal', config: { dataDir: join(directory, 'personal') } })
      const first = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: workspace } })
      const offer = first.view.actionOffers.find(value => value.sourceInstanceKey === 'source:work')!
      const receipt = await first.lease.generation.executeAction(first.view, offer.id,
        { action: 'add', target: 'memory', content: 'work-only sentinel' }, () => true)
      expect(receipt.status).toBe('succeeded')
      first.release()
      const next = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: workspace } })
      expect(next.view.projection.find(value => value.sourceInstanceKey === 'source:work')?.text).toContain('work-only sentinel')
      expect(next.view.projection.find(value => value.sourceInstanceKey === 'source:personal')?.text).not.toContain('work-only sentinel')
      next.release()
    } finally {
      await runner.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails invalid configuration before publishing a Source', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      await expect(runner.mount(plugin, { instanceId: 'invalid', config: { memoryLimitBytes: -1 } })).rejects.toThrow()
      expect(runner.runtime.contributionSnapshot().sources).toHaveLength(0)
    } finally { await runner.dispose() }
  })
})
