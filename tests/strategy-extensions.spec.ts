import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  ANY_MEMORY_STRATEGY,
  COMPOSABLE_MEMORY_API_VERSION,
  MEMORY_STRATEGY_WORKFLOWS,
  type MemoryJsonValue,
  type MemorySourceDefinition,
  type MemoryStrategyDefinition,
  type MemoryStrategyExtensionDefinition,
  type MemoryStrategyManifest,
} from 'dsh-mnemon/contracts'
import {
  createMemoryMutationReceipt,
  defineMemorySource,
  defineMemoryStrategy,
  defineMemoryStrategyConfiguration,
  defineMemoryStrategyExtension,
  defineMemoryViewExtension,
  installMemory,
  memoryViewExtensionValues,
  validateMemoryViewExtension,
  type MemoryStrategyConfiguration,
} from 'dsh-mnemon/extension-sdk'
import { DEFAULT_MEMORY_VIEW_BUDGET, MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as documents from 'dsh-mnemon-source-documents'
import type { DocumentMutationResult } from 'dsh-mnemon-source-documents/contracts'
import type { RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'
import * as capture from 'dsh-mnemon-strategy-auto-capture'
import * as lightPlugin from 'dsh-mnemon-strategy-light-context'
import * as scoped from 'dsh-mnemon-strategy-scoped'
import type { HostAgent, HostContextShape, HostSubagentsService, ToolDefinition } from '../src/host/dsh.ts'
import { agentScope } from '../src/host/runtime.ts'
import { runtimeCapacityWrite, strategyDrives, viewStrategy } from '../src/host/strategy-workflows.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { modelMemoryWake } from '../src/host/view-presentation.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { sessionLog } from './fixtures/session-log.ts'

function plugin(contribution: Parameters<typeof installMemory>[1]) {
  return { inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, contribution) } }
}

function source(onWrite = vi.fn(), failFactory = () => false): MemorySourceDefinition {
  return defineMemorySource({
    manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'notes', packageName: 'dsh-mnemon-source-notes',
      role: 'notes', capabilities: ['project', 'write'], consistency: 'exact-snapshot',
      actions: [{ id: 'append', capability: 'write', description: 'Append a note.', inputSchema: { type: 'string' } }] },
    create(context) {
      if (failFactory()) throw new Error('factory unavailable')
      return {
        facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'notes', role: 'notes', availability: 'ready',
          revision: 'r1', capabilities: ['project', 'write'], routeIds: [], actionIds: ['append'] }),
        project: request => ({ fragments: request.includeProjection ? [{ id: 'note', sourceInstanceKey: context.sourceInstanceKey,
          mode: request.mode, text: 'A durable note.'.slice(0, request.maxCharacters), revision: 'r1' }] : [] }),
        mutate: async request => {
          onWrite(request.input)
          return createMemoryMutationReceipt(request.view.id, request.offer.id, context.sourceInstanceKey, 'r2', request.input, 'committed')
        },
      }
    },
  })
}

const base: MemoryStrategyDefinition = defineMemoryStrategy({
  manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'base', packageName: 'dsh-mnemon-strategy-base',
    deterministic: true, supportedSourceRoles: ['notes'], maxSources: 10, maxRoutes: 10, maxActions: 10,
    extensionSlots: ['selection', 'projection', 'guidance'] },
  compose(request, sources, contributions = []) {
    const selection = contributions.find(item => item.slot === 'selection')?.value
    const selected = sources.filter(item => !Array.isArray(selection) || selection.includes(item.sourceInstanceKey))
    const projection = contributions.find(item => item.slot === 'projection')?.value
    const guidance = contributions.find(item => item.slot === 'guidance')?.value
    const characters = Math.floor(Math.min(request.budget.maxProjectionCharacters, typeof projection === 'number' ? projection : Infinity) / Math.max(1, selected.length))
    return { strategyTypeId: 'base', explanation: 'One View from independent, Strategy-owned slots.',
      sources: selected.map(item => ({ sourceInstanceKey: item.sourceInstanceKey,
        ...(characters > 0 ? { projection: { mode: 'eager' as const, maxCharacters: characters } } : {}), actionIds: item.actionIds })),
      ...(typeof guidance === 'string' ? { guidance: { routing: guidance } } : {}),
    }
  },
})

function extension(typeId: string, slot: string, value: MemoryJsonValue | (() => MemoryJsonValue), target = 'base'): MemoryStrategyExtensionDefinition {
  return defineMemoryStrategyExtension({
    manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy-extension', typeId,
      packageName: `dsh-mnemon-strategy-${typeId}`, strategyTypeId: target, slot, deterministic: true },
    contribute: typeof value === 'function' ? value : () => value,
  })
}

