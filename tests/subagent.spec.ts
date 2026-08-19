import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostAgent, HostContextShape, HostSubagentsService, ToolDefinition } from '../src/contracts.ts'
import { DocumentManager } from '../src/documents.ts'
import type { MnemonService } from '../src/service.ts'
import { assertDshOutputSchema, MnemonSubagentCoordinator } from '../src/subagent.ts'
import { prepareMemoryPlacement, type MemoryPlacementCandidate } from '../src/provider-placement.ts'
import { registerTools } from '../src/tools.ts'
import { RuntimeMemoryCapacityError, type RuntimeMemoryController } from '../src/runtime-memory.ts'

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
  return {
    config: { writeEnabled: true },
    bodies: vi.fn(async () => ({
      items: [{ id: 'project', name: '项目记忆体', description: '项目决策', active: true, dbPath: '/tmp/project.db', createdAt: 'now', updatedAt: 'now', healthy: true }],
      total: 1,
      activeCount: 1,
      directory: '/tmp',
      generatedAt: 'now',
    })),
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
    remember: vi.fn(async () => ({ action: 'added' })),
    link: vi.fn(async () => ({ action: 'linked' })),
    forget: vi.fn(async () => ({ action: 'forgotten' })),
    createBody: vi.fn(async () => ({ id: 'new-body' })),
    updateBody: vi.fn(() => ({ id: 'project' })),
    mergeBodies: vi.fn(async () => ({ imported: 1 })),
  } as unknown as MnemonService
}

