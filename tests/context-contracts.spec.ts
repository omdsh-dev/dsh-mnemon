import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MEMORY_CAPABILITIES, MEMORY_CONTEXT_POLICY_FORMAT, type MemoryEvidence, type MemoryExecutionResult, type MemoryMutationReceipt, type MemorySourceDefinition } from '../src/core/contracts/index.ts'
import { MemoryCompositionRunner } from '../src/sdk/testing.ts'
import { composeMemoryContext, defineMemoryContextPolicy, defineMemorySource, defineMemoryStrategy, installMemory } from '../src/sdk/index.ts'
import { validateMemoryAccess, validateMemoryExecution, validateMemoryOperation } from '../src/core/operation-contracts.ts'
import { inspectMemoryView } from '../src/host/view-presentation.ts'

const runners: MemoryCompositionRunner[] = []
afterEach(async () => { await Promise.all(runners.splice(0).map(runner => runner.dispose())) })
const strategy = defineMemoryStrategy({
  manifest: { apiVersion: 'dsh-mnemon/v1', kind: 'strategy', typeId: 'generic', packageName: 'generic-policy', deterministic: true,
    supportedSourceRoles: [], acceptedSourceCapabilities: [...MEMORY_CAPABILITIES], acceptedContributionFormats: [MEMORY_CONTEXT_POLICY_FORMAT], maxSources: 8, maxRoutes: 8, maxActions: 8 },
  compose: (request, sources, contributions = []) => composeMemoryContext(request, sources, contributions, { strategyTypeId: 'generic', explanation: 'Compose by available operations.' }),
})
const policy = defineMemoryContextPolicy({ typeId: 'external-rule', packageName: 'external-rule', strategyTypeId: 'generic', slot: 'independently-authored',
  contribute: (_request, sources) => ({ decisions: sources.map(source => ({ id: 'capture', sourceInstanceKey: source.sourceInstanceKey, ready: true,
    reason: { en: 'Evidence is ready.', 'zh-CN': '证据已就绪。' }, requires: { routeIds: ['read'], actionIds: ['run'] }, instruction: 'Inspect the evidence before executing the approved plan.' })) }),
})
async function fixture(options: { broken?: boolean; grant?: boolean; execution?: MemoryExecutionResult; completion?: MemoryMutationReceipt['completion']; next?: MemoryEvidence['continuation']; empty?: boolean; noWrites?: boolean } = {}) {
  const runner = new MemoryCompositionRunner(); runners.push(runner)
  let mutations = 0
  const source = defineMemorySource({
    manifest: { apiVersion: 'dsh-mnemon/v1', kind: 'source', typeId: 'external', packageName: 'external-source', role: 'a-new-resource-shape', consistency: 'exact-snapshot',
      context: { mode: 'routed', weight: 2 }, capabilities: ['project', 'read', 'write'],
      routes: [{ id: 'read', description: 'Read a resource', capability: 'read', inputSchema: { type: 'object', properties: { offset: { type: 'integer' } }, additionalProperties: false }, maxCalls: 2, access: { kinds: ['read'], result: 'resources' } }],
      actions: [{ id: 'run', description: 'Execute a reviewed plan', capability: 'write', authority: 'process-execution', inputSchema: {}, operation: { effects: ['execute'], execution: 'deferred', requiresReadGrant: true } }],
    },
    create(context) { return {
      facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'external', role: 'a-new-resource-shape', availability: 'ready', revision: 'r1', capabilities: ['project', 'read', 'write'], routeIds: ['read'], actionIds: ['run'] }),
      project(request) {
        if (options.broken) throw new Error('External service unavailable')
        return { fragments: request.includeProjection ? [{ id: 'cover', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode, text: 'Resources are available', revision: 'r1' }] : [],
          ...(options.grant === false ? {} : { readGrant: { id: 'grant', sourceInstanceKey: context.sourceInstanceKey, schema: 'example/v1', revision: 'r1', consistency: 'exact-snapshot' as const, value: { privateHandle: 'never-in-ui' } } }) }
      },
      query: request => ({ id: 'evidence', viewId: request.view.id, routeId: request.route.id, sourceInstanceKey: context.sourceInstanceKey, observedAt: new Date().toISOString(),
        items: [{ id: 'resource', text: 'bounded evidence', provenance: {}, reference: { id: 'resource', revision: 'r1', path: 'notes/example.md' } }], truncated: !!options.next, ...(options.next ? { continuation: options.next } : {}) }),
      mutate: request => { mutations++; return { id: 'receipt', viewId: request.view.id, offerId: request.offer.id, sourceInstanceKey: context.sourceInstanceKey,
        status: 'succeeded', completion: options.completion ?? 'accepted', ...(options.completion === 'committed' ? { committedAt: new Date().toISOString() } : {}), ...(options.execution ? { execution: options.execution } : {}) } },
    } },
  } satisfies MemorySourceDefinition)
  const restrictions = defineMemoryContextPolicy({ typeId: 'scope', packageName: 'scope-policy', strategyTypeId: 'generic', slot: 'scope', contribute: () => ({ decisions: [], selection: { ...(options.empty ? { sourceKeys: [] } : {}), ...(options.noWrites ? { writableSourceKeys: [] } : {}) } }) })
  await runner.mount({ apply(ctx: Context) { installMemory(ctx, { sources: [source], strategies: [strategy], strategyExtensions: [policy, restrictions] }) } }, { instanceId: 'external' })
  return { runner, mutations: () => mutations }
}