async function fixture(options: ConstructorParameters<typeof MemoryCompositionRunner>[0] = {}, definition = source()) {
  const runner = new MemoryCompositionRunner({ strategyTypeId: 'base', ...options })
  await runner.mount(plugin({ sources: [definition] }), { instanceId: 'notes' })
  await runner.mount(plugin({ strategies: [base] }), { instanceId: 'base' })
  return runner
}

describe('additive Strategy plugins through the public Cordis SDK', () => {
  it('enables three independent contributions without changing the selected Strategy and removes only its own effect', async () => {
    const write = vi.fn()
    const runner = await fixture({}, source(write))
    try {
      const baseline = await runner.beginTurn()
      await runner.mount(plugin({ strategyExtensions: [extension('scope', 'selection', ['source:notes'])] }), { instanceId: 'scope' })
      const unloadLight = await runner.mount(plugin({ strategyExtensions: [extension('light', 'projection', 4)] }), { instanceId: 'light' })
      await runner.mount(plugin({ strategyExtensions: [extension('capture', 'guidance', 'Capture qualified facts through authorized actions.')] }), { instanceId: 'capture' })
      const composed = await runner.beginTurn()
      expect(composed.view.strategyTypeId).toBe('base')
      expect(composed.view.strategyExtensions).toHaveLength(3)
      expect(composed.view.projection[0]?.text).toBe('A du')
      expect(composed.view.guidance?.routing).toContain('Capture qualified')
      expect(write).not.toHaveBeenCalled()
      await unloadLight()
      const after = await runner.beginTurn()
      expect(after.view.strategyExtensions?.map(item => item.slot).sort()).toEqual(['guidance', 'selection'])
      expect(after.view.projection).toEqual(baseline.view.projection)
      expect(after.view.guidance).toEqual(composed.view.guidance)
      expect(composed.view.projection[0]?.text).toBe('A du')
      expect(runner.inspect().drainingGenerationIds).toContain(composed.view.runtimeGeneration)
      composed.release()
      after.release()
      baseline.release()
    } finally { await runner.dispose() }
  })

  it('produces the same View regardless of plugin installation order', async () => {
    const values = [extension('scope', 'selection', ['source:notes']), extension('light', 'projection', 8), extension('capture', 'guidance', 'Capture.')]
    async function view(order: number[]) {
      const runner = await fixture()
      try {
        for (const index of order) await runner.mount(plugin({ strategyExtensions: [values[index]!] }), { instanceId: `policy-${index}` })
        const turn = await runner.beginTurn()
        const { createdAt: _, ...result } = turn.view
        turn.release()
        return result
      } finally { await runner.dispose() }
    }
    expect(await view([0, 1, 2])).toEqual(await view([2, 0, 1]))
  })

  it('accepts contributions mounted before their owning Strategy', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(plugin({ strategyExtensions: [extension('light', 'projection', 3)] }), { instanceId: 'light' })
      expect(runner.inspect().evaluation.state).toBe('incomplete')
      await runner.mount(plugin({ sources: [source()], strategies: [base] }), { instanceId: 'product' })
      const turn = await runner.beginTurn()
      expect(turn.view.projection[0]?.text).toBe('A d')
      turn.release()
    } finally { await runner.dispose() }
  })

  it('rejects a colliding batch atomically and leaves the active plugin and Serving generation intact', async () => {
    const runner = await fixture()
    try {
      await runner.mount(plugin({ strategyExtensions: [extension('first', 'projection', 5)] }), { instanceId: 'first' })
      const serving = runner.inspect().servingGenerationId
      await expect(runner.mount(plugin({ strategyExtensions: [extension('second', 'projection', 2), extension('also', 'guidance', 'Must not leak.')] }), { instanceId: 'collision' })).rejects.toThrow('slot conflict')
      expect(runner.inspect().servingGenerationId).toBe(serving)
      const turn = await runner.beginTurn()
      expect(turn.view.strategyExtensions?.map(item => item.typeId)).toEqual(['first'])
      expect(turn.view.guidance).toBeUndefined()
      turn.release()
    } finally { await runner.dispose() }
  })

  it('reports unsupported slots without replacing the previously valid generation', async () => {
    const runner = await fixture()
    try {
      const serving = runner.inspect().servingGenerationId
      const unload = await runner.mount(plugin({ strategyExtensions: [extension('unknown', 'unrecognized', null)] }), { instanceId: 'unknown' })
      expect(runner.inspect()).toMatchObject({ servingGenerationId: serving, evaluation: { state: 'rejected', diagnostics: [{ message: expect.stringContaining('does not support extension slot') }] } })
      await unload()
      expect(runner.inspect().evaluation.state).toBe('ready')
    } finally { await runner.dispose() }
  })

  it('does not run or silently retarget contributions intended for a different complete Strategy', async () => {
    const contribute = vi.fn(() => 'Not active here.')
    const runner = await fixture()
    try {
      await runner.mount(plugin({ strategyExtensions: [extension('other', 'guidance', contribute, 'another')] }), { instanceId: 'other' })
      expect(runner.inspect().evaluation.diagnostics).toMatchObject([{ code: 'strategy-extension-inactive', contributionInstanceKey: 'strategy-extension:other' }])
      const turn = await runner.beginTurn()
      expect(turn.view.strategyExtensions).toBeUndefined()
      expect(contribute).not.toHaveBeenCalled()
      turn.release()
    } finally { await runner.dispose() }
  })

  it('rejects non-deterministic and non-JSON contributions before projecting a View', async () => {
    const runner = await fixture()
    let count = 0
    try {
      const unload = await runner.mount(plugin({ strategyExtensions: [extension('random', 'projection', () => ++count)] }), { instanceId: 'random' })
      await expect(runner.beginTurn()).rejects.toThrow('not deterministic')
      await unload()
      await runner.mount(plugin({ strategyExtensions: [extension('invalid', 'projection', () => new Date() as never)] }), { instanceId: 'invalid' })
      await expect(runner.beginTurn()).rejects.toThrow('non-JSON object')
    } finally { await runner.dispose() }
  })

  it('keeps one projection budget across multiple Sources', async () => {
    const runner = await fixture()
    try {
      await runner.mount(plugin({ sources: [source()] }), { instanceId: 'second' })
      await runner.mount(plugin({ strategyExtensions: [extension('light', 'projection', 100)] }), { instanceId: 'light' })
      const turn = await runner.beginTurn({ budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxProjectionCharacters: 7 } })
      expect(turn.view.projection).toHaveLength(2)
      expect(turn.view.projection.reduce((sum, item) => sum + item.text.length, 0)).toBe(6)
      turn.release()
    } finally { await runner.dispose() }
  })

  it('cannot grant writes through guidance and still requires actual Host authorization', async () => {
    const write = vi.fn()
    const runner = await fixture({}, source(write))
    const readonly = await fixture({ sourceCapabilities: () => ['project'] }, source(write))
    try {
      for (const target of [runner, readonly]) await target.mount(plugin({ strategyExtensions: [extension('capture', 'guidance', 'Write a note.')] }), { instanceId: 'capture' })
      const turn = await runner.beginTurn()
      const readOnlyTurn = await readonly.beginTurn()
      expect(readOnlyTurn.view.actionOffers).toEqual([])
      await expect(turn.executeAction(turn.view.actionOffers[0]!.id, 'new fact', () => false)).rejects.toThrow()
      expect(write).not.toHaveBeenCalled()
      expect((await turn.executeAction(turn.view.actionOffers[0]!.id, 'new fact', () => true)).completion).toBe('committed')
      expect(write).toHaveBeenCalledExactlyOnceWith('new fact')
      turn.release()
      readOnlyTurn.release()
    } finally { await runner.dispose(); await readonly.dispose() }
  })

  it('does not revive a removed policy if the replacement Source generation cannot start', async () => {
    let fail = false
    const runner = await fixture({}, source(vi.fn(), () => fail))
    try {
      const unload = await runner.mount(plugin({ strategyExtensions: [extension('light', 'projection', 3)] }), { instanceId: 'light' })
      const pinned = await runner.beginTurn()
      fail = true
      await unload()
      expect(runner.inspect().servingGenerationId).toBeUndefined()
      await expect(runner.beginTurn()).rejects.toThrow('no Serving')
      expect(pinned.view.strategyExtensions).toHaveLength(1)
      pinned.release()
    } finally { await runner.dispose() }
  })

  it('rejects oversized contributions and releases failed composition leases', async () => {
    const runner = await fixture()
    try {
      await runner.mount(plugin({ strategyExtensions: [extension('large', 'guidance', 'x'.repeat(64_001))] }), { instanceId: 'large' })
      await expect(runner.beginTurn()).rejects.toThrow('exceeds 64000')
      expect(runner.inspect().drainingGenerationIds).toEqual([])
    } finally { await runner.dispose() }
  })

  it('passes immutable, permission-filtered facts instead of Source objects to extensions', async () => {
    const runner = await fixture({ sourceCapabilities: () => ['project'] })
    const contribute = vi.fn((request, facts) => {
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(facts)).toBe(true)
      expect(facts[0].actionIds).toEqual([])
      expect(facts[0].actions).toEqual([])
      expect('create' in facts[0]).toBe(false)
      expect('mutate' in facts[0]).toBe(false)
      return 6
    })
    try {
      const definition = defineMemoryStrategyExtension({ ...extension('bounded', 'projection', 6), contribute })
      await runner.mount(plugin({ strategyExtensions: [definition] }), { instanceId: 'bounded' })
      const turn = await runner.beginTurn()
      expect(contribute).toHaveBeenCalledTimes(2)
      turn.release()
    } finally { await runner.dispose() }
  })

  it('captures returned values before replay so a reused mutable result cannot hide nondeterminism', async () => {
    const runner = await fixture()
    const value: MemoryJsonValue[] = []
    try {
      await runner.mount(plugin({ strategyExtensions: [extension('mutable', 'selection', () => { value.push('source:notes'); return value })] }), { instanceId: 'mutable' })
      await expect(runner.beginTurn()).rejects.toThrow('not deterministic')
    } finally { await runner.dispose() }
  })
})

