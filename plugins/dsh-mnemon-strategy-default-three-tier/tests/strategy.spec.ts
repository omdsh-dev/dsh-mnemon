import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { defineMemorySource, installMemory, type MemoryAvailableSource } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION, type MemoryStrategyContribution, type MemoryViewRequest } from 'dsh-mnemon/contracts'
import { MemoryCompositionRunner, DEFAULT_MEMORY_VIEW_BUDGET } from 'dsh-mnemon/testing'
import { threeTierActionWorkflow, validateThreeTierExtension } from '../src/extension-sdk.ts'
import * as plugin from '../src/index.ts'
import {
  BOUNDED_RUNTIME_MEMORY_PROTOCOL,
  LOCAL_ARCHIVE_RUNTIME_MEMORY_PROTOCOL,
  ROUTING_GUIDANCE,
  ROUTING_GUIDANCE_WITHOUT_RECALL,
  RUNTIME_MEMORY_PROTOCOL,
  THREE_TIER_REMINDERS,
  THREE_TIER_REMINDERS_WITHOUT_RECALL,
} from '../src/guidance.ts'

function fact(role: string, key = role): MemoryAvailableSource {
  return {
    sourceInstanceKey: `source:${key}`, sourceTypeId: key, role,
    routes: [], actions: [],
    availability: 'ready', revision: 'r1', capabilities: ['project'], routeIds: [], actionIds: [],
  }
}