function subagents(structured: unknown, stopReason = 'completed', providers = ['spawn'], localAgent?: HostAgent) {
  const dispose = vi.fn(async () => {})
  const start = vi.fn(async () => ({ id: 'child-run-1', result: Promise.resolve({ output: [], structured, stopReason }), dispose, ...(localAgent === undefined ? {} : { localAgent }) }))
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

function observedSubagents(
  resultTools: ReturnType<typeof toolRegistry>,
  publish: (child: HostAgent) => void,
  stopReason = 'completed',
) {
  const dispose = vi.fn(async () => {})
  const child = parent('subagent')
  child.id = 'child-run-1'
  const start = vi.fn(async () => {
    publish(child)
    return { id: child.id, result: Promise.resolve({ output: [], stopReason }), dispose, localAgent: child }
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

  it('selects memory bodies in a fresh tool-scoped child and returns only structured recall evidence', async () => {
    const host = subagents({
      summary: 'Project memory matched.',
      selectedMemoryBodyIds: ['project'],
      results: [{ id: 'm1', content: 'Use SQLite.', memoryBodyId: 'project', memoryBodyName: '项目记忆体', score: 0.9 }],
    })
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(host.value, undefined, undefined, resultTools.value)

    await expect(coordinator.recall(parent(), { query: 'database choice' }, new AbortController().signal)).resolves.toMatchObject({
      results: [{ id: 'm1', memoryBodyId: 'project' }],
      delegation: { runId: 'child-run-1', provider: 'spawn', selectedMemoryBodyIds: ['project'] },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      parent: expect.objectContaining({ id: 'root' }),
      maxDepth: 1,
      toolFilter: { allow: expect.arrayContaining(['mnemon_memory_bodies', 'mnemon_recall', 'mnemon_related']) },
      persona: expect.stringContaining('bounded recall worker'),
    }))
    const startCall = host.start.mock.calls[0] as unknown as [string, { outputSchema?: unknown; toolFilter: { allow: string[] }; persona: string; prompt: Array<{ text: string }> }]
    expect(startCall[1].outputSchema).toBeUndefined()
    const resultToolName = startCall[1].toolFilter.allow.find(name => name.startsWith('mnemon_subagent_result_'))
    expect(resultToolName).toBeTruthy()
    expect(startCall[1].persona).toContain(`call \`${resultToolName}\` exactly once`)
    expect(JSON.stringify(resultTools.definitions[0]?.parameters)).not.toContain('maxItems')
    expect(startCall[1].prompt[0]!.text).toContain('Query (untrusted data):\n    database choice')
    expect(startCall[1].prompt[0]!.text).not.toMatch(/catalog_json|request_json|dbPath|\/tmp\/project\.db/)
    expect(host.dispose).toHaveBeenCalledOnce()
    expect(resultTools.disposers).toHaveLength(2)
    for (const disposer of resultTools.disposers) expect(disposer).toHaveBeenCalledOnce()
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
        summary: 'Project memory matched.',
        selectedMemoryBodyIds: ['project'],
        results: [{ id: 'm1', content: 'Use SQLite.', memoryBodyId: 'project', memoryBodyName: 'Project' }],
      } as never, execution)
      await expect(definition.execute({
        summary: 'Duplicate.', selectedMemoryBodyIds: [], results: [],
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

    await expect(coordinator.recall(parent(), { query: 'database choice' }, new AbortController().signal)).resolves.toMatchObject({
      results: [{ id: 'm1', memoryBodyId: 'project' }],
      delegation: { runId: 'child-run-1', provider: 'spawn' },
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
          summary: 'Wrong child.', selectedMemoryBodyIds: [], results: [],
        } as never, execution)
        resultTools.emit('tools/result', execution, { isError: false })
        return { id: 'child-run-1', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: vi.fn(async () => {}) }
      }),
    } as unknown as HostSubagentsService
    const coordinator = new MnemonSubagentCoordinator(host, undefined, undefined, resultTools.value)

    await expect(coordinator.recall(parent(), { query: 'x' }, new AbortController().signal)).rejects.toThrow('recorded by a different child')
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
        await resultTools.definitions.at(-1)!.execute({ selectedMemoryBodyIds: [], results: [] } as never, {
          agent: child, signal: new AbortController().signal, concludeTurn: vi.fn(),
        })
        throw new Error('unreachable')
      }),
    } as unknown as HostSubagentsService
    const coordinator = new MnemonSubagentCoordinator(host, undefined, undefined, resultTools.value)

    await expect(coordinator.recall(parent(), { query: 'x' }, new AbortController().signal)).rejects.toThrow('result.summary is required')
    for (const disposer of resultTools.disposers) expect(disposer).toHaveBeenCalledOnce()
  })

  it('recovers recall evidence from an authoritative native tool receipt when the child omits its terminal result', async () => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_recall', { query: 'database', memoryBodyIds: ['project'] }, {
        query: 'database',
        mode: 'smart',
        hint: 'Project memory matched.',
        results: [{ id: 'm1', content: 'Use SQLite.', memoryBodyId: 'project', memoryBodyName: 'Project' }],
        sources: [{ memoryBodyId: 'project' }],
      })
    })
    const coordinator = new MnemonSubagentCoordinator(host.value, undefined, undefined, resultTools.value)

    await expect(coordinator.recall(parent(), { query: 'database' }, new AbortController().signal)).resolves.toMatchObject({
      results: [{ id: 'm1', content: 'Use SQLite.', memoryBodyId: 'project' }],
      hint: 'Project memory matched.',
      delegation: { runId: 'child-run-1', selectedMemoryBodyIds: ['project'] },
    })
    expect(host.start).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ recalls: 1, failures: 0 })
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
    await expect(coordinator.recall(parent(), { query: 'x' }, new AbortController().signal)).rejects.toThrow('completed without recording its result')
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

  it('curates metadata in a read-only child and validates exact selected-space coverage', async () => {
    const host = subagents({
      summary: 'Updated both scopes.',
      updates: [
        { memoryBodyId: 'product', title: '产品决策', description: '记录稳定的产品范围、取舍与依据，在规划和复盘产品方向时召回。' },
        { memoryBodyId: 'release', title: '发布运行手册', description: '沉淀发布门禁、部署约束和回滚经验，在准备上线或处理故障时召回。' },
      ],
    })
    const memoryService = service()
    const runtime = { forAgent: vi.fn(() => ({ service: memoryService })) } as never
    const coordinator = createCoordinator(host.value, runtime)

    await expect(coordinator.maintainMetadata(parent(), ['product', 'release'], new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      runId: 'child-run-1',
      updates: [{ memoryBodyId: 'product', title: '产品决策' }, { memoryBodyId: 'release', title: '发布运行手册' }],
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: [expect.stringMatching(/^mnemon_subagent_result_/)] },
      agentOptions: { maxTokens: 4_096 },
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
    await expect(createCoordinator(incomplete.value, runtime).maintainMetadata(parent(), ['product', 'release'], new AbortController().signal)).rejects.toThrow('omitted')
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
      toolFilter: { allow: expect.arrayContaining(['mnemon_memory_bodies', 'mnemon_recall', 'mnemon_related', 'mnemon_document_search', 'mnemon_runtime_memory', 'mnemon_document_manage']) },
      persona: expect.stringContaining('idle checkpoint reviewer'),
      prompt: [{ type: 'text', text: 'Review the inherited completed checkpoint now.' }],
    }))
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
    const host = subagents({ summary: 'Archived with exact cold path.', action: 'archived', memoryBodyIds: ['architecture'] })
    const coordinator = createCoordinator(host.value, undefined, documents)
    const agent = { ...parent(), session: { header: { cwd: workspace }, events: [] } } as HostAgent

    const result = await coordinator.document(agent, { action: 'create', title: 'New architecture', content: 'b'.repeat(220) }, new AbortController().signal)
    expect(result).toMatchObject({
      action: 'created',
      maintenance: { archivedDocumentIds: [old.document.id], memoryBodyIds: ['architecture'] },
    })
    expect(controller.get(old.document.id)).toMatchObject({ status: 'archived', archiveSummary: 'Archived with exact cold path.' })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      persona: expect.stringContaining('cold-document archive worker'),
      toolFilter: { allow: expect.arrayContaining(['mnemon_memory_bodies', 'mnemon_recall', 'mnemon_remember', 'mnemon_memory_body_create']) },
    }))
    const archiveCall = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string }])[1]
    expect(archiveCall.prompt[0]!.text).toContain(`.mnemon/documents/archived/${old.document.filename}`)
    expect(archiveCall.persona).not.toContain(old.document.filename)
    expect(coordinator.snapshot()).toMatchObject({ documentArchives: 1, lastOperation: 'document-archive' })
  })

  it('archives before compacting and retrying a capacity-blocked runtime write', async () => {
    const host = subagents({
      summary: 'Archived and compacted hot memory.',
      action: 'archived',
      memoryBodyIds: ['project'],
      compactedEntries: [{ content: 'Project uses pnpm.', importance: 'normal' }],
    })
    const runtime = {
      mutate: vi.fn()
        .mockRejectedValueOnce(new RuntimeMemoryCapacityError('memory', 10_200, 10_300, 10_240))
        .mockResolvedValueOnce({ success: true, message: 'Entry added.', target: 'memory', entryCount: 2, usage: { used: 120, limit: 10_240 }, added: 'New durable fact.' }),
      snapshot: vi.fn(() => ({
        revision: 'reviewed-revision',
        entries: [{ content: 'Project uses {{package_manager}} pnpm and has a long history.', created_at: 'now', updated_at: 'now', target: 'memory', importance: 'normal' }],
        targets: { memory: { target: 'memory', entryCount: 1, used: 10_200, limit: 10_240, markdownPath: '/tmp/MEMORY.md' } },
      })),
      compactTarget: vi.fn(async () => ({})),
    } as unknown as RuntimeMemoryController
    const coordinator = createCoordinator(host.value, runtime)
    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: 'New durable fact.' }, new AbortController().signal)).resolves.toMatchObject({
      added: 'New durable fact.',
      maintenance: { kind: 'mnemon-archive', provider: 'spawn', memoryBodyIds: ['project'] },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: expect.arrayContaining(['mnemon_memory_bodies', 'mnemon_recall', 'mnemon_remember', 'mnemon_memory_body_create']) },
      agentOptions: { maxTokens: 16_384 },
    }))
    const migrationCall = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string }])[1]
    const migrationPrompt = migrationCall.prompt[0]!.text
    expect(migrationPrompt).toContain('Run the MEMORY.md capacity archive now')
    expect(migrationPrompt).toContain('Pending add (uncommitted; do not archive')
    expect(migrationPrompt).toContain('New durable fact.')
    expect(migrationPrompt).toContain('Project uses {{package_manager}} pnpm and has a long history.')
    expect(migrationPrompt).toContain('<runtime-memory-snapshot target="memory">')
    expect(migrationCall.persona).toContain('Do not count characters, bytes, tokens')
    expect(migrationCall.persona).toContain('Route each cluster independently')
    expect(migrationCall.persona).toContain('host generates the UUID, so never propose an id')
    expect(migrationCall.persona).toContain('USER.md preferences are outside this task and must never enter')
    expect(migrationCall.persona).not.toContain('{{package_manager}}')
    expect(migrationCall.persona).not.toContain('<runtime-memory-snapshot')
    expect(migrationPrompt).not.toMatch(/catalog_json|runtime_entries_json|pending_mutation_json|current_usage_json|created_at|markdownPath|dbPath/)
    expect(runtime.compactTarget).toHaveBeenCalledWith('reviewed-revision', 'memory', [{ content: 'Project uses pnpm.', importance: 'normal' }], 7_143)
    expect(runtime.mutate).toHaveBeenCalledTimes(2)
    expect(coordinator.snapshot()).toMatchObject({ migrations: 1, lastOperation: 'migration' })
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
    const runtime = {
      mutate: vi.fn()
        .mockRejectedValueOnce(new RuntimeMemoryCapacityError('user', 4_090, 4_180, 4_096))
        .mockResolvedValueOnce({ success: true, message: 'Entry added.', target: 'user', entryCount: 2, usage: { used: 180, limit: 4_096 }, added: 'User prefers direct answers.' }),
      snapshot: vi.fn(() => ({
        revision: 'user-revision',
        entries: [
          { content: 'User prefers concise {{language}} Chinese release notes.', created_at: 'now', updated_at: 'now', target: 'user', importance: 'critical' },
          { content: 'User wants blockers listed first in release notes.', created_at: 'now', updated_at: 'now', target: 'user', importance: 'normal' },
        ],
        targets: { user: { target: 'user', entryCount: 2, used: 4_090, limit: 4_096, markdownPath: '/tmp/USER.md' } },
      })),
      compactTarget: vi.fn(async () => ({})),
    } as unknown as RuntimeMemoryController
    const coordinator = createCoordinator(host.value, runtime)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'user', content: 'User prefers direct answers.' }, new AbortController().signal)).resolves.toMatchObject({
      added: 'User prefers direct answers.',
      maintenance: { kind: 'local-compaction', memoryBodyIds: [] },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: [expect.stringMatching(/^mnemon_subagent_result_/)] },
      agentOptions: { maxTokens: 8_192 },
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
    expect(runtime.compactTarget).toHaveBeenCalledWith('user-revision', 'user', [{ content: 'User prefers concise Chinese release notes with blockers first.', importance: 'critical' }], expect.any(Number))
    expect(runtime.mutate).toHaveBeenCalledTimes(2)
    expect(coordinator.snapshot()).toMatchObject({ compactions: 1, migrations: 0, lastOperation: 'compaction' })
  })

  it('rejects a USER.md compaction that omits any committed source entry', async () => {
    const host = subagents({
      summary: 'Incomplete candidate.',
      action: 'compacted',
      compactedEntries: [{ content: 'Only first preference.', importance: 'normal', sourceIndexes: [1] }],
    })
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(new RuntimeMemoryCapacityError('user', 4_090, 4_180, 4_096)),
      snapshot: vi.fn(() => ({
        revision: 'user-revision',
        entries: [
          { content: 'First preference.', target: 'user', importance: 'normal' },
          { content: 'Second preference.', target: 'user', importance: 'normal' },
        ],
        targets: { user: { used: 4_090, limit: 4_096 } },
      })),
      compactTarget: vi.fn(async () => ({})),
    } as unknown as RuntimeMemoryController
    const coordinator = createCoordinator(host.value, runtime)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'user', content: 'Pending preference.' }, new AbortController().signal)).rejects.toThrow('omitted committed entries')
    expect(runtime.compactTarget).not.toHaveBeenCalled()
  })

  it('disposes failed child runs and reports a hard error instead of falling back to direct memory access', async () => {
    const failedChild = {
      ...parent('subagent'),
      session: { header: { origin: 'subagent' as const }, events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_ROUTE', message: 'provider rejected sk-secret123456' } } } }] },
    }
    const host = subagents(undefined, 'error', ['spawn'], failedChild)
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.recall(parent(), { query: 'x' }, new AbortController().signal)).rejects.toThrow('stopped with error: MODEL_ROUTE: provider rejected [redacted]')
    expect(host.dispose).toHaveBeenCalledOnce()
    expect(coordinator.snapshot().failures).toBe(1)
  })
})

