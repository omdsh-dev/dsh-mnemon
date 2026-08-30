import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPOSABLE_MEMORY_API_VERSION,
  type MemoryAvailableSource, type MemoryBudgetUsage, type MemoryEvidenceItem, type MemoryMutationReceipt,
  type MemoryOperationSelection, type MemoryOperationSemantics, type MemorySourceDefinition,
  type MemorySourceRuntime, type MemoryStrategyDefinition,
} from 'dsh-mnemon/contracts'
import { createMemoryMutationReceipt, defineMemorySource, defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import { DEFAULT_MEMORY_VIEW_BUDGET, MemoryCompositionRunner, type MemoryTestOptions } from 'dsh-mnemon/testing'

const READ: MemoryOperationSemantics = {
  actions: ['read'], targets: ['records'], effects: [], representations: ['raw', 'excerpt'], overflow: 'truncate', retry: 'safe',
}
const WAKE: MemoryOperationSemantics = {
  actions: ['wake'], targets: ['records'], effects: [], representations: ['excerpt'], overflow: 'unavailable', retry: 'safe',
}
const RECORD: MemoryOperationSemantics = {
  actions: ['record'], targets: ['records'], effects: [{ target: 'records', mode: 'write' }], representations: ['receipt'], overflow: 'unavailable', retry: 'unsafe',
}
const runners: MemoryCompositionRunner[] = []
afterEach(async () => { for (const runner of runners.splice(0)) await runner.dispose() })

interface FixtureOptions {
  read?: MemoryOperationSemantics
  routeId?: string
  items?: MemoryEvidenceItem[]
  selection?: MemoryOperationSelection
  queryError?: boolean
  usage?: MemoryBudgetUsage[]
  receipt?: Partial<MemoryMutationReceipt>
  count?: number
  host?: MemoryTestOptions
  roles?: string[]
  compose?: MemoryStrategyDefinition['compose']
  customize?: (runtime: MemorySourceRuntime) => MemorySourceRuntime
}

function source(options: FixtureOptions = {}, query = vi.fn(), mutation = vi.fn()): MemorySourceDefinition {
  const routeId = options.routeId ?? 'native-lookup'
  return defineMemorySource({
    manifest: {
      apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'independent', packageName: 'dsh-mnemon-source-independent',
      role: 'notes', capabilities: ['project', 'read', 'write', 'forget'], consistency: 'exact-snapshot', projection: WAKE,
      routes: [{ id: routeId, description: 'A plugin-native operation name', capability: 'read', maxCalls: 2, maxResults: 10, maxCharacters: 100,
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false }, semantics: options.read ?? READ }],
      actions: [{ id: 'native-save', description: 'Save independently', capability: 'write', inputSchema: { type: 'object' }, semantics: RECORD }],
    },
    create(context) {
      const runtime: MemorySourceRuntime = {
        facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'independent', role: 'notes', availability: 'ready', revision: 'r1',
          capabilities: ['project', 'read', 'write', 'forget'], routeIds: [routeId], actionIds: ['native-save'] }),
        project: request => ({
          fragments: request.includeProjection ? [{ id: 'cover', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode,
            revision: 'r1', text: 'outline'.slice(0, request.maxCharacters), result: { representation: 'excerpt', coverage: 'partial', omitted: 'Follow the route for detail.' } }] : [],
          readGrant: { id: context.sourceInstanceKey + '/grant', sourceInstanceKey: context.sourceInstanceKey, schema: 'independent/v1',
            consistency: 'exact-snapshot', revision: 'r1', value: { privateNamespace: context.sourceInstanceKey } },
        }),
        query(request) {
          query(request)
          if (options.queryError) throw new Error('Source query failed after dispatch')
          return { id: 'read', viewId: request.view.id, routeId: request.route.id, sourceInstanceKey: context.sourceInstanceKey,
            observedAt: '2026-08-31T00:00:00.000Z', truncated: false,
            items: options.items ?? [{ id: 'note', text: 'abcdefghijk', provenance: { note: 'native-id' }, result: { representation: 'raw', coverage: 'complete' } }],
            ...(options.usage === undefined ? {} : { usage: options.usage }),
          }
        },
        mutate(request) {
          mutation(request)
          return { ...createMemoryMutationReceipt(request.view.id, request.offer.id, context.sourceInstanceKey, 'r2', {}, 'committed'), ...options.receipt }
        },
      }
      return options.customize?.(runtime) ?? runtime
    },
  })
}