describe('Strategy configuration author contract', () => {
  const label = { en: 'Test', 'zh-CN': '测试' }
  const strategy = defineMemoryStrategy({
    manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'test', packageName: 'dsh-mnemon-strategy-test',
      deterministic: true, supportedSourceRoles: ['working-context'], maxSources: 1, maxRoutes: 1, maxActions: 1 },
    compose: () => ({ strategyTypeId: 'test', explanation: 'Test configuration.', sources: [] }),
  })
  const definition = (): Omit<MemoryStrategyConfiguration, 'apiVersion'> => ({
    kind: 'strategy', typeId: 'test', label: { ...label }, description: { ...label },
    fields: [
      { key: 'budget', input: 'number', label: { ...label }, defaultValue: 512, minimum: 1, maximum: 4096 },
      { key: 'sources', input: 'source-list', label: { ...label } },
      { key: 'instruction', input: 'textarea', label: { ...label } },
    ],
    create: () => ({ strategies: [strategy] }),
  })

  it.each([
    { label: { en: { invalid: true }, 'zh-CN': '错误' } },
    { fields: [{ key: 'v', input: 'text', label: { en: 'Missing Chinese label' } }] },
    { fields: [{ key: 'v', input: 'source-list', label, sourceRoles: {} }] },
    { fields: [{ key: 'v', input: 'number', label, defaultValue: 'invalid' }] },
    { fields: [{ key: 'v', input: 'number', label, defaultValue: () => 100 }] },
    { fields: [{ key: 'v', input: 'number', label, defaultValue: 3.5 }] },
    { fields: [{ key: 'v', input: 'text', label }, { key: 'v', input: 'text', label }] },
  ])('rejects malformed metadata at definition time (%#)', overrides => {
    expect(() => defineMemoryStrategyConfiguration({ ...definition(), ...overrides } as never)).toThrow()
  })

  it.each([
    { budget: 0 }, { budget: 1.5 }, { budget: 4097 },
    { sources: ['source:work', 'source:work'] },
    { sources: [''] }, { sources: Array.from({ length: 33 }, (_, i) => 'source:' + i) },
    { instruction: 'x'.repeat(4001) }, { unknown: true },
  ])('rejects invalid input before calling the factory (%#)', input => {
    const create = vi.fn(definition().create)
    const configured = defineMemoryStrategyConfiguration({ ...definition(), create })
    expect(() => configured.create(input)).toThrow()
    expect(create).not.toHaveBeenCalled()
  })

  it('validates a snapshot without applying defaults or invoking a factory during discovery', () => {
    const original = definition()
    const create = vi.fn(original.create)
    const configured = defineMemoryStrategyConfiguration({ ...original, create })
    expect(create).not.toHaveBeenCalled()
    original.label.en = 'Changed later'
    original.fields[0]!.maximum = 0
    expect(configured.label.en).toBe('Test')
    expect(() => { configured.fields[0]!.maximum = 0 }).toThrow()
    expect(configured.create({})).toEqual({ strategies: [strategy] })
    expect(create).toHaveBeenCalledWith({})
    expect(configured.create({ budget: 512 })).toEqual({ strategies: [strategy] })
  })

  it.each([
    null,
    {},
    { strategies: [strategy, strategy] },
    { strategyExtensions: [{ manifest: { kind: 'strategy-extension', typeId: 'test' } }] },
    { strategies: [{ ...strategy, manifest: { ...strategy.manifest, typeId: 'another' } }] },
    { strategies: [strategy], sources: [{}] },
  ])('rejects a factory that does not return its declared contribution (%#)', contribution => {
    const configured = defineMemoryStrategyConfiguration({ ...definition(), create: () => contribution as never })
    expect(() => configured.create({})).toThrow('Plugin factory')
  })
})

