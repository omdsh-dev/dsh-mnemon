import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentMutationResult, DocumentSnapshot, DocumentView } from 'dsh-mnemon-source-documents/contracts'
import * as general from 'dsh-mnemon-strategy-general'
import { COMPOSABLE_MEMORY_API_VERSION, type MemoryMutationReceipt } from '../src/core/contracts/index.ts'
import { MemoryRuntime } from '../src/core/runtime.ts'
import type { Config } from '../src/host/config.ts'
import type { HostAgent, HostContextShape, ToolDefinition } from '../src/host/dsh.ts'
import { agentScope } from '../src/host/runtime.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { defineMemorySource } from '../src/sdk/index.ts'
import { compositionFixture } from './fixtures/composition.ts'

describe('global Source tool lifecycle (issue 522)', () => {
  const cleanups: Array<() => unknown> = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  function source(typeId: string) {
    return defineMemorySource({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId, packageName: 'third-party-source', role: 'external-memory', capabilities: ['project'], consistency: 'exact-snapshot' },
      create: context => ({
        facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: typeId, role: 'external-memory', availability: 'ready', revision: '1', capabilities: ['project'], routeIds: [], actionIds: [] }),
        project: () => ({ fragments: [] }),
      }),
    })
  }

  async function fixture(types = ['runtime', 'documents', 'memory-spaces'], initialReady?: Promise<unknown>) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const runtime = new MemoryRuntime()
    const mount = (type: string, id = type) => runtime.service.installContributions({ sources: [source(type)] }, { instanceId: id })
    const releases = Object.fromEntries(types.map(type => [type, mount(type)]))
    const host = ctx as unknown as HostContextShape
    const coordinator = new MnemonSubagentCoordinator({} as never, {} as never, host)
    // The fourth argument supplies global definitions, independent of any selected View.
    const stop = registerTools(host, {} as never, coordinator, runtime, initialReady)
    cleanups.push(async () => { if (typeof stop === 'function') stop(); coordinator.dispose(); await runtime.dispose(); await ctx.fiber.dispose() })
    return { ctx, runtime, mount, releases, stop, names: () => ctx.tools.schemas().map(tool => tool.name) }
  }

  it.each([
    { types: ['runtime', 'documents', 'memory-spaces'], count: 17 },
    { types: ['runtime', 'documents'], count: 7 },
    { types: ['runtime', 'memory-spaces'], count: 14 },
    { types: ['documents', 'memory-spaces'], count: 16 },
    { types: [], count: 3 },
  ])('advertises $count tools with $types registered', async ({ types, count }) => {
    const f = await fixture(types)
    expect(f.names()).toHaveLength(count)
    expect(f.names()).toEqual(expect.arrayContaining(['mnemon_subagent_result', 'mnemon_view_route', 'mnemon_view_action']))
  })

  it('removes the last instance, restores repeated cycles, and keeps other families registered', async () => {
    const f = await fixture()
    const runtimeTool = f.ctx.tools.get('mnemon_runtime_memory')
    for (let cycle = 0; cycle < 3; cycle++) {
      f.releases['memory-spaces']!()
      expect(f.names()).toHaveLength(7)
      expect(f.ctx.tools.get('mnemon_recall')).toBeUndefined()
      expect(f.ctx.tools.get('mnemon_runtime_memory')).toBe(runtimeTool)
      f.releases['memory-spaces'] = f.mount('memory-spaces')
      expect(f.names()).toHaveLength(17)
    }
  })

  it('counts every live same-type instance, including a third-party replacement', async () => {
    const f = await fixture()
    const recall = f.ctx.tools.get('mnemon_recall')
    const replacement = f.mount('memory-spaces', 'third-party-spaces')
    f.releases['memory-spaces']!()
    expect(f.ctx.tools.get('mnemon_recall')).toBe(recall)
    replacement()
    expect(f.ctx.tools.get('mnemon_recall')).toBeUndefined()
    f.mount('memory-spaces', 'another-vendor')
    expect(f.names()).toHaveLength(17)
  })

  it('follows Sources loaded after Host bootstrap', async () => {
    const f = await fixture([])
    expect(f.names()).toHaveLength(3)
    f.mount('documents')
    expect(f.names()).toHaveLength(6)
    f.mount('runtime')
    expect(f.names()).toHaveLength(7)
  })

  it('publishes only the committed final registry through nested transactions and rollback', async () => {
    const f = await fixture()
    const recall = f.ctx.tools.get('mnemon_recall')
    const changes: string[][] = []
    f.ctx.on('tools/change', () => { changes.push(f.names()) })
    await expect(f.runtime.batch(async () => {
      f.releases['memory-spaces']!()
      expect(f.ctx.tools.get('mnemon_recall')).toBe(recall)
      await f.runtime.batch(async () => {
        f.releases['memory-spaces'] = f.mount('memory-spaces')
        expect(f.ctx.tools.get('mnemon_recall')).toBe(recall)
      })
      // Plugin-management rollback restores definitions before leaving batch.
      throw new Error('synthetic validation failure')
    })).rejects.toThrow('synthetic validation failure')
    expect(changes).toEqual([])
    expect(f.ctx.tools.get('mnemon_recall')).toBe(recall)
    await f.runtime.batch(async () => {
      f.releases['memory-spaces']!()
      expect(f.ctx.tools.get('mnemon_recall')).toBe(recall)
    })
    expect(f.names()).toHaveLength(7)
  })

  it('uses the committed baseline when Host registration starts in a transaction', async () => {
    const f = await fixture()
    let stop: (() => void) | undefined
    await f.runtime.batch(async () => {
      f.releases['memory-spaces']!()
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      cleanups.push(() => ctx.fiber.dispose())
      stop = registerTools(ctx as unknown as HostContextShape, {} as never, {} as never, f.runtime)
      expect(ctx.tools.schemas()).toHaveLength(16)
      f.releases['memory-spaces'] = f.mount('memory-spaces')
      expect(ctx.tools.schemas()).toHaveLength(16)
    })
    stop?.()
  })

  it('publishes the latest committed Source set when initial Loader readiness settles', async () => {
    const ready = Promise.withResolvers<void>()
    const f = await fixture([], ready.promise)
    const independent = f.names().map(name => f.ctx.tools.get(name))
    f.mount('runtime')
    const documents = f.mount('documents')
    f.mount('memory-spaces')
    documents()
    expect(f.names()).toEqual(['mnemon_subagent_result', 'mnemon_view_route', 'mnemon_view_action'])
    await f.runtime.batch(async () => {
      f.mount('documents')
      // Readiness inside a transaction must still see the committed baseline.
      ready.resolve()
      await ready.promise
      await Promise.resolve()
      expect(f.names()).not.toContain('mnemon_document_create')
    })
    expect(f.names()).toHaveLength(17)
    for (const tool of independent) expect(f.ctx.tools.get(tool!.name)).toBe(tool)
  })

  it('does not resurrect tools after disposal while Loader readiness is pending', async () => {
    const ready = Promise.withResolvers<void>()
    const f = await fixture(['runtime', 'documents', 'memory-spaces'], ready.promise)
    expect(f.names()).toHaveLength(3)
    f.stop()
    ready.resolve()
    await ready.promise
    await Promise.resolve()
    expect(f.names()).toEqual(['mnemon_subagent_result'])
  })

  it('unsubscribes and disposes its tools without disposing the independent result tool', async () => {
    const f = await fixture()
    expect(typeof f.stop).toBe('function')
    f.stop()
    f.stop()
    expect(f.names()).toEqual(['mnemon_subagent_result'])
    f.releases['memory-spaces']!()
    f.mount('memory-spaces')
    expect(f.names()).toEqual(['mnemon_subagent_result'])
  })
})

