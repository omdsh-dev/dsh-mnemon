import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'
import type { DocumentView } from 'dsh-mnemon-source-documents/contracts'
import type { HostAgent, HostContextShape, HostSubagentsService, ToolDefinition } from '../src/host/dsh.ts'
import type { MnemonLifecycle } from '../src/host/lifecycle.ts'
import type { Config } from '../src/host/config.ts'
import { agentScope } from '../src/host/runtime.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { createWriteHandler } from '../src/host/rpc.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { sessionLog } from './fixtures/session-log.ts'

// Issue #336, widened: each memory layer can be switched off, and Memory Spaces can
// lack a Provider or a space. Every combination keeps working at its capacity limits.

const runtimeKey = 'source:mnemon-source-runtime'
const spacesKey = 'source:mnemon-source-memory-spaces'
const saved = 'Saved durable fact. '.repeat(15).trim()
const pending = 'Pending durable fact. '.repeat(15).trim()
const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })

type SpacesState = 'ready' | 'inactive-space' | 'read-only-space' | 'no-provider' | 'layer-off' | 'component-off'

async function fixture(state: SpacesState, config: Config = {}, documentsLimitBytes?: number) {
  const topology = state === 'layer-off' ? { memoryTopology: { layers: { 'memory-spaces': { enabled: false } } } } : {}
  const f = await compositionFixture({ runtimeMemory: { memoryLimitBytes: 512, userLimitBytes: 512 }, ...topology, ...config } as Config,
    documentsLimitBytes === undefined ? {} : { documentsLimitBytes })
  fixtures.push(f)
  if (state === 'ready' || state === 'inactive-space' || state === 'read-only-space') {
    const body = await f.memorySpace()
    if (state === 'inactive-space') await f.graph.source('memory-spaces').mutate('body-update', { memoryBodyId: body.id, active: false })
    // An active space that is recalled and takes no writes (#434).
    if (state === 'read-only-space') await f.graph.source('memory-spaces').mutate('body-write-policy', { memoryBodyId: body.id, policy: 'read-only' })
  }
  if (state === 'component-off') await f.releases[2]!()
  const start = vi.fn()
  const coordinator = new MnemonSubagentCoordinator({ start } as unknown as HostSubagentsService, f.live)
  const tools = new Map<string, ToolDefinition>()
  registerTools({ tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) } } as unknown as HostContextShape, f.live, coordinator)
  const lifecycle = { manageSource: coordinator.manageSource.bind(coordinator), workspaceRoot: () => f.workspace,
    snapshot: () => ({ taskAgentAvailable: false }) } as unknown as MnemonLifecycle
  const write = createWriteHandler(f.live, lifecycle)
  const root = { id: 'layers-root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
  const begin = async () => {
    const graph = f.live.snapshot()
    return graph.composableTurns.beginTurn(root.id + ':1', agentScope(root, graph.config))
  }
  // A tool refuses a layer that is off before it returns a promise; read both as one outcome.
  const execute = (name: string, input: object) => Promise.resolve().then(() => tools.get(name)!.execute(input as never, { agent: root, signal: new AbortController().signal }))
  const runtimeSnapshot = () => f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')
  const archiveText = async () => readFileSync(join((await runtimeSnapshot()).directory, 'archived', 'MEMORY.md'), 'utf8')
  return { ...f, start, coordinator, root, write, begin, execute, runtimeSnapshot, archiveText }
}

