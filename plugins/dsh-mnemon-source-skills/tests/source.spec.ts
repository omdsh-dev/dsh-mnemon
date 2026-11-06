import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as plugin from '../src/index.ts'
import { strategy } from './fixture.ts'

describe('Skills Source', () => {
  it('resolves recorded origins only through confirmed management, without offering model grants', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-skills-origin-'))
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'skills', config: { dataDir: join(directory, 'data'), dshHome: join(directory, 'dsh'), agentsHome: join(directory, 'agents') } })
      const project = await runner.managementClient('source:skills', { storage: 'global', workspaceId: workspace })
      let revision = (await project.read('revision', null)).revision
      await project.mutate('skill-create', { name: 'project-check', description: 'Check this project.', root: 'project-dsh' }, { confirmed: true, expectedRevision: revision })
      revision = (await project.read('revision', null)).revision
      const content = '---\nname: project-check\ndescription: Check this project.\n---\n\nRun project tests.\n'
      const draft = (await project.mutate('draft-record', {
        skillName: 'project-check', content, notes: '', changes: [], guidance: [],
        // Arbitrary client/model paths are not an origin-registration API.
        origin: { workspace: join(directory, 'elsewhere'), path: join(directory, 'elsewhere', 'SKILL.md') },
      }, { confirmed: true, expectedRevision: revision })).value as { id: string; origin: { path: string } }
      expect(draft.origin.path).toBe(join(workspace, '.dsh', 'skills', 'project-check', 'SKILL.md'))
      const global = await runner.managementClient('source:skills', { storage: 'global' })
      const detail = await global.read('draft', { id: draft.id })
      expect(detail.value).toMatchObject({ base: { path: draft.origin.path } })
      await expect(runner.executeManagement({ sourceInstanceKey: 'source:skills', scope: { storage: 'global' }, mode: 'mutate', operation: 'draft-adopt', input: { id: draft.id }, confirmed: false, expectedRevision: detail.revision })).rejects.toThrow(/confirmation/u)
      await expect(global.mutate('draft-adopt', { id: draft.id }, { confirmed: true, expectedRevision: 'stale' })).rejects.toThrow(/revision conflict/u)
      const turn = await runner.beginTurn({ scope: { storage: 'global' } })
      try {
        expect(turn.view.readGrants).toEqual([])
        expect(turn.view.routes).toEqual([])
        expect(turn.view.actionOffers).toEqual([])
      } finally { turn.release() }
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('manages skills through the protocol and never joins a model View', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-skills-source-'))
    const workspace = join(directory, 'workspace')
    mkdirSync(join(directory, 'dsh', 'skills', 'pdf'), { recursive: true })
    mkdirSync(workspace)
    writeFileSync(join(directory, 'dsh', 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Make PDFs.\n---\n\nSteps.\n')
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'skills', config: { dataDir: join(directory, 'data'), dshHome: join(directory, 'dsh'), agentsHome: join(directory, 'agents') } })
      const base = { sourceInstanceKey: 'source:skills', scope: { storage: 'custom' as const, workspaceId: workspace }, confirmed: false }
      const catalog = await runner.executeManagement({ ...base, mode: 'read', operation: 'catalog', input: null })
      expect(catalog.value).toMatchObject({ skills: [{ key: 'user-dsh:pdf', name: 'pdf', invocation: { modelInvocable: true, userInvocable: true } }] })
      const skill = (catalog.value as { skills: Array<{ hash: string }> }).skills[0]!
      await expect(runner.executeManagement({ ...base, mode: 'mutate', operation: 'skill-invocation', confirmed: true, expectedRevision: 'stale',
        input: { key: 'user-dsh:pdf', modelInvocable: false, userInvocable: true, expectedHash: skill.hash } })).rejects.toThrow('revision conflict')
      const toggled = await runner.executeManagement({ ...base, mode: 'mutate', operation: 'skill-invocation', confirmed: true, expectedRevision: catalog.revision,
        input: { key: 'user-dsh:pdf', modelInvocable: false, userInvocable: true, expectedHash: skill.hash } })
      expect(toggled.value).toMatchObject({ invocation: { modelInvocable: false, userInvocable: true } })
      expect(toggled.revision).not.toBe(catalog.revision)
      for (const key of ['allowCreate', 'allowUpdate']) {
        await expect(runner.executeManagement({ ...base, mode: 'mutate', operation: 'review-record', confirmed: true, expectedRevision: toggled.revision,
          input: {
            policy: { [key]: 'false' },
            review: { at: '2026-10-26T00:00:00Z', sessionId: 'test', outcome: 'nothing', trigger: 'manual', durationMs: 0 },
            trajectory: { sessionId: 'test', startedAt: '2026-10-26T00:00:00Z', endedAt: '2026-10-26T00:00:00Z', steps: [], stats: { turns: 0, userCharacters: 0, toolCalls: 0, toolFailures: 0, uniqueTools: 0, skills: [] } },
            suggestions: [], cases: [], annotations: [],
          } })).rejects.toThrow('must be a boolean')
      }
      // Settings are the Host's: the Source has none of its own to change.
      await expect(runner.executeManagement({ ...base, mode: 'mutate', operation: 'settings-update', confirmed: true, expectedRevision: toggled.revision, input: { patch: { minConfidence: 0.9 } } })).rejects.toThrow()
      await expect(runner.executeManagement({ ...base, mode: 'read', operation: 'nope', input: null })).rejects.toThrow('unsupported Skills read operation')
      const turn = await runner.beginTurn({ scope: base.scope })
      try {
        expect(turn.view.routes).toEqual([])
        expect(turn.view.actionOffers).toEqual([])
      } finally { turn.release() }
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })
})
