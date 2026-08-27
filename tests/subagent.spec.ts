import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostAgent, HostContextShape, HostSubagentsService, ToolDefinition } from '../src/contracts.ts'
import { DocumentManager } from '../src/documents.ts'
import type { MnemonService, RememberRequest } from '../src/service.ts'
import { assertDshOutputSchema, MnemonSubagentCoordinator } from '../src/subagent.ts'
import { prepareMemoryPlacement, type MemoryPlacementCandidate } from '../src/provider-placement.ts'
import { registerTools } from '../src/tools.ts'
import {
  RuntimeMemoryCapacityError,
  RuntimeMemoryController,
  type RuntimeMemoryMaintenancePlan,
} from '../src/runtime-memory.ts'
import { resolveConfig } from '../src/config.ts'

const capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function parent(origin?: 'subagent'): HostAgent {
  return {
    id: origin === undefined ? 'root' : 'child',
    status: 'idle',
    session: { header: { ...(origin === undefined ? {} : { origin }) }, events: [] },
  } as unknown as HostAgent
}

function service(): MnemonService {
  const project = {
    id: 'project',
    name: '项目记忆体',
    description: '项目决策',
    active: true,
    providerEnabled: true,
    dbPath: '/tmp/project.db',
    createdAt: 'now',
    updatedAt: 'now',
    healthy: true,
    provider: {
      id: 'mnemon-native',
      label: 'Mnemon Native',
      capabilities: { search: true, remember: true },
    },
  }
  const catalog = {
    items: [project],
    providers: [],
    total: 1,
    activeCount: 1,
    directory: '/tmp',
    generatedAt: 'now',
  }
  return {
    config: { writeEnabled: true },
    bodyDirectory: vi.fn(() => catalog),
    bodies: vi.fn(async () => catalog),
    search: vi.fn(async request => ({ query: request.query, mode: 'smart', results: [{ id: 'm1', content: 'SQLite', memoryBodyId: 'project', memoryBodyName: '项目记忆体' }] })),
    metadataSample: vi.fn(async (memoryBodyId: string) => ({
      memoryBodyId,
      name: memoryBodyId === 'release' ? 'Release' : 'Product',
      description: memoryBodyId === 'release' ? 'Release gates and rollback notes.' : 'Product scope and decisions.',
      providerId: 'mnemon-native',
      providerLabel: 'mnemon',
      method: 'native-basic',
      evidence: [{ content: memoryBodyId === 'release' ? 'Use staged rollout and a rollback gate.' : 'The product keeps durable architecture decisions.', category: 'decision', entities: ['DSH'] }],
    })),
    related: vi.fn(async () => []),
    status: vi.fn(async () => ({ healthy: true })),
    remember: vi.fn(async request => ({
      action: 'added',
      id: `stored-${createHash('sha256').update(request.content).digest('hex').slice(0, 8)}`,
      memoryBodyId: request.memoryBodyId,
      memoryBodyName: '项目记忆体',
    })),
    rememberMany: vi.fn(async (requests: readonly RememberRequest[]) => requests.map(request => ({
      action: 'added',
      id: `stored-${createHash('sha256').update(request.content).digest('hex').slice(0, 8)}`,
      memoryBodyId: request.memoryBodyId,
      memoryBodyName: '项目记忆体',
    }))),
    link: vi.fn(async () => ({ action: 'linked' })),
    forget: vi.fn(async () => ({ action: 'forgotten' })),
    createBody: vi.fn(async () => ({ id: 'new-body' })),
    updateBody: vi.fn(() => ({ id: 'project' })),
    mergeBodies: vi.fn(async () => ({ imported: 1 })),
  } as unknown as MnemonService
}

function addSecondWritableBody(memoryService: MnemonService): void {
  const catalog = memoryService.bodyDirectory()
  const source = catalog.items[0]!
  vi.mocked(memoryService.bodyDirectory).mockReturnValue({
    ...catalog,
    items: [source, {
      ...source,
      id: 'release',
      name: '发布记忆体',
      description: '发布门禁、回滚和金丝雀策略',
      dbPath: '/tmp/release.db',
    }],
    total: 2,
    activeCount: 2,
  })
}

function subagents(structured: unknown, stopReason = 'completed', providers = ['spawn'], localAgent?: HostAgent, diagnostic?: string) {
  const dispose = vi.fn(async () => {})
  const start = vi.fn(async () => ({
    id: 'child-run-1',
    result: Promise.resolve({ output: [], structured, stopReason, ...(diagnostic === undefined ? {} : { diagnostic }) }),
    dispose,
    ...(localAgent === undefined ? {} : { localAgent }),
  }))
  const value = {
    list: vi.fn(() => providers),
    getProvider: vi.fn((name: string) => providers.includes(name) ? { capabilities, inheritsParentContext: name === 'fork' } : undefined),
    start,
  } as unknown as HostSubagentsService
  return { value, start, dispose }
}

function toolRegistry() {
  const definitions: ToolDefinition[] = []
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>()
  const register = vi.fn((definition: ToolDefinition) => {
    definitions.push(definition)
    const dispose = vi.fn()
    disposers.push(dispose)
    return dispose
  })
  const on = vi.fn((name: string, listener: (...args: unknown[]) => unknown) => {
    const registered = listeners.get(name) ?? new Set()
    registered.add(listener)
    listeners.set(name, registered)
    const dispose = vi.fn(() => { registered.delete(listener) })
    disposers.push(dispose)
    return dispose
  })
  const emit = (name: string, ...args: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }
  return { value: { tools: { register }, on }, register, on, emit, definitions, disposers }
}

function createCoordinator(host: HostSubagentsService, runtime?: RuntimeMemoryController, documents?: DocumentManager) {
  return new MnemonSubagentCoordinator(host, runtime, documents, toolRegistry().value)
}

function runtimeSource(runtime: RuntimeMemoryController, memoryService: MnemonService) {
  return {
    forAgent: vi.fn((_agent: HostAgent) => ({
      runtimeMemory: runtime,
      service: memoryService,
      documents: {},
      memoryViews: {},
      memoryKernel: { assertParticipation: vi.fn() },
    })),
  }
}

function maintenancePlan(
  target: 'memory' | 'user' = 'memory',
  entries = [
    { content: 'Project uses pnpm.', importance: 'normal' as const },
    { content: 'Release checks require a canary.', importance: 'critical' as const },
  ],
): RuntimeMemoryMaintenancePlan {
  return {
    revision: `${target}-reviewed-revision`,
    action: 'add',
    target,
    entries: entries.map(entry => ({
      ...entry,
      target,
      created_at: '2026-08-23T00:00:00.000Z',
      updated_at: '2026-08-23T00:00:00.000Z',
    })),
    pending: { content: target === 'memory' ? 'New durable fact.' : 'User prefers direct answers.', importance: 'normal' },
    used: target === 'memory' ? 10_200 : 4_090,
    projected: target === 'memory' ? 10_300 : 4_180,
    limit: target === 'memory' ? 10_240 : 4_096,
    requiresMaintenance: true,
  }
}

function observedSubagents(
  resultTools: ReturnType<typeof toolRegistry>,
  publish: (child: HostAgent) => void,
  stopReason = 'completed',
  structured?: object,
) {
  const dispose = vi.fn(async () => {})
  const child = parent('subagent')
  child.id = 'child-run-1'
  const start = vi.fn(async () => {
    publish(child)
    return { id: child.id, result: Promise.resolve({ output: [], stopReason, ...(structured === undefined ? {} : { structured }) }), dispose, localAgent: child }
  })
  const value = {
    list: vi.fn(() => ['spawn']),
    getProvider: vi.fn(() => ({ capabilities })),
    start,
  } as unknown as HostSubagentsService
  return { value, start, dispose, child }
}

function emitSuccessfulToolResult(
  resultTools: ReturnType<typeof toolRegistry>,
  child: HostAgent,
  name: string,
  argumentsValue: unknown,
  value: unknown,
  parentToken?: symbol,
) {
  const execution = {
    name,
    arguments: argumentsValue,
    token: Symbol(name),
    ...(parentToken === undefined ? {} : { parent: parentToken }),
    agent: child,
    signal: new AbortController().signal,
  }
  resultTools.emit('tools/result', execution, { isError: false, value })
  return execution
}