describe('updating Documents created in the same execution (#559)', () => {
  const releases: Array<() => Promise<void>> = []
  afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })

  async function fixture(strategyId = 'general') {
    const f = await compositionFixture({ memoryTopology: { strategyId } })
    releases.push(f.dispose)
    await f.memorySpace()
    if (strategyId === 'general') await f.mount(general, { instanceId: 'general' })
    const scope = { storage: 'custom' as const, workspaceId: f.workspace, sessionId: 'author', agentId: 'author' }
    const turns = f.graph.composableTurns
    const turn = await turns.beginTurn('author', scope)
    const create = turn.view.actionOffers.find(offer => offer.sourceActionId === 'create')!
    const manage = turn.view.actionOffers.find(offer => offer.sourceActionId === 'manage')!
    const read = (id: string) => f.graph.source('documents').read('document', { id })
    return { ...f, scope, turns, turn, create, manage, read }
  }

  const createdId = (receipt: MemoryMutationReceipt) => (receipt.details as unknown as DocumentMutationResult).document.id
  const draft = { title: 'Same-turn draft', content: 'First draft.' }

  it.each(['general', 'default-three-tier'])('allows create then update under %s without expanding pinned reads or bypassing authorization', async strategy => {
    const f = await fixture(strategy)
    const pinned = JSON.stringify(f.turn.view)
    const created = await f.turns.executeAction('author', f.create.id, draft, () => true)
    expect(created).toMatchObject({ completion: 'committed', details: { action: 'created' } })
    const id = createdId(created)
    await expect(f.turns.executeAction('author', f.manage.id, { action: 'update', id, content: 'Denied edit.' }, () => false)).rejects.toThrow(/not currently authorized/)
    expect(await f.read(id)).toMatchObject({ content: draft.content, revision: 1 })
    await expect(f.turns.executeAction('author', f.manage.id, { action: 'update', id, content: 'Corrected draft.' }, () => true))
      .resolves.toMatchObject({ completion: 'committed', details: { action: 'updated', document: { id, revision: 2 } } })
    expect(await f.read(id)).toMatchObject({ content: 'Corrected draft.', revision: 2 })
    const search = f.turn.view.routes.find(route => route.sourceInstanceKey === f.create.sourceInstanceKey && route.sourceRouteId === 'search')!
    const evidence = await f.turns.executeRoute('author', search.id, { query: draft.title })
    expect(evidence.items.some(item => item.id === id)).toBe(false)
    expect(JSON.stringify(f.turn.view)).toBe(pinned)
  })

  it('does not share created targets with another execution pinned to the exact same View', async () => {
    const f = await fixture()
    const sibling = f.turns.pinTurn('sibling', { ...f.scope, agentId: 'sibling' }, f.turn.view.id)
    expect(sibling.view).toBe(f.turn.view)
    const id = createdId(await f.turns.executeAction('author', f.create.id, draft, () => true))
    const edit = { action: 'update', id, content: 'Not this execution.' }
    await expect(f.turns.executeAction('sibling', f.manage.id, edit, () => true)).rejects.toThrow(/outside this View ReadGrant/)
    await expect(f.turns.executeAction('author', f.manage.id, { ...edit, content: 'Author correction.' }, () => true)).resolves.toMatchObject({ completion: 'committed' })
    f.turns.endTurn('author')
    f.turns.pinTurn('later', f.scope, sibling.view.id)
    await expect(f.turns.executeAction('later', f.manage.id, edit, () => true)).rejects.toThrow(/outside this View ReadGrant/)
    expect(await f.read(id)).toMatchObject({ content: 'Author correction.', revision: 2 })
  })

  it('does not admit documents created through management after the turn was pinned', async () => {
    const f = await fixture()
    const created = await f.graph.source('documents').mutate<DocumentMutationResult>('mutate', { action: 'create', ...draft })
    await expect(f.turns.executeAction('author', f.manage.id, { action: 'update', id: created.document.id, content: 'Unseen replacement.' }, () => true))
      .rejects.toThrow(/outside this View ReadGrant/)
    expect(await f.read(created.document.id)).toMatchObject({ content: draft.content, revision: 1 })
  })

  it('does not admit same-turn targets from a different workspace sharing the storage root', async () => {
    const f = await fixture()
    const workspace = join(f.root, 'other-workspace')
    mkdirSync(workspace)
    const other = await f.turns.beginTurn('other-workspace', { ...f.scope, workspaceId: workspace, agentId: 'other' })
    const manage = other.view.actionOffers.find(offer => offer.sourceActionId === 'manage')!
    const id = createdId(await f.turns.executeAction('author', f.create.id, draft, () => true))
    await expect(f.turns.executeAction('other-workspace', manage.id, { action: 'update', id, content: 'Other workspace.' }, () => true))
      .rejects.toThrow(/outside this View ReadGrant/)
    expect(await f.read(id)).toMatchObject({ content: draft.content, revision: 1 })
  })
})