async function fixture(options: FixtureOptions = {}) {
  const query = vi.fn()
  const mutation = vi.fn()
  const observed = vi.fn<(sources: readonly MemoryAvailableSource[]) => void>()
  const runner = new MemoryCompositionRunner(options.host)
  runners.push(runner)
  const definition = source(options, query, mutation)
  const plugin = { inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { sources: [definition] }) } }
  for (let index = 0; index < (options.count ?? 1); index += 1) await runner.mount(plugin, { instanceId: `notes-${index}` })
  const strategy = defineMemoryStrategy({
    manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'semantic', packageName: 'dsh-mnemon-strategy-independent',
      deterministic: true, supportedSourceRoles: options.roles ?? ['notes'], maxSources: 4, maxRoutes: 4, maxActions: 4 },
    compose(request, sources) {
      observed(sources)
      if (options.compose !== undefined) return options.compose(request, sources)
      return { strategyTypeId: 'semantic', explanation: 'Compose by properties without knowing any native operation name.',
        sources: sources.map(item => ({
          sourceInstanceKey: item.sourceInstanceKey,
          projection: { mode: 'routed', maxCharacters: Math.max(1, Math.floor(request.budget.maxProjectionCharacters / sources.length)) },
          routeIds: item.routes.filter(route => route.semantics?.actions.includes('read')).map(route => route.id),
          actionIds: item.actions.map(action => action.id),
          routeOptions: Object.fromEntries(item.routes.map(route => [route.id, options.selection ?? {}])),
        })),
      }
    },
  })
  await runner.mount({ inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { strategies: [strategy] }) } }, { instanceId: 'strategy' })
  return { runner, query, mutation, observed }
}

