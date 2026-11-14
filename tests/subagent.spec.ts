import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostAgent, HostSubagentStartRequest, HostSubagentsService, ToolExecution } from '../src/host/dsh.ts'
import type { RememberRequest, SearchRequest, Insight, MemoryPlacementCandidate, PreparedMemoryPlacement } from 'dsh-mnemon-source-memory-spaces/contracts'
import type { DocumentMutationResult, DocumentView, DocumentMutation } from 'dsh-mnemon-source-documents/contracts'
import type { MemoryEvidence, MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { MnemonAgentRuntimeSource, MnemonRuntimeGraph } from '../src/host/runtime.ts'
import { agentScope } from '../src/host/runtime.ts'
import { AgentMemoryTurn } from '../src/host/agent-memory-turn.ts'
import { MemoryExecutions } from '../src/host/memory-executions.ts'
import { SourceSession } from '../src/host/source-session.ts'
import type { ComposableMemoryTurn } from '../src/core/turns.ts'
import { sourceFixture } from './fixtures/sources.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { assertDshOutputSchema, DELEGATED_OPERATIONS, DELEGATED_TASK_LINE, delegatedTaskLine, MnemonSubagentCoordinator, spaceWriteGuard, type RuntimeMaintenanceTaskRunner } from '../src/host/subagent.ts'
import { CONTINUATION_TEXT } from '../src/host/continuation-turn.ts'
import { resolveConfig } from '../src/host/config.ts'
import { sessionLog } from './fixtures/session-log.ts'
import {
  activations, addSecondWritableBody, capabilities, capacityError, cleanupSubagentFixtures,
  composableChild, createCoordinator, delegatedResultSchema, documentArchiveFixture, DSH_021_CAPABILITIES,
  emitSuccessfulToolResult, maintenancePlan, managedSession, observedSubagents, parent, pinnedTurn,
  releases, resultArguments, runtimeSource, service, subagents, temporaryDirectories, toolRegistry,
  type HostActivationSpec, type RuntimeOperations, type SpaceData,
} from './fixtures/subagent-coordinator.ts'

afterEach(cleanupSubagentFixtures)
it('discovers effective provider configuration without enumeration and rechecks live registration', async () => {
  const names = ['preloaded-local']
  const host = subagents({ answer: 'Found.', citations: [] }, 'completed', names)
  delete host.value.list
  const effectiveConfig = { providerName: 'preloaded-local' }
  const resultTools = Object.assign(toolRegistry().value, {
    registry: { values: () => [{ fibers: [{ get effectiveConfig() { return effectiveConfig } }] }] },
  })
  let coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools)
  const ask = () => coordinator.answer(parent(), 'Question', [], new AbortController().signal)
  try {
    await expect(ask()).resolves.toMatchObject({ delegation: { provider: 'preloaded-local' } })
    coordinator.dispose()
    coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools)
    await expect(ask()).resolves.toMatchObject({ delegation: { provider: 'preloaded-local' } })
    effectiveConfig.providerName = 'renamed-local'
    names.splice(0, names.length, 'renamed-local')
    await expect(ask()).resolves.toMatchObject({ delegation: { provider: 'renamed-local' } })
    names.length = 0
    await expect(ask()).rejects.toThrow('requires a non-inheriting DSH subagent provider')
    expect(host.start).toHaveBeenCalledTimes(3)
  } finally { coordinator.dispose() }
})

it.each(['opaque', 'inheriting', 'unisolated', 'missing', 'spawn-first', 'legacy-order'] as const)('validates explicit provider candidates and preserves selection policy: %s', async scenario => {
  const names = scenario === 'missing' ? [] : scenario === 'spawn-first' ? ['opaque', 'spawn'] : scenario === 'legacy-order' ? ['first', 'opaque'] : ['opaque']
  const host = subagents({ answer: 'Found.', citations: [] }, 'completed', names)
  if (scenario !== 'legacy-order') delete host.value.list
  if (scenario === 'inheriting' || scenario === 'unisolated') vi.mocked(host.value.getProvider).mockImplementation(name => name === 'opaque' ? {
    capabilities: { ...capabilities, depthLimit: scenario !== 'unisolated' }, inheritsParentContext: scenario === 'inheriting',
  } : undefined)
  const source = runtimeSource()
  Object.assign(source.forAgent(parent()).config, { subagentProviderNames: ['opaque'] })
  const coordinator = new MnemonSubagentCoordinator(host.value, source, toolRegistry().value)
  try {
    const answer = coordinator.answer(parent(), 'Question', [], new AbortController().signal)
    if (['inheriting', 'unisolated', 'missing'].includes(scenario)) {
      await expect(answer).rejects.toThrow('requires a non-inheriting DSH subagent provider')
      expect(host.start).not.toHaveBeenCalled()
    } else await expect(answer).resolves.toMatchObject({ delegation: { provider: scenario === 'spawn-first' ? 'spawn' : scenario === 'legacy-order' ? 'first' : 'opaque' } })
  } finally { coordinator.dispose() }
})