describe('memory layer combinations at their capacity limits (issue 336)', () => {
  it.each(['ready', 'inactive-space', 'read-only-space', 'no-provider', 'layer-off', 'component-off'] as const)('keeps MEMORY.md writable when Memory Spaces is %s, through the Agent tool and the web page', async state => {
    for (const entry of ['tool', 'web'] as const) {
      const f = await fixture(state)
      await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: saved })
      const turn = await f.begin()
      let result: unknown
      if (entry === 'tool') result = await f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending })
      else {
        const response = await f.write('source-management-mutate', {
          workspaceId: 'workspace', sourceInstanceKey: runtimeKey, operation: 'mutate', input: { action: 'add', target: 'memory', content: pending }, confirmed: true,
          expectedRevision: await f.live.snapshot().memoryComposition.current()!.managementRevision(runtimeKey, { storage: f.config.storageScope, workspaceId: f.workspace }),
        }) as { ok: boolean; value?: unknown; error?: unknown }
        expect(response).toMatchObject({ ok: true })
        result = (response.value as { value: unknown }).value
      }
      // The entry that did not fit is never lost: it is in a Memory Space, or in the local archive.
      expect((await f.runtimeSnapshot()).entries.map(item => item.content)).toEqual([pending])
      if (state === 'ready') {
        expect(result).toMatchObject({ maintenance: { kind: 'mnemon-archive' } })
        expect(await f.graph.source('memory-spaces').read('search', { query: 'Saved durable fact' })).toMatchObject({ results: [expect.objectContaining({ content: saved })] })
      } else {
        expect(result).toMatchObject({ maintenance: { kind: 'local-archive', memoryBodyIds: [] } })
        expect(await f.archiveText()).toContain(saved)
      }
      expect(f.start).not.toHaveBeenCalled()
      f.graph.composableTurns.endTurn(turn.turnId)
    }
  })

  it.each(['ready', 'inactive-space', 'read-only-space', 'no-provider', 'layer-off', 'component-off'] as const)('keeps MEMORY.md writable outside a turn when Memory Spaces is %s', async state => {
    const f = await fixture(state)
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: saved })
    // No turn is begun: the write takes the Host's own path, without a View.
    const result = await f.coordinator.runtime(f.root, { action: 'add', target: 'memory', content: pending }, new AbortController().signal)
    expect((await f.runtimeSnapshot()).entries.map(item => item.content)).toEqual([pending])
    if (state === 'ready') expect(result).toMatchObject({ maintenance: { kind: 'mnemon-archive' } })
    else {
      expect(result).toMatchObject({ maintenance: { kind: 'local-archive', memoryBodyIds: [] } })
      expect(await f.archiveText()).toContain(saved)
    }
    expect(f.start).not.toHaveBeenCalled()
  })

  it.each(['ready', 'inactive-space', 'read-only-space', 'no-provider', 'layer-off', 'component-off'] as const)('names only what the View offers when Memory Spaces is %s', async state => {
    const f = await fixture(state)
    const turn = await f.begin()
    const offers = turn.view.actionOffers.filter(offer => offer.sourceInstanceKey === spacesKey).map(offer => offer.sourceActionId)
    const system = turn.view.guidance?.system ?? ''
    if (state === 'ready') {
      expect(system).toContain('call mnemon_recall')
      expect(offers).toEqual(expect.arrayContaining(['remember', 'manage-spaces']))
    } else if (state === 'read-only-space') {
      // Recalled as before; nothing archives into it, and nothing in it can be linked or forgotten.
      expect(system).toContain('call mnemon_recall')
      expect(system).toContain('to a local archive file')
      expect(offers).toEqual(expect.arrayContaining(['remember', 'manage-spaces']))
      expect(offers).not.toContain('forget')
      expect(offers).not.toContain('link')
    } else {
      // No recall to call and no Memory Space to archive into: the protocol says so.
      expect(system).not.toContain('mnemon_recall')
      expect(system).toContain('to a local archive file')
    }
    // Documents routing and the write rules stay while Memory Spaces is there to read.
    const routing = turn.view.guidance?.routing
    if (state === 'ready' || state === 'read-only-space') expect(routing).toContain('Call mnemon_recall')
    else if (state === 'inactive-space' || state === 'no-provider') {
      expect(routing).toContain('Search Mnemon Documents for substantial project records')
      expect(routing).not.toContain('mnemon_recall')
    } else expect(routing).toBeUndefined()
    // Without a ready Provider nothing can be created or remembered, so nothing is offered.
    if (state === 'no-provider') expect(offers).toEqual([])
    f.graph.composableTurns.endTurn(turn.turnId)
  })

  it.each(['inactive-space', 'read-only-space', 'no-provider', 'layer-off', 'component-off'] as const)('archives a Project Document locally, without model work, when Memory Spaces is %s', async state => {
    const f = await fixture(state)
    await f.begin()
    const documents = f.graph.source('documents')
    const created = await documents.mutate<{ document: DocumentView }>('mutate', { action: 'create', title: 'Release checklist', content: 'Run the full verify, then tag the release.' })
    await expect(f.execute('mnemon_document_manage', { action: 'archive', id: created.document.id }))
      .resolves.toMatchObject({ action: 'archived', maintenance: { provider: 'host', memoryBodyIds: [], archivedDocumentIds: [created.document.id] } })
    const archived = await documents.read<DocumentView>('document', { id: created.document.id })
    expect(archived).toMatchObject({ status: 'archived', content: expect.stringContaining('Run the full verify') })
    expect(f.start).not.toHaveBeenCalled()
  })

  it.each(['inactive-space', 'read-only-space', 'no-provider', 'layer-off', 'component-off'] as const)('makes room in full Project Documents by archiving locally when Memory Spaces is %s', async state => {
    const f = await fixture(state, {}, 1_200)
    await f.begin()
    const documents = f.graph.source('documents')
    const first = await f.execute('mnemon_document_manage', { action: 'create', title: 'First record', content: 'First. '.repeat(100) }) as { document: DocumentView }
    await expect(f.execute('mnemon_document_manage', { action: 'create', title: 'Second record', content: 'Second. '.repeat(90) }))
      .resolves.toMatchObject({ action: 'created', maintenance: { memoryBodyIds: [], archivedDocumentIds: [first.document.id] } })
    expect(await documents.read<DocumentView>('document', { id: first.document.id })).toMatchObject({ status: 'archived', content: expect.stringContaining('First.') })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('keeps every enabled layer writable at its limit in all eight topology combinations', async () => {
    const ids = ['runtime', 'documents', 'memory-spaces'] as const
    for (let mask = 0; mask < 8; mask++) {
      const enabled = (id: typeof ids[number]) => (mask & (1 << ids.indexOf(id))) !== 0
      const f = await fixture(enabled('memory-spaces') ? 'ready' : 'layer-off', { memoryTopology: { layers: Object.fromEntries(ids.map(id => [id, { enabled: enabled(id) }])) } } as Config, 1_200)
      if (enabled('runtime')) await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: saved })
      const turn = await f.begin()
      const runtimeWrite = f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending })
      if (enabled('runtime')) {
        await expect(runtimeWrite).resolves.toMatchObject({ added: pending, maintenance: { kind: enabled('memory-spaces') ? 'mnemon-archive' : 'local-archive' } })
      } else await expect(runtimeWrite).rejects.toThrow('Memory Source runtime does not allow')
      const first = f.execute('mnemon_document_manage', { action: 'create', title: 'First record', content: 'First. '.repeat(100) })
      if (enabled('documents')) {
        await first
        // The Memory Spaces path needs a model planner, which this fixture has none of; the
        // local path does not, so only it runs here. Both keep the original Document.
        if (!enabled('memory-spaces')) {
          await expect(f.execute('mnemon_document_manage', { action: 'create', title: 'Second record', content: 'Second. '.repeat(90) }))
            .resolves.toMatchObject({ action: 'created', maintenance: { memoryBodyIds: [] } })
        }
      } else await expect(first).rejects.toThrow('Memory Source documents does not allow')
      f.graph.composableTurns.endTurn(turn.turnId)
    }
  })
})
