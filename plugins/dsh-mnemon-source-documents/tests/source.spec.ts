import { strategy } from './fixture.ts'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as plugin from '../src/index.ts'

describe('standalone documents Source', () => {
  it('manages create/read/update/search/local-archive within its selected Source store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-documents-management-'))
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'work', config: { dataDir: join(directory, 'data') } })
      const generation = runner.generations.current()!
      const base = { sourceInstanceKey: 'source:work', scope: { storage: 'custom' as const, workspaceId: workspace }, confirmed: false }
      const initial = await generation.executeManagement({ ...base, mode: 'read', operation: 'snapshot', input: null })
      const added = await generation.executeManagement({ ...base, mode: 'mutate', operation: 'mutate', confirmed: true, expectedRevision: initial.revision,
        input: { action: 'create', title: 'Managed doc', content: 'alpha sentinel' } })
      const { document } = added.value as unknown as plugin.DocumentMutationResult
      await expect(generation.executeManagement({ ...base, mode: 'mutate', operation: 'mutate', confirmed: true, expectedRevision: initial.revision,
        input: { action: 'update', id: document.id, content: 'stale' } })).rejects.toThrow('revision conflict')
      const updated = await generation.executeManagement({ ...base, mode: 'mutate', operation: 'mutate', confirmed: true, expectedRevision: added.revision,
        input: { action: 'update', id: document.id, content: 'beta sentinel' } })
      const loaded = await generation.executeManagement({ ...base, mode: 'read', operation: 'document', input: { id: document.id } })
      expect(loaded.value).toMatchObject({ content: 'beta sentinel' })
      const search = await generation.executeManagement({ ...base, mode: 'read', operation: 'search', input: { query: 'beta' } })
      expect(search.value).toMatchObject({ total: 1 })
      const archived = await generation.executeManagement({ ...base, mode: 'mutate', operation: 'archive', confirmed: true, expectedRevision: search.revision, input: { id: document.id } })
      expect(archived.value).toMatchObject({ action: 'archived', document: { status: 'archived', memoryBodyIds: [] } })
      const otherWorkspace = await generation.executeManagement({ ...base, scope: { ...base.scope, workspaceId: directory }, mode: 'read', operation: 'snapshot', input: null })
      // A configured dataDir is one explicit authority, even if a caller's cwd changes.
      expect(otherWorkspace.value).toMatchObject({ total: 1, workspaceRoot: directory })
      await expect(generation.executeManagement({ ...base, scope: { storage: 'custom' }, mode: 'read', operation: 'snapshot', input: null })).rejects.toThrow('unavailable')
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('owns storage and composes two independent configured instances with no private Host binding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-documents-plugin-'))
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
        { action: 'create', title: 'Work', content: 'work-only sentinel' }, () => true)
      expect(receipt.status).toBe('succeeded')
      first.release()
      const next = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: workspace } })
      const route = next.view.routes.find(value => value.sourceInstanceKey === 'source:work')!
      const evidence = await next.lease.generation.executeRoute(next.view, route.id, { query: 'sentinel' })
      expect(evidence.items).toHaveLength(1)
      const personal = next.view.routes.find(value => value.sourceInstanceKey === 'source:personal')!
      expect((await next.lease.generation.executeRoute(next.view, personal.id, { query: 'sentinel' })).items).toHaveLength(0)
      next.release()
    } finally {
      await runner.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails invalid configuration before publishing a Source', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      await expect(runner.mount(plugin, { instanceId: 'invalid', config: { limitBytes: -1 } })).rejects.toThrow()
      expect(runner.runtime.contributionSnapshot().sources).toHaveLength(0)
    } finally { await runner.dispose() }
  })
})