describe('Strategy workflow declarations and Host dispatch', () => {
  const manifest: MemoryStrategyManifest = {
    apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'personal-notes', packageName: 'personal-notes-strategy',
    deterministic: true, supportedSourceRoles: ['*'], maxSources: 4, maxRoutes: 4, maxActions: 4,
  }
  const define = (value: Partial<MemoryStrategyManifest> & Record<string, unknown>) => defineMemoryStrategy({
    manifest: { ...manifest, ...value } as MemoryStrategyManifest,
    compose: () => ({ strategyTypeId: manifest.typeId, sources: [], explanation: 'none' }),
  })

  it('names the workflows a Host can run', () => {
    expect(MEMORY_STRATEGY_WORKFLOWS).toEqual(['idle-review', 'runtime-capacity'])
  })

  it('keeps what a Strategy declares, and nothing when it declares nothing', () => {
    expect(define({ workflows: ['runtime-capacity', 'idle-review'] }).manifest.workflows).toEqual(['runtime-capacity', 'idle-review'])
    expect(define({ workflows: [] }).manifest.workflows).toEqual([])
    expect('workflows' in define({}).manifest).toBe(false)
  })

  it('rejects a malformed or repeated workflow id but loads one this Core does not know', () => {
    expect(() => define({ workflows: ['Idle Review'] as never })).toThrow(/memory Strategy workflow/)
    expect(() => define({ workflows: 'idle-review' as never })).toThrow(/workflows must be a list/)
    expect(() => define({ workflows: ['idle-review', 'idle-review'] })).toThrow(/duplicated: idle-review/)
    const newer = define({ workflows: ['idle-review', 'nightly-digest'] as never })
    expect(newer.manifest.workflows).toEqual(['idle-review', 'nightly-digest'])
    expect(strategyDrives(newer.manifest, 'idle-review')).toBe(true)
    expect(strategyDrives(newer.manifest, 'runtime-capacity')).toBe(false)
  })

  it('follows the declaration, for the Layered strategy too', () => {
    expect(strategyDrives({ typeId: 'personal-notes', workflows: ['idle-review'] }, 'idle-review')).toBe(true)
    expect(strategyDrives({ typeId: 'personal-notes', workflows: ['idle-review'] }, 'runtime-capacity')).toBe(false)
    expect(strategyDrives({ typeId: 'default-three-tier', workflows: ['runtime-capacity'] }, 'idle-review')).toBe(false)
    expect(strategyDrives({ typeId: 'default-three-tier', workflows: [] }, 'runtime-capacity')).toBe(false)
  })

  it('reads an undeclared Layered strategy, as a copy before 0.5.10 is, as driving both', () => {
    for (const workflow of MEMORY_STRATEGY_WORKFLOWS) {
      expect(strategyDrives({ typeId: 'default-three-tier' }, workflow)).toBe(true)
      expect(strategyDrives({ typeId: 'personal-notes' }, workflow)).toBe(false)
    }
  })

  it('takes over only the Runtime Source mutate Action for capacity maintenance', () => {
    const strategy = { typeId: 'personal-notes', workflows: ['runtime-capacity' as const] }
    expect(runtimeCapacityWrite(strategy, 'runtime', 'mutate')).toBe(true)
    expect(runtimeCapacityWrite(strategy, 'runtime', 'import')).toBe(false)
    expect(runtimeCapacityWrite(strategy, 'documents', 'mutate')).toBe(false)
    expect(runtimeCapacityWrite({ typeId: 'personal-notes' }, 'runtime', 'mutate')).toBe(false)
  })

  it('reads the Strategy that composed a View from the generation holding its definition', () => {
    const view = { strategyInstanceKey: 'strategy:notes', strategyTypeId: 'personal-notes' }
    const declared = { ...manifest, workflows: ['idle-review' as const] }
    expect(viewStrategy({ strategy: { instanceKey: 'strategy:notes', definition: { manifest: declared } } }, view)).toBe(declared)
    expect(viewStrategy({ strategy: { instanceKey: 'strategy:other', definition: { manifest: declared } } }, view)).toEqual({ typeId: 'personal-notes' })
    expect(viewStrategy(undefined, view)).toEqual({ typeId: 'personal-notes' })
  })
})