describe('standalone default three-tier Strategy', () => {
  it('is deterministic and depends only on facts, not Source implementations', () => {
    const request = { scope: { storage: 'custom' as const }, scenario: 'test', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET } }
    const facts = [fact('working-context'), fact('narrative'), fact('durable-evidence')]
    const first = plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, facts)
    expect(first).toEqual(plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [...facts].reverse()))
    expect(first.sources.map(source => source.sourceInstanceKey)).toEqual(facts.map(source => source.sourceInstanceKey))
    expect(first.sources.reduce((sum, source) => sum + (source.projection?.maxCharacters ?? 0), 0)).toBeLessThanOrEqual(request.budget.maxProjectionCharacters)
  })

  it('names mnemon_recall only with recall, and archiving into Memory Spaces only with a space to write (issue 336)', () => {
    const request = { scope: { storage: 'custom' as const }, scenario: 'test', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET } }
    const layer = (role: string, sourceTypeId: string, routeIds: string[] = [], actionIds: string[] = [], activeCount?: number) => ({
      ...fact(role, sourceTypeId), routeIds, actionIds, ...(activeCount === undefined ? {} : { hints: { activeCount } }),
    })
    const runtime = layer('working-context', 'runtime')
    const documents = layer('narrative', 'documents', ['search'])
    const spaces = (routeIds: string[], actionIds: string[], activeCount?: number) => layer('durable-evidence', 'memory-spaces', routeIds, actionIds, activeCount)
    const compose = (...facts: MemoryAvailableSource[]) => plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, facts).guidance
    // With Memory Spaces to recall from and write to, the guidance is exactly what it was.
    expect(compose(runtime, documents, spaces(['inspect', 'recall'], ['manage-spaces', 'remember', 'forget'], 1)))
      .toEqual({ routing: ROUTING_GUIDANCE, reminders: THREE_TIER_REMINDERS, system: BOUNDED_RUNTIME_MEMORY_PROTOCOL })
    // Facts without hints keep it too.
    expect(compose(runtime, documents, spaces(['inspect', 'recall'], ['remember']))?.system).toBe(BOUNDED_RUNTIME_MEMORY_PROTOCOL)
    // No Provider, or no space yet: Documents routing and the write rules stay, without mnemon_recall.
    for (const memorySpaces of [spaces(['inspect'], [], 0), spaces(['inspect'], ['manage-spaces', 'remember'], 0)]) {
      const guidance = compose(runtime, documents, memorySpaces)
      expect(guidance).toEqual({ routing: ROUTING_GUIDANCE_WITHOUT_RECALL, reminders: THREE_TIER_REMINDERS_WITHOUT_RECALL, system: LOCAL_ARCHIVE_RUNTIME_MEMORY_PROTOCOL })
      expect(JSON.stringify(guidance)).not.toContain('mnemon_recall')
      expect(guidance?.routing).toContain('Search Mnemon Documents for substantial project records')
      expect(guidance?.reminders?.write).toBe(THREE_TIER_REMINDERS.write)
    }
    // Without the layer there is no three-tier routing, as before, and nothing points at Memory Spaces.
    const without = compose(runtime, documents)
    expect(without).toEqual({ system: LOCAL_ARCHIVE_RUNTIME_MEMORY_PROTOCOL })
    expect(without?.system).toContain('to a local archive file')
    expect(without?.system).toContain('budget-limited projection')
    // Recall without automatic writes archives locally; writes without recall archive into Memory Spaces.
    const recallOnly = compose(runtime, documents, spaces(['inspect', 'recall'], [], 2))
    expect(recallOnly?.routing).toBe(ROUTING_GUIDANCE)
    expect(recallOnly?.system).toContain('call mnemon_recall instead of inferring')
    expect(recallOnly?.system).toContain('to a local archive file')
    const writeOnly = compose(runtime, documents, spaces(['inspect'], ['remember'], 2))
    expect(writeOnly?.routing).toBe(ROUTING_GUIDANCE_WITHOUT_RECALL)
    expect(writeOnly?.system).not.toContain('mnemon_recall')
    expect(writeOnly?.system).toContain('into one or more semantically appropriate Memory Spaces')
    // Active spaces that only extract asynchronously cannot take an archive: it stays local.
    const asyncOnly = compose(runtime, documents, { ...spaces(['inspect', 'recall'], ['remember'], 2), hints: { activeCount: 2, archivableCount: 0 } })
    expect(asyncOnly?.system).toContain('call mnemon_recall instead of inferring')
    expect(asyncOnly?.system).toContain('to a local archive file')
  })

  it('rejects ambiguous roles instead of selecting by mount order', () => {
    expect(() => plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose({
      scope: { storage: 'custom' }, scenario: 'test', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET },
    }, [fact('working-context', 'first'), fact('working-context', 'second')])).toThrow('ambiguous')
  })

  it('mounts and composes through real Cordis and the public test runner', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(plugin, { instanceId: 'strategy' })
      expect(runner.inspect().evaluation.state).toBe('incomplete')
      const source = defineMemorySource({
        manifest: {
          apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'fixture',
          packageName: 'test-source-fixture', role: 'working-context', capabilities: ['project'], consistency: 'exact-snapshot',
        },
        create: ctx => ({
          facts: () => ({ ...fact('working-context', 'fixture'), sourceInstanceKey: ctx.sourceInstanceKey }),
          project: request => ({ fragments: [{
            id: 'fixture', sourceInstanceKey: ctx.sourceInstanceKey, mode: request.mode,
            revision: 'r1', text: 'independent fixture',
          }] }),
        }),
      })
      const unmount = await runner.mount({
        inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { sources: [source] }) },
      }, { instanceId: 'source' })
      const turn = await runner.beginTurn()
      expect(turn.view.projection[0]?.text).toBe('independent fixture')
      await unmount()
      await expect(runner.beginTurn()).rejects.toThrow('no Serving')
      expect(runner.inspect().drainingGenerationIds).toContain(turn.view.runtimeGeneration)
      turn.release()
    } finally { await runner.dispose() }
  })
})