describe('independent Source/Strategy semantic contracts', () => {
  it('selects renamed native operations by validated properties and retains instance isolation', async () => {
    const { runner, observed, query } = await fixture({ routeId: 'anything-the-author-chooses', count: 2 })
    const turn = await runner.beginTurn()
    expect(turn.view.routes.map(route => route.id)).toEqual(['source:notes-0/anything-the-author-chooses', 'source:notes-1/anything-the-author-chooses'])
    const facts = observed.mock.calls[0]![0]
    expect(Object.isFrozen(facts[0]!.routes[0]!.semantics!.actions)).toBe(true)
    expect(facts[0]!.routes[0]).toMatchObject({ semantics: READ, inputSchema: { type: 'object' } })
    expect(JSON.stringify(facts)).not.toContain('privateNamespace')
    await turn.executeRoute(turn.view.routes[0]!.id, {})
    expect(query.mock.calls[0]![0].view).toEqual({ id: turn.view.id, scope: turn.view.scope })
    expect(JSON.stringify(query.mock.calls[0])).not.toContain('source:notes-1')
  })

  it('derives descriptors itself, ignores forged Facts descriptors, and filters effects by Host authority', async () => {
    const { runner, observed, query } = await fixture({
      host: { sourceCapabilities: () => ['project', 'read'] },
      read: { ...READ, targets: ['records', 'usage'], effects: [{ target: 'usage', mode: 'write', stage: 'retrieved' }], retry: 'unsafe' },
      customize: runtime => ({ ...runtime, facts: async (...args) => ({ ...await runtime.facts(...args),
        routes: [{ id: 'forged', semantics: READ }], actions: [{ id: 'forged' }],
      }) }),
    })
    const turn = await runner.beginTurn()
    expect(observed.mock.calls[0]![0][0]).toMatchObject({ routeIds: [], actionIds: [], routes: [], actions: [] })
    expect(turn.view.routes).toEqual([])
    expect(turn.view.actionOffers).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('does not count composition, replay or projection as retrieval usage', async () => {
    const { runner, query } = await fixture({ read: { ...READ, targets: ['records', 'usage'], effects: [{ target: 'usage', mode: 'write', stage: 'retrieved' }], retry: 'unsafe' } })
    const turn = await runner.beginTurn()
    const other = await runner.beginTurn()
    expect(turn.view.digest).toBe(other.view.digest)
    expect(query).not.toHaveBeenCalled()
    await turn.executeRoute(turn.view.routes[0]!.id, {})
    expect(query).toHaveBeenCalledOnce()
  })

  it.each([
    { ...READ, actions: ['remember'] },
    { ...READ, effects: [{ target: 'records', mode: 'write' }] },
    { ...READ, targets: ['records', 'usage'], effects: [{ target: 'usage', mode: 'write', stage: 'injected' }] },
    { ...READ, representations: ['raw'] },
    { ...READ, budgets: [{ resource: 'output', unit: 'tokens', measurement: 'exact', default: 10, maximum: 20 }] },
  ])('rejects invalid/ambiguous declarations before installation: %j', read => {
    expect(() => source({ read: read as MemoryOperationSemantics })).toThrow()
  })

  it('forbids side effects during wake/compilation', () => {
    const definition = source()
    expect(() => defineMemorySource({ ...definition, manifest: { ...definition.manifest,
      projection: { ...WAKE, targets: ['records', 'usage'], effects: [{ target: 'usage', mode: 'write', stage: 'injected' }] },
    } })).toThrow('without persistent effects')
  })
})

describe('finite budgets and truthful output', () => {
  it('resolves auto/ranges against ceilings without padding or pretending a preferred minimum was met', async () => {
    const { runner, query } = await fixture({ selection: { budgets: [
      { resource: 'output', unit: 'characters', measurement: 'exact', amount: { min: 8, max: 50 } },
      { resource: 'output', unit: 'items', measurement: 'exact', amount: 'auto' },
    ] } })
    const turn = await runner.beginTurn({ budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 7 } })
    expect(turn.view.routes[0]!.budgets).toEqual(expect.arrayContaining([{ resource: 'output', unit: 'characters', measurement: 'exact', max: 7, preferredMin: 8 }]))
    const evidence = await turn.executeRoute(turn.view.routes[0]!.id, {})
    expect(query.mock.calls[0]![0].route.maxCharacters).toBe(7)
    expect(evidence.items[0]).toMatchObject({ text: 'abcdefg', result: { representation: 'excerpt', sourceRepresentation: 'raw', coverage: 'partial' } })
    expect(evidence.usage).toContainEqual({ resource: 'output', unit: 'characters', measurement: 'exact', used: 7 })
  })

  it('rejects undeclared exact token guarantees rather than converting characters heuristically', async () => {
    const { runner } = await fixture({ read: { ...READ, budgets: [{ resource: 'output', unit: 'tokens', measurement: 'estimated', basis: 'four-characters', default: 10, maximum: 30 }] },
      selection: { budgets: [{ resource: 'output', unit: 'tokens', measurement: 'exact', basis: 'four-characters', amount: 'auto' }] },
    })
    await expect(runner.beginTurn()).rejects.toThrow('unsupported budget')
  })

  it('passes Source-owned input/cost budgets, checks reported usage, and labels estimates', async () => {
    const read: MemoryOperationSemantics = { ...READ, budgets: [
      { resource: 'output', unit: 'tokens', measurement: 'estimated', basis: 'four-characters', default: 10, maximum: 30 },
      { resource: 'input', unit: 'items', measurement: 'exact', default: 5, maximum: 20 },
      { resource: 'cost', unit: 'milliseconds', measurement: 'estimated', default: 100, maximum: 500 },
    ] }
    const { runner, query } = await fixture({ read, usage: [
      { resource: 'output', unit: 'tokens', measurement: 'estimated', basis: 'four-characters', used: 3 },
      { resource: 'input', unit: 'items', measurement: 'exact', used: 2 },
      { resource: 'cost', unit: 'milliseconds', measurement: 'estimated', used: 20 },
    ] })
    const turn = await runner.beginTurn()
    const result = await turn.executeRoute(turn.view.routes[0]!.id, {})
    expect(query.mock.calls[0]![0].route.budgets).toContainEqual({ resource: 'input', unit: 'items', measurement: 'exact', max: 5 })
    expect(result.usage).toContainEqual({ resource: 'output', unit: 'tokens', measurement: 'estimated', basis: 'four-characters', used: 3 })
    const missing = await fixture({ read })
    const missingTurn = await missing.runner.beginTurn()
    await expect(missingTurn.executeRoute(missingTurn.view.routes[0]!.id, {})).rejects.toThrow('did not report required usage')
  })

  it('enforces UTF-8 budgets without splitting a character or returning invalid surrogates', async () => {
    const { runner } = await fixture({ read: { ...READ, budgets: [{ resource: 'output', unit: 'bytes', measurement: 'exact', default: 6, maximum: 10 }] },
      items: [{ id: 'unicode', text: '中🙂文', provenance: null, result: { representation: 'raw', coverage: 'complete' } }],
    })
    const turn = await runner.beginTurn()
    const evidence = await turn.executeRoute(turn.view.routes[0]!.id, {})
    expect(evidence.items[0]!.text).toBe('中')
    expect(evidence.usage).toContainEqual({ resource: 'output', unit: 'bytes', measurement: 'exact', used: 3 })
  })

  it('does not label a clipped prefix as exact raw content or a complete summary', async () => {
    const { runner } = await fixture({ selection: { representation: 'raw' } })
    const turn = await runner.beginTurn({ budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 3 } })
    const evidence = await turn.executeRoute(turn.view.routes[0]!.id, {})
    expect(evidence.items).toEqual([])
    expect(evidence.unavailable).toContain('no semantic summary or complete result was fabricated')
  })

  it('omits whole results when truncation is not allowed and preserves the remaining evidence', async () => {
    const { runner } = await fixture({ read: { ...READ, overflow: 'omit' }, items: [
      { id: 'large', text: 'required atomic fact', provenance: null, result: { representation: 'raw', coverage: 'complete' } },
      { id: 'small', text: 'fact', provenance: null, result: { representation: 'raw', coverage: 'complete' } },
    ] })
    const turn = await runner.beginTurn({ budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 4 } })
    const evidence = await turn.executeRoute(turn.view.routes[0]!.id, {})
    expect(evidence.items.map(item => item.text)).toEqual(['fact'])
    expect(evidence.truncated).toBe(true)
    expect(evidence.items[0]!.result!.coverage).toBe('complete')
  })

  it('never mechanically truncates structured results into malformed JSON', async () => {
    const { runner } = await fixture({ read: { ...READ, representations: ['structured', 'excerpt'] },
      items: [{ id: 'relation', text: '{"relation":"causal"}', provenance: null, result: { representation: 'structured', coverage: 'complete' } }],
    })
    const turn = await runner.beginTurn({ budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 5 } })
    expect(await turn.executeRoute(turn.view.routes[0]!.id, {})).toMatchObject({ items: [], truncated: true, unavailable: expect.any(String) })
  })

  it('preserves the inferred origin of a budgeted excerpt', async () => {
    const { runner } = await fixture({ read: { ...READ, representations: ['inference', 'excerpt'] },
      items: [{ id: 'inferred', text: 'possible preference, not observed', provenance: null, result: { representation: 'inference', coverage: 'unknown' } }],
    })
    const turn = await runner.beginTurn({ budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 10 } })
    expect((await turn.executeRoute(turn.view.routes[0]!.id, {})).items[0]!.result).toMatchObject({ representation: 'excerpt', sourceRepresentation: 'inference', coverage: 'partial' })
  })

  it('counts failed dispatches against the call budget and never automatically retries them', async () => {
    const { runner, query } = await fixture({ queryError: true, selection: { budgets: [{ resource: 'cost', unit: 'calls', measurement: 'exact', amount: { max: 1 } }] } })
    const turn = await runner.beginTurn()
    await expect(turn.executeRoute(turn.view.routes[0]!.id, {})).rejects.toThrow('failed after dispatch')
    await expect(turn.executeRoute(turn.view.routes[0]!.id, {})).rejects.toThrow('budget is exhausted')
    expect(query).toHaveBeenCalledOnce()
  })

  it('rejects options for unselected operations and unsupported Source roles', async () => {
    const bad = await fixture({ compose: (_request, sources) => ({ strategyTypeId: 'semantic', explanation: 'Invalid options',
      sources: [{ sourceInstanceKey: sources[0]!.sourceInstanceKey, routeOptions: { missing: {} } }],
    }) })
    await expect(bad.runner.beginTurn()).rejects.toThrow('unselected route')
    const unsupported = await fixture({ roles: ['different-role'] })
    await expect(unsupported.runner.beginTurn()).rejects.toThrow('unsupported Source role')
  })

  it('enforces the total per-Source projection budget across multiple fragments', async () => {
    const { runner } = await fixture({
      compose: (_request, sources) => ({ strategyTypeId: 'semantic', explanation: 'Small Source allocation',
        sources: [{ sourceInstanceKey: sources[0]!.sourceInstanceKey, projection: { mode: 'eager', maxCharacters: 4 } }],
      }),
      customize: runtime => ({ ...runtime, project: async (...args) => {
        const value = await runtime.project(...args)
        return { ...value, fragments: [...value.fragments, ...value.fragments.map(fragment => ({ ...fragment, id: 'second-fragment' }))] }
      } }),
    })
    await expect(runner.beginTurn()).rejects.toThrow('exceeded budget')
  })
})