describe('standard View extensions for any main Strategy', () => {
  const notes = defineMemorySource({
    manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'notes', packageName: 'dsh-mnemon-source-notes',
      role: 'notes', capabilities: ['project'], consistency: 'exact-snapshot' },
    create: context => ({
      facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'notes', role: 'notes', availability: 'ready',
        revision: 'r1', capabilities: ['project'], routeIds: [], actionIds: [] }),
      project: request => ({ fragments: request.includeProjection ? [{ id: 'note', sourceInstanceKey: context.sourceInstanceKey,
        mode: request.mode, text: 'A durable note.'.slice(0, request.maxCharacters), revision: 'r1' }] : [] }),
    }),
  })

  function viewStrategyDef(typeId: string, extensionSlots?: string[]): MemoryStrategyDefinition {
    return defineMemoryStrategy({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId, packageName: `dsh-mnemon-strategy-${typeId}`,
        deterministic: true, supportedSourceRoles: ['notes'], maxSources: 4, maxRoutes: 4, maxActions: 4,
        ...(extensionSlots === undefined ? {} : { extensionSlots }) },
      compose(request, sources, contributions = []) {
        const { projection } = memoryViewExtensionValues(contributions)
        const characters = Math.min(request.budget.maxProjectionCharacters, projection?.maxProjectionCharacters ?? Infinity)
        return { strategyTypeId: typeId, explanation: 'Project every note within the standard projection ceiling.',
          sources: sources.map(item => ({ sourceInstanceKey: item.sourceInstanceKey, projection: { mode: 'eager' as const, maxCharacters: characters } })) }
      },
    })
  }

  const light = (maxProjectionCharacters: number, typeId = 'light') => defineMemoryViewExtension({
    typeId, packageName: `dsh-mnemon-strategy-${typeId}`, slot: 'projection', contribute: () => ({ maxProjectionCharacters }),
  })

  async function viewFixture(selected: string) {
    const runner = new MemoryCompositionRunner({ strategyTypeId: selected })
    await runner.mount(plugin({ sources: [notes] }), { instanceId: 'notes' })
    await runner.mount(plugin({ strategies: [viewStrategyDef('first', ['selection', 'projection', 'capture']), viewStrategyDef('second')] }), { instanceId: 'strategies' })
    return runner
  }

  it('follows whichever selected Strategy declares the standard slot', async () => {
    for (const [selected, text] of [['first', 'A du'], ['second', 'A durable note.']] as const) {
      const runner = await viewFixture(selected)
      try {
        await runner.mount(plugin({ strategyExtensions: [light(4)] }), { instanceId: 'light' })
        const turn = await runner.beginTurn()
        expect(turn.view.strategyTypeId).toBe(selected)
        expect(turn.view.projection[0]?.text).toBe(text)
        expect(turn.view.strategyExtensions?.map(item => item.typeId)).toEqual(selected === 'first' ? ['light'] : undefined)
        if (selected === 'second') {
          expect(runner.inspect().evaluation.diagnostics).toMatchObject([{ code: 'strategy-extension-inactive',
            message: 'Selected Strategy second does not accept the projection slot.' }])
        }
        turn.release()
      } finally { await runner.dispose() }
    }
  })

  it('rejects a second owner of a slot at mount, whichever main Strategy it targets', async () => {
    const runner = await viewFixture('first')
    try {
      await runner.mount(plugin({ strategyExtensions: [light(4)] }), { instanceId: 'light' })
      const serving = runner.inspect().servingGenerationId
      for (const strategyTypeId of ['first', 'second']) {
        const targeted = defineMemoryStrategyExtension({
          manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy-extension', typeId: 'narrow', packageName: 'dsh-mnemon-strategy-narrow',
            strategyTypeId, slot: 'projection', deterministic: true },
          contribute: () => ({ maxProjectionCharacters: 2 }),
        })
        await expect(runner.mount(plugin({ strategyExtensions: [targeted] }), { instanceId: 'narrow' })).rejects.toThrow(`slot conflict: ${strategyTypeId}/projection`)
      }
      expect(runner.inspect()).toMatchObject({ servingGenerationId: serving, evaluation: { state: 'ready' } })
    } finally { await runner.dispose() }
  })

  it('keeps any-Strategy extensions on standard slots and validates their values', () => {
    expect(() => defineMemoryStrategyExtension({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy-extension', typeId: 'custom', packageName: 'dsh-mnemon-strategy-custom',
        strategyTypeId: ANY_MEMORY_STRATEGY, slot: 'guidance', deterministic: true },
      contribute: () => null,
    })).toThrow('must use a standard slot: guidance')
    expect(light(8).manifest).toMatchObject({ strategyTypeId: '*', slot: 'projection' })
    expect(() => validateMemoryViewExtension('projection', { maxProjectionCharacters: 8, extra: true })).toThrow('unsupported View projection field: extra')
    expect(() => validateMemoryViewExtension('selection', { sourceKeys: ['source:a'], writableSourceKeys: ['source:b'] })).toThrow('within selected sourceKeys')
    expect(() => validateMemoryViewExtension('capture', { instruction: 'Record.', actionIds: [] })).toThrow('capture actionIds')
    const contribution = { instanceKey: 'strategy-extension:light', typeId: 'light', slot: 'projection', value: { maxProjectionCharacters: 8 } }
    expect(memoryViewExtensionValues([contribution])).toEqual({ projection: { maxProjectionCharacters: 8 } })
    expect(() => memoryViewExtensionValues([contribution, contribution])).toThrow('duplicate View extension slot: projection')
  })

  it('falls back to the only installed Strategy only when the Host asks for it', async () => {
    for (const strategyFallback of [undefined, 'sole-strategy'] as const) {
      const runner = new MemoryCompositionRunner({ strategyTypeId: 'first', ...(strategyFallback === undefined ? {} : { strategyFallback }) })
      try {
        await runner.mount(plugin({ sources: [notes] }), { instanceId: 'notes' })
        await runner.mount(plugin({ strategies: [viewStrategyDef('second')] }), { instanceId: 'second' })
        if (strategyFallback === undefined) {
          expect(runner.inspect().evaluation).toMatchObject({ state: 'rejected', diagnostics: [{ message: expect.stringContaining('selected memory Strategy type is unavailable: first') }] })
          continue
        }
        expect(runner.inspect().evaluation.diagnostics).toEqual([{ code: 'strategy-fallback', contributionInstanceKey: 'strategy:second',
          message: 'Selected Strategy first is unavailable; composing with the only installed Strategy second.' }])
        const turn = await runner.beginTurn()
        expect(turn.view.strategyTypeId).toBe('second')
        turn.release()
      } finally { await runner.dispose() }
    }
  })

  it('runs an any-Strategy extension only for the selected Strategy', async () => {
    const contribute = vi.fn(() => ({ maxProjectionCharacters: 4 }))
    const runner = await viewFixture('second')
    try {
      await runner.mount(plugin({ strategyExtensions: [defineMemoryViewExtension({ typeId: 'watched', packageName: 'dsh-mnemon-strategy-watched', slot: 'projection', contribute })] }), { instanceId: 'watched' })
      const turn = await runner.beginTurn()
      expect(contribute).not.toHaveBeenCalled()
      turn.release()
    } finally { await runner.dispose() }
  })
})