describe('default three-tier instructions', () => {
  it('owns the unchanged runtime write protocol, separate from Source snapshots', () => {
    expect(RUNTIME_MEMORY_PROTOCOL).toContain('Manage hot memory exclusively with mnemon_runtime_memory')
    expect(RUNTIME_MEMORY_PROTOCOL).toContain('Use action="add" only for a new independent fact')
    expect(RUNTIME_MEMORY_PROTOCOL).toContain('Use action="replace" with a short unique old_text')
    expect(RUNTIME_MEMORY_PROTOCOL).toContain('Use action="remove" with a short unique old_text')
    expect(RUNTIME_MEMORY_PROTOCOL).toContain("The user's explicit request in the current turn wins over both files")
    expect(RUNTIME_MEMORY_PROTOCOL).toContain('call mnemon_recall instead of inferring or filling the gap')
    expect(ROUTING_GUIDANCE).toContain('Search Mnemon Documents for substantial project records')
    expect(THREE_TIER_REMINDERS.read).toContain('Otherwise use neither.')
    expect(THREE_TIER_REMINDERS.write).toContain('never retrieved evidence')
    expect(THREE_TIER_REMINDERS.both).toContain('Otherwise use none.')
  })
})

describe('three-tier owned extension contracts', () => {
  const strategy = plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY
  const request: MemoryViewRequest = { scope: { storage: 'custom' }, scenario: 'test', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET } }
  const roles = ['working-context', 'narrative', 'durable-evidence']
  function sources(count = 3): MemoryAvailableSource[] {
    return Array.from({ length: count }, (_, index) => ({ sourceInstanceKey: `source:${index}`, sourceTypeId: `notes-${index}`,
      role: roles[index % 3]!, availability: 'ready', revision: 'r1', capabilities: ['project', 'write'], routeIds: [], actionIds: ['append'], routes: [],
      actions: [{ id: 'append', description: 'Append.', capability: 'write', inputSchema: { type: 'object' } }] }))
  }
  function contribution(slot: string, value: MemoryStrategyContribution['value']): MemoryStrategyContribution {
    return { instanceKey: `strategy-extension:${slot}`, typeId: slot, slot, value }
  }

  it('declares the background work the Host runs for it', () => {
    expect(strategy.manifest.workflows).toEqual(['idle-review', 'runtime-capacity'])
  })

  it('owns only the Runtime capacity workflow of the selected default Strategy', () => {
    expect(threeTierActionWorkflow('default-three-tier', 'runtime', 'mutate')).toBe('runtime-capacity')
    expect(threeTierActionWorkflow('custom', 'runtime', 'mutate')).toBeUndefined()
    expect(threeTierActionWorkflow('default-three-tier', 'external-source', 'mutate')).toBeUndefined()
    expect(threeTierActionWorkflow('default-three-tier', 'runtime', 'import')).toBeUndefined()
    expect(threeTierActionWorkflow('default-three-tier', 'documents', 'create')).toBeUndefined()
  })

  it('retains default composition exactly when no extension is active', () => {
    const facts = sources()
    expect(strategy.compose(request, facts)).toEqual(strategy.compose(request, facts, []))
    const result = strategy.compose(request, facts)
    expect(result.sources.map(source => source.projection?.maxCharacters)).toEqual([58982, 3277, 3277])
    expect(result.sources.map(source => source.projection?.mode)).toEqual(['eager', 'routed', 'routed'])
    expect(result.sources.every(source => source.actionIds?.[0] === 'append')).toBe(true)
  })

  it('combines selection, projection and capture without replacing each other', () => {
    const facts = sources(6)
    const policies = [contribution('selection', { sourceKeys: facts.map(source => source.sourceInstanceKey), writableSourceKeys: ['source:5'] }),
      contribution('projection', { maxProjectionCharacters: 4096 }), contribution('capture', { instruction: 'Save qualified user facts.', actionIds: ['append'] })]
    const result = strategy.compose(request, facts, policies)
    expect(result.sources).toHaveLength(6)
    expect(result.sources.flatMap(source => source.actionIds ?? [])).toEqual(['append'])
    expect(result.sources.reduce((sum, source) => sum + (source.projection?.maxCharacters ?? 0), 0)).toBe(4096)
    expect(result.guidance?.system).toContain('Eligible Source instances: source:5')
    expect(result).toEqual(strategy.compose(request, [...facts].reverse(), [...policies].reverse()))
  })

  it('does not add capture instructions when selection or Host capabilities forbid writes', () => {
    const facts = sources()
    const capture = contribution('capture', { instruction: 'Save facts.', actionIds: ['append'] })
    const readonly = contribution('selection', { sourceKeys: facts.map(source => source.sourceInstanceKey), writableSourceKeys: [] })
    expect(strategy.compose(request, facts, [readonly, capture]).guidance?.system).toBeUndefined()
    expect(strategy.compose(request, facts.map(source => ({ ...source, actionIds: [], actions: [] })), [capture]).guidance?.system).toBeUndefined()
  })

  it('keeps runtime semantics without claiming default, narrowed or multi-Source projections are the entire store', () => {
    const facts = sources().map((source, index) => ({ ...source, sourceTypeId: ['runtime', 'documents', 'memory-spaces'][index]! }))
    const original = strategy.compose(request, facts)
    expect(original.guidance?.system).toContain('budget-limited projection')
    expect(original.guidance?.system).not.toContain('complete projection')
    const limited = strategy.compose(request, facts, [contribution('projection', { maxProjectionCharacters: 100 })])
    expect(limited.guidance?.system).toContain('budget-limited projection')
    expect(limited.guidance?.system).not.toContain('complete projection')
    const scoped = strategy.compose(request, facts, [contribution('selection', { sourceKeys: facts.map(source => source.sourceInstanceKey) })])
    expect(scoped.guidance?.system).toContain('only that Source')
    expect(scoped.guidance?.system).toContain('Read-only Sources stay read-only')
  })

  it('keeps all allocation sums finite and bounded, including tiny budgets and 32 Sources', () => {
    for (const count of [0, 1, 2, 3, 7, 16, 32]) for (const budget of [1, 2, 3, 7, 100, 4096, 10000000]) {
      const facts = sources(count)
      const value = strategy.compose({ ...request, budget: { ...request.budget, maxProjectionCharacters: budget } }, facts,
        [contribution('selection', { sourceKeys: facts.map(source => source.sourceInstanceKey) })])
      const allocations = value.sources.flatMap(source => source.projection === undefined ? [] : [source.projection.maxCharacters])
      expect(allocations.every(value => Number.isSafeInteger(value) && value > 0)).toBe(true)
      expect(allocations.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(budget)
      if (count > 0) expect(allocations.reduce((sum, value) => sum + value, 0)).toBe(budget)
    }
  })

  it('rejects unknown slots, fields, duplicate policies and missing explicit Sources', () => {
    expect(() => strategy.compose(request, sources(), [contribution('unknown', {})])).toThrow('unsupported')
    expect(() => validateThreeTierExtension('projection', { maxProjectionCharacters: 10, writes: true })).toThrow('unsupported')
    const policy = contribution('capture', { instruction: 'Capture.', actionIds: ['append'] })
    expect(() => strategy.compose(request, sources(), [policy, policy])).toThrow('duplicate')
    expect(() => strategy.compose(request, sources(), [contribution('selection', { sourceKeys: ['source:missing'] })])).toThrow('not installed')
  })

  it('reserves all pinned content within a light/scoped budget and fails visibly if the budget cannot hold it', () => {
    const facts = sources()
    facts[0]!.hints = { minimumProjectionCharacters: 99 }
    for (const selection of [[], [contribution('selection', { sourceKeys: facts.map(source => source.sourceInstanceKey) })]]) {
      const policies = [contribution('projection', { maxProjectionCharacters: 100 }), ...selection]
      const result = strategy.compose(request, facts, policies)
      expect(result.sources[0]).toMatchObject({ required: true, projection: { maxCharacters: 99 } })
      expect(result.sources.reduce((sum, source) => sum + (source.projection?.maxCharacters ?? 0), 0)).toBeLessThanOrEqual(100)
      facts[0]!.hints = { minimumProjectionCharacters: 101 }
      expect(() => strategy.compose(request, facts, policies)).toThrow('Unpin entries or increase')
      facts[0]!.hints = { minimumProjectionCharacters: 99 }
    }
  })
})