describe('Mnemon memory subagent coordinator', () => {
  it('rejects structured-output keywords outside the DSH schema subset', () => {
    expect(() => assertDshOutputSchema({
      type: 'object',
      properties: { results: { type: 'array', items: { type: 'string' }, maxItems: 12 } },
      required: ['results'],
    })).toThrow('schema.properties.results.maxItems')
    expect(() => assertDshOutputSchema({
      type: 'object',
      properties: { results: { type: 'array', items: { type: 'string' } } },
      required: ['results'],
    })).not.toThrow()
  })

  it('executes bounded Recall directly against the pinned MemorySource without starting a child', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    const authorizedIds = Array.from({ length: 80 }, (_, index) => index === 0 ? 'project' : `space-${index + 1}`)
    const results = Array.from({ length: 20 }, (_, index) => ({
      id: `m${index + 1}`,
      content: index === 0 ? `Evidence ${index + 1} ${'x'.repeat(3_000)}` : `Evidence ${index + 1}`,
      tags: index === 0 ? Array.from({ length: 20 }, (_, tag) => `tag-${tag + 1}`) : undefined,
      relevanceTier: 'high' as const,
      memoryBodyId: 'project',
      memoryBodyName: 'Project',
    }))
    vi.mocked(memoryService.search).mockResolvedValue({
      query: 'database choice',
      mode: 'smart',
      results,
      hint: 'h'.repeat(1_500),
      sources: [{ memoryBodyId: 'project' }],
    } as never)
    const memoryViews = {
      activeTurn: vi.fn(() => ({ turnId: 'root:1', viewId: 'view-pinned' })),
      sourceState: vi.fn(() => ({ memoryBodyIds: authorizedIds })),
    }
    const source = { forAgent: vi.fn(() => ({ service: memoryService, runtimeMemory: {}, documents: {}, memoryViews })) }
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, undefined, toolRegistry().value)

    const recalled = await coordinator.recall(parent(), { query: 'database choice', limit: 50, category: 'fact', intent: 'WHY' }, new AbortController().signal, { requirePinnedView: true })

    expect(memoryService.search).toHaveBeenCalledWith({ query: 'database choice', limit: 6, memoryBodyIds: authorizedIds }, expect.any(AbortSignal))
    expect(recalled).toMatchObject({ results: expect.any(Array) })
    expect(recalled.results).toHaveLength(4)
    expect(recalled.results[0]?.content).toHaveLength(1_200)
    expect(recalled.results[0]?.content.endsWith('…')).toBe(true)
    expect(recalled.results[0]?.tags).toHaveLength(8)
    expect(recalled.hint).toContain('one materially different focused Recall query')
    expect(recalled).not.toHaveProperty('sources')
    expect(recalled).not.toHaveProperty('selectedMemoryBodyIds')
    expect(recalled).not.toHaveProperty('delegation')
    expect(JSON.stringify(recalled).length).toBeLessThan(5_000)
    expect(host.start).not.toHaveBeenCalled()
    expect(coordinator.snapshot()).toMatchObject({ recalls: 1, failures: 0, lastOperation: 'recall' })
  })

  it('admits one LLM-driven different-query refinement and closes the turn after it', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    vi.mocked(memoryService.search).mockImplementation(async request => request.query.trim().replace(/\s+/gu, ' ').toLocaleLowerCase() === 'release history'
      ? {
          query: request.query,
          mode: 'smart',
          sources: [],
          results: [
            { id: 'high-1', content: 'Canary at 35%.', relevanceTier: 'high', memoryBodyId: 'project' },
            { id: 'high-duplicate', content: 'Canary at 35%.', relevanceTier: 'high', memoryBodyId: 'other' },
            { id: 'medium-1', content: 'Medium clue one.', relevanceTier: 'medium', memoryBodyId: 'project' },
            { id: 'medium-2', content: 'Medium clue two.', relevanceTier: 'medium', memoryBodyId: 'project' },
            { id: 'unknown-1', content: 'Unknown clue one.', memoryBodyId: 'project' },
            { id: 'unknown-2', content: 'Unknown clue two.', memoryBodyId: 'project' },
            { id: 'low-1', content: 'Low clue.', relevanceTier: 'low', memoryBodyId: 'project' },
          ],
        }
      : {
          query: request.query,
          mode: 'smart',
          sources: [],
          results: [
            { id: 'duplicate-first', content: 'Canary at 35%.', relevanceTier: 'high', memoryBodyId: 'project' },
            { id: 'rollback-1', content: 'Rollback exposed tenant skew.', relevanceTier: 'high', memoryBodyId: 'project' },
            { id: 'medium-refinement', content: 'A second medium clue.', relevanceTier: 'medium', memoryBodyId: 'project' },
            { id: 'unknown-refinement', content: 'A second unknown clue.', memoryBodyId: 'project' },
          ],
        } as never)
    let turnId = 'root:9'
    const memoryViews = {
      activeTurn: vi.fn(() => ({ turnId, viewId: `view-${turnId}` })),
      sourceState: vi.fn(() => ({ memoryBodyIds: ['project', 'other'] })),
    }
    const source = { forAgent: vi.fn(() => ({ service: memoryService, runtimeMemory: {}, documents: {}, memoryViews })) }
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, undefined, toolRegistry().value)
    const signal = new AbortController().signal

    const first = await coordinator.recall(parent(), { query: '  Release   History ' }, signal, { requirePinnedView: true })
    const duplicate = await coordinator.recall(parent(), { query: 'release-history?!', mode: 'basic', limit: 1 }, signal, { requirePinnedView: true })
    const refinement = await coordinator.recall(parent(), { query: 'rollback drill' }, signal, { requirePinnedView: true })
    const exhausted = await coordinator.recall(parent(), { query: 'tenant recovery' }, signal, { requirePinnedView: true })
    turnId = 'root:10'
    const nextTurn = await coordinator.recall(parent(), { query: 'rollback drill' }, signal, { requirePinnedView: true })

    expect(first.results.map(result => result.id)).toEqual(['high-1', 'medium-1', 'unknown-1'])
    expect(duplicate).toMatchObject({ results: first.results, hint: expect.stringContaining('query already ran') })
    expect(refinement).toMatchObject({
      results: [
        { id: 'rollback-1', content: 'Rollback exposed tenant skew.' },
        { id: 'medium-refinement', content: 'A second medium clue.' },
        { id: 'unknown-refinement', content: 'A second unknown clue.' },
      ],
      hint: expect.stringContaining('Recall refinement is complete'),
    })
    expect(exhausted).toMatchObject({ results: refinement.results, hint: expect.stringContaining('budget is exhausted') })
    expect(nextTurn.results.map(result => result.id)).toEqual(['duplicate-first', 'rollback-1', 'medium-refinement', 'unknown-refinement'])
    expect(memoryService.search).toHaveBeenCalledTimes(3)
    expect(coordinator.snapshot()).toMatchObject({ recalls: 3, failures: 0 })
  })

  it('shares one Documents search claim across root and child calls in a pinned turn', () => {
    const host = subagents(undefined)
    const memoryService = service()
    let turnId = 'root:documents-1'
    const memoryViews = {
      activeTurn: vi.fn((agentId: string) => agentId === 'root' ? { turnId, viewId: `view-${turnId}` } : undefined),
      sourceState: vi.fn(() => ({ memoryBodyIds: ['project'] })),
    }
    const source = { forAgent: vi.fn(() => ({ service: memoryService, runtimeMemory: {}, documents: {}, memoryViews })) }
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, undefined, toolRegistry().value)
    const child = parent('subagent')
    child.session.header!.parentSession = 'root'

    expect(coordinator.claimDocumentSearch(parent())).toBe(true)
    expect(coordinator.claimDocumentSearch(child)).toBe(false)
    turnId = 'root:documents-2'
    expect(coordinator.claimDocumentSearch(child)).toBe(true)
    expect(memoryViews.activeTurn).toHaveBeenCalledWith('root')
  })

  it('shares one six-result and 4,800-character envelope across both Recall queries', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    vi.mocked(memoryService.search)
      .mockResolvedValueOnce({
        query: 'initial query',
        mode: 'smart',
        results: Array.from({ length: 6 }, (_, index) => ({
          id: `initial-${index + 1}`,
          content: `${index + 1}`.repeat(1_000),
          relevanceTier: 'high' as const,
          memoryBodyId: 'project',
        })),
      } as never)
      .mockResolvedValueOnce({
        query: 'refined query',
        mode: 'smart',
        results: [
          { id: 'initial-copy', content: '1'.repeat(1_000), relevanceTier: 'high', memoryBodyId: 'project' },
          ...Array.from({ length: 4 }, (_, index) => ({
            id: `refined-${index + 1}`,
            content: String.fromCharCode(114 + index).repeat(1_000),
            relevanceTier: 'high' as const,
            memoryBodyId: 'project',
          })),
        ],
      } as never)
    const memoryViews = {
      activeTurn: vi.fn(() => ({ turnId: 'root:envelope', viewId: 'view-envelope' })),
      sourceState: vi.fn(() => ({ memoryBodyIds: ['project'] })),
    }
    const source = { forAgent: vi.fn(() => ({ service: memoryService, runtimeMemory: {}, documents: {}, memoryViews })) }
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, undefined, toolRegistry().value)
    const signal = new AbortController().signal

    const initial = await coordinator.recall(parent(), { query: 'initial query' }, signal, { requirePinnedView: true })
    const refined = await coordinator.recall(parent(), { query: 'refined query' }, signal, { requirePinnedView: true })

    expect(initial.results).toHaveLength(4)
    expect(initial.results.reduce((total, result) => total + result.content.length, 0)).toBe(3_600)
    expect(refined.results).toHaveLength(2)
    expect(refined.results.every(result => result.id !== 'initial-copy')).toBe(true)
    expect([...initial.results, ...refined.results]).toHaveLength(6)
    expect([...initial.results, ...refined.results].reduce((total, result) => total + result.content.length, 0)).toBe(4_800)
    expect(memoryService.search).toHaveBeenCalledTimes(2)
  })

  it('joins concurrent same-turn Recall calls to one Provider result', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    let finishSearch!: (value: { query: string; mode: 'smart'; results: Array<{ id: string; content: string; relevanceTier: 'high'; memoryBodyId: string }> }) => void
    vi.mocked(memoryService.search).mockImplementation(() => new Promise(resolve => { finishSearch = resolve }) as never)
    const memoryViews = {
      activeTurn: vi.fn(() => ({ turnId: 'root:concurrent', viewId: 'view-concurrent' })),
      sourceState: vi.fn(() => ({ memoryBodyIds: ['project'] })),
    }
    const source = { forAgent: vi.fn(() => ({ service: memoryService, runtimeMemory: {}, documents: {}, memoryViews })) }
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, undefined, toolRegistry().value)
    const signal = new AbortController().signal

    const first = coordinator.recall(parent(), { query: 'release history' }, signal, { requirePinnedView: true })
    const duplicate = coordinator.recall(parent(), { query: 'release history' }, signal, { requirePinnedView: true })
    expect(memoryService.search).toHaveBeenCalledOnce()
    finishSearch({
      query: 'release history',
      mode: 'smart',
      results: [{ id: 'history-1', content: 'Use 35% and 65%.', relevanceTier: 'high', memoryBodyId: 'project' }],
    })

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
    expect(firstResult.results).toEqual([expect.objectContaining({ id: 'history-1' })])
    expect(duplicateResult).toMatchObject({
      results: firstResult.results,
      hint: expect.stringContaining('replayed its admitted evidence'),
    })
    expect(coordinator.snapshot()).toMatchObject({ recalls: 1, failures: 0 })
  })

  it('serializes concurrent different-query Recall calls before admitting refinement evidence', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    let finishInitial!: (value: { query: string; mode: 'smart'; results: Array<{ id: string; content: string; relevanceTier: 'high'; memoryBodyId: string }> }) => void
    vi.mocked(memoryService.search)
      .mockImplementationOnce(() => new Promise(resolve => { finishInitial = resolve }) as never)
      .mockResolvedValueOnce({
        query: 'refined query',
        mode: 'smart',
        results: [
          { id: 'duplicate', content: 'Initial evidence.', relevanceTier: 'high', memoryBodyId: 'project' },
          { id: 'refined', content: 'Refined evidence.', relevanceTier: 'high', memoryBodyId: 'project' },
        ],
      } as never)
    const memoryViews = {
      activeTurn: vi.fn(() => ({ turnId: 'root:serialized', viewId: 'view-serialized' })),
      sourceState: vi.fn(() => ({ memoryBodyIds: ['project'] })),
    }
    const source = { forAgent: vi.fn(() => ({ service: memoryService, runtimeMemory: {}, documents: {}, memoryViews })) }
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, undefined, toolRegistry().value)
    const signal = new AbortController().signal

    const initial = coordinator.recall(parent(), { query: 'initial query' }, signal, { requirePinnedView: true })
    const refined = coordinator.recall(parent(), { query: 'refined query' }, signal, { requirePinnedView: true })
    expect(memoryService.search).toHaveBeenCalledOnce()
    finishInitial({
      query: 'initial query',
      mode: 'smart',
      results: [{ id: 'initial', content: 'Initial evidence.', relevanceTier: 'high', memoryBodyId: 'project' }],
    })

    await expect(initial).resolves.toMatchObject({ results: [{ id: 'initial' }] })
    await expect(refined).resolves.toMatchObject({ results: [{ id: 'refined' }] })
    expect(memoryService.search).toHaveBeenCalledTimes(2)
  })

  it('does not consume the refinement claim when its Provider query fails', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    vi.mocked(memoryService.search)
      .mockResolvedValueOnce({
        query: 'initial query',
        mode: 'smart',
        results: [{ id: 'initial', content: 'Initial evidence.', relevanceTier: 'high', memoryBodyId: 'project' }],
      } as never)
      .mockRejectedValueOnce(new Error('temporary provider failure'))
      .mockResolvedValueOnce({
        query: 'refined query',
        mode: 'smart',
        results: [{ id: 'refined', content: 'Recovered evidence.', relevanceTier: 'high', memoryBodyId: 'project' }],
      } as never)
    const memoryViews = {
      activeTurn: vi.fn(() => ({ turnId: 'root:retry', viewId: 'view-retry' })),
      sourceState: vi.fn(() => ({ memoryBodyIds: ['project'] })),
    }
    const source = { forAgent: vi.fn(() => ({ service: memoryService, runtimeMemory: {}, documents: {}, memoryViews })) }
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, undefined, toolRegistry().value)
    const signal = new AbortController().signal

    await coordinator.recall(parent(), { query: 'initial query' }, signal, { requirePinnedView: true })
    await expect(coordinator.recall(parent(), { query: 'refined query' }, signal, { requirePinnedView: true })).rejects.toThrow('temporary provider failure')
    await expect(coordinator.recall(parent(), { query: 'refined query' }, signal, { requirePinnedView: true })).resolves.toMatchObject({
      results: [{ id: 'refined', content: 'Recovered evidence.' }],
      hint: expect.stringContaining('Recall refinement is complete'),
    })
    expect(memoryService.search).toHaveBeenCalledTimes(3)
    expect(coordinator.snapshot()).toMatchObject({ recalls: 2, failures: 1 })
  })

  it('derives a child read from its root parent turn with no model-facing capability', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    const memoryViews = {
      activeTurn: vi.fn((agentId: string) => agentId === 'root' ? { turnId: 'root:1', viewId: 'view-pinned' } : undefined),
      sourceState: vi.fn(() => ({ memoryBodyIds: ['project'] })),
    }
    const source = { forAgent: vi.fn(() => ({ service: memoryService, runtimeMemory: {}, documents: {}, memoryViews })) }
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, undefined, toolRegistry().value)
    const child = parent('subagent')
    child.session.header!.parentSession = 'root'

    expect(coordinator.scopeRecallRequest(child, { query: 'database choice' })).toEqual({ query: 'database choice', memoryBodyIds: ['project'] })
    expect(() => coordinator.scopeRecallRequest(child, { query: 'database choice', memoryBodyIds: ['outside'] })).toThrow('outside pinned Source')
    expect(coordinator.scopeRelatedMemoryBody(child)).toBe('project')
    expect(() => coordinator.scopeRelatedMemoryBody(child, 'outside')).toThrow('outside pinned Source')
    await expect(coordinator.recall(child, { query: 'database choice' }, new AbortController().signal)).resolves.not.toHaveProperty('selectedMemoryBodyIds')
    expect(memoryViews.activeTurn).toHaveBeenCalledWith('root')
    expect(host.start).not.toHaveBeenCalled()
  })

  it('fails closed without pinned authority and executes bounded Related directly when authorized', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    const memoryViews = {
      activeTurn: vi.fn(() => undefined as { turnId: string; viewId: string } | undefined),
      sourceState: vi.fn(() => ({ memoryBodyIds: ['project'] })),
    }
    const source = { forAgent: vi.fn(() => ({ service: memoryService, runtimeMemory: {}, documents: {}, memoryViews })) }
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, undefined, toolRegistry().value)
    const signal = new AbortController().signal

    await expect(coordinator.recall(parent(), { query: 'database choice' }, signal, { requirePinnedView: true })).rejects.toThrow('MemorySource generation pinned')
    const child = parent('subagent')
    child.session.header!.parentSession = 'root'
    await expect(coordinator.recall(child, { query: 'database choice' }, signal, { requirePinnedView: true })).rejects.toThrow('MemorySource generation pinned')
    expect(memoryService.search).not.toHaveBeenCalled()

    memoryViews.activeTurn.mockReturnValue({ turnId: 'root:2', viewId: 'view-pinned' })
    await coordinator.recall(parent(), { query: 'SQLite' }, signal, { requirePinnedView: true })
    vi.mocked(memoryService.related).mockResolvedValue([
      { id: 'duplicate', content: 'SQLite', memoryBodyId: 'project', memoryBodyName: 'Project' },
      { id: 'm2', content: 'Related fact', memoryBodyId: 'project', memoryBodyName: 'Project' },
    ])
    await expect(coordinator.related(parent(), 'm1', undefined, signal, { depth: 3, edge: 'causal', requirePinnedView: true })).resolves.toMatchObject({
      query: 'related:m1',
      mode: 'related',
      results: [{ id: 'm2', content: 'Related fact', memoryBodyId: 'project', memoryBodyName: 'Project' }],
      hint: expect.stringContaining('Related traversal is complete'),
    })
    await expect(coordinator.related(parent(), 'm1', undefined, signal, { depth: 3, edge: 'causal', requirePinnedView: true })).resolves.toMatchObject({
      results: [{ id: 'm2', content: 'Related fact', memoryBodyId: 'project', memoryBodyName: 'Project' }],
      hint: expect.stringContaining('exact Related traversal already ran'),
    })
    expect(memoryService.related).toHaveBeenCalledWith('m1', 3, 'causal', signal, 'project')
    expect(memoryService.related).toHaveBeenCalledOnce()
    expect(host.start).not.toHaveBeenCalled()
  })

  it('captures a schema-validated result through the one-run tool without DSH structured output', async () => {
    const resultTools = toolRegistry()
    const dispose = vi.fn(async () => {})
    const concludeTurn = vi.fn()
    const child = parent('subagent')
    child.id = 'child-run-1'
    const start = vi.fn(async (_provider: string, request: { outputSchema?: unknown; toolFilter?: { allow?: string[] } }) => {
      expect(request.outputSchema).toBeUndefined()
      const definition = resultTools.definitions.at(-1)!
      expect(request.toolFilter?.allow).toContain(definition.name)
      const outerToken = Symbol('run-code')
      const execution = { name: definition.name, token: Symbol('result'), parent: outerToken, agent: child, signal: new AbortController().signal, concludeTurn }
      await definition.execute({
        summary: 'Stored in project.',
        action: 'stored',
        memoryBodyIds: ['project'],
      } as never, execution)
      await expect(definition.execute({
        summary: 'Duplicate.', action: 'skipped', memoryBodyIds: [],
      } as never, { ...execution, token: Symbol('duplicate') })).rejects.toThrow('already recorded')
      resultTools.emit('tools/result', execution, { isError: false })
      resultTools.emit('tools/result', { name: 'run_code', token: outerToken, signal: execution.signal, agent: child }, { isError: false })
      return { id: child.id, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose }
    })
    const host = {
      list: vi.fn(() => ['spawn']),
      getProvider: vi.fn(() => ({ capabilities: { ...capabilities, outputSchema: false } })),
      start,
    } as unknown as HostSubagentsService
    const coordinator = new MnemonSubagentCoordinator(host, undefined, undefined, resultTools.value)

    await expect(coordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      action: 'stored',
      memoryBodyIds: ['project'],
    })
    expect(concludeTurn).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    for (const disposer of resultTools.disposers) expect(disposer).toHaveBeenCalledOnce()
  })

  it('rejects a result captured from any child other than the run that owns the tool', async () => {
    const resultTools = toolRegistry()
    const intruder = parent('subagent')
    intruder.id = 'different-child'
    const host = {
      list: vi.fn(() => ['spawn']),
      getProvider: vi.fn(() => ({ capabilities })),
      start: vi.fn(async () => {
        const definition = resultTools.definitions.at(-1)!
        const execution = { name: definition.name, token: Symbol('intruder'), agent: intruder, signal: new AbortController().signal, concludeTurn: vi.fn() }
        await definition.execute({
          summary: 'Wrong child.', action: 'skipped', memoryBodyIds: [],
        } as never, execution)
        resultTools.emit('tools/result', execution, { isError: false })
        return { id: 'child-run-1', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: vi.fn(async () => {}) }
      }),
    } as unknown as HostSubagentsService
    const coordinator = new MnemonSubagentCoordinator(host, undefined, undefined, resultTools.value)

    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('recorded by a different child')
    for (const disposer of resultTools.disposers) expect(disposer).toHaveBeenCalledOnce()
  })

  it('rejects malformed result-tool arguments before accepting the child result', async () => {
    const resultTools = toolRegistry()
    const child = parent('subagent')
    child.id = 'child-run-1'
    const host = {
      list: vi.fn(() => ['spawn']),
      getProvider: vi.fn(() => ({ capabilities })),
      start: vi.fn(async () => {
        await resultTools.definitions.at(-1)!.execute({ action: 'stored', memoryBodyIds: [] } as never, {
          agent: child, signal: new AbortController().signal, concludeTurn: vi.fn(),
        })
        throw new Error('unreachable')
      }),
    } as unknown as HostSubagentsService
    const coordinator = new MnemonSubagentCoordinator(host, undefined, undefined, resultTools.value)

    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('result.summary is required')
    for (const disposer of resultTools.disposers) expect(disposer).toHaveBeenCalledOnce()
  })

  it('recovers a committed write receipt without retrying the mutation', async () => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Use SQLite.', memoryBodyId: 'project' }, {
        action: 'added',
        message: 'Stored durable project memory.',
        memoryBodyId: 'project',
        memoryBodyName: 'Project',
      })
    })
    const coordinator = new MnemonSubagentCoordinator(host.value, undefined, undefined, resultTools.value)

    await expect(coordinator.remember(parent(), { content: 'Use SQLite.', memoryBodyId: 'project' }, new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      action: 'added',
      summary: 'Stored durable project memory.',
      memoryBodyIds: ['project'],
    })
    expect(host.start).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ writes: 1, failures: 0 })
  })

  it('commits a nested Code Mode receipt only after the enclosing run_code succeeds', async () => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      const outerToken = Symbol('run-code')
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Use SQLite.' }, {
        action: 'added', memoryBodyId: 'project', memoryBodyName: 'Project',
      }, outerToken)
      resultTools.emit('tools/result', {
        name: 'run_code', arguments: {}, token: outerToken, agent: child, signal: new AbortController().signal,
      }, { isError: false, value: null })
    })
    const coordinator = new MnemonSubagentCoordinator(host.value, undefined, undefined, resultTools.value)

    await expect(coordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)).resolves.toMatchObject({
      action: 'added', memoryBodyIds: ['project'],
    })
  })

  it('discards a nested receipt when the enclosing Code Mode call fails', async () => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      const outerToken = Symbol('run-code')
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Use SQLite.' }, {
        action: 'added', memoryBodyId: 'project', memoryBodyName: 'Project',
      }, outerToken)
      resultTools.emit('tools/result', {
        name: 'run_code', arguments: {}, token: outerToken, agent: child, signal: new AbortController().signal,
      }, { isError: true })
    })
    const coordinator = new MnemonSubagentCoordinator(host.value, undefined, undefined, resultTools.value)

    await expect(coordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)).rejects.toThrow('completed without recording its result')
  })

  it('does not recover partial or failed child runs from unrelated successful tools', async () => {
    const resultTools = toolRegistry()
    const partial = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_memory_body_create', { name: 'Project', description: 'Project decisions.' }, {
        id: 'project', name: 'Project', description: 'Project decisions.',
      })
    })
    const partialCoordinator = new MnemonSubagentCoordinator(partial.value, undefined, undefined, resultTools.value)
    await expect(partialCoordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)).rejects.toThrow('completed without recording its result')

    const failedTools = toolRegistry()
    const failed = observedSubagents(failedTools, child => {
      emitSuccessfulToolResult(failedTools, child, 'mnemon_remember', { content: 'Use SQLite.' }, {
        action: 'added', memoryBodyId: 'project', memoryBodyName: 'Project',
      })
    }, 'error')
    const failedCoordinator = new MnemonSubagentCoordinator(failed.value, undefined, undefined, failedTools.value)
    await expect(failedCoordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)).rejects.toThrow('stopped with error')
  })

  it('fails closed when a child completes without a terminal result or matching successful tool receipt', async () => {
    const host = subagents(undefined)
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('completed without recording its result')
    expect(host.dispose).toHaveBeenCalledOnce()
  })

  it('delegates writes with mutation tools and returns a compact receipt', async () => {
    const host = subagents({ summary: 'Stored in project.', action: 'stored', memoryBodyIds: ['project'] })
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.remember(parent(), { content: 'Durable choice' }, new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      action: 'stored',
      memoryBodyIds: ['project'],
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: expect.arrayContaining(['mnemon_recall', 'mnemon_remember', 'mnemon_memory_body_create', 'mnemon_memory_body_merge']) },
    }))
    expect((host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }> }])[1].prompt[0]!.text).not.toMatch(/catalog_json|request_json|dbPath/)
  })

  it('selects a provider in a tool-free child and keeps user policy out of the persona', async () => {
    const host = subagents({
      providerId: 'openviking',
      reason: 'A shared remote scope matches this team knowledge body.',
      confidence: 'high',
    })
    const coordinator = createCoordinator(host.value)
    const placementCandidates: MemoryPlacementCandidate[] = [
      {
        id: 'mnemon-native', label: 'Mnemon Native', kind: 'local', configured: true, summary: 'Local exact memory.',
        capabilities: { search: true, browse: true, graph: true, entities: true, related: true, remember: true, link: true, forget: true, writeMode: 'exact', deletionMode: 'soft' },
      },
      {
        id: 'openviking', label: 'OpenViking', kind: 'remote', configured: true, summary: 'Shared extracting memory.',
        capabilities: { search: true, browse: true, graph: false, entities: false, related: false, remember: true, link: false, forget: false, writeMode: 'async-extracting', deletionMode: 'hard' },
      },
    ]
    const prepared = prepareMemoryPlacement({ mode: 'automatic', prompt: '团队知识优先 OpenViking。' }, placementCandidates)

    await expect(coordinator.placeProvider(parent(), {
      name: '团队发布经验',
      description: '跨成员共享发布门禁与回滚经验。',
    }, prepared, new AbortController().signal)).resolves.toMatchObject({
      providerId: 'openviking',
      decidedBy: 'llm',
      runId: 'child-run-1',
    })

    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: [expect.stringMatching(/^mnemon_subagent_result_/)] },
      maxDepth: 1,
      persona: expect.stringContaining('host-filtered eligible list'),
    }))
    const request = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string }])[1]
    expect(request.prompt[0]!.text).toContain('团队知识优先 OpenViking。')
    expect(request.persona).not.toContain('团队知识优先 OpenViking。')
    expect(request.persona).not.toMatch(/api.?key|endpoint|secret/iu)
    expect(coordinator.snapshot()).toMatchObject({ placements: 1, lastOperation: 'placement' })
  })

  it('curates metadata in a read-only child and keeps valid entries when another candidate is invalid', async () => {
    const host = subagents({
      summary: 'Updated one scope.',
      updates: [
        { memoryBodyId: 'product', title: '产品决策', description: '记录稳定的产品范围、取舍与依据，在规划和复盘产品方向时召回。' },
        { memoryBodyId: 'release', title: 'x'.repeat(49), description: '沉淀发布门禁、部署约束和回滚经验，在准备上线或处理故障时召回。' },
      ],
    })
    const memoryService = service()
    const runtime = { forAgent: vi.fn(() => ({ service: memoryService })) } as never
    const coordinator = createCoordinator(host.value, runtime)

    await expect(coordinator.maintainMetadata(parent(), ['product', 'release'], new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      runId: 'child-run-1',
      updates: [{ memoryBodyId: 'product', title: '产品决策' }],
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: [expect.stringMatching(/^mnemon_subagent_result_/)] },
      agentOptions: { maxTokens: 16_384 },
      persona: expect.stringContaining('fastest bounded metadata-sampling path'),
    }))
    expect(memoryService.metadataSample).toHaveBeenCalledWith('product', expect.any(AbortSignal))
    expect(memoryService.metadataSample).toHaveBeenCalledWith('release', expect.any(AbortSignal))
    const metadataCall = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }> }])[1]
    expect(metadataCall.prompt[0]!.text).toContain('sampling method: native-basic')
    expect(metadataCall.prompt[0]!.text).toContain('The product keeps durable architecture decisions.')
    expect(metadataCall.prompt[0]!.text).not.toMatch(/dbPath|endpoint|api.?key/iu)
    expect(coordinator.snapshot()).toMatchObject({ metadataMaintenances: 1, lastOperation: 'metadata-maintenance' })

    const incomplete = subagents({ summary: 'Only one.', updates: [{ memoryBodyId: 'product', title: '产品决策', description: '记录稳定的产品范围与取舍，在规划和复盘产品方向时召回。' }] })
    await expect(createCoordinator(incomplete.value, runtime).maintainMetadata(parent(), ['product', 'release'], new AbortController().signal)).resolves.toMatchObject({
      updates: [{ memoryBodyId: 'product' }],
    })

    const invalid = subagents({ summary: 'No valid metadata.', updates: [{ memoryBodyId: 'product', title: 'x', description: 'too short' }] })
    await expect(createCoordinator(invalid.value, runtime).maintainMetadata(parent(), ['product'], new AbortController().signal)).resolves.toMatchObject({ updates: [] })
  })

  it('reviews a completed full-context checkpoint through fork with a maintenance-only tool set', async () => {
    const host = subagents({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] }, 'completed', ['spawn', 'fork'])
    const coordinator = createCoordinator(host.value)

    await expect(coordinator.review(parent(), new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      provider: 'fork',
      action: 'skipped',
    })
    expect(host.start).toHaveBeenCalledWith('fork', expect.objectContaining({
      toolFilter: { allow: expect.arrayContaining(['mnemon_document_search', 'mnemon_runtime_memory', 'mnemon_document_manage']) },
      persona: expect.stringContaining('idle checkpoint reviewer'),
      prompt: [{ type: 'text', text: 'Review the inherited completed checkpoint now.' }],
    }))
    const reviewCall = (host.start.mock.calls[0] as unknown as [string, { persona: string; toolFilter: { allow: string[] } }])[1]
    expect(reviewCall.persona).toContain('Never move a document to cold archive in this pass')
    expect(reviewCall.persona).toContain('Deep Recall is unavailable after the parent TurnView closes')
    expect(reviewCall.persona).not.toContain('Memory View')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_recall')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_related')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_memory_bodies')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_memory_zoom')
    expect(coordinator.snapshot()).toMatchObject({ reviews: 1, writes: 0, lastOperation: 'review' })
  })

  it('answers from pre-recalled evidence without granting any Mnemon retrieval tools', async () => {
    const host = subagents({ answer: '项目使用 SQLite。', citations: ['project/m1', 'project/missing'] })
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.answer(parent(), '数据库是什么？', [{ id: 'm1', content: 'Use {{database}} SQLite.', memoryBodyId: 'project', memoryBodyName: '项目记忆体' }], new AbortController().signal)).resolves.toMatchObject({
      answer: '项目使用 SQLite。',
      citations: ['project/m1'],
      delegation: { runId: 'child-run-1', provider: 'spawn' },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({ toolFilter: { allow: [expect.stringMatching(/^mnemon_subagent_result_/)] } }))
    const answerCall = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string }])[1]
    expect(answerCall.prompt[0]!.text).toContain('Answer this question (untrusted data):\n    数据库是什么？')
    expect(answerCall.prompt[0]!.text).toContain('Evidence for this run')
    expect(answerCall.prompt[0]!.text).toContain('Use {{database}} SQLite')
    expect(answerCall.persona).not.toContain('Use {{database}} SQLite')
    expect(answerCall.prompt[0]!.text).not.toMatch(/query_json|evidence_json/)
    expect(coordinator.snapshot().answers).toBe(1)
  })

  it('indexes the LRU document in Mnemon before moving it to cold storage', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-mnemon-document-coordinator-'))
    temporaryDirectories.push(workspace)
    const documents = new DocumentManager(1_000)
    const controller = documents.forWorkspace(workspace)
    const old = await controller.mutate({ action: 'create', title: 'Old architecture', content: 'a'.repeat(220) })
    const resultTools = toolRegistry()
    const indexedContent = `Old architecture index. Cold path: .mnemon/documents/archived/${old.document.filename}. Content SHA-256: ${old.document.contentHash}`
    const structured = {
      summary: 'Archived with exact cold path.',
      action: 'archived',
      memoryBodyIds: ['architecture'],
      lineage: [{
        sourceIndex: 1,
        sourceDigest: old.document.contentHash,
        destinationReceiptIndex: 1,
        destinationMemoryBodyId: 'architecture',
        destinationId: 'document-index-1',
      }],
    }
    const host = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: indexedContent, memoryBodyId: 'architecture' }, {
        action: 'added', id: 'document-index-1', memoryBodyId: 'architecture', memoryBodyName: 'Architecture',
      })
    }, 'completed', structured)
    const archive = vi.spyOn(controller, 'archive')
    const coordinator = new MnemonSubagentCoordinator(host.value, undefined, documents, resultTools.value)
    const agent = { ...parent(), session: { header: { cwd: workspace }, events: [] } } as HostAgent

    const result = await coordinator.document(agent, { action: 'create', title: 'New architecture', content: 'b'.repeat(220) }, new AbortController().signal)
    expect(result).toMatchObject({
      action: 'created',
      maintenance: { archivedDocumentIds: [old.document.id], memoryBodyIds: ['architecture'] },
    })
    expect(controller.get(old.document.id)).toMatchObject({ status: 'archived', archiveSummary: 'Archived with exact cold path.' })
    expect(archive).toHaveBeenCalledWith(old.document.id, old.document.revision, expect.objectContaining({
      memoryBodyIds: ['architecture'],
      lineage: [{
        source: { layerId: 'documents', reference: `document:${old.document.id}:${old.document.revision}`, digest: old.document.contentHash },
        destination: {
          layerId: 'memory-spaces',
          reference: 'memory-space:architecture/item:document-index-1',
          digest: createHash('sha256').update(indexedContent).digest('hex'),
        },
      }],
    }))
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      persona: expect.stringContaining('cold-document archive worker'),
      toolFilter: { allow: expect.arrayContaining(['mnemon_memory_bodies', 'mnemon_recall', 'mnemon_remember', 'mnemon_memory_body_create']) },
    }))
    const archiveCall = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string }])[1]
    expect(archiveCall.prompt[0]!.text).toContain(`.mnemon/documents/archived/${old.document.filename}`)
    expect(archiveCall.persona).not.toContain(old.document.filename)
    expect(coordinator.snapshot()).toMatchObject({ documentArchives: 1, lastOperation: 'document-archive' })
  })

  it('keeps a document active when its destination receipt omits the exact cold reference', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-mnemon-document-lineage-'))
    temporaryDirectories.push(workspace)
    const documents = new DocumentManager()
    const controller = documents.forWorkspace(workspace)
    const created = await controller.mutate({ action: 'create', title: 'Release gates', content: 'Canary before production.' })
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'An unrelated release note.', memoryBodyId: 'release' }, {
        action: 'added', id: 'release-note-1', memoryBodyId: 'release', memoryBodyName: 'Release',
      })
    }, 'completed', {
      summary: 'Indexed.',
      action: 'archived',
      memoryBodyIds: ['release'],
      lineage: [{
        sourceIndex: 1,
        sourceDigest: created.document.contentHash,
        destinationReceiptIndex: 1,
        destinationMemoryBodyId: 'release',
        destinationId: 'release-note-1',
      }],
    })
    const archive = vi.spyOn(controller, 'archive')
    const coordinator = new MnemonSubagentCoordinator(host.value, undefined, documents, resultTools.value)
    const agent = { ...parent(), session: { header: { cwd: workspace }, events: [] } } as HostAgent

    await expect(coordinator.archiveDocument(agent, created.document.id, new AbortController().signal))
      .rejects.toThrow('does not contain the exact cold path and content digest')
    expect(archive).not.toHaveBeenCalled()
    expect(controller.get(created.document.id).status).toBe('active')
  })

  it('uses bounded routing excerpts, then batch-archives exact sources and commits atomically', async () => {
    const plan = maintenancePlan()
    plan.entries[1]!.content = `发布历史 ${'金丝雀门禁'.repeat(500)}`
    plan.pending = { content: `未提交变更 ${'待'.repeat(2_000)}`, importance: 'normal' }
    const structured = {
      summary: 'Route both committed entries to project memory.',
      action: 'planned',
      routes: [{ sourceIndexes: [1, 2], memoryBodyId: 'project' }],
    }
    const resultTools = toolRegistry()
    const host = subagents(structured)
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({
        success: true,
        message: 'Entry added.',
        target: 'memory',
        entryCount: 2,
        usage: { used: 120, limit: 10_240 },
        added: plan.pending!.content,
      })),
    } as unknown as RuntimeMemoryController
    const memoryService = service()
    addSecondWritableBody(memoryService)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, undefined, resultTools.value)
    const request = { action: 'add', target: 'memory', content: plan.pending!.content } as const

    await expect(coordinator.runtime(parent(), request, new AbortController().signal)).resolves.toMatchObject({
      added: plan.pending.content,
      maintenance: { kind: 'mnemon-archive', provider: 'spawn', memoryBodyIds: ['project'] },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: [expect.stringMatching(/^mnemon_subagent_result_/)] },
      agentOptions: { maxTokens: 32_768 },
    }))
    const migrationCall = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string; toolFilter: { allow: string[] } }])[1]
    const migrationPrompt = migrationCall.prompt[0]!.text
    expect(migrationPrompt).toContain('Route this bounded MEMORY.md archive batch now')
    expect(migrationPrompt).toContain('Project uses pnpm.')
    expect(migrationPrompt).toContain('发布历史')
    expect(migrationPrompt).toContain('[... host-truncated routing excerpt ...]')
    expect(migrationPrompt).not.toContain(plan.pending.content)
    expect(migrationPrompt).not.toContain(plan.entries[1]!.content)
    expect(migrationPrompt).toContain('id=project')
    expect(migrationPrompt).toContain('id=release')
    expect(migrationPrompt).toContain('<runtime-memory-routing-excerpts>')
    expect(Buffer.byteLength(migrationPrompt, 'utf8')).toBeLessThan(8 * 1024)
    expect(migrationCall.persona).toContain('proposal has no data-plane authority')
    expect(migrationCall.persona).toContain('bulk-imports exact source entries')
    expect(migrationCall.persona).toContain('Excerpts may be host-truncated')
    expect(migrationCall.persona).toContain('USER.md preferences are outside this task and must never enter')
    expect(migrationCall.persona).toContain('Do not call task tools')
    expect(migrationCall.persona).not.toContain('<runtime-memory-routing-excerpts>')
    expect(migrationPrompt).not.toMatch(/catalog_json|runtime_entries_json|pending_mutation_json|current_usage_json|created_at|markdownPath|dbPath/)
    const resultSchema = (resultTools.definitions[0] as unknown as { parameters: unknown }).parameters
    expect(JSON.stringify(resultSchema)).not.toContain('compactedEntries')
    expect(memoryService.rememberMany).toHaveBeenCalledOnce()
    expect(memoryService.rememberMany).toHaveBeenCalledWith([
      { content: plan.entries[0]!.content, category: 'context', importance: 3, source: 'agent', memoryBodyId: 'project' },
      { content: plan.entries[1]!.content, category: 'context', importance: 5, source: 'agent', memoryBodyId: 'project' },
    ], expect.any(AbortSignal))
    expect(memoryService.remember).not.toHaveBeenCalled()
    expect(memoryService.createBody).not.toHaveBeenCalled()
    expect(runtime.compactAndMutate).toHaveBeenCalledWith(
      plan.revision,
      request,
      plan.entries.map(({ content, importance }) => ({ content, importance })),
      expect.any(Number),
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({ reference: `runtime:${plan.revision}:memory:1` }),
          destination: expect.objectContaining({ layerId: 'memory-spaces', reference: expect.stringContaining('memory-space:project/item:stored-') }),
        }),
      ]),
    )
    expect(runtime.mutate).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ migrations: 1, lastOperation: 'migration' })
  })

  it('completes the dense Chinese capacity reproduction without starting a model worker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-integration-'))
    temporaryDirectories.push(directory)
    const runtime = new RuntimeMemoryController({ effectiveDataDir: () => directory })
    const anchor = `项目锚点 ${'a'.repeat(220)}`
    const archived = `历史约束 ${'中'.repeat(2_550)}`
    const pending = `新增约束 ${'文'.repeat(2_550)}`
    await runtime.mutate({ action: 'add', target: 'memory', content: anchor })
    await runtime.mutate({ action: 'add', target: 'memory', content: archived })
    const host = subagents(undefined)
    const memoryService = service()
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, undefined, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: pending }, new AbortController().signal)).resolves.toMatchObject({
      added: pending,
      maintenance: { kind: 'mnemon-archive', provider: 'host', memoryBodyIds: ['project'] },
    })
    expect(host.start).not.toHaveBeenCalled()
    expect(memoryService.rememberMany).toHaveBeenCalledOnce()
    expect(vi.mocked(memoryService.rememberMany).mock.calls[0]![0].map(request => request.content)).toEqual([anchor, archived])
    expect(memoryService.remember).not.toHaveBeenCalled()
    expect(runtime.snapshot().entries.map(entry => entry.content)).toEqual([pending])
    expect(coordinator.snapshot()).toMatchObject({ migrations: 1, lastOperation: 'migration', lastRunId: expect.stringMatching(/^host-/) })
  })

  it('fails before model work when no existing active writable Memory Space can receive an archive', async () => {
    const plan = maintenancePlan()
    const host = subagents(undefined)
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeMemoryController
    const memoryService = service()
    vi.mocked(memoryService.bodyDirectory).mockReturnValue({
      ...memoryService.bodyDirectory(),
      items: [],
      total: 0,
      activeCount: 0,
    })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, undefined, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('existing active writable Memory Space')
    expect(host.start).not.toHaveBeenCalled()
    expect(memoryService.rememberMany).not.toHaveBeenCalled()
    expect(memoryService.remember).not.toHaveBeenCalled()
    expect(runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('enforces automatic Memory Space write participation before capacity archival', async () => {
    const plan = maintenancePlan()
    const host = subagents(undefined)
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeMemoryController
    const memoryService = service()
    const source = runtimeSource(runtime, memoryService)
    const graph = source.forAgent(parent())
    vi.mocked(graph.memoryKernel.assertParticipation).mockImplementation(() => {
      throw new Error('memory layer memory-spaces allows write only for manual operations')
    })
    vi.mocked(source.forAgent).mockReturnValue(graph)

    await expect(new MnemonSubagentCoordinator(host.value, source as never, undefined, toolRegistry().value)
      .runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('allows write only for manual operations')
    expect(graph.memoryKernel.assertParticipation).toHaveBeenCalledWith('memory-spaces', 'write', 'automatic')
    expect(host.start).not.toHaveBeenCalled()
    expect(memoryService.rememberMany).not.toHaveBeenCalled()
    expect(memoryService.remember).not.toHaveBeenCalled()
  })

  it('rejects incomplete or invalid routes before any Provider write', async () => {
    const plan = maintenancePlan()
    const host = subagents({
      summary: 'Incomplete route.',
      action: 'planned',
      routes: [{ sourceIndexes: [1], memoryBodyId: 'project' }],
    })
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeMemoryController
    const memoryService = service()
    addSecondWritableBody(memoryService)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, undefined, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('omitted committed archive sources')
    expect(memoryService.rememberMany).not.toHaveBeenCalled()
    expect(memoryService.remember).not.toHaveBeenCalled()
    expect(runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('accepts a skipped archive write only after exact Host recall verification', async () => {
    const sourceEntry = { content: 'Use SQLite for local storage.', importance: 'normal' as const }
    const plan = maintenancePlan('memory', [sourceEntry])
    const host = subagents({
      summary: 'Route existing SQLite fact.',
      action: 'planned',
      routes: [{ sourceIndexes: [1], memoryBodyId: 'project' }],
    })
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, target: 'memory', added: plan.pending!.content, usage: { used: 20, limit: 10_240 } })),
    } as unknown as RuntimeMemoryController
    const memoryService = service()
    vi.mocked(memoryService.rememberMany).mockResolvedValueOnce([{ action: 'skipped', memoryBodyId: 'project' }])
    vi.mocked(memoryService.search).mockResolvedValueOnce({
      query: sourceEntry.content,
      mode: 'smart',
      results: [{ id: 'sqlite-1', content: sourceEntry.content, memoryBodyId: 'project', memoryBodyName: 'Project' }],
    } as never)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, undefined, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .resolves.toMatchObject({ maintenance: { kind: 'mnemon-archive', memoryBodyIds: ['project'] } })
    expect(runtime.compactAndMutate).toHaveBeenCalledWith(plan.revision, expect.any(Object), [sourceEntry], expect.any(Number), [{
      source: {
        layerId: 'runtime',
        reference: `runtime:${plan.revision}:memory:1`,
        digest: createHash('sha256').update(JSON.stringify(sourceEntry)).digest('hex'),
      },
      destination: {
        layerId: 'memory-spaces',
        reference: 'memory-space:project/item:sqlite-1',
        digest: createHash('sha256').update(sourceEntry.content).digest('hex'),
      },
    }])
  })

  it('checks revision again before Provider writes and rejects asynchronous acceptance', async () => {
    const plan = maintenancePlan('memory', [{ content: 'Use pnpm.', importance: 'normal' }])
    const structured = {
      summary: 'Route pnpm fact.',
      action: 'planned',
      routes: [{ sourceIndexes: [1], memoryBodyId: 'project' }],
    }
    const staleRuntime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, revision: 'concurrent-revision' }),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeMemoryController
    const staleService = service()
    await expect(new MnemonSubagentCoordinator(subagents(structured).value, runtimeSource(staleRuntime, staleService) as never, undefined, toolRegistry().value)
      .runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('no archive writes were attempted')
    expect(staleService.rememberMany).not.toHaveBeenCalled()
    expect(staleService.remember).not.toHaveBeenCalled()

    const queuedRuntime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeMemoryController
    const queuedService = service()
    vi.mocked(queuedService.rememberMany).mockResolvedValueOnce([{ action: 'queued', status: 'pending', taskId: 'task-slow', memoryBodyId: 'project' }])
    await expect(new MnemonSubagentCoordinator(subagents(structured).value, runtimeSource(queuedRuntime, queuedService) as never, undefined, toolRegistry().value)
      .runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('did not commit synchronously')
    expect(queuedRuntime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('compacts USER.md locally with complete source coverage and never grants Mnemon tools', async () => {
    const host = subagents({
      summary: 'Merged two compatible profile preferences locally.',
      action: 'compacted',
      compactedEntries: [{
        content: 'User prefers concise Chinese release notes with blockers first.',
        importance: 'critical',
        sourceIndexes: [1, 2],
      }],
    })
    const plan = maintenancePlan('user', [
      { content: 'User prefers concise {{language}} Chinese release notes.', importance: 'critical' },
      { content: 'User wants blockers listed first in release notes.', importance: 'normal' },
    ])
    plan.revision = 'user-revision'
    plan.pending = { content: 'User prefers direct answers.', importance: 'normal' }
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('user', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, message: 'Entry added.', target: 'user', entryCount: 2, usage: { used: 180, limit: 4_096 }, added: plan.pending!.content })),
    } as unknown as RuntimeMemoryController
    const coordinator = createCoordinator(host.value, runtime)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'user', content: 'User prefers direct answers.' }, new AbortController().signal)).resolves.toMatchObject({
      added: 'User prefers direct answers.',
      maintenance: { kind: 'local-compaction', memoryBodyIds: [] },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: [expect.stringMatching(/^mnemon_subagent_result_/)] },
      agentOptions: { maxTokens: 32_768 },
      persona: expect.stringContaining('local USER.md compactor'),
    }))
    const compactionCall = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string }])[1]
    const compactionPrompt = compactionCall.prompt[0]!.text
    expect(compactionPrompt).toContain('Run local USER.md compaction now')
    expect(compactionPrompt).toContain('User prefers direct answers.')
    expect(compactionPrompt).toContain('User prefers concise {{language}} Chinese release notes.')
    expect(compactionPrompt).toContain('<runtime-memory-snapshot target="user">')
    expect(compactionCall.persona).toContain('never send user preferences to Mnemon Memory Spaces')
    expect(compactionCall.persona).toContain('every source number must appear exactly once')
    expect(compactionCall.persona).not.toContain('{{language}}')
    expect(compactionCall.persona).not.toContain('<runtime-memory-snapshot')
    expect(runtime.compactAndMutate).toHaveBeenCalledWith(
      'user-revision',
      { action: 'add', target: 'user', content: 'User prefers direct answers.' },
      [{ content: 'User prefers concise Chinese release notes with blockers first.', importance: 'critical' }],
      expect.any(Number),
    )
    expect(runtime.mutate).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ compactions: 1, migrations: 0, lastOperation: 'compaction' })
  })

  it('rejects a USER.md compaction that omits any committed source entry', async () => {
    const host = subagents({
      summary: 'Incomplete candidate.',
      action: 'compacted',
      compactedEntries: [{ content: 'Only first preference.', importance: 'normal', sourceIndexes: [1] }],
    })
    const plan = maintenancePlan('user', [
      { content: 'First preference.', importance: 'normal' },
      { content: 'Second preference.', importance: 'normal' },
    ])
    plan.pending = { content: 'Pending preference.', importance: 'normal' }
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('user', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeMemoryController
    const coordinator = createCoordinator(host.value, runtime)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'user', content: 'Pending preference.' }, new AbortController().signal)).rejects.toThrow('omitted committed entries')
    expect(runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('disposes failed delegated writes and reports the bounded provider error', async () => {
    const failedChild = {
      ...parent('subagent'),
      session: { header: { origin: 'subagent' as const }, events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_ROUTE', message: 'provider rejected sk-secret123456' } } } }] },
    }
    const host = subagents(undefined, 'error', ['spawn'], failedChild)
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('stopped with error: MODEL_ROUTE: provider rejected [redacted]')
    expect(host.dispose).toHaveBeenCalledOnce()
    expect(coordinator.snapshot().failures).toBe(1)
  })

  it('uses the rc.8 provider diagnostic for a failed remote child', async () => {
    const host = subagents(undefined, 'error', ['spawn'], undefined, 'REMOTE_GATEWAY:  rejected   sk-secret123456')
    const coordinator = createCoordinator(host.value)

    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal))
      .rejects.toThrow('stopped with error: REMOTE_GATEWAY: rejected [redacted]')
    expect(host.dispose).toHaveBeenCalledOnce()
  })

  it('pins a fixed task Agent model onto the fork-based idle review delegation', async () => {
    const host = subagents({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] }, 'completed', ['spawn', 'fork'])
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(
      host.value,
      undefined,
      undefined,
      resultTools.value,
      () => ({ provider: 'pinned-provider', model: 'pinned-model' }),
    )

    await expect(coordinator.review(parent(), new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      provider: 'fork',
      action: 'skipped',
    })
    expect(host.start).toHaveBeenCalledWith('fork', expect.objectContaining({
      toolFilter: { allow: expect.arrayContaining(['mnemon_document_search', 'mnemon_runtime_memory', 'mnemon_document_manage']) },
      agentOptions: { provider: 'pinned-provider', model: 'pinned-model' },
    }))
  })

  it('omits provider/model from agentOptions when the task Agent model is inherited', async () => {
    const host = subagents({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] }, 'completed', ['spawn', 'fork'])
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(
      host.value,
      undefined,
      undefined,
      resultTools.value,
      () => undefined,
    )

    await expect(coordinator.review(parent(), new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      provider: 'fork',
    })
    const reviewCall = (host.start.mock.calls[0] as unknown as [string, { agentOptions?: unknown }])[1]
    expect(reviewCall.agentOptions).toBeUndefined()
  })

  it('merges a fixed task Agent model with the per-op maxTokens for short-lived delegates', async () => {
    const host = subagents({
      summary: 'Merged two compatible profile preferences locally.',
      action: 'compacted',
      compactedEntries: [{
        content: 'User prefers concise Chinese release notes with blockers first.',
        importance: 'critical',
        sourceIndexes: [1, 2],
      }],
    })
    const plan = maintenancePlan('user', [
      { content: 'User prefers concise {{language}} Chinese release notes.', importance: 'critical' },
      { content: 'User wants blockers listed first in release notes.', importance: 'normal' },
    ])
    plan.pending = { content: 'User prefers direct answers.', importance: 'normal' }
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('user', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, message: 'Entry added.', target: 'user', entryCount: 2, usage: { used: 180, limit: 4_096 }, added: plan.pending!.content })),
    } as unknown as RuntimeMemoryController
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(
      host.value,
      runtime,
      undefined,
      resultTools.value,
      () => ({ provider: 'pinned-provider', model: 'pinned-model' }),
    )

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'user', content: 'User prefers direct answers.' }, new AbortController().signal)).resolves.toMatchObject({
      maintenance: { kind: 'local-compaction' },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      agentOptions: { provider: 'pinned-provider', model: 'pinned-model', maxTokens: 32_768 },
    }))
  })
})

