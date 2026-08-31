import { strategy } from './fixture.ts'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as plugin from '../src/index.ts'

describe('standalone runtime Source', () => {
  it('owns capacity planning and revision-fenced compaction behind its management protocol', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-runtime-maintenance-'))
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'work', config: { dataDir: directory, memoryLimitBytes: 256 } })
      const base = { sourceInstanceKey: 'source:work', scope: { storage: 'custom' as const }, confirmed: true }
      const current = () => runner.executeManagement({ ...base, mode: 'read', operation: 'snapshot', input: null })
      await runner.executeManagement({ ...base, mode: 'mutate', operation: 'mutate', expectedRevision: (await current()).revision,
        input: { action: 'add', target: 'memory', content: 'A'.repeat(180) } })
      const mutation = { action: 'add', target: 'memory', content: 'B'.repeat(100) }
      await expect(runner.executeManagement({ ...base, mode: 'mutate', operation: 'mutate', expectedRevision: (await current()).revision, input: mutation })).rejects.toMatchObject({ code: 'runtime-capacity' })
      const planned = await runner.executeManagement({ ...base, mode: 'read', operation: 'maintenance-plan', input: mutation })
      const plan = planned.value as unknown as plugin.RuntimeMemoryMaintenancePlan
      expect(plan.requiresMaintenance).toBe(true)
      const input = { revision: plan.revision, mutation, compacted: [{ content: 'A summary', importance: 'normal' }], maxBytes: 100 }
      await runner.executeManagement({ ...base, mode: 'mutate', operation: 'compact-and-mutate', expectedRevision: planned.revision, input })
      await expect(runner.executeManagement({ ...base, mode: 'mutate', operation: 'compact-and-mutate', expectedRevision: (await current()).revision, input })).rejects.toMatchObject({ code: 'revision-conflict' })
      expect((await current()).value).toMatchObject({ entries: [{ content: 'A summary' }, { content: 'B'.repeat(100) }] })
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('serves its own management protocol with confirmation, revision fencing and legacy input compatibility', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-runtime-management-'))
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'work', config: { dataDir: directory } })
      const scope = { storage: 'custom' as const }
      const base = { sourceInstanceKey: 'source:work', scope, confirmed: false }
      const initial = await runner.executeManagement({ ...base, mode: 'read', operation: 'snapshot', input: null })
      const create = { ...base, mode: 'mutate' as const, operation: 'mutate', expectedRevision: initial.revision,
        input: { action: 'add', target: 'memory', content: 'managed entry' } }
      await expect(runner.executeManagement(create)).rejects.toThrow('confirmation')
      const added = await runner.executeManagement({ ...create, confirmed: true })
      await expect(runner.executeManagement({ ...create, confirmed: true })).rejects.toThrow('revision conflict')
      const replaced = await runner.executeManagement({ ...create, confirmed: true, expectedRevision: added.revision,
        input: { action: 'replace', target: 'memory', old_text: 'managed entry', content: 'replaced entry' } })
      await runner.executeManagement({ ...create, confirmed: true, expectedRevision: replaced.revision,
        input: { action: 'remove', target: 'memory', old_text: 'replaced entry' } })
      const final = await runner.executeManagement({ ...base, mode: 'read', operation: 'snapshot', input: null })
      expect(final.value).toMatchObject({ entries: [] })
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

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
      const receipt = await first.executeAction(offer.id,
        { action: 'add', target: 'memory', content: 'work-only sentinel' }, () => true)
      expect(receipt.status).toBe('succeeded')
      expect(receipt.completion).toBe('committed')
      expect(receipt.committedAt).toEqual(expect.any(String))
      first.release()
      const next = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: workspace } })
      expect(next.view.projection.find(value => value.sourceInstanceKey === 'source:work')?.text).toContain('work-only sentinel')
      expect(next.view.routes).toEqual([]) // Working context does not imply a summary tree or full-history reader.
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
      expect(runner.inspect().evaluation.sourceInstanceKeys).toHaveLength(0)
    } finally { await runner.dispose() }
  })
})