describe('Host document creation protection', () => {
  const releases: Array<() => Promise<void>> = []
  afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })

  async function fixture(options: Config = {}) {
    const f = await compositionFixture(options)
    releases.push(f.dispose)
    const root = { id: 'root', session: { header: { cwd: f.workspace } } } as HostAgent
    const child = { id: 'review-child', session: { header: { cwd: f.workspace, origin: 'subagent', parentSession: root.id } } } as HostAgent
    const registered: ToolDefinition[] = []
    const coordinator = { document: vi.fn(), archiveDocument: vi.fn() } as unknown as MnemonSubagentCoordinator
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
    const documents = f.graph.source('documents')
    const turn = async () => {
      const pinned = await f.graph.composableTurns.beginTurn('root:documents', agentScope(root, f.config), 'test')
      f.graph.composableTurns.pinTurn('child:documents', agentScope(child, f.config), pinned.view.id)
      return pinned
    }
    return { ...f, root, child, registered, coordinator, documents, turn,
      create: registered.find(tool => tool.name === 'mnemon_document_create')!, signal: new AbortController().signal }
  }

  it('creates through the offered Source Action and preserves the user original', async () => {
    const f = await fixture()
    const original = await f.documents.mutate<DocumentMutationResult>('mutate', {
      action: 'create', title: 'Deployment code', content: '# Original\n\n```ts\nconst canary = true\n```', sessionIds: ['user-session'],
    })
    await f.turn()
    const args = { title: 'Deployment follow-up', content: 'A separate rollout note.', sourcePaths: ['README.md'] }
    const result = await f.create.execute(args as never, { agent: f.child, signal: f.signal }) as { document: { id: string } }
    // The model reads the Document it wrote and the layer's totals, not every Document with its paths (#390).
    expect(result).toMatchObject({ action: 'created', document: { title: args.title, sourcePaths: ['README.md'] },
      documents: { active: 2, archived: 0 }, memoryReceipt: { completion: 'committed' } })
    expect(result).not.toHaveProperty('snapshot')
    expect(result.document).not.toHaveProperty('content')
    expect(await f.documents.read<DocumentView>('document', { id: result.document.id })).toMatchObject({ content: args.content, sessionIds: [f.child.id] })
    expect(await f.documents.read<DocumentView>('document', { id: original.document.id })).toMatchObject({
      content: original.document.content, contentHash: original.document.contentHash, revision: original.document.revision,
    })
    expect(await f.documents.read<DocumentSnapshot>('snapshot')).toMatchObject({ activeCount: 2, archivedCount: 0 })
    expect(f.coordinator.document).not.toHaveBeenCalled()
    expect(f.coordinator.archiveDocument).not.toHaveBeenCalled()
  })

  it('rejects an update disguised as creation at the actual Source boundary', async () => {
    const f = await fixture()
    const original = await f.documents.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Original code', content: 'Exact user code.' })
    await f.turn()
    await expect(f.create.execute({ title: 'Summary', content: 'Condensed.', action: 'update', id: original.document.id } as never,
      { agent: f.child, signal: f.signal })).rejects.toThrow()
    expect(await f.documents.read<DocumentView>('document', { id: original.document.id })).toMatchObject({ content: 'Exact user code.', revision: 1 })
    expect(await f.documents.read<DocumentSnapshot>('snapshot')).toMatchObject({ revision: original.snapshot.revision, activeCount: 1 })
  })

  it.each<[string, Config]>([
    ['read-only mode', { writeEnabled: false }],
    ['disabled Documents', { memoryTopology: { layers: { documents: { enabled: false } } } }],
    ['manual-only Documents', { memoryTopology: { layers: { documents: { participation: { write: 'manual' } } } } }],
  ])('rejects creation in %s before mutation', async (_name, options) => {
    const f = await fixture(options)
    expect(() => f.create.execute({ title: 'Blocked', content: 'Blocked candidate.' } as never, { agent: f.child, signal: f.signal })).toThrow()
    expect(f.coordinator.document).not.toHaveBeenCalled()
    expect(f.coordinator.archiveDocument).not.toHaveBeenCalled()
  })

  it('hands the model a compact receipt for root Document writes too (#390)', async () => {
    const f = await fixture()
    const written = await f.documents.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Runbook', content: '# Runbook' })
    vi.mocked(f.coordinator.document).mockResolvedValue(written as never)
    const manage = f.registered.find(tool => tool.name === 'mnemon_document_manage')!
    const result = await manage.execute({ action: 'update', id: written.document.id, content: '# Runbook v2' } as never, { agent: f.root, signal: f.signal })
    expect(result).toEqual({
      success: true, action: 'created',
      document: expect.objectContaining({ id: written.document.id, title: 'Runbook', contentHash: written.document.contentHash }),
      documents: { active: 1, archived: 0, activeBytes: written.snapshot.activeBytes, limitBytes: written.snapshot.limitBytes },
    })
    // Neither the body the model wrote nor a path, in the workspace or under the storage root, comes back.
    expect((result as { document: object }).document).not.toHaveProperty('relativePath')
    expect(JSON.stringify(result)).not.toContain('# Runbook')
    expect(JSON.stringify(result)).not.toContain(f.workspace)
    expect(JSON.stringify(result)).not.toContain(f.config.dataDir!)
  })

  it('keeps the lineage of an archive, whose digest names the content hash the model was handed (#390)', async () => {
    const f = await fixture()
    const written = await f.documents.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Runbook', content: '# Runbook' })
    const lineage = [{ source: { layerId: 'documents', reference: written.document.id, digest: written.document.contentHash } }]
    vi.mocked(f.coordinator.archiveDocument).mockResolvedValue({ ...written, action: 'archived', document: { ...written.document, status: 'archived' }, lineage } as never)
    await f.turn()
    const manage = f.registered.find(tool => tool.name === 'mnemon_document_manage')!
    const archived = await manage.execute({ action: 'archive', id: written.document.id } as never, { agent: f.root, signal: f.signal }) as {
      lineage: typeof lineage; document: { contentHash: string; status: string; revision: number }
    }
    // What the --document-archive e2e model checks: the lineage digest is the hash of the Document it wrote.
    expect(archived).toMatchObject({ document: { status: 'archived', revision: written.document.revision } })
    expect(archived.lineage[0]!.source.digest).toBe(archived.document.contentHash)
    expect(archived).not.toHaveProperty('snapshot')
  })

  it('keeps explicit root document updates on the coordinated management path', async () => {
    const f = await fixture()
    const manage = f.registered.find(tool => tool.name === 'mnemon_document_manage')!
    await manage.execute({ action: 'update', id: 'document-id', content: 'User-requested revision.' } as never, { agent: f.root, signal: f.signal })
    expect(f.coordinator.document).toHaveBeenCalledWith(f.root, {
      action: 'update', id: 'document-id', content: 'User-requested revision.', sessionIds: [f.root.id],
    }, f.signal)
  })
})