describe('Mnemon root/child tool split', () => {
  it('routes both root and child Recall through Host-pinned Source authority', async () => {
    const registered: ToolDefinition[] = []
    const memoryService = service()
    const coordinator = {
      recall: vi.fn(async () => ({ query: 'x', mode: 'smart', results: [] })),
      related: vi.fn(async () => ({ query: 'related:m1', mode: 'related', results: [{ id: 'm2', content: 'Related fact', memoryBodyId: 'project', memoryBodyName: '项目记忆体' }] })),
      runtime: vi.fn(async () => ({ success: true, message: 'Entry added.', target: 'user', entryCount: 1, usage: { used: 20, limit: 4096 } })),
    } as unknown as MnemonSubagentCoordinator
    const runtimeMemory = { mutate: vi.fn() } as unknown as RuntimeMemoryController
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.push(tool) } } } as unknown as HostContextShape, memoryService, coordinator, runtimeMemory, { forAgent: vi.fn() } as never)
    const recall = registered.find(tool => tool.name === 'mnemon_recall')!
    const schemas = registered.flatMap(tool => [tool.parameters, tool.output?.schema]).filter(Boolean)
    for (const schema of schemas) {
      const serialized = JSON.stringify(schema)
      expect(serialized).not.toMatch(/"(?:maxItems|minItems|minimum|maximum)":/)
    }
    const signal = new AbortController().signal

    const hotMemory = registered.find(tool => tool.name === 'mnemon_runtime_memory')!
    await hotMemory.execute({ action: 'add', target: 'user', content: 'Prefers concise replies', importance: 'critical' } as never, { agent: parent(), signal })
    expect(coordinator.runtime).toHaveBeenCalledWith(parent(), { action: 'add', target: 'user', content: 'Prefers concise replies', importance: 'critical' }, signal)
    await hotMemory.execute({ action: 'add', target: 'memory', content: 'Child fact' } as never, { agent: parent('subagent'), signal })
    expect(runtimeMemory.mutate).toHaveBeenCalledWith({ action: 'add', target: 'memory', content: 'Child fact' })

    await recall.execute({ query: 'root query' } as never, { agent: parent(), signal })
    expect(coordinator.recall).toHaveBeenNthCalledWith(1, parent(), { query: 'root query' }, signal, { requirePinnedView: true })
    expect(memoryService.search).not.toHaveBeenCalled()

    await recall.execute({ query: 'child query', memoryBodyIds: ['project'] } as never, { agent: parent('subagent'), signal })
    expect(coordinator.recall).toHaveBeenNthCalledWith(2, parent('subagent'), { query: 'child query', memoryBodyIds: ['project'] }, signal, { requirePinnedView: true })
    expect(memoryService.search).not.toHaveBeenCalled()

    const related = registered.find(tool => tool.name === 'mnemon_related')!
    await expect(related.execute({ id: 'm1', depth: 2, memoryBodyId: 'project' } as never, { agent: parent('subagent'), signal })).resolves.toEqual({
      query: 'related:m1',
      mode: 'related',
      results: [{ id: 'm2', content: 'Related fact', memoryBodyId: 'project', memoryBodyName: '项目记忆体' }],
    })
    expect(coordinator.related).toHaveBeenCalledWith(parent('subagent'), 'm1', 'project', signal, { depth: 2, requirePinnedView: true })
    expect(registered.some(tool => tool.name === 'mnemon_memory_zoom')).toBe(false)
    expect(JSON.stringify(recall.parameters)).not.toMatch(/viewId|viewNodeId|viewCapability/u)
    expect(JSON.stringify(recall.parameters)).toContain('do not list the catalog only to populate it')
    expect(registered.find(tool => tool.name === 'mnemon_memory_bodies')!.description).toContain('Never call it to route Recall')
    expect(hotMemory.description).toContain('answering a read question must stay read-only')
    expect(hotMemory.description).toContain('unless the user explicitly asks to save that exact evidence')
  })

  it('projects status as a bounded health summary without control-plane paths or detailed statistics', async () => {
    const registered: ToolDefinition[] = []
    const memoryService = service()
    vi.mocked(memoryService.status).mockResolvedValue({
      healthy: true,
      version: '0.3.0',
      dshMnemonVersion: '0.3.0',
      cliPath: '/private/bin/mnemon',
      commandFound: true,
      dataDir: '/private/mnemon-data',
      store: 'project',
      mnemonDefaultStore: 'project',
      dshActiveStores: ['project'],
      writeEnabled: true,
      timeoutMs: 30_000,
      defaultRecallLimit: 20,
      recallQuality: {},
      memoryBodyDirectory: '/private/mnemon-data/memory-bodies',
      memoryBodies: [
        { active: true, providerEnabled: true, healthy: true },
        { active: true, providerEnabled: true, healthy: false, error: 'connection refused' },
        { active: false, providerEnabled: false, healthy: false },
      ],
      providerServices: [{
        providerId: 'openviking', label: 'OpenViking', enabled: true, configured: true,
        status: 'unhealthy', memoryBodyCount: 2, activeMemoryBodyCount: 1, error: 'connection refused',
      }],
      stats: {
        totalInsights: 10, deletedInsights: 1, edgeCount: 4, oplogCount: 12, dbSizeBytes: 4096,
        byCategory: { decision: 9 }, topEntities: [{ entity: 'secret-project', count: 8 }], dbPath: '/private/project.db',
      },
    } as never)
    const coordinator = { recall: vi.fn(), runtime: vi.fn() } as unknown as MnemonSubagentCoordinator
    registerTools(
      { tools: { register: (tool: ToolDefinition) => { registered.push(tool) } } } as unknown as HostContextShape,
      memoryService,
      coordinator,
      { mutate: vi.fn() } as unknown as RuntimeMemoryController,
      {} as DocumentManager,
    )

    const status = await registered.find(tool => tool.name === 'mnemon_status')!.execute(
      {} as never,
      { agent: parent(), signal: new AbortController().signal },
    ) as Record<string, unknown>

    expect(status).toMatchObject({
      healthy: false,
      commandFound: true,
      writeEnabled: true,
      memorySpaces: { total: 3, active: 2, healthy: 1, unhealthy: 1, providerDisabled: 1 },
      aggregate: { totalInsights: 10, edgeCount: 4, dbSizeBytes: 4096 },
    })
    expect(JSON.stringify(status)).not.toMatch(/cliPath|dataDir|memoryBodyDirectory|dbPath|byCategory|topEntities|secret-project/)
    expect(JSON.stringify(status).length).toBeLessThan(2_000)
  })

  it('enforces automatic topology participation without hiding the management catalog', async () => {
    const registered: ToolDefinition[] = []
    const memoryService = {
      ...service(),
      config: resolveConfig({
        memoryTopology: {
          layers: {
            runtime: { participation: { write: 'manual' } },
            'memory-spaces': { enabled: false },
          },
        },
      }),
    } as MnemonService
    const coordinator = {
      recall: vi.fn(),
      runtime: vi.fn(),
    } as unknown as MnemonSubagentCoordinator
    const runtimeMemory = { mutate: vi.fn() } as unknown as RuntimeMemoryController
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.push(tool) } } } as unknown as HostContextShape, memoryService, coordinator, runtimeMemory, { forAgent: vi.fn() } as never)
    const signal = new AbortController().signal

    await expect(registered.find(tool => tool.name === 'mnemon_recall')!.execute(
      { query: 'blocked' } as never,
      { agent: parent(), signal },
    )).rejects.toThrow('memory layer memory-spaces is disabled')
    expect(() => registered.find(tool => tool.name === 'mnemon_runtime_memory')!.execute(
      { action: 'add', target: 'memory', content: 'blocked' } as never,
      { agent: parent(), signal },
    )).toThrow('allows write only for manual operations')
    const catalog = await registered.find(tool => tool.name === 'mnemon_memory_bodies')!.execute(
      {} as never,
      { agent: parent(), signal },
    ) as { total: number; items: unknown[] }
    expect(catalog).toMatchObject({ total: 1, omittedCount: 0 })
    expect(JSON.stringify(catalog)).not.toMatch(/dbPath|directory|settings|stats|apiKey/)
    expect(coordinator.recall).not.toHaveBeenCalled()
    expect(coordinator.runtime).not.toHaveBeenCalled()
  })
})