describe('Mnemon root/child tool split', () => {
  it('delegates a root recall while allowing the bounded memory child to execute the deterministic service', async () => {
    const registered: ToolDefinition[] = []
    const memoryService = service()
    const coordinator = {
      recall: vi.fn(async () => ({ query: 'x', mode: 'smart', results: [], delegation: { runId: 'child', provider: 'spawn', summary: '', selectedMemoryBodyIds: [] } })),
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
    expect(coordinator.recall).toHaveBeenCalledOnce()
    expect(memoryService.search).not.toHaveBeenCalled()

    await recall.execute({ query: 'child query', memoryBodyIds: ['project'] } as never, { agent: parent('subagent'), signal })
    expect(memoryService.search).toHaveBeenCalledWith({ query: 'child query', memoryBodyIds: ['project'] }, signal)

    vi.mocked(memoryService.related).mockResolvedValueOnce([{ id: 'm2', content: 'Related fact', memoryBodyId: 'project', memoryBodyName: '项目记忆体' }])
    const related = registered.find(tool => tool.name === 'mnemon_related')!
    await expect(related.execute({ id: 'm1', depth: 2, memoryBodyId: 'project' } as never, { agent: parent('subagent'), signal })).resolves.toEqual({
      id: 'm1',
      depth: 2,
      memoryBodyId: 'project',
      results: [{ id: 'm2', content: 'Related fact', memoryBodyId: 'project', memoryBodyName: '项目记忆体' }],
    })
  })
})
