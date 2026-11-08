import { strategy } from './fixture.ts'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_MEMORY_VIEW_BUDGET } from 'dsh-mnemon/contracts'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as plugin from '../src/index.ts'
import { RuntimeMemoryController } from '../src/controller.ts'

describe('standalone runtime Source', () => {
  it('owns stable scope and visible-entry digests, separating additions and ages from retractions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-runtime-snapshot-scope-'))
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    execFileSync('git', ['init', '--quiet', '-b', 'main', workspace])
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-08-12T08:00:00.000Z'))
      const controller = new RuntimeMemoryController({ effectiveDataDir: () => directory })
      await controller.mutate({ action: 'add', target: 'memory', content: 'Original fact.', importance: 'critical' })
      const sourceInstanceKey = 'source:work'
      const source = plugin.createRuntimeMemorySource({ dataDir: directory }).create({ sourceInstanceKey,
        provenance: { packageName: plugin.name, entryId: 'work' } })
      const project = async (maxCharacters = 2048) => {
        const scope = { storage: 'custom' as const, workspaceId: workspace }
        const facts = await source.facts({ scope, scenario: 'turn', budget: DEFAULT_MEMORY_VIEW_BUDGET })
        return source.project({ scope, sourceInstanceKey, expectedRevision: facts.revision, includeProjection: true, mode: 'eager', maxCharacters })
      }
      const metadata = (value: Awaited<ReturnType<typeof project>>) =>
        (value.fragments[0]!.provenance as { snapshot: { version: number; scope: string; entries: string[] } }).snapshot
      const first = await project()
      expect(metadata(first)).toEqual({ version: 1, scope: expect.stringMatching(/^[a-f0-9]{64}$/u), entries: [expect.stringMatching(/^[a-f0-9]{64}$/u)] })
      vi.setSystemTime(new Date('2026-08-13T08:00:00.000Z'))
      const aged = await project()
      expect(aged.fragments[0]!.text).not.toBe(first.fragments[0]!.text)
      expect(metadata(aged)).toEqual(metadata(first))
      await controller.mutate({ action: 'add', target: 'memory', content: 'Additional fact.' })
      const added = metadata(await project())
      expect(added.scope).toBe(metadata(first).scope)
      expect(added.entries).toHaveLength(2)
      expect(added.entries).toContain(metadata(first).entries[0])
      await controller.mutate({ action: 'replace', target: 'memory', oldText: 'Original fact.', content: 'Corrected fact.' })
      const corrected = metadata(await project())
      expect(corrected.entries).not.toContain(metadata(first).entries[0])
      execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/other'], { cwd: workspace })
      const other = metadata(await project())
      expect(other.entries).toEqual(corrected.entries)
      expect(other.scope).not.toBe(corrected.scope)
      expect((await project(20)).fragments[0]!.provenance).not.toHaveProperty('snapshot')
    } finally {
      vi.useRealTimers()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('pins metadata and content together between facts and projection across an age boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-runtime-age-'))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-08-12T08:00:00.000Z'))
      const controller = new RuntimeMemoryController({ effectiveDataDir: () => directory })
      await controller.mutate({ action: 'add', target: 'memory', content: 'Original fact.', importance: 'critical' })
      const sourceInstanceKey = 'source:work'
      const source = plugin.createRuntimeMemorySource({ dataDir: directory }).create({ sourceInstanceKey,
        provenance: { packageName: plugin.name, entryId: 'work' } })
      const scope = { storage: 'custom' as const }
      const request = { scope, scenario: 'turn', budget: DEFAULT_MEMORY_VIEW_BUDGET }
      vi.setSystemTime(new Date('2026-08-13T07:59:59.999Z'))
      const facts = await source.facts(request)
      vi.setSystemTime(new Date('2026-08-13T08:00:00.000Z'))
      await controller.mutate({ action: 'replace', target: 'memory', oldText: 'Original fact.', content: 'Corrected fact.', importance: 'low' })
      const project = { scope, sourceInstanceKey, expectedRevision: facts.revision, includeProjection: true, mode: 'eager' as const, maxCharacters: 2048 }
      const pinned = await source.project(project)
      expect(pinned.fragments[0]?.text).toContain('[importance=critical]\nOriginal fact.')
      expect(pinned.fragments[0]?.text).not.toContain('Corrected fact.')

      const nextScope = { ...scope }
      const nextFacts = await source.facts({ ...request, scope: nextScope })
      const next = await source.project({ ...project, scope: nextScope, expectedRevision: nextFacts.revision })
      expect(next.fragments[0]?.text).toContain('[importance=low; created=1d]\nCorrected fact.')
      expect(next.fragments[0]?.revision).not.toBe(pinned.fragments[0]?.revision)
      expect(next.presentation?.items).toMatchObject([{ title: 'Corrected fact.' }])
    } finally {
      vi.useRealTimers()
      rmSync(directory, { recursive: true, force: true })
    }
  })

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
      await (await runner.managementClient('source:work')).mutate('mutate',
        { action: 'add', target: 'memory', content: 'EGO_LINUX_CHROME' }, { confirmed: true })
      const initial = await runner.executeManagement({ ...base, mode: 'read', operation: 'snapshot', input: null })
      const create = { ...base, mode: 'mutate' as const, operation: 'mutate', expectedRevision: initial.revision,
        input: { action: 'add', target: 'memory', content: 'X' } }
      await expect(runner.executeManagement(create)).rejects.toThrow('confirmation')
      const added = await runner.executeManagement({ ...create, confirmed: true })
      await expect(runner.executeManagement({ ...create, confirmed: true })).rejects.toThrow('revision conflict')
      const replace = { ...create, expectedRevision: added.revision,
        input: { action: 'replace', target: 'memory', old_text: 'X', content: 'LINUX' } }
      await expect(runner.executeManagement(replace)).rejects.toThrow('confirmation')
      const replaced = await runner.executeManagement({ ...replace, confirmed: true })
      await expect(runner.executeManagement({ ...replace, confirmed: true })).rejects.toThrow('revision conflict')
      await runner.executeManagement({ ...create, confirmed: true, expectedRevision: replaced.revision,
        input: { action: 'remove', target: 'memory', old_text: 'LINUX' } })
      const final = await runner.executeManagement({ ...base, mode: 'read', operation: 'snapshot', input: null })
      expect(final.value).toMatchObject({ entries: [{ content: 'EGO_LINUX_CHROME' }] })
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
      expect(next.view.projection.find(value => value.sourceInstanceKey === 'source:work')?.text)
        .toContain('<runtime-memory-file name="MEMORY.md">\nwork-only sentinel')
      expect(next.view.sourcePresentations?.find(value => value.sourceInstanceKey === 'source:work')).toMatchObject({
        mode: 'eager', visibleItems: 1, totalItems: 1, items: [{ title: 'work-only sentinel' }],
      })
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

