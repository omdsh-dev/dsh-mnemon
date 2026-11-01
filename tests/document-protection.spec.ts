import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostAgent, HostContextShape, ToolDefinition } from '../src/host/dsh.ts'
import type { DocumentMutationResult, DocumentSnapshot, DocumentView } from 'dsh-mnemon-source-documents/contracts'
import type { Config } from '../src/host/config.ts'
import { registerTools } from '../src/host/tools.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { agentScope } from '../src/host/runtime.ts'
import { compositionFixture } from './fixtures/composition.ts'

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

describe('Host document creation protection', () => {
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