describe('additive Strategy plugins through the real Host', () => {
  const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
  afterEach(async () => { for (const item of fixtures.splice(0)) await item.dispose() })
  async function hostFixture(options: Parameters<typeof compositionFixture>[0] = {}) {
    const value = await compositionFixture(options)
    fixtures.push(value)
    return value
  }
  function agent(f: Awaited<ReturnType<typeof hostFixture>>) {
    return { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
  }
  const runtimeKey = 'source:mnemon-source-runtime'
  const documentsKey = 'source:mnemon-source-documents'
  const spacesKey = 'source:mnemon-source-memory-spaces'
  const selectedKeys = [runtimeKey, documentsKey, spacesKey]

  it('combines selection, a smaller projection and capture without replacing the default Strategy', async () => {
    const f = await hostFixture()
    const body = await f.memorySpace()
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Runtime sentinel. '.repeat(100) })
    await f.mount(scoped, { instanceId: 'scoped', config: { sourceKeys: selectedKeys, writableSourceKeys: [spacesKey] } })
    const removeLight = await f.mount(lightPlugin, { instanceId: 'light', config: { maxProjectionCharacters: 500 } })
    await f.mount(capture, { instanceId: 'capture' })
    const parent = agent(f)
    const turn = await f.graph.composableTurns.beginTurn('additive:1', agentScope(parent, f.config))
    expect(turn.view.strategyTypeId).toBe('default-three-tier')
    expect(turn.view.strategyExtensions?.map(item => item.slot).sort()).toEqual(['capture', 'projection', 'selection'])
    expect(turn.view.projection.reduce((sum, fragment) => sum + fragment.text.length, 0)).toBeLessThanOrEqual(500)
    expect(turn.view.actionOffers.every(offer => offer.sourceInstanceKey === spacesKey)).toBe(true)
    expect(modelMemoryWake(f.graph, turn).guidance?.system).toContain('MNEMON OPTIONAL AUTO CAPTURE')

    const tools = new Map<string, ToolDefinition>()
    const coordinator = new MnemonSubagentCoordinator({} as HostSubagentsService, f.live)
    registerTools({ tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
    const execute = (name: string, args: object) => (tools.get(name)!.execute as Function)(args, { agent: parent, signal: new AbortController().signal })
    await expect(execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: 'must not write' })).rejects.toThrow('not offered')
    const remember = turn.view.actionOffers.find(offer => offer.sourceActionId === 'remember')!
    await expect(execute('mnemon_view_action', { offerId: remember.id, input: { memoryBodyId: body.id, content: 'Additive plugin durable sentinel.' } })).resolves.toMatchObject({ completion: 'committed' })

    await removeLight()
    expect(turn.view.strategyExtensions).toHaveLength(3)
    f.graph.composableTurns.endTurn(turn.turnId)
    const next = await f.graph.composableTurns.beginTurn('additive:2', agentScope(parent, f.config))
    expect(next.view.strategyExtensions?.map(item => item.slot).sort()).toEqual(['capture', 'selection'])
    expect(next.view.projection.reduce((sum, fragment) => sum + fragment.text.length, 0)).toBeGreaterThan(500)
    expect(next.view.actionOffers.every(offer => offer.sourceInstanceKey === spacesKey)).toBe(true)
    const recall = next.view.routes.find(route => route.sourceRouteId === 'recall')!
    const evidence = await f.graph.composableTurns.executeRoute(next.turnId, recall.id, { query: 'Additive plugin durable sentinel' })
    expect(evidence.items[0]?.text).toContain('Additive plugin durable sentinel')
  })

  it('does not archive Runtime into a View-read-only Source on capacity overflow', async () => {
    const f = await hostFixture({ runtimeMemory: { memoryLimitBytes: 512 } })
    await f.memorySpace()
    const runtime = f.graph.source('runtime')
    await runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'Saved durable fact. '.repeat(15) })
    await f.mount(scoped, { instanceId: 'scoped', config: { sourceKeys: selectedKeys, writableSourceKeys: [runtimeKey] } })
    const parent = agent(f)
    await f.graph.composableTurns.beginTurn('readonly:1', agentScope(parent, f.config))
    const before = await runtime.read<RuntimeMemorySnapshot>('snapshot')
    const space = f.graph.memoryComposition.current()!.sourceRuntime(spacesKey)!
    const management = vi.spyOn(space as { manage: NonNullable<typeof space.manage> }, 'manage')
    const start = vi.fn()
    const coordinator = new MnemonSubagentCoordinator({ start } as unknown as HostSubagentsService, f.live)
    await expect(coordinator.runtime(parent, { action: 'add', target: 'memory', content: 'Pending durable fact. '.repeat(15) }, new AbortController().signal))
      .rejects.toThrow('Source Action is not offered by the current View: memory-spaces/remember')
    expect(management.mock.calls.filter(([request]) => request.mode === 'mutate')).toEqual([])
    expect(start).not.toHaveBeenCalled()
    expect(await runtime.read('snapshot')).toMatchObject({ revision: before.revision, entries: before.entries, targets: before.targets })
  })

  it('rejects a read-only Documents mutation before its archive preflight can start a worker', async () => {
    const f = await hostFixture()
    await f.releases[1]!()
    await f.mount(documents, { instanceId: 'small-documents', config: { dataDir: join(f.root, 'small-documents'), limitBytes: 700 } })
    const controller = f.graph.source('documents')
    const initial = await controller.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Saved', content: 'Old record. '.repeat(12) })
    await f.mount(scoped, { instanceId: 'scoped', config: {
      sourceKeys: [runtimeKey, 'source:small-documents', spacesKey], writableSourceKeys: [runtimeKey, spacesKey],
    } })
    const parent = agent(f)
    await f.graph.composableTurns.beginTurn('readonly:documents', agentScope(parent, f.config))
    const start = vi.fn()
    const coordinator = new MnemonSubagentCoordinator({ start } as unknown as HostSubagentsService, f.live)
    await expect(coordinator.document(parent, { action: 'create', title: 'New', content: 'New record. '.repeat(12) }, new AbortController().signal))
      .rejects.toThrow('Source Action is not offered by the current View: documents/manage')
    expect(start).not.toHaveBeenCalled()
    expect(await controller.read('document', { id: initial.document.id })).toMatchObject({ status: 'active', content: initial.document.content })
  })

  it('retains automatic capacity archival when both Sources are offered as writable', async () => {
    const f = await hostFixture({ runtimeMemory: { memoryLimitBytes: 512 } })
    await f.memorySpace()
    const saved = 'Saved durable fact. '.repeat(15).trim()
    const pending = 'Pending durable fact. '.repeat(15).trim()
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: saved })
    await f.mount(scoped, { instanceId: 'scoped' })
    const parent = agent(f)
    const turn = await f.graph.composableTurns.beginTurn('writable:1', agentScope(parent, f.config))
    const start = vi.fn()
    const coordinator = new MnemonSubagentCoordinator({ start } as unknown as HostSubagentsService, f.live)
    await expect(coordinator.runtime(parent, { action: 'add', target: 'memory', content: pending }, new AbortController().signal))
      .resolves.toMatchObject({ added: pending, maintenance: { kind: 'mnemon-archive', provider: 'host' } })
    expect(start).not.toHaveBeenCalled()
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([pending])
    const recall = turn.view.routes.find(route => route.sourceRouteId === 'recall')!
    const evidence = await f.graph.composableTurns.executeRoute(turn.turnId, recall.id, { query: 'Saved durable fact' })
    expect(evidence.items[0]?.text).toBe(saved)
  })
})