describe('structured access through public plugin boundaries', () => {
  it('accepts an unfamiliar role and extension slot, and binds guidance to selected operations', async () => {
    const { runner } = await fixture({ execution: { id: 'job-1', state: 'queued' } })
    const turn = await runner.beginTurn()
    expect(turn.view.decisions?.[0]).toMatchObject({ state: 'applied', routeIds: ['read'], actionIds: ['run'] })
    expect(turn.view.guidance?.system).toContain('Inspect the evidence')
    const receipt = await turn.executeAction(turn.view.actionOffers[0]!.id, {}, () => true)
    expect(receipt).toMatchObject({ completion: 'accepted', execution: { id: 'job-1', state: 'queued' } })
    const evidence = await turn.executeRoute(turn.view.routes[0]!.id, {})
    expect(evidence.items[0]?.reference).toMatchObject({ revision: 'r1', path: 'notes/example.md' })
    const inspection = inspectMemoryView(undefined as never, turn.view, 'preview', undefined, 'public')
    expect(inspection.decisions?.[0]?.state).toBe('applied')
    expect(inspection.actions[0]).toMatchObject({ requiresApproval: true, operation: { execution: 'deferred' } })
    expect(JSON.stringify(inspection)).not.toContain('privateHandle')
  })
  it.each([{ broken: true, state: 'unavailable' }, { empty: true, state: 'excluded' }, { noWrites: true, state: 'excluded' }] as const)('removes instructions when a prerequisite cannot participate: $state', async options => {
    const { runner } = await fixture(options), turn = await runner.beginTurn()
    expect(turn.view.decisions?.[0]?.state).toBe(options.state)
    expect(turn.view.guidance?.system ?? '').not.toContain('Inspect the evidence')
    if (options.broken || options.empty) expect(turn.view.routes).toHaveLength(0)
  })
  it('does not execute before authorization or without the Source read grant', async () => {
    const one = await fixture(), turn = await one.runner.beginTurn()
    await expect(turn.executeAction(turn.view.actionOffers[0]!.id, {}, () => false)).rejects.toThrow(/authoriz/)
    expect(one.mutations()).toBe(0)
    // An action-only View may omit reads; its write still requires the explicit grant.
    const two = await fixture({ grant: false, noWrites: false })
    await expect(two.runner.beginTurn()).rejects.toThrow(/grant/i)
    expect(two.mutations()).toBe(0)
  })
  it.each([
    { completion: 'accepted', error: /execution identity/ },
    { execution: { id: 'job', state: 'running' }, completion: 'committed', error: /Pending execution/ },
    { execution: { id: 'job', state: 'unknown' }, completion: 'committed', error: /Pending execution/ },
    { execution: { id: 'job', state: 'failed' }, completion: 'accepted', error: /Failed execution/ },
    { execution: { id: 'job', state: 'cancelled' }, completion: 'accepted', error: /Failed execution/ },
    { execution: { id: 'job', state: 'interrupted' }, completion: 'accepted', error: /Failed execution/ },
    { execution: { id: 'job', state: 'timed-out' }, completion: 'accepted', error: /Failed execution/ },
  ] as const)('rejects a misleading execution receipt', async options => {
    const { runner } = await fixture(options), turn = await runner.beginTurn()
    await expect(turn.executeAction(turn.view.actionOffers[0]!.id, {}, () => true)).rejects.toThrow(options.error)
  })
  it('validates continuation scope and schema and retains normal route budgets', async () => {
    const good = await fixture({ next: { routeId: 'read', input: { offset: 1 } } }), turn = await good.runner.beginTurn()
    const first = await turn.executeRoute(turn.view.routes[0]!.id, {})
    expect(first.continuation?.routeId).toBe(turn.view.routes[0]!.id)
    await turn.executeRoute(first.continuation!.routeId, first.continuation!.input)
    await expect(turn.executeRoute(first.continuation!.routeId, {})).rejects.toThrow(/budget|call limit/)
    for (const next of [{ routeId: 'source:foreign/read', input: {} }, { routeId: 'read', input: { secret: 'hidden' } }]) {
      const { runner } = await fixture({ next }), invalid = await runner.beginTurn()
      await expect(invalid.executeRoute(invalid.view.routes[0]!.id, {})).rejects.toThrow(/continuation|schema|additional/i)
    }
  })
  it('rejects contradictory semantics instead of inferring permissions from labels', () => {
    expect(() => validateMemoryAccess({ kinds: ['read', 'read'], result: 'text' })).toThrow(/distinct/)
    expect(() => validateMemoryOperation({ effects: ['execute'], execution: 'deferred' })).toThrow(/authority/)
    expect(() => validateMemoryExecution({ id: 'job', state: 'running', exitCode: 0 })).toThrow(/state/)
    expect(() => validateMemoryExecution({ id: 'job', state: 'succeeded', exitCode: 1 })).toThrow(/state/)
  })
})