describe('provenance, expansion and mutation completion', () => {
  it.each(['native-lookup', 'not-offered'])('only turns an offered same-Source reference into a callable expansion: %s', routeId => {
    return (async () => {
      const { runner } = await fixture({ items: [{ id: 'ref', text: 'reference', score: 100, provenance: { uri: 'opaque:note' },
        result: { representation: 'excerpt', coverage: 'partial', expansion: { routeId, input: { id: 'note' } } },
      }] })
      const turn = await runner.beginTurn()
      const result = (await turn.executeRoute(turn.view.routes[0]!.id, {})).items[0]!.result!
      expect(result.expansion).toEqual(routeId === 'native-lookup' ? { routeId: 'source:notes-0/native-lookup', input: { id: 'note' } } : { unavailable: expect.any(String) })
      expect(result.score).toMatchObject({ basis: 'source:notes-0', meaning: expect.stringContaining('not calibrated confidence') })
    })()
  })

  it('rejects cross-Source expansion and invalid expansion input', async () => {
    for (const expansion of [{ routeId: 'source:other/native-lookup', input: {} }, { routeId: 'native-lookup', input: { id: 123 } }]) {
      const { runner } = await fixture({ items: [{ id: 'ref', text: 'ref', provenance: null, result: { representation: 'excerpt', coverage: 'partial', expansion } }] })
      const turn = await runner.beginTurn()
      await expect(turn.executeRoute(turn.view.routes[0]!.id, {})).rejects.toThrow()
    }
  })

  it.each(['accepted', 'candidate', 'unknown'] as const)('keeps %s distinct from committed without manufacturing a timestamp', async completion => {
    const { runner, mutation } = await fixture({ customize: runtime => ({ ...runtime, mutate(request) {
      mutation(request)
      return createMemoryMutationReceipt(request.view.id, request.offer.id, request.offer.sourceInstanceKey, 'candidate-revision', { candidate: 'proposed policy; not active' }, completion)
    } }) })
    const turn = await runner.beginTurn()
    const before = runner.inspect().servingGenerationId
    const receipt = await turn.executeAction(turn.view.actionOffers[0]!.id, {}, () => true)
    expect(receipt.completion).toBe(completion)
    expect('committedAt' in receipt).toBe(false)
    expect(runner.inspect().servingGenerationId).toBe(before)
  })

  it('requires explicit valid commit proof and rechecks authority before dispatch', async () => {
    const { runner, mutation } = await fixture({ receipt: { committedAt: '' } })
    const turn = await runner.beginTurn()
    await expect(turn.executeAction(turn.view.actionOffers[0]!.id, { force: true }, () => false)).rejects.toThrow('not currently authorized')
    expect(mutation).not.toHaveBeenCalled()
    await expect(turn.executeAction(turn.view.actionOffers[0]!.id, {}, () => true)).rejects.toThrow('explicit commit timestamp')
    const uncommitted = await fixture({ receipt: { completion: 'accepted' } })
    const other = await uncommitted.runner.beginTurn()
    await expect(other.executeAction(other.view.actionOffers[0]!.id, {}, () => true)).rejects.toThrow('cannot claim a commit timestamp')
  })

  it('keeps the receipt helper conservative unless the Source explicitly confirms commitment', () => {
    expect(createMemoryMutationReceipt('v', 'o', 's', undefined, {})).toMatchObject({ completion: 'unknown', status: 'partial' })
    expect(createMemoryMutationReceipt('v', 'o', 's', undefined, {})).not.toHaveProperty('committedAt')
  })
})