it('keeps complete pins before ordinary USER content and rejects a projection smaller than its pin reservation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mnemon-runtime-pin-projection-'))
  try {
    const controller = new RuntimeMemoryController({ effectiveDataDir: () => directory })
    await controller.mutate({ action: 'add', target: 'user', content: 'ordinary user '.repeat(120) })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Pinned working rule.' })
    await controller.setPinned('memory', 'Pinned working rule.', true)
    const sourceInstanceKey = 'source:pin'
    const source = plugin.createRuntimeMemorySource({ dataDir: directory }).create({ sourceInstanceKey, provenance: { packageName: plugin.name, entryId: 'pin' } })
    const scope = { storage: 'custom' as const }
    const facts = await source.facts({ scope, scenario: 'turn', budget: DEFAULT_MEMORY_VIEW_BUDGET })
    const minimum = (facts.hints as { minimumProjectionCharacters: number }).minimumProjectionCharacters
    const request = { scope, sourceInstanceKey, expectedRevision: facts.revision, includeProjection: true, mode: 'eager' as const, maxCharacters: minimum }
    const projected = await source.project(request)
    expect(projected.fragments[0]!.text).toContain('Pinned working rule.')
    expect(projected.fragments[0]!.text).not.toContain('ordinary user')
    await expect(Promise.resolve().then(() => source.project({ ...request, maxCharacters: minimum - 1 }))).rejects.toThrow('were not truncated')
    await expect(source.manage!({ scope, sourceInstanceKey, expectedRevision: facts.revision, mode: 'mutate', operation: 'pin', confirmed: false, input: { target: 'memory', content: 'Pinned working rule.', pinned: false } })).rejects.toThrow('confirmation')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