describe('Mnemon memory subagent coordinator', () => {
  it('archives a document with Host lineage without model-counted recall receipts (issue 222)', async () => {
    const f = await documentArchiveFixture()
    const result = await f.archive()
    const request = vi.mocked(f.spaces.rememberMany).mock.calls[0]![0][0]!
    expect(request.content).toContain(`.mnemon/documents/archived/${f.document.filename}`)
    expect(request.content).toContain(f.document.contentHash)
    expect(result).toMatchObject({ action: 'archived', document: { status: 'archived', content: f.document.content }, maintenance: { memoryBodyIds: ['project'] } })
    expect(result.lineage).toEqual([{
      source: { layerId: 'documents', reference: `document:${f.document.id}:1`, digest: f.document.contentHash },
      destination: { layerId: 'memory-spaces', reference: expect.stringContaining('memory-space:project/item:'), digest: createHash('sha256').update(request.content).digest('hex') },
    }])
    expect(f.host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({ toolFilter: { allow: ['mnemon_subagent_result'] } }))
    expect(f.spaces.rememberMany).toHaveBeenCalledOnce()
    expect(f.spaces.remember).not.toHaveBeenCalled()
    expect(f.spaces.forget).not.toHaveBeenCalled()
  })

  it.each([
    { action: 'planned', summary: 'Invalid destination.', memoryBodyId: 'invented' },
    { action: 'planned', summary: ' ', memoryBodyId: 'project' },
    { action: 'planned', summary: 'x'.repeat(1001), memoryBodyId: 'project' },
    { action: 'failed', summary: 'No safe index.', memoryBodyId: 'project' },
  ])('rejects an invalid document archive proposal before any write: %j', async proposal => {
    const f = await documentArchiveFixture(proposal)
    await expect(f.archive()).rejects.toThrow()
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
    expect(f.spaces.remember).not.toHaveBeenCalled()
    expect(f.spaces.createBody).not.toHaveBeenCalled()
    expect((await f.controller.read<DocumentView>('document', { id: f.document.id })).status).toBe('active')
  })

  it('compensates only the newly created cold index when the document commit fails', async () => {
    const f = await documentArchiveFixture()
    vi.spyOn(f.controller, 'mutate').mockRejectedValueOnce(new Error('document revision conflict'))
    await expect(f.archive()).rejects.toThrow('document revision conflict')
    const content = vi.mocked(f.spaces.rememberMany).mock.calls[0]![0][0]!.content
    expect(f.spaces.forget).toHaveBeenCalledWith(`stored-${createHash('sha256').update(content).digest('hex').slice(0, 8)}`, expect.any(AbortSignal), 'project')
    expect((await f.controller.read<DocumentView>('document', { id: f.document.id })).status).toBe('active')
  })

  it('reuses an existing exact cold index after a failed attempt without deleting it on conflict', async () => {
    const f = await documentArchiveFixture()
    const content = `Prior archive index. .mnemon/documents/archived/${f.document.filename} ${f.document.contentHash}`
    vi.mocked(f.spaces.search).mockResolvedValue({ query: '', mode: 'keyword', results: [{ id: 'pre-existing', content, memoryBodyId: 'project' } as Insight] })
    vi.spyOn(f.controller, 'mutate').mockRejectedValueOnce(new Error('document revision conflict'))
    await expect(f.archive()).rejects.toThrow('document revision conflict')
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
    expect(f.spaces.forget).not.toHaveBeenCalled()
    await expect(f.archive()).resolves.toMatchObject({ action: 'archived' })
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
  })

  it('cleans a new index with a fresh signal after caller cancellation', async () => {
    const f = await documentArchiveFixture()
    const abort = new AbortController()
    vi.mocked(f.spaces.rememberMany).mockImplementationOnce(async requests => {
      abort.abort(new Error('caller canceled'))
      return [{ action: 'added', id: 'canceled-index', memoryBodyId: requests[0]!.memoryBodyId }]
    })
    await expect(f.archive(abort.signal)).rejects.toThrow('caller canceled')
    expect(f.spaces.forget).toHaveBeenCalledWith('canceled-index', expect.any(AbortSignal), 'project')
    expect(vi.mocked(f.spaces.forget).mock.calls[0]![1]!.aborted).toBe(false)
  })

  it('reports a failed cleanup with the exact destination for recovery', async () => {
    const f = await documentArchiveFixture()
    vi.mocked(f.spaces.rememberMany).mockResolvedValueOnce([{ action: 'added', id: 'orphan-index', memoryBodyId: 'project' }])
    vi.spyOn(f.controller, 'mutate').mockRejectedValueOnce(new Error('disk unavailable'))
    vi.mocked(f.spaces.forget).mockRejectedValueOnce(new Error('provider unavailable'))
    await expect(f.archive()).rejects.toThrow(/cleanup failed.*project.*orphan-index/)
  })

  it('preserves the cold index if the document committed before a transport failure', async () => {
    const f = await documentArchiveFixture()
    const mutate = f.controller.mutate.bind(f.controller)
    vi.spyOn(f.controller, 'mutate').mockImplementationOnce(async (...args) => {
      await mutate(...args)
      throw new Error('response interrupted after commit')
    })
    await expect(f.archive()).rejects.toThrow('index cleanup failed')
    expect((await f.controller.read<DocumentView>('document', { id: f.document.id })).status).toBe('archived')
    expect(f.spaces.forget).not.toHaveBeenCalled()
  })

  it('rechecks the document revision after planning and before writing the index', async () => {
    const f = await documentArchiveFixture()
    const start = f.host.start.getMockImplementation()!
    f.host.start.mockImplementationOnce(async () => {
      await f.controller.mutate('mutate', { action: 'update', id: f.document.id, content: 'New revision.' })
      return start()
    })
    await expect(f.archive()).rejects.toThrow('revision conflict before archive indexing')
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
    expect(f.spaces.forget).not.toHaveBeenCalled()
  })

  it('rechecks destination eligibility after planning and before index writes', async () => {
    const f = await documentArchiveFixture()
    const start = f.host.start.getMockImplementation()!
    f.host.start.mockImplementationOnce(async () => {
      f.spaces.bodyDirectory().items[0]!.active = false
      return start()
    })
    await expect(f.archive()).rejects.toThrow('no longer eligible')
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
  })

  it.each(['before planning', 'during planning'])('honors the live global read-only policy %s', async moment => {
    const f = await documentArchiveFixture()
    const disable = () => Object.defineProperty(f.runtime, 'config', { value: { ...f.runtime.config, writeEnabled: false } })
    if (moment === 'before planning') disable()
    else {
      const start = f.host.start.getMockImplementation()!
      f.host.start.mockImplementationOnce(async () => { disable(); return start() })
    }
    await expect(f.archive()).rejects.toThrow('read-only')
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
    expect((await f.controller.read<DocumentView>('document', { id: f.document.id })).status).toBe('active')
    if (moment === 'before planning') expect(f.host.start).not.toHaveBeenCalled()
  })

  it('accepts a deduplicated index only with exact Host readback and never rolls it back', async () => {
    const f = await documentArchiveFixture()
    vi.mocked(f.spaces.rememberMany).mockImplementationOnce(async requests => {
      vi.mocked(f.spaces.search).mockResolvedValue({ query: '', mode: 'keyword', results: [{ id: 'existing-index', content: requests[0]!.content, memoryBodyId: 'project' } as Insight] })
      return [{ action: 'skipped', id: 'existing-index', memoryBodyId: 'project' }]
    })
    await expect(f.archive()).resolves.toMatchObject({ action: 'archived', lineage: [{ destination: { reference: 'memory-space:project/item:existing-index' } }] })
    expect(f.spaces.forget).not.toHaveBeenCalled()
  })

  it('archives and compensates through real composed Documents and Holographic Sources', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    const body = await f.memorySpace()
    const spaces = f.graph.source('memory-spaces')
    await spaces.mutate('body-update', { memoryBodyId: body.id, request: { active: true } })
    const documents = f.graph.source('documents')
    const created = await documents.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Composed archive', content: 'Keep the original code.' })
    const host = subagents({ action: 'planned', summary: 'Cold index for the original code.', memoryBodyId: body.id })
    const coordinator = new MnemonSubagentCoordinator(host.value, f.live, toolRegistry().value)
    const agent = { ...parent(), session: { header: { cwd: f.workspace }, ...sessionLog() } } as HostAgent
    await expect(coordinator.archiveDocument(agent, created.document.id, new AbortController().signal)).resolves.toMatchObject({ action: 'archived', lineage: [{ source: { digest: created.document.contentHash } }] })
    const indexed = await spaces.read<{ results: Insight[] }>('search', { query: created.document.contentHash, memoryBodyIds: [body.id] })
    expect(indexed.results).toHaveLength(1)
    expect(indexed.results[0]!.content).toContain(created.document.contentHash)
    const rejected = await documents.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Conflict archive', content: 'A separate original that must stay active.' })
    const original = SourceSession.prototype.mutate
    const failCommit = vi.spyOn(SourceSession.prototype, 'mutate').mockImplementation(function (this: SourceSession, operation, input, signal) {
      if (this.typeId === 'documents' && operation === 'archive') return Promise.reject(new Error('injected document commit failure'))
      return original.call(this, operation, input, signal)
    })
    try {
      await expect(coordinator.archiveDocument(agent, rejected.document.id, new AbortController().signal)).rejects.toThrow('injected document commit failure')
    } finally { failCommit.mockRestore() }
    const after = await spaces.read<{ results: Insight[] }>('search', { query: rejected.document.contentHash, memoryBodyIds: [body.id] })
    expect(after.results.filter(item => item.content.includes(rejected.document.contentHash))).toEqual([])
    expect((await documents.read<DocumentView>('document', { id: rejected.document.id })).status).toBe('active')
    const originalIndex = await spaces.read<{ results: Insight[] }>('search', { query: created.document.contentHash, memoryBodyIds: [body.id] })
    expect(originalIndex.results.some(item => item.id === indexed.results[0]!.id)).toBe(true)
  })

  it('rejects a destination activated outside the current View namespace grant', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    const body = await f.memorySpace()
    const spaces = f.graph.source('memory-spaces')
    await spaces.mutate('body-update', { memoryBodyId: body.id, request: { active: true } })
    const documents = f.graph.source('documents')
    const created = await documents.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Scoped document', content: 'Must not escape the active View.' })
    const agent = { ...parent(), session: { header: { cwd: f.workspace }, ...sessionLog() } } as HostAgent
    const turn = await f.graph.composableTurns.beginTurn('archive-scoped', agentScope(agent, f.config), 'test')
    const outside = await spaces.mutate<{ id: string }>('body-create', { name: 'Outside pinned scope', description: 'Not in the immutable namespace grant.', providerId: 'holographic' })
    await spaces.mutate('body-update', { memoryBodyId: outside.id, request: { active: true } })
    const host = subagents({ action: 'planned', summary: 'No bypass.', memoryBodyId: outside.id })
    const coordinator = new MnemonSubagentCoordinator(host.value, f.live, toolRegistry().value)
    try {
      await expect(coordinator.archiveDocument(agent, created.document.id, new AbortController().signal)).rejects.toThrow('ineligible Memory Space')
      expect((await documents.read<DocumentView>('document', { id: created.document.id })).status).toBe('active')
    } finally { await f.graph.composableTurns.endTurn(turn.turnId) }
  })

  it.each(['accepted', 'updated', 'skipped'])('never deletes an ambiguous or existing document index receipt: %s', async action => {
    const f = await documentArchiveFixture()
    vi.mocked(f.spaces.rememberMany).mockResolvedValueOnce([{ action, id: 'not-proven-new', memoryBodyId: 'project' }])
    await expect(f.archive()).rejects.toThrow()
    expect(f.spaces.forget).not.toHaveBeenCalled()
    expect((await f.controller.read<DocumentView>('document', { id: f.document.id })).status).toBe('active')
  })

  it('takes a skipped document index receipt that names the exact stored index as its evidence', async () => {
    const f = await documentArchiveFixture()
    // As Mnemon Native answers when the space already holds this exact index text.
    vi.mocked(f.spaces.rememberMany).mockImplementationOnce(async requests => [{ action: 'skipped', id: 'index-1', content: requests[0]!.content, memoryBodyId: 'project' }])
    const result = await f.archive()
    const request = vi.mocked(f.spaces.rememberMany).mock.calls[0]![0][0]!
    expect(result.lineage![0]!.destination).toEqual({ layerId: 'memory-spaces', reference: 'memory-space:project/item:index-1', digest: createHash('sha256').update(request.content).digest('hex') })
    // Only the lookup for an earlier index ran; nothing was searched again or removed.
    expect(f.spaces.search).toHaveBeenCalledOnce()
    expect(f.spaces.forget).not.toHaveBeenCalled()
  })

  it.each(['inactive', 'disabled', 'async', 'no-forget'])('never indexes into an unsafe destination; archives locally before model work instead (issue 336): %s', async state => {
    const f = await documentArchiveFixture()
    const body = f.spaces.bodyDirectory().items[0]!
    if (state === 'inactive') body.active = false
    if (state === 'disabled') body.providerEnabled = false
    if (state === 'async') body.provider.capabilities.writeMode = 'async-extracting'
    if (state === 'no-forget') body.provider.capabilities.forget = false
    await expect(f.archive()).resolves.toMatchObject({ action: 'archived', maintenance: { provider: 'host', memoryBodyIds: [], summary: expect.stringContaining('without a Mnemon index') } })
    expect((await f.controller.read<DocumentView>('document', { id: f.document.id })).status).toBe('archived')
    expect(f.host.start).not.toHaveBeenCalled()
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
  })

  it('keeps a shared maintenance View until all concurrent children finish', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    const root = parent()
    root.session.header!.cwd = f.workspace
    const results = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()]
    let starts = 0
    const host = { list: () => ['spawn'], getProvider: () => ({ capabilities }), start: vi.fn(async () => {
      const index = starts++
      return { id: 'parallel-' + index, result: results[index]!.promise, dispose: vi.fn(async () => {}) }
    }) } as unknown as HostSubagentsService
    const binding = vi.spyOn(f.live, 'bindAgentRuntime')
    const coordinator = new MnemonSubagentCoordinator(host, f.live, toolRegistry().value)
    const first = coordinator.remember(root, { content: 'first' }, new AbortController().signal)
    const second = new MnemonSubagentCoordinator(host, f.live, toolRegistry().value)
      .remember(root, { content: 'second' }, new AbortController().signal)
    await vi.waitFor(() => expect(starts).toBe(2))
    const view = f.graph.composableTurns.activeTurn('root')!
    expect(view).toBeDefined()
    expect(binding).toHaveBeenCalledOnce()
    const result = { output: [], stopReason: 'completed', structured: { summary: 'No write needed.', action: 'skipped', memoryBodyIds: [] } }
    results[0]!.resolve(result)
    await first
    expect(f.graph.composableTurns.activeTurn('root')).toBe(view)
    results[1]!.resolve(result)
    await second
    expect(f.graph.composableTurns.activeTurn('root')).toBeUndefined()
  })


  it('waits for background child and result-observer cleanup before pinning a foreground turn', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    const root = parent()
    root.session.header!.cwd = f.workspace
    const childCleanup = Promise.withResolvers<void>()
    const toolCleanup = Promise.withResolvers<void>()
    const host = subagents({ summary: 'No write needed.', action: 'skipped', memoryBodyIds: [] })
    host.dispose.mockImplementation(() => childCleanup.promise)
    const tools = toolRegistry()
    const observe = tools.on.getMockImplementation()!
    tools.on.mockImplementation((name, ...args) => name === 'tools/result' ? vi.fn(() => toolCleanup.promise) : observe(name, ...args))
    const coordinator = new MnemonSubagentCoordinator(host.value, f.live, tools.value)
    const background = coordinator.remember(root, { content: 'first' }, new AbortController().signal)
    await vi.waitFor(() => expect(host.dispose).toHaveBeenCalledOnce())
    const workflow = f.graph.composableTurns.activeTurn(root.id)
    const owner = new AgentMemoryTurn(root, f.live)
    let foregroundSettled = false
    const foreground = owner.begin(1).then(() => { foregroundSettled = true }, error => { foregroundSettled = true; return error })
    try {
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(foregroundSettled).toBe(false)
      expect(f.graph.composableTurns.activeTurn(root.id)).toBe(workflow)
      childCleanup.resolve()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(foregroundSettled).toBe(false)
      toolCleanup.resolve()
      await background
      expect(await foreground).toBeUndefined()
      expect(owner.current?.context.turnId).toBe('root:1')
    } finally {
      childCleanup.resolve()
      toolCleanup.resolve()
      await Promise.all([background, foreground])
      owner.dispose()
    }
  })

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
    const composableTurns = {
      activeTurn: vi.fn().mockReturnValue(pinnedTurn('root:1', 'view-pinned', authorizedIds)),
    }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, toolRegistry().value)

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

  it('keeps a Core budget-unavailable reason visible on empty Recall and replay', async () => {
    const agent = parent()
    const turn = pinnedTurn('root:unavailable', 'view-unavailable')
    const source = runtimeSource(undefined, service(), undefined, {
      activeTurn: () => turn,
    })
    const route = vi.spyOn(source.forAgent(agent).source('memory-spaces', agentScope(agent, source.config)), 'route').mockResolvedValue({
      id: 'read-unavailable', viewId: 'view-unavailable', routeId: 'space/recall', sourceInstanceKey: 'source:mnemon-source-memory-spaces',
      observedAt: '2026-08-31T00:00:00.000Z', items: [], truncated: true,
      unavailable: 'An exact record cannot fit this output budget.',
    })
    const coordinator = new MnemonSubagentCoordinator(subagents(undefined).value, source, toolRegistry().value)
    const signal = new AbortController().signal
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await coordinator.recall(agent, { query: 'exact record' }, signal, { requirePinnedView: true })
      expect(result.results).toEqual([])
      expect(result).toMatchObject({ unavailable: 'An exact record cannot fit this output budget.' })
    }
    expect(route).toHaveBeenCalledOnce()
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
    let pinned = pinnedTurn('root:9', 'view-root:9', ['project', 'other'])
    const composableTurns = {
      activeTurn: vi.fn(() => pinned),
    }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, toolRegistry().value)
    const signal = new AbortController().signal

    const first = await coordinator.recall(parent(), { query: '  Release   History ' }, signal, { requirePinnedView: true })
    const duplicate = await coordinator.recall(parent(), { query: 'release-history?!', mode: 'basic', limit: 1 }, signal, { requirePinnedView: true })
    const refinement = await coordinator.recall(parent(), { query: 'rollback drill' }, signal, { requirePinnedView: true })
    const exhausted = await coordinator.recall(parent(), { query: 'tenant recovery' }, signal, { requirePinnedView: true })
    pinned = pinnedTurn('root:10', 'view-root:10', ['project', 'other'])
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
    // Past the budget a new query runs nothing; the refinement's evidence never reads as its answer (#389).
    expect(exhausted).toMatchObject({ query: 'tenant recovery', results: [], notRun: true, budgetExhausted: true, hint: expect.stringContaining('budget is exhausted') })
    expect(nextTurn.results.map(result => result.id)).toEqual(['duplicate-first', 'rollback-1', 'medium-refinement', 'unknown-refinement'])
    expect(memoryService.search).toHaveBeenCalledTimes(3)
    expect(coordinator.snapshot()).toMatchObject({ recalls: 3, failures: 0 })
  })

  it('keeps same-query Recall caches scoped to the selected Memory Spaces', async () => {
    const memoryService = service()
    vi.mocked(memoryService.search).mockImplementation(async request => ({
      query: request.query,
      mode: 'smart',
      results: (request.memoryBodyIds ?? []).map(memoryBodyId => ({ id: memoryBodyId, content: `Evidence in ${memoryBodyId}.`, memoryBodyId, relevanceTier: 'high' })),
    }) as never)
    const composableTurns = {
      activeTurn: vi.fn().mockReturnValue(pinnedTurn('root:scoped', 'view-scoped', ['project', 'other'])),
    }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(subagents(undefined).value, source)
    const signal = new AbortController().signal
    const first = await coordinator.recall(parent(), { query: 'same query', memoryBodyIds: ['project'] }, signal, { requirePinnedView: true })
    const second = await coordinator.recall(parent(), { query: 'same query', memoryBodyIds: ['other'] }, signal, { requirePinnedView: true })
    const repeated = await coordinator.recall(parent(), { query: 'same query', memoryBodyIds: ['project'] }, signal, { requirePinnedView: true })
    const exhausted = await coordinator.recall(parent(), { query: 'third query', memoryBodyIds: ['project'] }, signal, { requirePinnedView: true })
    expect(first.results.map(row => row.memoryBodyId)).toEqual(['project'])
    expect(second.results.map(row => row.memoryBodyId)).toEqual(['other'])
    expect(repeated.results).toEqual(first.results)
    expect(exhausted).toMatchObject({ results: [], hint: expect.stringContaining('budget is exhausted') })
    expect(memoryService.search).toHaveBeenCalledTimes(2)
  })

  it('does not replay Related evidence from a different selected Memory Space', async () => {
    const memoryService = service()
    vi.mocked(memoryService.search).mockResolvedValueOnce({
      query: 'release history', mode: 'smart',
      results: [
        { id: 'a', content: 'History from A.', relevanceTier: 'high', memoryBodyId: 'space-a' },
        { id: 'b', content: 'History from B.', relevanceTier: 'high', memoryBodyId: 'space-b' },
      ],
    } as never)
    vi.mocked(memoryService.related).mockResolvedValueOnce([
      { id: 'neighbor', content: 'Graph evidence from A.', relevanceTier: 'high', memoryBodyId: 'space-a' },
    ])
    const composableTurns = {
      activeTurn: vi.fn().mockReturnValue(pinnedTurn('root:related', 'view-related', ['space-a', 'space-b'])),
    }
    const coordinator = new MnemonSubagentCoordinator(subagents(undefined).value, runtimeSource(undefined, memoryService, undefined, composableTurns))
    const signal = new AbortController().signal
    await coordinator.recall(parent(), { query: 'release history' }, signal, { requirePinnedView: true })
    const first = await coordinator.related(parent(), 'a', 'space-a', signal, { requirePinnedView: true })
    const replay = await coordinator.related(parent(), 'b', 'space-b', signal, { requirePinnedView: true })
    expect(first.results).toHaveLength(1)
    expect(replay.results).toEqual([])
    expect(memoryService.related).toHaveBeenCalledOnce()
  })

  it('keeps queued refinement on the service captured with its original authority', async () => {
    const memoryService = service()
    const replacement = service()
    let complete!: () => void
    const gate = new Promise<void>(resolve => { complete = resolve })
    vi.mocked(memoryService.search).mockImplementation(async request => {
      if (request.query === 'initial') await gate
      return { query: request.query, mode: 'smart', results: [{ id: request.query, content: request.query, memoryBodyId: 'project', relevanceTier: 'high' }] } as never
    })
    const composableTurns = {
      activeTurn: vi.fn().mockReturnValue(pinnedTurn('root:queued', 'view-queued')),
    }
    let currentRuntime = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const source = { forAgent: (agent: HostAgent) => currentRuntime.forAgent(agent) }
    const coordinator = new MnemonSubagentCoordinator(subagents(undefined).value,
      { ...source, executions: new MemoryExecutions(source as never) } as never)
    const signal = new AbortController().signal
    const initial = coordinator.recall(parent(), { query: 'initial' }, signal, { requirePinnedView: true })
    const refined = coordinator.recall(parent(), { query: 'refined' }, signal, { requirePinnedView: true })
    currentRuntime = runtimeSource(undefined, replacement, undefined, composableTurns)
    complete()
    await Promise.all([initial, refined])
    expect(memoryService.search).toHaveBeenCalledTimes(2)
    expect(replacement.search).not.toHaveBeenCalled()
  })

  it('does not start queued Provider work after cancellation', async () => {
    const memoryService = service()
    let complete!: () => void
    const gate = new Promise<void>(resolve => { complete = resolve })
    vi.mocked(memoryService.search).mockImplementationOnce(async request => {
      await gate
      return { query: request.query, mode: 'smart', results: [] } as never
    })
    const composableTurns = {
      activeTurn: vi.fn().mockReturnValue(pinnedTurn('root:cancel', 'view-cancel')),
    }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(subagents(undefined).value, source as never)
    const controller = new AbortController()
    const initial = coordinator.recall(parent(), { query: 'initial' }, new AbortController().signal, { requirePinnedView: true })
    const refined = coordinator.recall(parent(), { query: 'refined' }, controller.signal, { requirePinnedView: true })
    const rejected = expect(refined).rejects.toThrow('cancel queued refinement')
    controller.abort(new Error('cancel queued refinement'))
    complete()
    await initial
    await rejected
    expect(memoryService.search).toHaveBeenCalledOnce()
  })

  it('isolates Documents search claims by the executing root or child turn', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    let rootPin = pinnedTurn('root:documents-1', 'view-documents')
    const childPin = pinnedTurn('child:documents-1', 'view-documents')
    const composableTurns = {
      activeTurn: vi.fn((agentId: string) => agentId === 'root' ? rootPin : agentId === 'child' ? childPin : undefined),
    }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, toolRegistry().value)
    const child = parent('subagent')
    child.session.header!.parentSession = 'root'

    expect((await coordinator.documentQuery(parent(), { query: 'probe' }, new AbortController().signal) as { notRun?: boolean }).notRun === true).toBe(false)
    expect((await coordinator.documentQuery(child, { query: 'probe' }, new AbortController().signal) as { notRun?: boolean }).notRun === true).toBe(false)
    expect((await coordinator.documentQuery(parent(), { query: 'probe' }, new AbortController().signal) as { notRun?: boolean }).notRun === true).toBe(true)
    expect((await coordinator.documentQuery(child, { query: 'probe' }, new AbortController().signal) as { notRun?: boolean }).notRun === true).toBe(true)
    rootPin = pinnedTurn('root:documents-2', 'view-documents')
    expect((await coordinator.documentQuery(parent(), { query: 'probe' }, new AbortController().signal) as { notRun?: boolean }).notRun === true).toBe(false)
    expect(composableTurns.activeTurn).toHaveBeenCalledWith('root')
    expect(composableTurns.activeTurn).toHaveBeenCalledWith('child')
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
    const composableTurns = {
      activeTurn: vi.fn().mockReturnValue(pinnedTurn('root:envelope', 'view-envelope', ['project'])),
    }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, toolRegistry().value)
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
    const composableTurns = {
      activeTurn: vi.fn().mockReturnValue(pinnedTurn('root:concurrent', 'view-concurrent', ['project'])),
    }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, toolRegistry().value)
    const signal = new AbortController().signal

    const first = coordinator.recall(parent(), { query: 'release history' }, signal, { requirePinnedView: true })
    const duplicate = coordinator.recall(parent(), { query: 'release history' }, signal, { requirePinnedView: true })
    await vi.waitFor(() => expect(memoryService.search).toHaveBeenCalledOnce())
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
    const composableTurns = {
      activeTurn: vi.fn().mockReturnValue(pinnedTurn('root:serialized', 'view-serialized', ['project'])),
    }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, toolRegistry().value)
    const signal = new AbortController().signal

    const initial = coordinator.recall(parent(), { query: 'initial query' }, signal, { requirePinnedView: true })
    const refined = coordinator.recall(parent(), { query: 'refined query' }, signal, { requirePinnedView: true })
    await vi.waitFor(() => expect(memoryService.search).toHaveBeenCalledOnce())
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
    const composableTurns = {
      activeTurn: vi.fn().mockReturnValue(pinnedTurn('root:retry', 'view-retry', ['project'])),
    }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, toolRegistry().value)
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

  it('derives a child read from its own inherited pin with no model-facing capability', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    const childPin = pinnedTurn('child:1', 'view-pinned', ['project'])
    const composableTurns = { activeTurn: vi.fn((agentId: string) => agentId === 'child' ? childPin : undefined) }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, toolRegistry().value)
    const child = parent('subagent')
    child.session.header!.parentSession = 'root'

    expect(coordinator.scopeRecallRequest(child, { query: 'database choice' })).toEqual({ query: 'database choice', memoryBodyIds: ['project'] })
    expect(() => coordinator.scopeRecallRequest(child, { query: 'database choice', memoryBodyIds: ['outside'] })).toThrow('outside pinned Source')
    expect(coordinator.scopeRelatedMemorySpace(child)).toBe('project')
    expect(() => coordinator.scopeRelatedMemorySpace(child, 'outside')).toThrow('outside pinned Source')
    await expect(coordinator.recall(child, { query: 'database choice' }, new AbortController().signal)).resolves.not.toHaveProperty('selectedMemoryBodyIds')
    expect(composableTurns.activeTurn).toHaveBeenCalledWith('child')
    expect(host.start).not.toHaveBeenCalled()
  })

  it('fails closed without pinned authority and executes bounded Related directly when authorized', async () => {
    const host = subagents(undefined)
    const memoryService = service()
    const composableTurns = {
      activeTurn: vi.fn(() => undefined as ComposableMemoryTurn | undefined),
    }
    const source = runtimeSource(undefined, memoryService, undefined, composableTurns)
    const coordinator = new MnemonSubagentCoordinator(host.value, source as never, toolRegistry().value)
    const signal = new AbortController().signal

    await expect(coordinator.recall(parent(), { query: 'database choice' }, signal, { requirePinnedView: true })).rejects.toThrow('View pinned to the current turn')
    const child = parent('subagent')
    child.session.header!.parentSession = 'root'
    await expect(coordinator.recall(child, { query: 'database choice' }, signal, { requirePinnedView: true })).rejects.toThrow('View pinned to the current turn')
    expect(memoryService.search).not.toHaveBeenCalled()

    composableTurns.activeTurn.mockReturnValue(pinnedTurn('root:2', 'view-pinned'))
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

  it('keeps one result-tool name and schema registered across consecutive delegated writes', async () => {
    const resultTools = toolRegistry()
    const host = subagents({ summary: 'Stored.', action: 'stored', memoryBodyIds: ['project'] })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    await coordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)
    await coordinator.remember(parent(), { content: 'Use bounded retries.' }, new AbortController().signal)
    expect(resultTools.register).toHaveBeenCalledOnce()
    expect(resultTools.definitions[0]?.name).toBe('mnemon_subagent_result')
    expect(host.start).toHaveBeenNthCalledWith(1, 'spawn', expect.objectContaining({ toolFilter: { allow: expect.arrayContaining(['mnemon_subagent_result']) } }))
    expect(host.start).toHaveBeenNthCalledWith(2, 'spawn', expect.objectContaining({ toolFilter: { allow: expect.arrayContaining(['mnemon_subagent_result']) } }))
    expect(resultTools.disposers[0]).not.toHaveBeenCalled()
    coordinator.dispose()
    coordinator.dispose()
    expect(resultTools.disposers[0]).toHaveBeenCalledOnce()
  })

  it('isolates concurrent result capabilities and rejects stale or foreign submissions', async () => {
    const resultTools = toolRegistry()
    const starts: Array<{ request: HostSubagentStartRequest; child: HostAgent; done: ReturnType<typeof Promise.withResolvers<{ output: []; stopReason: string }>> }> = []
    const host = {
      list: () => ['spawn'], getProvider: () => ({ capabilities }),
      start: vi.fn(async (_provider: string, request: HostSubagentStartRequest) => {
        const child = { ...parent('subagent'), id: 'child-' + starts.length }
        const done = Promise.withResolvers<{ output: []; stopReason: string }>()
        starts.push({ request, child, done })
        return { id: child.id, result: done.promise, dispose: async () => {} }
      }),
    } as unknown as HostSubagentsService
    const coordinator = new MnemonSubagentCoordinator(host, runtimeSource(), resultTools.value)
    const definition = resultTools.definitions[0]!
    const fingerprint = JSON.stringify(definition.parameters)
    const calls = [
      coordinator.remember(parent(), { content: 'first' }, new AbortController().signal),
      coordinator.remember({ ...parent(), id: 'other-parent' }, { content: 'second' }, new AbortController().signal),
    ]
    calls.forEach(call => { void call.catch(() => {}) })
    try {
      await vi.waitFor(() => expect(starts).toHaveLength(2))
      const first = starts[0]!
      const second = starts[1]!
      const result = { summary: 'First result.', action: 'skipped', memoryBodyIds: [] }
      const firstArgs = resultArguments(first.request, result)
      const execution = { name: definition.name, agent: first.child, signal: new AbortController().signal, concludeTurn: vi.fn(), token: Symbol('first') }
      await expect(definition.execute(firstArgs as never, { ...execution, agent: parent() })).rejects.toThrow('restricted to delegated children')
      await expect(definition.execute({ ...firstArgs, requestId: 'unknown' } as never, execution)).rejects.toThrow('no longer active')
      await expect(definition.execute(firstArgs as never, { ...execution, agent: second.child })).rejects.toThrow('different child')
      expect(execution.concludeTurn).not.toHaveBeenCalled()
      await definition.execute(firstArgs as never, execution)
      resultTools.emit('tools/result', execution, { isError: false })
      await expect(definition.execute(firstArgs as never, { ...execution, token: Symbol('duplicate') })).rejects.toThrow('already recorded')
      const secondExecution = { ...execution, agent: second.child, token: Symbol('second'), concludeTurn: vi.fn() }
      await definition.execute(resultArguments(second.request, { ...result, summary: 'Second result.' }) as never, secondExecution)
      resultTools.emit('tools/result', secondExecution, { isError: false })
      first.done.resolve({ output: [], stopReason: 'completed' })
      second.done.resolve({ output: [], stopReason: 'completed' })
      expect(await Promise.all(calls)).toMatchObject([{ summary: 'First result.' }, { summary: 'Second result.' }])
      await expect(definition.execute(firstArgs as never, execution)).rejects.toThrow('no longer active')
      expect(resultTools.register).toHaveBeenCalledOnce()
      expect(JSON.stringify(definition.parameters)).toBe(fingerprint)
      expect(resultTools.disposers[0]).not.toHaveBeenCalled()
    } finally {
      for (const start of starts) start.done.resolve({ output: [], stopReason: 'cancelled' })
      await Promise.allSettled(calls)
      await coordinator.dispose()
    }
  })

  it.each(['tool', 'outer'])('accepts only an authoritative successful result after a rejected %s execution', async failure => {
    const resultTools = toolRegistry()
    const child = { ...parent('subagent'), id: 'result-owner' }
    const host = {
      list: () => ['spawn'], getProvider: () => ({ capabilities }),
      start: vi.fn(async (_provider: string, request: HostSubagentStartRequest) => {
        const definition = resultTools.definitions[0]!
        const outer = Symbol('outer')
        const execution = { name: definition.name, agent: child, signal: new AbortController().signal, concludeTurn: vi.fn(), token: Symbol('first'), ...(failure === 'outer' ? { parent: outer } : {}) }
        await definition.execute(resultArguments(request, { summary: 'Must not commit.', action: 'skipped', memoryBodyIds: [] }) as never, execution)
        resultTools.emit('tools/result', execution, { isError: failure === 'tool' })
        if (failure === 'outer') resultTools.emit('tools/result', { name: 'run_code', agent: child, signal: execution.signal, token: outer }, { isError: true })
        const retry = { name: definition.name, agent: child, signal: execution.signal, concludeTurn: vi.fn(), token: Symbol('retry') }
        await definition.execute(resultArguments(request, { summary: 'Authoritative retry.', action: 'skipped', memoryBodyIds: [] }) as never, retry)
        resultTools.emit('tools/result', retry, { isError: false })
        return { id: child.id, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
      }),
    } as unknown as HostSubagentsService
    const coordinator = new MnemonSubagentCoordinator(host, runtimeSource(), resultTools.value)
    try {
      await expect(coordinator.remember(parent(), { content: 'checkpoint' }, new AbortController().signal)).resolves.toMatchObject({ summary: 'Authoritative retry.' })
    } finally { await coordinator.dispose() }
  })

  it('revokes result capabilities before asynchronous child cleanup completes', async () => {
    const resultTools = toolRegistry()
    const cleanup = Promise.withResolvers<void>()
    const host = subagents({ summary: 'Done.', action: 'skipped', memoryBodyIds: [] })
    host.dispose.mockImplementation(() => cleanup.promise)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    const call = coordinator.remember(parent(), { content: 'checkpoint' }, new AbortController().signal)
    try {
      await vi.waitFor(() => expect(host.dispose).toHaveBeenCalledOnce())
      const request = (host.start.mock.calls as unknown as Array<[string, { persona: string }]>)[0]![1]
      await expect(resultTools.definitions[0]!.execute(resultArguments(request, { summary: 'Late.', action: 'skipped', memoryBodyIds: [] }) as never, {
        agent: { ...parent('subagent'), id: 'child-run-1' }, signal: new AbortController().signal, concludeTurn: vi.fn(),
      })).rejects.toThrow('no longer active')
    } finally {
      cleanup.resolve()
      await call
      await coordinator.dispose()
    }
  })

  it('revokes a rejected startup capability while retaining the stable tool for later work', async () => {
    const resultTools = toolRegistry()
    const host = subagents({ summary: 'Recovered.', action: 'skipped', memoryBodyIds: [] })
    host.start.mockRejectedValueOnce(new Error('provider startup failed'))
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    try {
      await expect(coordinator.remember(parent(), { content: 'first' }, new AbortController().signal)).rejects.toThrow('provider startup failed')
      const request = (host.start.mock.calls as unknown as Array<[string, { persona: string }]>)[0]![1]
      await expect(resultTools.definitions[0]!.execute(resultArguments(request, { summary: 'Late.', action: 'skipped', memoryBodyIds: [] }) as never, {
        agent: parent('subagent'), signal: new AbortController().signal, concludeTurn: vi.fn(),
      })).rejects.toThrow('no longer active')
      await expect(coordinator.remember(parent(), { content: 'second' }, new AbortController().signal)).resolves.toMatchObject({ summary: 'Recovered.' })
      expect(resultTools.register).toHaveBeenCalledOnce()
    } finally { await coordinator.dispose() }
  })

  it('does not reopen a result request when disposed during workflow preparation', async () => {
    const resultTools = toolRegistry()
    const source = runtimeSource()
    const signal = new AbortController().signal
    const execution = await source.executions.workflow(parent(), 'write', signal)
    const release = vi.fn(execution.release)
    const ready = Promise.withResolvers<typeof execution>()
    const workflow = vi.spyOn(source.executions, 'workflow').mockReturnValueOnce(ready.promise)
    const host = subagents({ summary: 'Must not start.', action: 'skipped', memoryBodyIds: [] })
    const coordinator = new MnemonSubagentCoordinator(host.value, source, resultTools.value)
    const call = coordinator.remember(parent(), { content: 'checkpoint' }, signal)
    const rejected = expect(call).rejects.toThrow('coordinator is disposed')
    await vi.waitFor(() => expect(workflow).toHaveBeenCalledOnce())
    await coordinator.dispose()
    ready.resolve({ ...execution, release })
    await rejected
    expect(host.start).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
    expect(resultTools.on).not.toHaveBeenCalledWith('tools/result', expect.any(Function))
  })

  it('revokes every outstanding capability when the coordinator is disposed', async () => {
    const resultTools = toolRegistry()
    const done = Promise.withResolvers<{ output: []; stopReason: string; structured: unknown }>()
    const host = subagents(undefined)
    host.start.mockImplementation(async () => ({ id: 'child-run-1', result: done.promise, dispose: host.dispose }))
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    const call = coordinator.remember(parent(), { content: 'checkpoint' }, new AbortController().signal)
    void call.catch(() => {})
    try {
      await vi.waitFor(() => expect(host.start).toHaveBeenCalledOnce())
      const request = (host.start.mock.calls as unknown as Array<[string, { persona: string }]>)[0]![1]
      await coordinator.dispose()
      await expect(resultTools.definitions[0]!.execute(resultArguments(request, { summary: 'Late.', action: 'skipped', memoryBodyIds: [] }) as never, {
        agent: { ...parent('subagent'), id: 'child-run-1' }, signal: new AbortController().signal, concludeTurn: vi.fn(),
      })).rejects.toThrow('no longer active')
      expect(resultTools.disposers[0]).toHaveBeenCalledOnce()
    } finally {
      done.resolve({ output: [], stopReason: 'cancelled', structured: undefined })
      await expect(call).rejects.toThrow('stopped with cancelled')
      await coordinator.dispose()
    }
  })

  it('rejects submissions after cancellation even before the provider settles', async () => {
    const resultTools = toolRegistry()
    const done = Promise.withResolvers<{ output: []; stopReason: string }>()
    const host = subagents(undefined)
    host.start.mockImplementation(async () => ({ id: 'child-run-1', result: done.promise.then(value => ({ ...value, structured: undefined })), dispose: host.dispose }))
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    const controller = new AbortController()
    const call = coordinator.remember(parent(), { content: 'checkpoint' }, controller.signal)
    void call.catch(() => {})
    try {
      await vi.waitFor(() => expect(host.start).toHaveBeenCalledOnce())
      const request = (host.start.mock.calls as unknown as Array<[string, { persona: string }]>)[0]![1]
      controller.abort(new Error('checkpoint cancelled'))
      await expect(resultTools.definitions[0]!.execute(resultArguments(request, { summary: 'Late.', action: 'skipped', memoryBodyIds: [] }) as never, {
        agent: { ...parent('subagent'), id: 'child-run-1' }, signal: new AbortController().signal, concludeTurn: vi.fn(),
      })).rejects.toThrow('checkpoint cancelled')
    } finally {
      done.resolve({ output: [], stopReason: 'cancelled' })
      await expect(call).rejects.toThrow('stopped with cancelled')
      await coordinator.dispose()
    }
  })

  it('captures a schema-validated result through the stable tool without DSH structured output', async () => {
    const resultTools = toolRegistry()
    const dispose = vi.fn(async () => {})
    const concludeTurn = vi.fn()
    const child = parent('subagent')
    child.id = 'child-run-1'
    const start = vi.fn(async (_provider: string, request: { persona?: string; outputSchema?: unknown; toolFilter?: { allow?: string[] } }) => {
      expect(request.outputSchema).toBeUndefined()
      const definition = resultTools.definitions.at(-1)!
      expect(request.toolFilter?.allow).toContain(definition.name)
      const outerToken = Symbol('run-code')
      const execution = { name: definition.name, token: Symbol('result'), parent: outerToken, agent: child, signal: new AbortController().signal, concludeTurn }
      await definition.execute(resultArguments(request, {
        summary: 'Stored in project.', action: 'stored', memoryBodyIds: ['project'],
      }) as never, execution)
      await expect(definition.execute(resultArguments(request, {
        summary: 'Duplicate.', action: 'skipped', memoryBodyIds: [],
      }) as never, { ...execution, token: Symbol('duplicate') })).rejects.toThrow('already recorded')
      resultTools.emit('tools/result', execution, { isError: false })
      resultTools.emit('tools/result', { name: 'run_code', token: outerToken, signal: execution.signal, agent: child }, { isError: false })
      // Where the memory went comes from the Source receipt (#387).
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Use SQLite.', memoryBodyId: 'project' }, { action: 'added', memoryBodyId: 'project' })
      return { id: child.id, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose }
    })
    const host = {
      list: vi.fn(() => ['spawn']),
      getProvider: vi.fn(() => ({ capabilities: { ...capabilities, outputSchema: false } })),
      start,
    } as unknown as HostSubagentsService
    const coordinator = new MnemonSubagentCoordinator(host, runtimeSource(), resultTools.value)

    // The Source receipt's action is what happened.
    await expect(coordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      action: 'added',
      memoryBodyIds: ['project'],
    })
    expect(concludeTurn).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    coordinator.dispose()
    for (const disposer of resultTools.disposers) expect(disposer).toHaveBeenCalledOnce()
  })

  it('rejects a result captured from any child other than the run that owns the tool', async () => {
    const resultTools = toolRegistry()
    const intruder = parent('subagent')
    intruder.id = 'different-child'
    const host = {
      list: vi.fn(() => ['spawn']),
      getProvider: vi.fn(() => ({ capabilities })),
      start: vi.fn(async (_provider: string, request: { persona?: string }) => {
        const definition = resultTools.definitions.at(-1)!
        const execution = { name: definition.name, token: Symbol('intruder'), agent: intruder, signal: new AbortController().signal, concludeTurn: vi.fn() }
        await definition.execute(resultArguments(request, {
          summary: 'Wrong child.', action: 'skipped', memoryBodyIds: [],
        }) as never, execution)
        resultTools.emit('tools/result', execution, { isError: false })
        return { id: 'child-run-1', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: vi.fn(async () => {}) }
      }),
    } as unknown as HostSubagentsService
    const coordinator = new MnemonSubagentCoordinator(host, runtimeSource(), resultTools.value)

    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('recorded by a different child')
    coordinator.dispose()
    for (const disposer of resultTools.disposers) expect(disposer).toHaveBeenCalledOnce()
  })

  it('rejects malformed result-tool arguments before accepting the child result', async () => {
    const resultTools = toolRegistry()
    const child = parent('subagent')
    child.id = 'child-run-1'
    const host = {
      list: vi.fn(() => ['spawn']),
      getProvider: vi.fn(() => ({ capabilities })),
      start: vi.fn(async (_provider: string, request: { persona?: string }) => {
        await resultTools.definitions.at(-1)!.execute(resultArguments(request, { action: 'stored', memoryBodyIds: [] }) as never, {
          agent: child, signal: new AbortController().signal, concludeTurn: vi.fn(),
        })
        throw new Error('unreachable')
      }),
    } as unknown as HostSubagentsService
    const coordinator = new MnemonSubagentCoordinator(host, runtimeSource(), resultTools.value)

    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('result.summary is required')
    coordinator.dispose()
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
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)

    await expect(coordinator.remember(parent(), { content: 'Use SQLite.', memoryBodyId: 'project' }, new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      action: 'added',
      summary: 'Stored durable project memory.',
      memoryBodyIds: ['project'],
    })
    expect(host.start).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ writes: 1, failures: 0 })
  })

  it.each([false, true])('says whether a write saved its memory without a vector (embedded: %s, #388)', async embedded => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Grafana runs on port 3300.', memoryBodyId: 'project' }, {
        action: 'added', id: 'memory-1', embedded, message: 'Stored durable project memory.', memoryBodyId: 'project', memoryBodyName: 'Project',
      })
    })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    const result = await coordinator.remember(parent(), { content: 'Grafana runs on port 3300.', memoryBodyId: 'project' }, new AbortController().signal)
    expect(result).toMatchObject({ delegated: true, action: 'added', memoryBodyIds: ['project'] })
    if (embedded) {
      expect(result).not.toHaveProperty('unembedded')
      expect(result).not.toHaveProperty('hint')
    } else {
      expect(result).toMatchObject({ unembedded: [{ memoryBodyId: 'project', id: 'memory-1' }], hint: expect.stringContaining('Saved without a vector') })
      // The next step goes through DSH's own storage root and embedding settings, never a terminal command.
      expect((result as { hint: string }).hint).toContain('Test status in the Mnemon Native embedding settings')
      expect((result as { hint: string }).hint).not.toContain('--store')
    }
  })

  it('lists only the memories a run saved without a vector, and none for a skipped duplicate (#388)', async () => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Grafana runs on port 3300.', memoryBodyId: 'project' }, {
        action: 'added', id: 'memory-1', embedded: true, memoryBodyId: 'project',
      })
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Prometheus runs on port 9090.', memoryBodyId: 'ops' }, {
        action: 'added', id: 'memory-2', embedded: false, memoryBodyId: 'ops',
      })
      // A duplicate skip carries no embedded field at all.
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Grafana runs on port 3300.', memoryBodyId: 'project' }, {
        action: 'skipped', memoryBodyId: 'project',
      })
    }, 'completed', { action: 'stored', summary: 'Saved two memories.', memoryBodyIds: ['project', 'ops'] })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    const result = await coordinator.remember(parent(), { content: 'Monitoring ports.' }, new AbortController().signal)
    expect(result).toMatchObject({ unembedded: [{ memoryBodyId: 'ops', id: 'memory-2' }] })
    expect((result as { unembedded: unknown[] }).unembedded).toHaveLength(1)
  })

  it.each(['accepted', 'candidate', 'partial', 'unknown', 'failed'])('does not recover %s completion as stored', async completion => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Pending fact.', memoryBodyId: 'project' }, {
        action: 'stored', memoryBodyId: 'project', memoryReceipt: { status: 'succeeded', completion },
      })
    })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    await expect(coordinator.remember(parent(), { content: 'Pending fact.' }, new AbortController().signal)).resolves.toMatchObject({ action: completion })
    expect(host.start).toHaveBeenCalledOnce()
  })

  it('does not promote an observed accepted receipt using the child summary', async () => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Pending fact.', memoryBodyId: 'project' }, {
        action: 'queued', memoryBodyId: 'project', memoryReceipt: { status: 'accepted', completion: 'accepted' },
      })
    }, 'completed', { summary: 'Stored.', action: 'stored', memoryBodyIds: ['project'] })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    await expect(coordinator.remember(parent(), { content: 'Pending fact.' }, new AbortController().signal)).resolves.toMatchObject({ action: 'accepted' })
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
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)

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
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)

    await expect(coordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)).rejects.toThrow('completed without recording its result')
  })

  it('names the space a write inside a failed Code Mode program went to, not the one the writer claims (#387)', async () => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      const outerToken = Symbol('run-code')
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Use SQLite.', memoryBodyId: 'project' }, {
        action: 'added', id: 'memory-1', memoryBodyId: 'project', memoryBodyName: 'Project',
      }, outerToken)
      resultTools.emit('tools/result', {
        name: 'run_code', arguments: {}, token: outerToken, agent: child, signal: new AbortController().signal,
      }, { isError: true })
    }, 'completed', { action: 'stored', summary: 'Saved in Elsewhere.', memoryBodyIds: ['elsewhere'] })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    const result = await coordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)
    expect(result).toMatchObject({ action: 'stored', memoryBodyIds: ['project'] })
  })

  it.each([
    ['stored', 'unknown'],
    ['skipped', 'skipped'],
  ])('lands nowhere when no receipt shows a write, and reports a claimed %s as %s (#387)', async (claimed, reported) => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, () => {}, 'completed', { action: claimed, summary: 'Saved in Trials.', memoryBodyIds: ['trials'] })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    const result = await coordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)
    expect(result).toMatchObject({ action: reported, memoryBodyIds: [] })
    expect(result).not.toHaveProperty('activatedMemoryBodyIds')
  })

  it('checks a named space before any writer runs, and switches one on only for the user (#387)', async () => {
    const spaces = service()
    const catalog = spaces.bodyDirectory()
    const archive = { ...catalog.items[0]!, id: 'archive', name: 'Archive', active: false }
    const remote = { ...catalog.items[0]!, id: 'remote', name: 'Remote', providerEnabled: false, provider: { id: 'mem0', label: 'Mem0', capabilities: { remember: true } } }
    const readOnly = { ...catalog.items[0]!, id: 'readonly', name: 'Read only', provider: { id: 'openviking', label: 'OpenViking', capabilities: { remember: false } } }
    vi.mocked(spaces.bodyDirectory).mockReturnValue({ ...catalog, items: [...catalog.items, archive, remote, readOnly] } as never)
    const host = subagents({ action: 'stored', summary: 'Saved.', memoryBodyIds: ['archive'] })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(undefined, spaces), toolRegistry().value)
    const signal = new AbortController().signal
    await expect(coordinator.remember(parent(), { content: 'x', memoryBodyId: 'missing' }, signal)).rejects.toThrow(
      'Memory Space "missing" does not exist. Name one by its id: "project" (项目记忆空间), "archive" (Archive, switched off), "remote" (Remote), "readonly" (Read only).')
    await expect(coordinator.remember(parent(), { content: 'x', memoryBodyId: 'remote' }, signal)).rejects.toThrow('Memory Space "remote" uses Mem0, which is turned off on the dsh-mnemon page under Plugins.')
    await expect(coordinator.remember(parent(), { content: 'x', memoryBodyId: 'readonly' }, signal)).rejects.toThrow('Memory Space "readonly" (OpenViking) does not take writes.')
    await expect(coordinator.remember(parent(), { content: 'x', memoryBodyId: 'archive' }, signal)).rejects.toThrow(
      'Memory Space "archive" (Archive) is switched off, and a write would switch it back on. If the user wants it back, switch it on first with mnemon_memory_body_update (active: true); otherwise name an active space.')
    expect(host.start).not.toHaveBeenCalled()
    await coordinator.remember(parent(), { content: 'x', memoryBodyId: 'archive' }, signal, { activateTarget: true })
    expect(host.start).toHaveBeenCalledOnce()
  })

  it('writes nothing when it cannot read the Memory Space directory (#387)', async () => {
    const spaces = service()
    vi.mocked(spaces.bodyDirectory).mockImplementation(() => { throw new Error('registry unreadable') })
    const host = subagents({ action: 'stored', summary: 'Saved.', memoryBodyIds: ['project'] })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(undefined, spaces), toolRegistry().value)
    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('The Memory Space directory could not be read, so nothing was saved: registry unreadable')
    expect(host.start).not.toHaveBeenCalled()
  })

  it('holds a write to its named space, and keeps a write without one off switched-off spaces (#387)', () => {
    const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args }) as unknown as ToolExecution
    const named = spaceWriteGuard('project', new Set(['archive']))
    expect(named(call('mnemon_remember', { memoryBodyId: 'project' }))).toBeUndefined()
    expect(named(call('mnemon_remember', { memoryBodyId: 'archive' }))).toBe(
      'This write was requested for Memory Space "project". Call mnemon_remember with memoryBodyId "project", or finish without writing and say why it does not fit.')
    expect(named(call('mnemon_link', { sourceId: 'a', targetId: 'b' }))).toContain('Call mnemon_link with memoryBodyId "project"')
    expect(named(call('mnemon_link', { sourceId: 'a', targetId: 'b', memoryBodyId: 'project' }))).toBeUndefined()
    expect(named(call('mnemon_memory_body_create', { name: 'New' }))).toContain('so it creates or changes no space')
    expect(named(call('mnemon_memory_body_update', { memoryBodyId: 'project', description: 'x' }))).toContain('so it creates or changes no space')
    expect(named(call('mnemon_recall', { query: 'x' }))).toBeUndefined()
    const open = spaceWriteGuard(undefined, new Set(['archive']))
    expect(open(call('mnemon_remember', { memoryBodyId: 'project' }))).toBeUndefined()
    // Without an id the Source writes only to the one active space.
    expect(open(call('mnemon_remember', {}))).toBeUndefined()
    expect(open(call('mnemon_remember', { memoryBodyId: 'archive' }))).toBe(
      'Memory Space "archive" is switched off, and a write would switch it on. Write to an active space, or finish without writing and say which space would fit.')
    expect(open(call('mnemon_link', { sourceId: 'a', targetId: 'b', memoryBodyId: 'archive' }))).toContain('Memory Space "archive" is switched off')
    expect(open(call('mnemon_memory_body_update', { memoryBodyId: 'archive', active: true }))).toBe('Memory Space "archive" is switched off; only the user switches it on.')
    expect(open(call('mnemon_memory_body_update', { memoryBodyId: 'archive', description: 'Older trials.' }))).toBeUndefined()
    // Saving a memory never merges spaces: a merge switches spaces on and off.
    for (const guard of [named, open]) {
      expect(guard(call('mnemon_memory_body_merge', { targetMemoryBodyId: 'project', sourceMemoryBodyIds: ['other'] }))).toBe(
        'Saving a memory never merges Memory Spaces; a merge is a request of its own. Write the memory, or finish without writing.')
    }
  })

  it('does not recover partial or failed child runs from unrelated successful tools', async () => {
    const resultTools = toolRegistry()
    const partial = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_memory_body_create', { name: 'Project', description: 'Project decisions.' }, {
        id: 'project', name: 'Project', description: 'Project decisions.',
      })
    })
    const partialCoordinator = new MnemonSubagentCoordinator(partial.value, runtimeSource(), resultTools.value)
    await expect(partialCoordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)).rejects.toThrow('completed without recording its result')

    const failedTools = toolRegistry()
    const failed = observedSubagents(failedTools, child => {
      emitSuccessfulToolResult(failedTools, child, 'mnemon_remember', { content: 'Use SQLite.' }, {
        action: 'added', memoryBodyId: 'project', memoryBodyName: 'Project',
      })
    }, 'error')
    const failedCoordinator = new MnemonSubagentCoordinator(failed.value, runtimeSource(), failedTools.value)
    await expect(failedCoordinator.remember(parent(), { content: 'Use SQLite.' }, new AbortController().signal)).rejects.toThrow('stopped with error')
  })

  it('fails closed when a child completes without a terminal result or matching successful tool receipt', async () => {
    const host = subagents(undefined)
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('completed without recording its result')
    expect(host.dispose).toHaveBeenCalledOnce()
  })

  it('delegates writes with mutation tools and returns a compact receipt', async () => {
    const resultTools = toolRegistry()
    const host = observedSubagents(resultTools, child => {
      emitSuccessfulToolResult(resultTools, child, 'mnemon_remember', { content: 'Durable choice', memoryBodyId: 'project' }, { action: 'added', memoryBodyId: 'project' })
    }, 'completed', { summary: 'Stored in project.', action: 'stored', memoryBodyIds: ['project'] })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    await expect(coordinator.remember(parent(), { content: 'Durable choice' }, new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      action: 'added',
      memoryBodyIds: ['project'],
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: expect.arrayContaining(['mnemon_recall', 'mnemon_remember', 'mnemon_memory_body_create', 'mnemon_memory_body_merge']) },
    }))
    expect((host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }> }])[1].prompt[0]!.text).not.toMatch(/catalog_json|request_json|dbPath/)
  })

  it('excludes destructive forget from autonomous distillation runs (issue 148)', async () => {
    const host = subagents({ summary: 'Stored in project.', action: 'stored', memoryBodyIds: ['project'] })
    const coordinator = createCoordinator(host.value)
    await coordinator.remember(parent(), { content: 'Durable choice' }, new AbortController().signal)
    const rememberCall = (host.start.mock.calls[0] as unknown as [string, { toolFilter: { allow: string[] }; persona: string }])[1]
    expect(rememberCall.toolFilter.allow).toContain('mnemon_remember')
    expect(rememberCall.toolFilter.allow).not.toContain('mnemon_forget')
    expect(rememberCall.persona).toContain('you cannot and must not delete existing entries')
  })

  it('recovers a delegated write child whose server refuses a request without a user query (issue 327)', async () => {
    const host = subagents({ summary: 'Stored in project.', action: 'stored', memoryBodyIds: ['project'] })
    const registry = toolRegistry()
    const handlers = new Map<string, (payload: never, next: () => Promise<unknown>) => Promise<unknown>>()
    const append = vi.fn()
    const child = { ...parent('subagent'), id: 'child-run-1', session: { ...parent('subagent').session, append }, ctx: { on: (name: string, handler: never) => {
      handlers.set(name, handler)
      return () => {}
    } } } as unknown as HostAgent
    // DSH publishes the child while the provider starts it.
    const publishing: HostSubagentsService = { ...host.value, async start(provider, request) {
      registry.publish(child, request.parent)
      return host.value.start!(provider, request)
    } }
    const coordinator = new MnemonSubagentCoordinator(publishing, runtimeSource(), registry.value)
    await coordinator.remember(parent(), { content: 'Durable choice' }, new AbortController().signal)
    expect([...handlers.keys()].sort()).toEqual(['agent/pre-step', 'agent/request-error'])
    const live = new AbortController().signal
    const step = handlers.get('agent/pre-step')!
    // Nothing changes before a refusal.
    await expect(step({ messages: [], step: 2, signal: live } as never, async () => ({ kind: 'enter', messages: [] }))).resolves.toEqual({ kind: 'enter', messages: [] })
    await expect(handlers.get('agent/request-error')!({ turn: 1, step: 3, failure: { message: 'no user query found in messages', code: 'SERVER_ERROR' }, signal: live } as never, async () => undefined))
      .resolves.toEqual({ kind: 'retry' })
    expect(append).toHaveBeenCalledExactlyOnceWith('user/message', expect.objectContaining({ content: [{ type: 'text', text: CONTINUATION_TEXT }] }), { surfaceOp: 'append' })
    await expect(step({ messages: [], step: 4, signal: live } as never, async () => ({ kind: 'enter', messages: [] })))
      .resolves.toMatchObject({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: CONTINUATION_TEXT }] }] })
  })

  it('excludes destructive forget from supervised writeback runs (issue 148)', async () => {
    const host = subagents({ summary: 'Stored in project.', action: 'stored', memoryBodyIds: ['project'] })
    const coordinator = createCoordinator(host.value)
    await coordinator.write(parent(), 'supervised-writeback', { content: 'Live user candidate' }, new AbortController().signal)
    const writebackCall = (host.start.mock.calls[0] as unknown as [string, { toolFilter: { allow: string[] } }])[1]
    expect(writebackCall.toolFilter.allow).not.toContain('mnemon_forget')
    expect(writebackCall.toolFilter.allow).toContain('mnemon_remember')
  })

  it('keeps the forget tool for explicit user forget operations', async () => {
    const host = subagents({ summary: 'Forgot m1.', action: 'forgotten', memoryBodyIds: ['project'] })
    const coordinator = createCoordinator(host.value)
    await coordinator.write(parent(), 'forget', { id: 'm1' }, new AbortController().signal)
    const forgetCall = (host.start.mock.calls[0] as unknown as [string, { toolFilter: { allow: string[] }; persona: string }])[1]
    expect(forgetCall.toolFilter.allow).toContain('mnemon_forget')
    expect(forgetCall.persona).not.toContain('you cannot and must not delete existing entries')
  })

  it('selects a provider in a tool-free child and keeps user policy out of the persona', async () => {
    const host = subagents({
      providerId: 'work-account',
      reason: 'A shared remote scope matches this team knowledge body.',
      confidence: 'high',
    })
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    host.start.mockImplementation(async (...args: unknown[]) => {
      const request = args[1] as { persona?: string }
      const definition = resultTools.definitions[0]!
      const execution = { name: definition.name, agent: { ...parent('subagent'), id: 'child-run-1' }, signal: new AbortController().signal, concludeTurn: vi.fn(), token: Symbol('placement') }
      await expect(definition.execute(resultArguments(request, {
        summary: 'A write envelope cannot complete placement.', action: 'skipped', memoryBodyIds: [],
      }) as never, execution)).rejects.toThrow('result.providerId is required')
      await expect(definition.execute(resultArguments(request, {
        providerId: 'unavailable-account', reason: 'Not eligible.', confidence: 'high',
      }) as never, execution)).rejects.toThrow('result.providerId is not an allowed value')
      expect(execution.concludeTurn).not.toHaveBeenCalled()
      await definition.execute(resultArguments(request, {
        providerId: 'work-account', reason: 'A shared remote scope matches this team knowledge body.', confidence: 'high',
      }) as never, execution)
      resultTools.emit('tools/result', execution, { isError: false })
      return { id: 'child-run-1', result: Promise.resolve({ output: [], structured: undefined, stopReason: 'completed' }), dispose: host.dispose }
    })
    const placementCandidates: MemoryPlacementCandidate[] = [
      {
        id: 'mnemon-native', label: 'Mnemon Native', kind: 'local', configured: true, summary: 'Local exact memory.',
        capabilities: { search: true, browse: true, graph: true, entities: true, related: true, remember: true, link: true, forget: true, writeMode: 'exact', deletionMode: 'soft' },
      },
      {
        id: 'work-account', label: 'Work Vector Store', kind: 'remote', configured: true, summary: 'Shared extracting memory.',
        capabilities: { search: true, browse: true, graph: false, entities: false, related: false, remember: true, link: false, forget: false, writeMode: 'async-extracting', deletionMode: 'hard' },
      },
    ]
    const prepared: PreparedMemoryPlacement = {
      prompt: '团队知识优先团队 Provider。', candidates: placementCandidates, appliedRules: [], selectorBrief: 'Choose an eligible local or shared store.',
    }

    await expect(coordinator.placeProvider(parent(), {
      name: '团队发布经验',
      description: '跨成员共享发布门禁与回滚经验。',
    }, prepared, new AbortController().signal)).resolves.toMatchObject({
      providerId: 'work-account',
      decidedBy: 'llm',
      runId: 'child-run-1',
    })

    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: ['mnemon_subagent_result'] },
      maxDepth: 1,
      persona: expect.stringContaining('host-filtered eligible list'),
    }))
    const request = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string }])[1]
    expect(request.prompt[0]!.text).toContain('团队知识优先团队 Provider。')
    expect(request.persona).not.toContain('团队知识优先团队 Provider。')
    expect(request.persona).not.toMatch(/api.?key|endpoint|secret/iu)
    expect(delegatedResultSchema((host.start.mock.calls as unknown as Array<[string, { persona: string }] >)[0]![1]).properties.providerId?.enum)
      .toEqual(['mnemon-native', 'work-account'])
    expect(coordinator.snapshot()).toMatchObject({ placements: 1, lastOperation: 'placement' })
    await coordinator.dispose()
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
    const runtime = runtimeSource(undefined, memoryService)
    const coordinator = createCoordinator(host.value, runtime)

    await expect(coordinator.maintainMetadata(parent(), ['product', 'release'], new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      runId: 'child-run-1',
      updates: [{ memoryBodyId: 'product', title: '产品决策' }],
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: ['mnemon_subagent_result'] },
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
    await expect(createCoordinator(incomplete.value, runtime).maintainMetadata(parent(), ['product', 'release'], new AbortController().signal)).resolves.toMatchObject({
      updates: [{ memoryBodyId: 'product' }],
    })

    const invalid = subagents({ summary: 'No valid metadata.', updates: [{ memoryBodyId: 'product', title: 'x', description: 'too short' }] })
    await expect(createCoordinator(invalid.value, runtime).maintainMetadata(parent(), ['product'], new AbortController().signal)).resolves.toMatchObject({ updates: [] })
  })

  it('answers from pre-recalled evidence without granting any Mnemon retrieval tools', async () => {
    const host = subagents({ answer: '项目使用 SQLite。', citations: ['project/m1', 'project/missing'] })
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.answer(parent(), '数据库是什么？', [{ id: 'm1', content: 'Use {{database}} SQLite.', memoryBodyId: 'project', memoryBodyName: '项目记忆空间' }], new AbortController().signal)).resolves.toMatchObject({
      answer: '项目使用 SQLite。',
      citations: ['project/m1'],
      delegation: { runId: 'child-run-1', provider: 'spawn' },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({ toolFilter: { allow: ['mnemon_subagent_result'] } }))
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
    const documents = await sourceFixture({ dataDir: join(workspace, '.mnemon'), workspace, documentLimitBytes: 1_000 })
    releases.push(documents.dispose)
    const controller = managedSession(documents.documents)
    const old = await controller.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Old architecture', content: 'a'.repeat(220) })
    const resultTools = toolRegistry()
    const memoryService = service()
    const host = subagents({ summary: 'Archived with exact cold path.', action: 'planned', memoryBodyId: 'project' })
    vi.mocked(memoryService.rememberMany).mockResolvedValueOnce([{ action: 'added', id: 'document-index-1', memoryBodyId: 'project' }])
    const archive = vi.spyOn(controller, 'mutate')
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(undefined, memoryService, controller), resultTools.value)
    const agent = { ...parent(), session: { header: { cwd: workspace }, ...sessionLog() } } as HostAgent

    const result = await coordinator.document(agent, { action: 'create', title: 'New architecture', content: 'b'.repeat(220) }, new AbortController().signal)
    expect(result).toMatchObject({
      action: 'created',
      maintenance: { archivedDocumentIds: [old.document.id], memoryBodyIds: ['project'] },
    })
    expect(await controller.read<DocumentView>('document', { id: old.document.id })).toMatchObject({ status: 'archived', archiveSummary: 'Archived with exact cold path.' })
    expect(archive).toHaveBeenCalledWith('archive', expect.objectContaining({
      id: old.document.id, documentRevision: old.document.revision,
      memoryBodyIds: ['project'],
      lineage: [{
        source: { layerId: 'documents', reference: `document:${old.document.id}:${old.document.revision}`, digest: old.document.contentHash },
        destination: {
          layerId: 'memory-spaces',
          reference: 'memory-space:project/item:document-index-1',
          digest: createHash('sha256').update(vi.mocked(memoryService.rememberMany).mock.calls[0]![0][0]!.content).digest('hex'),
        },
      }],
    }), expect.any(AbortSignal))
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      persona: expect.stringContaining('cold-document archive planner'),
      toolFilter: { allow: ['mnemon_subagent_result'] },
    }))
    const archiveCall = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string }])[1]
    expect(archiveCall.prompt[0]!.text).toContain(`.mnemon/documents/archived/${old.document.filename}`)
    expect(archiveCall.persona).not.toContain(old.document.filename)
    expect(coordinator.snapshot()).toMatchObject({ documentArchives: 1, lastOperation: 'document-archive' })
  })

  it('does not accept a near-match or another space as an existing document index', async () => {
    const f = await documentArchiveFixture()
    const cold = `.mnemon/documents/archived/${f.document.filename}`
    vi.mocked(f.spaces.search).mockResolvedValue({ query: '', mode: 'keyword', results: [
      { id: 'near-match', content: `Old revision ${cold} wrong-digest`, memoryBodyId: 'project' },
      { id: 'wrong-space', content: `${cold} ${f.document.contentHash}`, memoryBodyId: 'other' },
    ] as Insight[] })
    await expect(f.archive()).resolves.toMatchObject({ action: 'archived' })
    expect(f.spaces.rememberMany).toHaveBeenCalledOnce()
    expect(f.spaces.forget).not.toHaveBeenCalled()
  })

  it('disposes failed delegated writes and reports the bounded provider error', async () => {
    const failedChild = {
      ...parent('subagent'),
      session: { header: { origin: 'subagent' as const }, ...sessionLog([{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_ROUTE', message: 'provider rejected sk-secret123456' } } } }]) },
    }
    const host = subagents(undefined, 'error', ['spawn'], failedChild)
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('stopped with error: MODEL_ROUTE: provider rejected [redacted]')
    expect(host.dispose).toHaveBeenCalledOnce()
    expect(coordinator.snapshot().failures).toBe(1)
  })

  it('uses the provider diagnostic for a failed remote child', async () => {
    const host = subagents(undefined, 'error', ['spawn'], undefined, 'REMOTE_GATEWAY:  rejected   sk-secret123456')
    const coordinator = createCoordinator(host.value)

    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal))
      .rejects.toThrow('stopped with error: REMOTE_GATEWAY: rejected [redacted]')
    expect(host.dispose).toHaveBeenCalledOnce()
  })

  it('compacts USER.md through a DSH 0.2.1 activation that reports only to Mnemon, composed in the child\'s own scope (#356)', async () => {
    const registry = toolRegistry()
    const composed = composableChild('child-run-1')
    const host = activations({
      summary: 'Merged two compatible profile preferences locally.',
      action: 'compacted',
      compactedEntries: [{ content: 'User prefers concise Chinese release notes with blockers first.', importance: 'critical', sourceIndexes: [1, 2] }],
    }, 'completed', ['spawn'], spec => registry.publish(composed.child, spec.request.parent), () => registry.unpublish('child-run-1'))
    const plan = maintenancePlan('user', [
      { content: 'User prefers concise Chinese release notes.', importance: 'critical' },
      { content: 'User wants blockers listed first in release notes.', importance: 'normal' },
    ])
    plan.pending = { content: 'User prefers direct answers.', importance: 'normal' }
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('user', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, message: 'Entry added.', target: 'user', entryCount: 2, usage: { used: 180, limit: 4_096 }, added: plan.pending!.content })),
    } as unknown as RuntimeOperations
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime), registry.value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'user', content: 'User prefers direct answers.' }, new AbortController().signal)).resolves.toMatchObject({
      added: 'User prefers direct answers.',
      maintenance: { kind: 'local-compaction', runId: 'child-run-1', provider: 'spawn' },
    })
    expect(host.startActivation).toHaveBeenCalledOnce()
    const spec = host.startActivation.mock.calls[0]![0]
    expect(spec).toMatchObject({ provider: 'spawn', label: 'Consolidate local user profile', delivery: 'caller' })
    const request = spec.request
    expect(request).toMatchObject({ maxDepth: 1, agentOptions: { maxTokens: 8_192 } })
    for (const key of ['toolFilter', 'persona', 'label', 'signal']) expect(request).not.toHaveProperty(key)
    expect(composed.restrictions).toEqual([{ allow: ['mnemon_subagent_result'] }])
    expect(composed.sections).toEqual([{ name: 'deployment:persona-prefix', order: 0, text: expect.stringContaining('local USER.md compactor') }])
    expect(composed.sections[0]!.text).toMatch(/requestId `[^`]+`/u)
    expect(host.dispose).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ compactions: 1, failures: 0 })
  })

  it('reviews a checkpoint through a DSH 0.2.1 fork activation that carries both the review guard and its own composition (#356)', async () => {
    const registry = toolRegistry()
    const composed = composableChild('child-run-1')
    const host = activations({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] }, 'completed', ['spawn', 'fork'],
      spec => registry.publish(composed.child, spec.request.parent), () => registry.unpublish('child-run-1'))
    const runtime = runtimeSource()
    runtime.config.idleReview.provider = 'fork'
    const coordinator = new MnemonSubagentCoordinator(host.value, runtime, registry.value)

    await expect(coordinator.review(parent(), new AbortController().signal)).resolves.toMatchObject({ delegated: true, provider: 'fork', action: 'skipped' })
    expect(host.startActivation).toHaveBeenCalledWith(expect.objectContaining({ provider: 'fork', label: 'Mnemon idle checkpoint review', delivery: 'caller' }))
    expect(host.startActivation.mock.calls[0]![0].request).not.toHaveProperty('toolFilter')
    expect(composed.guard).toHaveBeenCalledOnce()
    expect(composed.restrictions).toEqual([{ allow: expect.arrayContaining(['mnemon_document_search', 'mnemon_document_create', 'mnemon_subagent_result']) }])
    expect(composed.sections).toHaveLength(1)
    expect(host.dispose).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ reviews: 1, failures: 0 })
  })

  it('starts no memory subagent through a DSH 0.2.1 provider that runs children elsewhere', async () => {
    const host = activations({ summary: 'unused' })
    vi.mocked(host.value.getProvider).mockImplementation(() => ({ capabilities: DSH_021_CAPABILITIES }) as never)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), toolRegistry().value)

    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('requires a non-inheriting DSH subagent provider that limits depth and gives each child its own instructions and tools')
    expect(host.startActivation).not.toHaveBeenCalled()
  })

  it('selects no provider on a DSH whose providers decline a persona and tool filter', async () => {
    const host = activations({ summary: 'unused' })
    vi.mocked(host.value.getProvider).mockImplementation(() => ({ capabilities: { outputSchema: true, depthLimit: true, toolFilter: false, persona: false } }) as never)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), toolRegistry().value)

    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('requires a non-inheriting DSH subagent provider that limits depth and gives each child its own instructions and tools')
    expect(host.startActivation).not.toHaveBeenCalled()
  })

  it('reports the bounded error of a failed activation child found in the Agent registry (#356)', async () => {
    const registry = toolRegistry()
    const failedChild = {
      ...composableChild('child-run-1').child,
      session: { header: { origin: 'subagent' as const }, ...sessionLog([{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_ROUTE', message: 'provider rejected sk-secret123456' } } } }]) },
    } as unknown as HostAgent
    const host = activations(undefined, 'error', ['spawn'], spec => registry.publish(failedChild, spec.request.parent), () => registry.unpublish(failedChild.id))
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), registry.value)

    // The child has left the registry by the time its result settles; the detail comes from the child found at start.
    await expect(coordinator.remember(parent(), { content: 'x' }, new AbortController().signal)).rejects.toThrow('stopped with error: MODEL_ROUTE: provider rejected [redacted]')
    expect(host.dispose).toHaveBeenCalledOnce()
    expect(coordinator.snapshot().failures).toBe(1)
  })

  it('uses an explicit skill model ahead of the fixed task model', async () => {
    const host = subagents({ answer: 'done' }, 'completed', ['spawn'])
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value, () => ({ provider: 'pinned-provider', model: 'pinned-model' }))
    const route = { provider: 'chosen-provider', model: 'chosen-model' }
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }

    await coordinator.skillTask(parent(), 'Skill draft', 'Write a draft', schema, 'Write skills.', new AbortController().signal, route)
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      agentOptions: { ...route, maxTokens: 16_384 },
    }))
  })

  it('passes a draft-specific output budget without changing other skill work', async () => {
    const host = subagents({ answer: 'done' })
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    const route = { provider: 'chosen-provider', model: 'chosen-model' }
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
    await coordinator.skillTask(parent(), 'Skill draft', 'Write a draft', schema, 'Write skills.', new AbortController().signal, route, 49_152)
    await coordinator.skillTask(parent(), 'Skill judge', 'Judge the result', schema, 'Judge skills.', new AbortController().signal)
    expect(host.start.mock.calls.map(([, request]) => request?.agentOptions)).toEqual([
      { ...route, maxTokens: 49_152 }, { maxTokens: 16_384 },
    ])
  })

  it('reports truncation with its actual budget before parsing an incomplete skill result', async () => {
    const host = subagents({ incomplete: true }, 'max-tokens')
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(), resultTools.value)
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
    await expect(coordinator.skillTask(parent(), 'Skill draft', 'Write a draft', schema, 'Write skills.', new AbortController().signal, undefined, 32_768))
      .rejects.toMatchObject({ stopReason: 'max-tokens', maxTokens: 32_768 })
    expect(host.dispose).toHaveBeenCalledOnce()
  })

  it('pins a fixed task Agent model onto the bounded idle review delegation', async () => {
    const host = subagents({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] }, 'completed', ['spawn', 'fork'])
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(resultTools.withReviewPublication(host.value), runtimeSource(), resultTools.value, () => ({ provider: 'pinned-provider', model: 'pinned-model' }))

    await expect(coordinator.review(parent(), new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      provider: 'spawn',
      action: 'skipped',
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: expect.arrayContaining(['mnemon_document_search', 'mnemon_runtime_memory', 'mnemon_document_create']) },
      agentOptions: { provider: 'pinned-provider', model: 'pinned-model', maxTokens: 16384 },
    }))
  })

  it('omits provider/model from agentOptions when the task Agent model is inherited', async () => {
    const host = subagents({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] }, 'completed', ['spawn', 'fork'])
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(resultTools.withReviewPublication(host.value), runtimeSource(), resultTools.value, () => undefined)

    await expect(coordinator.review(parent(), new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      provider: 'spawn',
    })
    const reviewCall = (host.start.mock.calls[0] as unknown as [string, { agentOptions?: unknown }])[1]
    expect(reviewCall.agentOptions).toEqual({ maxTokens: 16384 })
  })

  it('uses the configured idle-review maxTokens for the review child (regression: max-tokens stop)', async () => {
    const host = subagents({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] }, 'completed', ['spawn', 'fork'])
    const resultTools = toolRegistry()
    const runtime = runtimeSource()
    runtime.config.idleReview.maxTokens = 24_576
    const coordinator = new MnemonSubagentCoordinator(resultTools.withReviewPublication(host.value), runtime, resultTools.value)

    await expect(coordinator.review(parent(), new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      provider: 'spawn',
    })
    const reviewCall = (host.start.mock.calls[0] as unknown as [string, { agentOptions?: unknown }])[1]
    expect(reviewCall.agentOptions).toEqual({ maxTokens: 24_576 })
  })

  it('merges a fixed task Agent model with the configured Runtime maintenance maxTokens', async () => {
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
      mutate: vi.fn().mockRejectedValueOnce(capacityError('user', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, message: 'Entry added.', target: 'user', entryCount: 2, usage: { used: 180, limit: 4_096 }, added: plan.pending!.content })),
    } as unknown as RuntimeOperations
    const resultTools = toolRegistry()
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime), resultTools.value, () => ({ provider: 'pinned-provider', model: 'pinned-model' }), () => 32_768)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'user', content: 'User prefers direct answers.' }, new AbortController().signal)).resolves.toMatchObject({
      maintenance: { kind: 'local-compaction' },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      agentOptions: { provider: 'pinned-provider', model: 'pinned-model', maxTokens: 32_768 },
    }))
  })
})

/**
 * What one delegated child reads, as SHA-256 hashes: its persona, the completion protocol after it,
 * which names its result schema, with the run's requestId left out, and its task.
 */
function childText(call: unknown[]) {
  const request = call[1] as HostSubagentStartRequest
  const persona = request.persona ?? ''
  const protocol = persona.indexOf('\n\nCompletion protocol: ')
  const requestId = /requestId `([^`]+)`/u.exec(persona)?.[1] ?? ''
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
  return {
    label: request.label,
    persona: sha256(persona.slice(0, protocol)),
    completion: sha256(persona.slice(protocol).replaceAll(requestId, '<requestId>')),
    task: sha256(request.prompt[0]!.text),
  }
}

describe('What delegated children read', () => {
  it('gives every kind of delegated child the persona, result schema and task it has always read', async () => {
    const signal = new AbortController().signal
    const read: Record<string, Array<ReturnType<typeof childText>>> = {}

    const writes: Array<[string, string, unknown]> = [
      ['remember', 'remember', { content: 'The release train leaves on Thursdays.', category: 'decision', importance: 4, tags: ['release', 'schedule'], entities: ['DSH'], source: 'agent',
        metadata: { ticket: 'REL-12', reviewed: true } }],
      ['remember in a named space', 'remember', { content: 'The release train leaves on Thursdays.', memoryBodyId: 'project' }],
      ['supervised writeback', 'supervised-writeback', { content: 'I prefer short status updates.\nBlockers first.' }],
      ['link', 'link', { sourceId: 'm1', targetId: 'm2', type: 'causal', weight: 0.8, reason: 'The red gate caused the rollback.', memoryBodyId: 'project' }],
      ['forget', 'forget', { id: 'm1', memoryBodyId: 'project' }],
      ['create a space', 'create-memory-body', { name: 'Release', description: 'Release gates and rollbacks.', providerId: 'mnemon-native', reason: 'Local exact memory.', confidence: 'high' }],
      ['update a space', 'update-memory-body', { memoryBodyId: 'project', description: 'Project decisions and their reasons.', active: true }],
      ['merge spaces', 'merge-memory-bodies', { targetMemoryBodyId: 'project', sourceMemoryBodyIds: ['release'], deactivateSources: true }],
    ]
    for (const [name, operation, request] of writes) {
      const host = subagents({ summary: 'Saved.', action: 'stored', memoryBodyIds: ['project'] })
      await createCoordinator(host.value).write(parent(), operation, request, signal)
      read[name] = host.start.mock.calls.map(childText)
    }

    const answering = subagents({ answer: 'SQLite.', citations: ['project/m1'] })
    await createCoordinator(answering.value).answer(parent(), 'Which database do we use?', [
      { id: 'm1', content: 'The project uses SQLite.\nMigrations run on boot.', memoryBodyId: 'project', memoryBodyName: 'Project', category: 'decision' },
      { id: 'm2', content: 'Backups run nightly.', memoryBodyId: 'project' },
    ], signal)
    read.answer = answering.start.mock.calls.map(childText)

    const placing = subagents({ providerId: 'mnemon-native', reason: 'Local exact memory fits.', confidence: 'high' })
    await createCoordinator(placing.value).placeProvider(parent(), { name: 'Release', description: 'Release gates and rollbacks.' }, {
      prompt: 'Keep team knowledge local.', appliedRules: [], selectorBrief: 'Choose an eligible local or shared store.',
      candidates: [{
        id: 'mnemon-native', label: 'Mnemon Native', kind: 'local', configured: true, summary: 'Local exact memory.',
        capabilities: { search: true, browse: true, graph: true, entities: true, related: true, remember: true, link: true, forget: true, writeMode: 'exact', deletionMode: 'soft' },
      }, {
        id: 'work-account', label: 'Work Vector Store', kind: 'remote', configured: true, summary: 'Shared extracting memory.',
        capabilities: { search: true, browse: true, graph: false, entities: false, related: false, remember: true, link: false, forget: false, writeMode: 'async-extracting', deletionMode: 'hard' },
      }],
    }, signal)
    read.placement = placing.start.mock.calls.map(childText)

    const curating = subagents({ summary: 'Updated two scopes.', updates: [
      { memoryBodyId: 'product', title: 'Product decisions', description: 'Stable product scope and trade-offs, recalled when planning.' },
      { memoryBodyId: 'release', title: 'Release gates', description: 'Release gates and rollback notes, recalled before shipping.' },
    ] })
    await createCoordinator(curating.value).maintainMetadata(parent(), ['product', 'release'], signal)
    read['metadata maintenance'] = curating.start.mock.calls.map(childText)

    for (const provider of ['spawn', 'fork'] as const) {
      for (const runtimeMemory of [true, false]) {
        const reviewing = subagents({ summary: 'Nothing to keep.', action: 'skipped', memoryBodyIds: [] }, 'completed', ['spawn', 'fork'])
        const runtime = runtimeSource()
        Object.assign(runtime.config.idleReview, { provider, runtimeMemory })
        await createCoordinator(reviewing.value, runtime).review(parent(), signal)
        read[`review through ${provider}${runtimeMemory ? '' : ' without runtime memory'}`] = reviewing.start.mock.calls.map(childText)
      }
    }

    // Four entries make two routing batches; the second is longer than a routing excerpt keeps.
    const plan = maintenancePlan('memory', [
      { content: `Release checks require a canary. ${'Watch the canary for an hour. '.repeat(10)}`, importance: 'critical' },
      { content: `Rollback notes: ${'roll back on a red gate. '.repeat(30)}`, importance: 'normal' },
      { content: `The project uses pnpm. ${'Pin the lockfile. '.repeat(18)}`, importance: 'normal' },
      { content: `Deploys go through staging. ${'Stage before production. '.repeat(12)}`, importance: 'normal' },
    ])
    plan.entries[3]!.branches = ['release/1.2', 'release/1.3']
    const routing = subagents(undefined)
    routing.start.mockImplementation(async (_provider, request) => {
      const indexes = /Allowed source indexes for this batch: ([\d, ]+)\./u.exec(request!.prompt[0]!.text)![1]!.split(', ').map(Number)
      const structured = { summary: 'Routed the batch.', action: 'planned', routes: [{ sourceIndexes: indexes, memoryBodyId: 'release' }] }
      return { id: 'child-run-1', result: Promise.resolve({ output: [], structured, stopReason: 'completed' }), dispose: routing.dispose }
    })
    const archiveRuntime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, target: 'memory', added: plan.pending!.content, usage: { used: 30, limit: plan.limit } })),
    } as unknown as RuntimeOperations
    const archiveSpaces = service()
    addSecondWritableBody(archiveSpaces)
    await new MnemonSubagentCoordinator(routing.value, runtimeSource(archiveRuntime, archiveSpaces), toolRegistry().value)
      .runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, signal)
    read['MEMORY.md archive routing'] = routing.start.mock.calls.map(childText)

    const compacting = subagents({ summary: 'Merged two preferences.', action: 'compacted', compactedEntries: [
      { content: 'User prefers concise Chinese release notes with blockers first.', importance: 'critical', sourceIndexes: [1, 2] },
    ] })
    const profile = maintenancePlan('user', [
      { content: 'User prefers concise Chinese release notes.', importance: 'critical' },
      { content: 'User wants blockers listed first in release notes.', importance: 'normal' },
    ])
    const profileRuntime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('user', profile.used, profile.projected, profile.limit)),
      planMaintenance: vi.fn(async () => profile),
      compactAndMutate: vi.fn(async () => ({ success: true, target: 'user', added: profile.pending!.content, usage: { used: 180, limit: profile.limit } })),
    } as unknown as RuntimeOperations
    await createCoordinator(compacting.value, profileRuntime).runtime(parent(), { action: 'add', target: 'user', content: profile.pending!.content }, signal)
    read['USER.md compaction'] = compacting.start.mock.calls.map(childText)

    const content = 'Canary before production.\nKeep the exact original.'
    const document = {
      id: 'release-design', title: 'Release design', description: 'Release gates and rollbacks', status: 'active', revision: 2,
      filename: 'release-design-0a1b2c3d.md', relativePath: '.mnemon/documents/active/release-design-0a1b2c3d.md', sourcePaths: ['docs/release.md', 'docs/rollback.md'],
      content, contentHash: createHash('sha256').update(content).digest('hex'),
    } as unknown as DocumentView
    const controller = {
      forGeneration() { return this },
      read: vi.fn(async () => document),
      mutate: vi.fn(async () => ({ action: 'archived', document: { ...document, status: 'archived' } })),
    } as unknown as SourceSession
    const archiving = subagents({ summary: 'Release design: release gates and rollbacks.', action: 'planned', memoryBodyId: 'project' })
    const indexSpaces = service()
    vi.mocked(indexSpaces.search).mockResolvedValue({ query: '', mode: 'keyword', results: [] })
    await new MnemonSubagentCoordinator(archiving.value, runtimeSource(undefined, indexSpaces, controller), toolRegistry().value).archiveDocument(parent(), document.id, signal)
    read['document archive'] = archiving.start.mock.calls.map(childText)

    // Reconciliation runs as a maintenance task, through the task runner, over evidence it reads from the graph.
    const reconciling = subagents({ title: 'Memory is coherent', summary: 'Nothing to change.', action: 'none', operations: [] })
    const local = (content: string, overrides: object = {}) => ({ content, target: 'memory', importance: 'normal', created_at: '2026-08-14T12:00:00.000Z', updated_at: '2026-08-14T12:00:00.000Z', ...overrides })
    const usage = (target: 'memory' | 'user') => ({ target, used: 120, limit: 1_024, entryCount: 1, markdownPath: `/fixture/${target}.md` })
    const desktop = { id: 'machine-b', label: 'desktop', createdAt: '2026-08-14T12:00:00.000Z' }
    const reconcileGraph = {
      directory: '/fixture',
      packs: { identity: () => ({ id: 'machine-a', label: 'laptop', createdAt: '2026-08-14T12:00:00.000Z' }) },
      memoryComposition: { acquire: () => ({ generation: {}, release: () => {} }) },
      source: (type: string) => ({ forGeneration: () => ({ read: async () => type === 'runtime'
        ? { entries: [
          local('Release notes go out on Thursdays.'),
          local('Release notes ship every Thursday.', { origin: { machine: 'machine-b', label: 'desktop' } }),
          local('Pin the lockfile.\nNever float it.', { importance: 'critical', branches: ['main', 'release'] }),
          local('Prefers short answers.', { target: 'user' }),
        ], targets: { memory: usage('memory'), user: usage('user') } }
        : { activeBytes: 400, limitBytes: 1_024, documents: [
          { id: 'release-design', title: 'Release design', status: 'active', sizeBytes: 400, description: 'Release gates\nand rollbacks' },
          { id: 'old-design', title: 'Old design', status: 'archived', sizeBytes: 100, description: '' },
        ] } }) }),
      sync: { readRemoteForEvidence: async () => ({
        remoteOnly: [{ target: 'memory', importance: 'normal', content: 'Canary first.', origin: { machine: 'machine-b', label: 'desktop' } }],
        conflicts: [{ target: 'memory', similarity: 0.8,
          local: { target: 'memory', importance: 'normal', content: 'Deploy on Fridays.' }, remote: { target: 'memory', importance: 'normal', content: 'Never deploy on Fridays.' } }],
        truncated: false, remoteTombstones: [{ target: 'user', contentHash: 'removed-entry', deletedAt: '2026-08-15T12:00:00.000Z' }],
        branch: 'mnemon/sync', remote: { machine: desktop },
      }) },
      reviews: { list: () => [{ status: 'pending', opinions: [{ author: 'user', text: 'Keep the Thursday rule.', createdAt: '2026-08-16T12:00:00.000Z' }] }], create: vi.fn() },
    } as unknown as MnemonRuntimeGraph
    const maintenanceTask: RuntimeMaintenanceTaskRunner = (_scope, _signal, operation) => operation(parent())
    await new MnemonSubagentCoordinator(reconciling.value, runtimeSource(), toolRegistry().value, undefined, undefined, maintenanceTask)
      .reconcile(reconcileGraph, { storage: 'global' }, signal, { guidance: 'Merge the two Thursday rules.' })
    read.reconcile = reconciling.start.mock.calls.map(childText)

    expect(read).toEqual({
      remember: [
        { label: 'Mnemon remember', persona: 'c2ef08b302b643b680f1e7d7e953981027d0e780d15ec931282a20fc4e20eeb6',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: '1751ae61c39e985c6bd27da78fae45834a688eb7c33325675c7d92417ed341a4' },
      ],
      'remember in a named space': [
        { label: 'Mnemon remember', persona: 'c2ef08b302b643b680f1e7d7e953981027d0e780d15ec931282a20fc4e20eeb6',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: 'fbe048318b4e53edd70fc79bd7a5ebc2c63e8f74d70bef18d9e731bcaec64076' },
      ],
      'supervised writeback': [
        { label: 'Mnemon supervised-writeback', persona: '052eed66fc4e7743491fdba64bf4e2ed894bf9d3265070769cb8c3e1d44f2ebf',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: '973f143b101ae2ad3926f6a808be6419020fed3644c5cb7e60dc681ca02fdae3' },
      ],
      link: [
        { label: 'Mnemon link', persona: '382f5a3272f33fc0a8d9899160f7c329d92f98b9132b5cc7ff66deb4e8761dbc',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: 'd5938f682627e3d836a12325e815b17cfe7d3343e782bb490c188fa88b518e9f' },
      ],
      forget: [
        { label: 'Mnemon forget', persona: '382f5a3272f33fc0a8d9899160f7c329d92f98b9132b5cc7ff66deb4e8761dbc',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: '3274d890fed46556e1f6fcdc0eeba4d1b29b0e71a65113e3ee57ec8fd1ae0b57' },
      ],
      'create a space': [
        { label: 'Mnemon create-memory-body', persona: '382f5a3272f33fc0a8d9899160f7c329d92f98b9132b5cc7ff66deb4e8761dbc',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: '96a0f34ffb8273c8fceb1c1109db7650db0fe4d217895a2929eeec599e753e8f' },
      ],
      'update a space': [
        { label: 'Mnemon update-memory-body', persona: '382f5a3272f33fc0a8d9899160f7c329d92f98b9132b5cc7ff66deb4e8761dbc',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: 'e076721d8b7495ae45dcb1887c804e8b9326cc94470bf4d452dce0ee7b882ee0' },
      ],
      'merge spaces': [
        { label: 'Mnemon merge-memory-bodies', persona: '382f5a3272f33fc0a8d9899160f7c329d92f98b9132b5cc7ff66deb4e8761dbc',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: '87044cdaa67c1cdda9bd633b5781f8e4eccdd5d933b7f3f2a371e331713fab54' },
      ],
      answer: [
        { label: 'Memory evidence answer', persona: 'd0cfab8b646850fac2d9dc5d5ce1ca9ecd789b8d43654743910f7cbb715be475',
          completion: '256628d68e90fd65dba3e55fb7071086f36c5dec72959af5747aa2aa1a9a84e0', task: 'b0b8b50b6427d5f104ce0b615605dd415bda3fcf04a686ddef8ad7f10592b050' },
      ],
      placement: [
        { label: 'Choose Memory Space provider', persona: 'd048f9a8b8de95e54b086cf3c3dc02132d35258df99145c0dd05167f967b8b24',
          completion: '1c8a1d160f6b4c303af0252f287361536f4b9c915aeb1222c20da376394af8e8', task: 'aa2554b0478b6197e39dea08a97815e20f5ba07bcff9a8efeeb93eb38de1ca2c' },
      ],
      'metadata maintenance': [
        { label: 'Maintain Memory Space metadata', persona: '66baf435b42607d4b31856010c359e1b977fdbe17392f448b97781b49c917116',
          completion: '2a7a58a0056d47cf91320ae39ff9a2646052851107bba25911f0798ffdad0e31', task: 'd3bc8fd4ade16995f03ec1256db7ed61b2e5949f037517d883d27bb3218783b8' },
      ],
      'review through spawn': [
        { label: 'Mnemon idle checkpoint review', persona: '0557258a9e2fe882869bcdc5165c0bdade2020d811a292f8940e9703202c2fcd',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: '970af4c615d54aecdb62770ba4e1548982ff945e8c44d1a3eee301e848c99715' },
      ],
      'review through spawn without runtime memory': [
        { label: 'Mnemon idle checkpoint review', persona: '39ed4aaacc757ba9650c9fed5344ddc7ddebcfc40748be75cef2e2f048d8b744',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: '970af4c615d54aecdb62770ba4e1548982ff945e8c44d1a3eee301e848c99715' },
      ],
      'review through fork': [
        { label: 'Mnemon idle checkpoint review', persona: 'b5b2550f1c6a2930288dbd0d495daf54ea8dfb8e433b05b1c59fb198015a4ec7',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: 'd9ea7e7313d5f106117fa055829b396755f497c0b2636f48eb3008eb0b0178f9' },
      ],
      'review through fork without runtime memory': [
        { label: 'Mnemon idle checkpoint review', persona: '88b3f6472f3effce4156cbd94bd50aa38e1d031303eed3624689f5484998f1f2',
          completion: '0f114375d13f5c83bd7f5982103b05c96e0d0e1e86ab9a7e71c95c9e15538569', task: 'd9ea7e7313d5f106117fa055829b396755f497c0b2636f48eb3008eb0b0178f9' },
      ],
      'MEMORY.md archive routing': [
        { label: 'Route runtime memory archive batch 1/2', persona: '4d53843ba45153bce9650aa3b15569e55b0d07f822b171c1a122c365be9f65ed',
          completion: 'bb5b867bfa2dea31314ba5e43d48ce7b139b948180a9cbb3ae76733e2a9beb8b', task: 'fda9ce8daf3e1fac2f4037dc241f45f04b799ff8b94a43fc524be18de9de77ac' },
        { label: 'Route runtime memory archive batch 2/2', persona: '4d53843ba45153bce9650aa3b15569e55b0d07f822b171c1a122c365be9f65ed',
          completion: 'bb5b867bfa2dea31314ba5e43d48ce7b139b948180a9cbb3ae76733e2a9beb8b', task: '1fdd3fa010d4969e2767ec1bcfe8c68a2c4a5c4692beda0458873dbc51f957a4' },
      ],
      'USER.md compaction': [
        { label: 'Consolidate local user profile', persona: '101adc0217657b569b62f9b4593db4b6c05c9b99d5b50f4bce00ff7c88b03f96',
          completion: 'ad30a87ce8001ef267efc7f7200bf6a24a865d0b2ea8e2a584fcf459d065d573', task: '0bb7e05d90746ad863088a86330efcc5d63ab90eee2f0d4fe7b75f57e1f4a830' },
      ],
      'document archive': [
        { label: 'Plan managed document archive', persona: '079d9b022c83a76432b2e30df74c2ab0645ab9ad0699d9d97ad16200dc9b3193',
          completion: '5c95bc1cf5f5d4dab44882acee1d79c78ea45f102f62f812a80a50a0f6e85339', task: 'a99518a38c81da67924e77e8a3952e62cda37231f50d20753eb93b3c04761561' },
      ],
      reconcile: [
        { label: 'Reconcile merged local memory', persona: '93c711b3dc920e849710fae0dc4e70106e1721d650bfd220a384b9140ab0631f',
          completion: '4d1af330026824a64fd444c1bdc2346a8eac05b613b73e4b41953cd2a6b2a0d6', task: 'de45a175f4d54a02d45fb2d80e3de6457e71d631a098d968de5fe962e5d3f826' },
      ],
    })
  })

  it('names every delegated operation by a line the documented pattern matches', () => {
    expect(DELEGATED_OPERATIONS.map(delegatedTaskLine).filter(line => !DELEGATED_TASK_LINE.test(line))).toEqual([])
    expect(DELEGATED_TASK_LINE.source).toBe('^\\[dsh-mnemon:delegated [a-z-]+\\]$')
    expect(new Set(DELEGATED_OPERATIONS.map(delegatedTaskLine)).size).toBe(DELEGATED_OPERATIONS.length)
  })
})
