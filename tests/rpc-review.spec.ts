import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSnapshot } from 'dsh-mnemon-source-documents/contracts'
import type { RuntimeMemoryEntry, RuntimeMemorySnapshot, RuntimeMemoryTargetView } from 'dsh-mnemon-source-runtime/contracts'
import { type Config, resolveConfig } from '../src/host/config.ts'
import type { MnemonLifecycle } from '../src/host/lifecycle.ts'
import type { MnemonMachineIdentity, MnemonReconcileOperation, MnemonReviewEntry } from '../src/host/protocol.ts'
import type { MnemonReconcileApplier, MnemonReconcileSessions } from '../src/host/reconcile.ts'
import {
  applyReconcileOperations,
  emptyDocumentSnapshot,
  foreignMachines,
  MAX_RECONCILE_OPERATIONS,
  parseReconcileResult,
  pendingOpinions,
  RECONCILE_SCHEMA,
  reconcilePrompt,
  sourceApplier,
} from '../src/host/reconcile.ts'
import { MnemonReviewLedger } from '../src/host/review-ledger.ts'
import { createReviewHandler } from '../src/host/rpc.ts'
import type { LiveMnemonRuntime } from '../src/host/runtime.ts'
import { sourceFixture } from './fixtures/sources.ts'

describe('Mnemon review endpoints', () => {
  const directories: string[] = []
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

  function temporary(label: string): string {
    const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
    directories.push(directory)
    return directory
  }

  /** A data root that already holds one runtime memory, so a move has something to carry. */
  function populated(label: string): string {
    const root = temporary(label)
    mkdirSync(join(root, 'runtime'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'memories.json'), `${JSON.stringify({
      version: 1,
      entries: [{
        content: 'Prefer concise answers', target: 'user', importance: 'normal',
        created_at: '2026-08-14T12:00:00.000Z', updated_at: '2026-08-14T12:00:00.000Z',
      }],
    }, null, 2)}\n`)
    return root
  }

  interface Fixture {
    runtime: LiveMnemonRuntime
    graph: Record<string, unknown>
    ledger: MnemonReviewLedger
    root: string
    runtimeSource: { read: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> }
    documentsSource: { read: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> }
  }

  function fixture(options: Config = {}): Fixture {
    const root = populated('rpc-review')
    const ledger = new MnemonReviewLedger({ effectiveDataDir: () => root })
    const runtimeSource = { read: vi.fn(async () => ({ entries: [], targets: {} })), mutate: vi.fn(async () => ({})) }
    const documentsSource = { read: vi.fn(async () => ({ documents: [], activeCount: 0 })), mutate: vi.fn(async () => ({})) }
    const sources: Record<string, unknown> = { runtime: runtimeSource, documents: documentsSource, 'memory-spaces': { read: vi.fn(async () => ({})), mutate: vi.fn(async () => ({})) } }
    const graph = {
      config: resolveConfig(options),
      directory: root,
      source: vi.fn((type: string) => sources[type]),
      // No live generation keeps the post-apply Memory Space reload out of these assertions.
      memoryComposition: { current: () => undefined, acquire: vi.fn(), inspect: () => ({ evaluation: { state: 'ready' } }) },
      storage: { catalog: vi.fn(() => ({ activeRoot: root })) },
      packs: { target: vi.fn(() => ({ root, scope: 'custom' })), exportPack: vi.fn(), inspectPack: vi.fn(), importPack: vi.fn() },
      sync: { status: vi.fn(), configure: vi.fn(), push: vi.fn(), preview: vi.fn(), pull: vi.fn() },
      reviews: ledger,
    }
    const route = { graph, participation: { excluded: false }, selectedWorkspace: { id: 'workspace', title: 'Fixture', path: '/fixture/workspace' }, selectedRoot: root, effectiveRoot: root, aligned: true, liveSession: true }
    const runtime = { config: graph.config, route: vi.fn(() => route), reviews: ledger } as unknown as LiveMnemonRuntime
    return { runtime, graph, ledger, root, runtimeSource, documentsSource }
  }

  function lifecycle(methods: Record<string, unknown> = {}): MnemonLifecycle {
    return { workspaceRoot: () => '/fixture/workspace', snapshot: () => ({ enabled: true, taskAgentAvailable: true }), ...methods } as unknown as MnemonLifecycle
  }

  const proposal = {
    title: 'Merge duplicate answers',
    summary: 'Two installations recorded the same preference.',
    machine: { id: 'machine-a', label: 'laptop' },
    foreignMachines: ['desktop'],
    operations: [{ kind: 'runtime-remove' as const, target: 'user' as const, oldText: 'Prefer short answers', reason: 'Superseded by the concise preference.' }],
  }

  it('allows view on a read-only Host while gating review mutations behind writeEnabled', async () => {
    const readonly = fixture({ writeEnabled: false })
    const readonlyHandler = createReviewHandler(readonly.runtime)
    const readonlyCreated = readonly.ledger.create(proposal)

    expect(await readonlyHandler('view', {})).toMatchObject({ ok: true, value: { pending: 1, entries: [{ id: readonlyCreated.id, status: 'pending', title: 'Merge duplicate answers' }] } })
    expect(await readonlyHandler('opinion', { id: readonlyCreated.id, text: 'Blocked on read-only Host.' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })
    expect(await readonlyHandler('decide', { id: readonlyCreated.id, status: 'rejected' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })
    expect(await readonlyHandler('reopen', { id: readonlyCreated.id })).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })
    expect(await readonlyHandler('apply', { id: readonlyCreated.id })).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })

    const f = fixture()
    const handler = createReviewHandler(f.runtime)
    const created = f.ledger.create(proposal)
    expect(await handler('opinion', { id: created.id, text: 'Keep the wording from the desktop.', author: 'user' })).toMatchObject({ ok: true })
    // Only the Host decides what an Agent is: an unrecognised author is recorded as the user.
    expect(await handler('opinion', { id: created.id, text: 'Also update the changelog.', author: 'robot' })).toMatchObject({ ok: true })
    expect(f.ledger.get(created.id)?.opinions.map(opinion => [opinion.author, opinion.text])).toEqual([
      ['user', 'Keep the wording from the desktop.'],
      ['user', 'Also update the changelog.'],
    ])
    expect(await handler('opinion', { id: created.id, text: '   ' })).toMatchObject({ ok: false, error: { message: 'a review opinion must not be empty' } })
    expect(await handler('decide', { id: created.id, status: 'rejected' })).toMatchObject({ ok: true, value: { status: 'rejected' } })
    expect(await handler('decide', { id: created.id, status: 'accepted' })).toMatchObject({ ok: false, error: { message: `this review was already decided: ${created.id}` } })
    expect(await handler('reopen', { id: created.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    expect(await handler('reopen', { id: 'missing' })).toMatchObject({ ok: false, error: { message: 'unknown review entry: missing' } })
    expect(await handler('nope', {})).toMatchObject({ ok: false, error: { code: 'bad-request', message: 'unknown review endpoint: nope' } })
  })

  it('scopes view, opinion, decide, reopen, and apply to the requested workspace review ledger', async () => {
    const wsA = fixture()
    const wsB = fixture()
    const entryA = wsA.ledger.create({ ...proposal, title: 'Workspace A proposal' })
    const entryB = wsB.ledger.create({ ...proposal, title: 'Workspace B proposal' })

    const multiRuntime = {
      config: wsA.runtime.config,
      reviews: wsA.ledger,
      route: vi.fn((requested?: { workspaceId?: string }) => {
        const target = requested?.workspaceId === 'ws-b' ? wsB : wsA
        return {
          graph: target.graph,
          participation: { excluded: false },
          selectedWorkspace: { id: requested?.workspaceId ?? 'ws-a', title: 'Scoped', path: target.root },
          selectedRoot: target.root,
          effectiveRoot: target.root,
          aligned: true,
          liveSession: true,
        }
      }),
    } as unknown as LiveMnemonRuntime

    const handler = createReviewHandler(multiRuntime, lifecycle())
    expect(await handler('view', { workspaceId: 'ws-b' })).toMatchObject({
      ok: true,
      value: { entries: [{ id: entryB.id, title: 'Workspace B proposal' }] },
    })
    expect(await handler('opinion', { workspaceId: 'ws-b', id: entryB.id, text: 'Scoped to B' })).toMatchObject({ ok: true })
    expect(wsA.ledger.get(entryA.id)?.opinions).toEqual([])
    expect(wsB.ledger.get(entryB.id)?.opinions).toMatchObject([{ text: 'Scoped to B' }])

    expect(await handler('decide', { workspaceId: 'ws-b', id: entryB.id, status: 'accepted' })).toMatchObject({ ok: true })
    expect(wsA.ledger.get(entryA.id)?.status).toBe('pending')
    expect(wsB.ledger.get(entryB.id)?.status).toBe('accepted')

    expect(await handler('apply', { workspaceId: 'ws-b', id: entryB.id })).toMatchObject({ ok: true, value: { applied: 1 } })
    expect(wsB.runtimeSource.mutate).toHaveBeenCalledTimes(1)
    expect(wsA.runtimeSource.mutate).not.toHaveBeenCalled()

    expect(await handler('reopen', { workspaceId: 'ws-b', id: entryB.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    expect(wsB.ledger.get(entryB.id)?.status).toBe('pending')
  })

  it('requires documents:archive rather than runtime:write when applying document-archive-only proposals', async () => {
    const f = fixture({
      memoryTopology: {
        layers: {
          runtime: { enabled: false },
          documents: { enabled: true },
        },
      },
    })
    f.documentsSource.read.mockResolvedValue({
      documents: [{ id: 'obsolete-guide', revision: 3, status: 'active' }],
      activeCount: 1,
    })
    const entry = f.ledger.create({
      ...proposal,
      operations: [{ kind: 'document-archive', documentId: 'obsolete-guide', reason: 'Outdated.' }],
    })
    f.ledger.decide(entry.id, 'accepted')
    const handler = createReviewHandler(f.runtime, lifecycle())

    expect(await handler('apply', { id: entry.id })).toMatchObject({ ok: true, value: { applied: 1, failures: [] } })
    expect(f.documentsSource.mutate).toHaveBeenCalledWith(
      'archive',
      { id: 'obsolete-guide', documentRevision: 3, summary: 'Outdated.' },
      expect.any(AbortSignal),
    )
    expect(f.runtimeSource.mutate).not.toHaveBeenCalled()

    const docsDisabled = fixture({
      memoryTopology: {
        layers: {
          runtime: { enabled: true },
          documents: { enabled: false },
        },
      },
    })
    const blocked = docsDisabled.ledger.create({
      ...proposal,
      operations: [{ kind: 'document-archive', documentId: 'obsolete-guide', reason: 'Outdated.' }],
    })
    docsDisabled.ledger.decide(blocked.id, 'accepted')
    expect(await createReviewHandler(docsDisabled.runtime, lifecycle())('apply', { id: blocked.id })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('documents') },
    })
  })

  it('serializes concurrent opinion mutations without losing updates', async () => {
    const f = fixture()
    const entry = f.ledger.create(proposal)
    const handler = createReviewHandler(f.runtime, lifecycle())

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => handler('opinion', { id: entry.id, text: `Opinion ${index}` })),
    )
    expect(results.every(result => result.ok)).toBe(true)
    expect(f.ledger.get(entry.id)?.opinions.map(item => item.text).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `Opinion ${index}`).sort(),
    )
  })

  it('runs a reconciliation only through a writable Host that owns the work', async () => {
    const f = fixture()
    const result = { title: 'Merge duplicate answers', summary: 'One preference is recorded twice.', action: 'planned' as const, operations: 1, foreignMachines: ['desktop'], provider: 'openai', runId: 'run-1' }
    const reconcile = vi.fn(async () => result)
    const handler = createReviewHandler(f.runtime, lifecycle({ reconcile }))

    expect(await handler('reconcile', { workspaceId: '/fixture/workspace' })).toMatchObject({ ok: true, value: result })
    expect(reconcile).toHaveBeenCalledWith(f.graph, { storage: 'global', workspaceId: '/fixture/workspace' }, expect.any(AbortSignal), {})
    // The reviewer's words reach the run that plans, and nothing else about it changes.
    expect(await handler('reconcile', { workspaceId: '/fixture/workspace', guidance: 'Merge the two answers.' })).toMatchObject({ ok: true, value: result })
    expect(reconcile).toHaveBeenLastCalledWith(f.graph, { storage: 'global', workspaceId: '/fixture/workspace' }, expect.any(AbortSignal), { guidance: 'Merge the two answers.' })
    expect(await handler('reconcile', { workspaceId: '/fixture/workspace', guidance: 7 })).toMatchObject({ ok: false, error: { message: 'the reconciliation guidance must be a string' } })
    expect(await createReviewHandler(f.runtime)('reconcile', {})).toMatchObject({ ok: false, error: { message: 'Mnemon memory reconciliation is unavailable' } })

    const readonly = fixture({ writeEnabled: false })
    expect(await createReviewHandler(readonly.runtime, lifecycle({ reconcile }))('reconcile', {})).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  it('applies an accepted review operation by operation', async () => {
    const f = fixture()
    const entry = f.ledger.create(proposal)
    const handler = createReviewHandler(f.runtime, lifecycle())

    expect(await handler('apply', { id: entry.id })).toMatchObject({ ok: false, error: { message: `accept the review before applying it: ${entry.id}` } })
    expect(f.runtimeSource.mutate).not.toHaveBeenCalled()
    expect(await handler('apply', { id: 'missing' })).toMatchObject({ ok: false, error: { message: 'unknown review entry: missing' } })

    f.ledger.decide(entry.id, 'accepted')
    const applied = await handler('apply', { id: entry.id })
    expect(applied).toMatchObject({ ok: true, value: { applied: 1, failures: [] } })
    expect(f.runtimeSource.mutate).toHaveBeenCalledWith('mutate', { action: 'remove', target: 'user', oldText: 'Prefer short answers' }, expect.any(AbortSignal))
    // The ledger records which position ran, so the plan is not offered whole a second time.
    expect(f.ledger.get(entry.id)).toMatchObject({ status: 'accepted', appliedAt: expect.any(String), appliedOperations: [0] })
  })

  it('applies only the operations the reviewer selected, and refuses an index the plan does not hold', async () => {
    const f = fixture()
    const entry = f.ledger.create({ ...proposal, operations: [
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'Superseded.' },
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer concise answers', reason: 'Superseded.' },
    ] })
    f.ledger.decide(entry.id, 'accepted')
    const handler = createReviewHandler(f.runtime, lifecycle())

    // A caller that believes it applied the whole review must not be told a subset did.
    expect(await handler('apply', { id: entry.id, operations: [2] })).toMatchObject({ ok: false, error: { message: 'the review holds no operation at index 2' } })
    expect(await handler('apply', { id: entry.id, operations: 'all' })).toMatchObject({ ok: false, error: { message: 'the operations to apply must be a list of operation indexes' } })
    expect(f.runtimeSource.mutate).not.toHaveBeenCalled()

    expect(await handler('apply', { id: entry.id, operations: [1] })).toMatchObject({ ok: true, value: { applied: 1, failures: [] } })
    expect(f.runtimeSource.mutate).toHaveBeenCalledTimes(1)
    expect(f.runtimeSource.mutate).toHaveBeenCalledWith('mutate', { action: 'remove', target: 'user', oldText: 'Prefer concise answers' }, expect.any(AbortSignal))
    // The review stays accepted and keeps the operations that were not applied.
    expect(f.ledger.get(entry.id)).toMatchObject({ status: 'accepted', operations: [{ oldText: 'Prefer short answers' }, { oldText: 'Prefer concise answers' }] })

    expect(f.ledger.get(entry.id)).toMatchObject({ appliedOperations: [1] })

    expect(await handler('apply', { id: entry.id, operations: [0] })).toMatchObject({ ok: true, value: { applied: 1, failures: [] } })
    expect(f.runtimeSource.mutate).toHaveBeenLastCalledWith('mutate', { action: 'remove', target: 'user', oldText: 'Prefer short answers' }, expect.any(AbortSignal))
    expect(f.ledger.get(entry.id)).toMatchObject({ appliedOperations: [0, 1] })
  })

  it('never runs a position twice, and refuses a plan that has nothing left', async () => {
    // Running an operation again addresses text the first run replaced, so the ledger is what
    // decides what is left: a position that ran is skipped, and an exhausted plan is refused.
    const f = fixture()
    const entry = f.ledger.create({ ...proposal, operations: [
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'Superseded.' },
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer concise answers', reason: 'Superseded.' },
    ] })
    f.ledger.decide(entry.id, 'accepted')
    const handler = createReviewHandler(f.runtime, lifecycle())

    expect(await handler('apply', { id: entry.id, operations: [0, 1] })).toMatchObject({ ok: true, value: { applied: 2, failures: [] } })
    expect(f.runtimeSource.mutate).toHaveBeenCalledTimes(2)

    expect(await handler('apply', { id: entry.id, operations: [0, 1] })).toMatchObject({ ok: false, error: { message: `every operation in this review has already run: ${entry.id}` } })
    expect(f.runtimeSource.mutate).toHaveBeenCalledTimes(2)

    // Asking for a position that already ran applies nothing from it: what is left is what runs.
    expect(await handler('apply', { id: entry.id, operations: [0] })).toMatchObject({ ok: false, error: { message: `every operation in this review has already run: ${entry.id}` } })
    expect(f.runtimeSource.mutate).toHaveBeenCalledTimes(2)
  })

  it('runs what is left of a partly applied plan, and reopening offers the whole plan again', async () => {
    const f = fixture()
    const entry = f.ledger.create({ ...proposal, operations: [
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'Superseded.' },
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer concise answers', reason: 'Superseded.' },
    ] })
    f.ledger.decide(entry.id, 'accepted')
    const handler = createReviewHandler(f.runtime, lifecycle())

    expect(await handler('apply', { id: entry.id, operations: [0] })).toMatchObject({ ok: true, value: { applied: 1, failures: [] } })
    // The rest is still there, so applying it is not a replay.
    expect(await handler('apply', { id: entry.id })).toMatchObject({ ok: true, value: { applied: 1, failures: [] } })
    expect(f.runtimeSource.mutate).toHaveBeenLastCalledWith('mutate', { action: 'remove', target: 'user', oldText: 'Prefer concise answers' }, expect.any(AbortSignal))
    expect(f.ledger.get(entry.id)).toMatchObject({ appliedOperations: [0, 1] })

    // Reopening is a decision about the whole plan, so the record of what ran goes with it.
    expect(await handler('reopen', { id: entry.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    expect(f.ledger.get(entry.id)).not.toHaveProperty('appliedOperations')
    expect(f.ledger.get(entry.id)).not.toHaveProperty('appliedAt')
  })

  it('records the failure and stops at the operation that no longer holds', async () => {
    const f = fixture()
    const entry = f.ledger.create({ ...proposal, operations: [
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'Superseded.' },
      { kind: 'runtime-remove', target: 'user', oldText: 'Gone already', reason: 'Superseded.' },
    ] })
    f.ledger.decide(entry.id, 'accepted')
    f.runtimeSource.mutate.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('No user entry contains "Gone already".'))

    const applied = await createReviewHandler(f.runtime, lifecycle())('apply', { id: entry.id })

    expect(applied).toMatchObject({ ok: false, error: { message: 'operation 2 (runtime-remove) failed: No user entry contains "Gone already".' } })
    expect(f.runtimeSource.mutate).toHaveBeenCalledTimes(2)
    expect(f.ledger.get(entry.id)?.failure).toBe('operation 2 (runtime-remove) failed: No user entry contains "Gone already".')
  })

  it('keeps every review endpoint behind the Host it belongs to', async () => {
    const f = fixture()
    const entry = f.ledger.create(proposal)
    f.ledger.decide(entry.id, 'accepted')
    const handler = createReviewHandler(f.runtime, lifecycle())

    expect(await handler('view', 'not an object')).toMatchObject({ ok: false, error: { code: 'internal', message: 'payload must be an object' } })
    expect(await handler('apply', { id: entry.id, sessionId: 7 })).toMatchObject({ ok: false, error: { message: 'sessionId must be a string' } })
    expect(f.runtimeSource.mutate).not.toHaveBeenCalled()
  })
})

describe('Mnemon review ledger', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function temporary(): string {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-review-'))
    directories.push(directory)
    return directory
  }

  function ledger(root: string): MnemonReviewLedger {
    return new MnemonReviewLedger({ effectiveDataDir: () => root })
  }

  const proposal = {
    title: 'Merge duplicate preferences',
    summary: 'Two entries say the same thing with different wording.',
    machine: { id: 'machine-a', label: 'laptop' },
    foreignMachines: ['desktop'],
    operations: [{ kind: 'runtime-remove' as const, target: 'user' as const, oldText: 'Prefer short answers', reason: 'duplicate' }],
  }

  it('files a proposal as pending and keeps the newest first', () => {
    const root = temporary()
    const store = ledger(root)
    const first = store.create(proposal)
    const second = store.create({ ...proposal, title: 'Archive stale notes' })
    expect(first.status).toBe('pending')
    expect(first.opinions).toEqual([])
    expect(first.decidedAt).toBeUndefined()
    expect(store.list().map(entry => entry.id)).toEqual([second.id, first.id])
    expect(store.view()).toEqual(expect.objectContaining({ path: join(root, 'state', 'review-ledger.json'), pending: 2 }))
    expect(store.get(first.id)?.title).toBe('Merge duplicate preferences')
    expect(store.get('missing')).toBeUndefined()
    expect(JSON.parse(readFileSync(store.path(), 'utf8')).version).toBe(1)
  })

  it('records opinions from the user and from an agent, and refuses an empty one', () => {
    const root = temporary()
    const store = ledger(root)
    const entry = store.create(proposal)
    const withUser = store.addOpinion(entry.id, 'user', '  Keep the shorter wording.  ')
    expect(withUser.opinions).toEqual([expect.objectContaining({ author: 'user', text: 'Keep the shorter wording.' })])
    const withAgent = store.addOpinion(entry.id, 'agent', 'The two entries differ in scope.')
    expect(withAgent.opinions.map(opinion => opinion.author)).toEqual(['user', 'agent'])
    expect(withAgent.opinions[1]!.id).not.toBe(withAgent.opinions[0]!.id)
    expect(() => store.addOpinion(entry.id, 'user', '   ')).toThrow('a review opinion must not be empty')
    expect(() => store.addOpinion('missing', 'user', 'hello')).toThrow('unknown review entry: missing')
    // The ledger stores what it is given; only the RPC layer narrows an author to user or agent.
    expect(store.addOpinion(entry.id, 'agent', 'A third note.').opinions.at(-1)!.author).toBe('agent')
  })

  it('accepts, rejects, applies, and reopens a proposal exactly once per step', () => {
    const root = temporary()
    const store = ledger(root)
    const accepted = store.decide(store.create(proposal).id, 'accepted')
    expect(accepted.status).toBe('accepted')
    expect(accepted.decidedAt).toBeDefined()
    expect(() => store.decide(accepted.id, 'rejected')).toThrow(`this review was already decided: ${accepted.id}`)

    const applied = store.applied(accepted.id)
    expect(applied.appliedAt).toBeDefined()
    expect(applied.failure).toBeUndefined()

    const rejected = store.decide(store.create(proposal).id, 'rejected')
    expect(rejected.status).toBe('rejected')
    const reopened = store.reopen(rejected.id)
    expect(reopened.status).toBe('pending')
    expect(reopened.decidedAt).toBeUndefined()
    expect(store.view().pending).toBe(1)
    expect(() => store.reopen('missing')).toThrow('unknown review entry: missing')
  })

  it('keeps a failed application visible instead of hiding it', () => {
    const root = temporary()
    const store = ledger(root)
    const entry = store.decide(store.create(proposal).id, 'accepted')
    const failed = store.applied(entry.id, 'operation 1 (runtime-remove) failed: gone')
    expect(failed.failure).toBe('operation 1 (runtime-remove) failed: gone')
    const reopened = store.reopen(entry.id)
    expect(reopened.failure).toBeUndefined()
    expect(reopened.status).toBe('pending')
  })

  it('refuses a ledger written by another version and drops entries it cannot parse', () => {
    const root = temporary()
    const store = ledger(root)
    const path = store.path()
    mkdirSync(join(root, 'state'), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 2, entries: [] }))
    expect(() => store.list()).toThrow(`review ledger is invalid: ${path}`)
    writeFileSync(path, JSON.stringify({ version: 1, entries: [{ id: 'kept', status: 'pending', title: 'Kept', summary: '', machine: {}, foreignMachines: [], operations: [], opinions: [], createdAt: 'now', updatedAt: 'now' }, { id: '', status: 'pending' }, 'nonsense'] }))
    expect(store.list().map(entry => entry.id)).toEqual(['kept'])
    expect(store.view().pending).toBe(1)
  })
})

describe('Mnemon memory reconciliation', () => {
  const directories: string[] = []
  const disposals: Array<() => Promise<void>> = []

  function temporary(label: string): string {
    const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
    directories.push(directory)
    return directory
  }

  afterEach(async () => {
    for (const dispose of disposals.splice(0)) await dispose()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  const machine: MnemonMachineIdentity = { id: 'machine-a', label: 'laptop', createdAt: '2026-08-14T12:00:00.000Z' }

  function entry(content: string, overrides: Partial<RuntimeMemoryEntry> = {}): RuntimeMemoryEntry {
    return {
      content,
      created_at: '2026-08-14T12:00:00.000Z',
      updated_at: '2026-08-14T12:00:00.000Z',
      target: 'user',
      importance: 'normal',
      ...overrides,
    }
  }

  function snapshot(entries: RuntimeMemoryEntry[]): RuntimeMemorySnapshot {
    const view = (target: 'memory' | 'user'): RuntimeMemoryTargetView => ({ target, used: 0, limit: 1024, entryCount: 0, markdownPath: `/fixture/${target}.md` })
    return {
      directory: '/fixture/runtime',
      sourcePath: '/fixture/runtime/memories.json',
      revision: 'revision',
      generatedAt: '2026-08-14T12:00:00.000Z',
      entries,
      targets: { memory: view('memory'), user: view('user') },
    }
  }

  function documents(records: Array<{ id: string; title: string; status: 'active' | 'archived' }>): DocumentSnapshot {
    return {
      workspaceRoot: '/fixture',
      directory: '/fixture/documents',
      indexPath: '/fixture/documents/index.json',
      generatedAt: '2026-08-14T12:00:00.000Z',
      revision: 'revision',
      limitBytes: 1024,
      activeBytes: 0,
      activeCount: records.length,
      archivedCount: 0,
      total: records.length,
      documents: records.map(record => ({
        id: record.id,
        title: record.title,
        description: '',
        status: record.status,
        filename: `${record.id}.md`,
        relativePath: `documents/${record.id}.md`,
        sourcePaths: [],
        sessionIds: [],
        createdAt: '2026-08-14T12:00:00.000Z',
        updatedAt: '2026-08-14T12:00:00.000Z',
        lastAccessedAt: '2026-08-14T12:00:00.000Z',
        revision: 1,
        contentHash: 'hash',
        sizeBytes: 10,
        memoryBodyIds: [],
        healthy: true,
        excerpt: '',
      })),
    }
  }

  function evidence(entries: RuntimeMemoryEntry[], records: Array<{ id: string; title: string; status: 'active' | 'archived' }> = [], others: string[] = []): Parameters<typeof parseReconcileResult>[1] {
    return { machine, runtime: snapshot(entries), documents: documents(records), foreignMachines: others }
  }

  const planned = { title: 'Tidy duplicates', summary: 'Two entries say the same thing.', action: 'planned' as const }

  describe('Mnemon memory reconciliation evidence', () => {
    it('names the other installations whose entries the merged memory holds', () => {
      const entries = [
        entry('local'),
        entry('from desktop', { origin: { machine: 'machine-b', label: 'desktop', at: 'now' } }),
        entry('also desktop', { origin: { machine: 'machine-b', label: 'desktop', at: 'later' } }),
        entry('unnamed', { origin: { machine: 'machine-c', label: '   ', at: 'now' } }),
        entry('mine', { origin: { machine: 'machine-a', label: 'laptop', at: 'now' } }),
      ]
      expect(foreignMachines(entries, machine)).toEqual(['desktop', 'machine-c'])
      expect(foreignMachines([entry('local')], machine)).toEqual([])
    })

    it('writes the evidence a model reads, and bounds it', () => {
      const prompt = reconcilePrompt(evidence([entry('Prefer short answers'), entry('Use tabs', { target: 'memory', importance: 'critical', branches: ['main', 'release'], origin: { machine: 'machine-b', label: 'desktop', at: 'now' } })], [{ id: 'doc-1', title: 'Design', status: 'active' }], ['desktop']))
      expect(prompt.split('\n')[0]).toBe('This installation: laptop (machine-a).')
      expect(prompt).toContain('Entries from these other installations are present: desktop.')
      expect(prompt).toContain('1. [user/normal] Prefer short answers')
      expect(prompt).toContain('2. [memory/critical] (from desktop) branches=main|release Use tabs')
      expect(prompt).toContain('Active documents (1; 0/1024 bytes):')
      expect(prompt).toContain('- doc-1 | Design | 10 bytes | ')

      const quiet = reconcilePrompt(evidence([entry('only local')]))
      expect(quiet).toContain('No entry in the local runtime memory was written by another installation.')
      expect(quiet).toContain('Active documents (0; 0/1024 bytes):\nnone')

      const bounded = reconcilePrompt(evidence(Array.from({ length: 400 }, (_, index) => entry(`Entry ${index} ${'x'.repeat(400)}`))))
      expect(bounded).toContain('further entries were withheld to bound this request.')
    })

    it('writes what the branch holds that this installation does not, and what the reviewer asked for', () => {
      const withRemote = reconcilePrompt({
        ...evidence([entry('only local')]),
        remote: {
          entries: [
            { target: 'user', content: 'Prefers table output', importance: 'normal', origin: { machine: 'machine-b', label: 'desktop', at: 'now' } },
            { target: 'memory', content: 'Deploy on Fridays', importance: 'critical' },
          ],
          truncated: false,
          tombstones: [{ target: 'user', contentHash: 'abc', deletedAt: '2026-08-13T12:00:00.000Z', machine: 'machine-b' }],
          branch: 'mnemon-sync',
          machine: { id: 'machine-b', label: 'desktop', createdAt: 'now' },
        },
        guidance: 'Two preferences say the same thing; merge them.',
        opinions: [{ author: 'user', text: 'Keep the wording of the first one.', createdAt: '2026-08-14T10:00:00.000Z' }],
      })
      expect(withRemote).toContain('The sync branch (mnemon-sync) holds 2 entries this installation does not have, published by desktop (machine-b):')
      expect(withRemote).toContain('- [user/normal] (from desktop) Prefers table output')
      // An entry the branch holds without an origin is still attributed to the branch.
      expect(withRemote).toContain('- [memory/critical] Deploy on Fridays')
      expect(withRemote).toContain('The branch recorded 1 removals this installation has not applied:')
      expect(withRemote).toContain('- [user] removed 2026-08-13T12:00:00.000Z')
      expect(withRemote).toContain('The reviewer asks for this plan to do the following. It states what they want, not what is allowed:')
      expect(withRemote).toContain('Two preferences say the same thing; merge them.')
      expect(withRemote).toContain("Opinions already recorded on the pending proposals, oldest first. Treat them as the reviewer's position:")
      expect(withRemote).toContain('- reviewer: Keep the wording of the first one.')

      // No branch, no guidance, no opinions: the evidence is exactly the local one.
      const local = reconcilePrompt(evidence([entry('only local')]))
      expect(local).not.toContain('sync branch')
      expect(local).not.toContain('reviewer asks for this plan')

      // A branch that holds nothing is stated as nothing, not left unsaid.
      const quiet = reconcilePrompt({ ...evidence([entry('only local')]), remote: { entries: [], truncated: false, tombstones: [], branch: 'mnemon-sync' } })
      expect(quiet).toContain('The sync branch (mnemon-sync) holds 0 entries this installation does not have:')
      expect(quiet).toContain('\nnone')
      expect(quiet).not.toContain('The branch recorded')

      // Both lists are bounded, and a cut list says it was cut.
      const bounded = reconcilePrompt({
        ...evidence([entry('only local')]),
        remote: {
          entries: Array.from({ length: 200 }, (_, index) => ({ target: 'user' as const, content: 'Remote ' + String(index) + ' ' + 'x'.repeat(400), importance: 'normal' as const })),
          truncated: true,
          tombstones: [],
          branch: 'mnemon-sync',
        },
        guidance: 'g'.repeat(3_000),
      })
      expect(bounded).toContain('further entries were withheld to bound this request.')
      expect(bounded).toContain('The branch may hold more entries than this list states.')
      expect(bounded).not.toContain('g'.repeat(2_500))
    })

    it('folds the opinions of pending reviews into the evidence, oldest first', () => {
      const review = (id: string, status: 'pending' | 'accepted' | 'rejected', opinions: Array<{ author: 'user' | 'agent'; text: string; createdAt: string }>): MnemonReviewEntry => ({
        id, title: id, summary: '', status, operations: [], opinions: opinions.map((item, index) => ({ id: id + '-' + String(index), ...item })),
        machine, foreignMachines: [], createdAt: '2026-08-14T12:00:00.000Z', updatedAt: '2026-08-14T12:00:00.000Z',
      })
      expect(pendingOpinions([
        review('a', 'pending', [{ author: 'user', text: 'Later', createdAt: '2026-08-14T12:00:00.000Z' }]),
        review('b', 'accepted', [{ author: 'agent', text: 'Decided', createdAt: '2026-08-14T09:00:00.000Z' }]),
        review('c', 'pending', [{ author: 'agent', text: 'Earlier', createdAt: '2026-08-14T08:00:00.000Z' }]),
        review('d', 'pending', []),
      ])).toEqual([
        { author: 'agent', text: 'Earlier', createdAt: '2026-08-14T08:00:00.000Z' },
        { author: 'user', text: 'Later', createdAt: '2026-08-14T12:00:00.000Z' },
      ])
      expect(pendingOpinions([])).toEqual([])
    })

    it('describes a documents-free snapshot without inventing a directory', () => {
      expect(emptyDocumentSnapshot('/fixture', '2026-08-14T12:00:00.000Z')).toEqual(expect.objectContaining({ directory: '/fixture', limitBytes: 0, documents: [] }))
    })

    it('publishes a result schema the host can hand to a run', () => {
      expect(RECONCILE_SCHEMA.required).toEqual(['title', 'summary', 'action', 'operations'])
      expect(RECONCILE_SCHEMA.properties.action.enum).toEqual(['planned', 'none', 'failed'])
      expect(RECONCILE_SCHEMA.properties.operations.items.properties.kind.enum).toEqual(['runtime-add', 'runtime-replace', 'runtime-remove', 'document-archive'])
      expect(MAX_RECONCILE_OPERATIONS).toBe(40)
    })
  })

  describe('Mnemon memory reconciliation parsing', () => {
    it('accepts one operation of every kind the applier understands', () => {
      const result = parseReconcileResult({
        ...planned,
        operations: [
          { kind: 'runtime-add', target: 'memory', content: 'Keep the changelog short', importance: 'low', reason: 'new' },
          { kind: 'runtime-replace', target: 'user', oldText: 'short answers', content: 'Prefer concise answers', branches: ['main', 'main'], reason: 'merge' },
          { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'duplicate' },
          { kind: 'document-archive', documentId: 'doc-1', reason: 'superseded' },
        ],
      }, evidence([entry('Prefer short answers')], [{ id: 'doc-1', title: 'Design', status: 'active' }]))
      expect(result.action).toBe('planned')
      expect(result.operations).toEqual([
        { kind: 'runtime-add', target: 'memory', content: 'Keep the changelog short', importance: 'low', reason: 'new' },
        { kind: 'runtime-replace', target: 'user', oldText: 'short answers', content: 'Prefer concise answers', branches: ['main'], reason: 'merge' },
        { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'duplicate' },
        { kind: 'document-archive', documentId: 'doc-1', reason: 'superseded' },
      ])
    })

    it('accepts a proposal that plans nothing', () => {
      expect(parseReconcileResult({ ...planned, action: 'none', operations: [] }, evidence([]))).toEqual({ title: 'Tidy duplicates', summary: 'Two entries say the same thing.', action: 'none', operations: [] })
    })

    it('refuses a result that is not a plan a reviewer could read', () => {
      const scope = evidence([])
      expect(() => parseReconcileResult(null, scope)).toThrow('memory reconciliation returned an invalid structured result')
      expect(() => parseReconcileResult({ ...planned, action: 'maybe', operations: [] }, scope)).toThrow('memory reconciliation returned an unsupported action: "maybe"')
      expect(() => parseReconcileResult({ summary: 's', action: 'planned', operations: [] }, scope)).toThrow('memory reconciliation returned no title')
      expect(() => parseReconcileResult({ title: 't', action: 'planned', operations: [] }, scope)).toThrow('memory reconciliation returned no summary')
      expect(() => parseReconcileResult({ ...planned, operations: 'none' }, scope)).toThrow('memory reconciliation returned an invalid operation list')
      expect(() => parseReconcileResult({ ...planned, operations: Array.from({ length: MAX_RECONCILE_OPERATIONS + 1 }, () => ({ kind: 'runtime-remove', target: 'user', oldText: 'x', reason: 'r' })) }, scope)).toThrow(`memory reconciliation proposed 41 operations; at most ${MAX_RECONCILE_OPERATIONS} are accepted at once`)
      expect(() => parseReconcileResult({ ...planned, action: 'failed', operations: [{ kind: 'runtime-remove', target: 'user', oldText: 'x', reason: 'r' }] }, evidence([entry('x')]))).toThrow('memory reconciliation reported a failure together with operations')
    })

    it('refuses an operation the host would have to guess at', () => {
      const scope = evidence([entry('Prefer short answers'), entry('Prefer short answers too')], [{ id: 'doc-1', title: 'Design', status: 'active' }, { id: 'doc-2', title: 'Old', status: 'archived' }])
      const plan = (operation: unknown) => () => parseReconcileResult({ ...planned, operations: [operation] }, scope)
      expect(plan('nonsense')).toThrow('reconcile operation 1 must be an object')
      expect(plan({ kind: 'runtime-nudge', reason: 'r' })).toThrow('reconcile operation 1 has an unsupported kind: "runtime-nudge"')
      expect(plan({ kind: 'runtime-remove', target: 'user', oldText: 'x' })).toThrow('reconcile operation 1 needs a non-empty reason')
      expect(plan({ kind: 'runtime-remove', target: 'everywhere', oldText: 'x', reason: 'r' })).toThrow('reconcile operation 1 needs a target of memory or user')
      expect(plan({ kind: 'runtime-add', target: 'user', content: 'c', reason: 'r' })).toThrow('reconcile operation 1 needs an importance of critical, normal, or low')
      expect(plan({ kind: 'runtime-add', target: 'user', content: 'c', importance: 'urgent', reason: 'r' })).toThrow('reconcile operation 1 needs an importance of critical, normal, or low')
      expect(plan({ kind: 'runtime-add', target: 'user', content: 'c', importance: 'low', branches: ['main', ''], reason: 'r' })).toThrow('reconcile operation 1 needs branches to be a list of branch names')
      expect(plan({ kind: 'runtime-add', target: 'user', importance: 'low', reason: 'r' })).toThrow('reconcile operation 1 needs a non-empty content')
      expect(plan({ kind: 'document-archive', reason: 'r' })).toThrow('reconcile operation 1 needs a documentId')
      expect(plan({ kind: 'document-archive', documentId: 'doc-9', reason: 'r' })).toThrow('reconcile operation 1 names an unknown document: doc-9')
      expect(plan({ kind: 'document-archive', documentId: 'doc-2', reason: 'r' })).toThrow('reconcile operation 1 names a document that is not active: doc-2')
      expect(plan({ kind: 'runtime-remove', target: 'user', oldText: 'nothing like this', reason: 'r' })).toThrow('reconcile operation 1 addresses no user entry containing "nothing like this"')
      expect(plan({ kind: 'runtime-remove', target: 'user', oldText: 'Prefer', reason: 'r' })).toThrow('reconcile operation 1 addresses more than one user entry; use a unique substring')
    })

    it('addresses an entry by exact text before falling back to a substring', () => {
      const scope = evidence([entry('Prefer short answers'), entry('Prefer short answers and no preamble')])
      const result = parseReconcileResult({ ...planned, operations: [{ kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'duplicate' }] }, scope)
      expect(result.operations).toEqual([{ kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'duplicate' }])
    })
  })

  describe('Mnemon memory reconciliation application', () => {
    const add: MnemonReconcileOperation = { kind: 'runtime-add', target: 'user', content: 'Prefer concise answers', importance: 'normal', reason: 'merge' }
    const remove: MnemonReconcileOperation = { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'duplicate' }
    const archive: MnemonReconcileOperation = { kind: 'document-archive', documentId: 'doc-1', reason: 'superseded' }

    it('replays a plan in order and stops at the first failure', async () => {
      const runtime = vi.fn<MnemonReconcileApplier['runtime']>(async () => ({}))
      const archiveDocument = vi.fn<MnemonReconcileApplier['archive']>(async () => ({}))
      const applier = { runtime, archive: archiveDocument }
      expect(await applyReconcileOperations([add, remove, archive], applier, new AbortController().signal)).toEqual({ applied: 3, failures: [] })
      expect(runtime.mock.calls.map(call => call[0])).toEqual([
        { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' },
        { action: 'remove', target: 'user', oldText: 'Prefer short answers' },
      ])
      expect(archiveDocument).toHaveBeenCalledWith('doc-1', 'superseded', expect.any(AbortSignal))

      const failing = vi.fn<MnemonReconcileApplier['runtime']>(async () => ({}))
      failing.mockRejectedValueOnce(new Error('gone')).mockResolvedValue({})
      expect(await applyReconcileOperations([add, remove, archive], { runtime: failing, archive: archiveDocument }, new AbortController().signal)).toEqual({ applied: 0, failures: ['operation 1 (runtime-add) failed: gone'] })
      expect(failing).toHaveBeenCalledTimes(1)

      const aborting = new AbortController()
      aborting.abort()
      await expect(applyReconcileOperations([add], applier, aborting.signal)).rejects.toThrow()
    })

    it('carries an optional importance and branch scope through a replace', async () => {
      const runtime = vi.fn<MnemonReconcileApplier['runtime']>(async () => ({}))
      await applyReconcileOperations([{ kind: 'runtime-replace', target: 'memory', oldText: 'Use tabs', content: 'Use two spaces', importance: 'low', branches: ['main'], reason: 'merge' }], { runtime, archive: vi.fn() }, new AbortController().signal)
      expect(runtime.mock.calls[0]![0]).toEqual({ action: 'replace', target: 'memory', oldText: 'Use tabs', content: 'Use two spaces', importance: 'low', branches: ['main'] })
    })

    it('archives through the revision the Documents Source reports, not one the plan guessed', async () => {
      const documentsRead = vi.fn(async () => ({ documents: [{ id: 'doc-1', revision: 7, status: 'active' }] }))
      const sessions = {
        runtime: { mutate: vi.fn(async () => ({})) },
        documents: { read: documentsRead, mutate: vi.fn(async () => ({})) },
      } as unknown as MnemonReconcileSessions
      const applier = sourceApplier(sessions)
      await applier.archive('doc-1', 'superseded', new AbortController().signal)
      expect(sessions.documents.mutate).toHaveBeenCalledWith('archive', { id: 'doc-1', documentRevision: 7, summary: 'superseded' }, expect.any(AbortSignal))

      documentsRead.mockResolvedValueOnce({ documents: [] })
      await expect(applier.archive('doc-1', 'superseded', new AbortController().signal)).rejects.toThrow('the document to archive is no longer present: doc-1')
    })

    it('applies a real proposal to the real Sources it names', async () => {
      const dataDir = temporary('reconcile')
      const workspace = temporary('reconcile-workspace')
      const fixture = await sourceFixture({ dataDir, workspace })
      disposals.push(fixture.dispose)
      const confirmed = { confirmed: true as const }
      await fixture.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer short answers', importance: 'normal' }, confirmed)
      const created = await fixture.documents.mutate('mutate', { action: 'create', title: 'Design', content: '# Design' }, confirmed)
      const createdId = (created.value as { document: { id: string } }).document.id

      const live = (await fixture.runtime.read('snapshot')).value as unknown as RuntimeMemorySnapshot
      const liveDocuments = (await fixture.documents.read('snapshot')).value as unknown as DocumentSnapshot
      const scope = { machine, runtime: live, documents: liveDocuments, foreignMachines: [] }
      const result = parseReconcileResult({
        ...planned,
        operations: [
          { kind: 'runtime-add', target: 'memory', content: 'Keep the changelog short', importance: 'low', reason: 'new' },
          { kind: 'runtime-replace', target: 'user', oldText: 'short answers', content: 'Prefer concise answers', reason: 'merge' },
          { kind: 'document-archive', documentId: createdId, reason: 'superseded' },
        ],
      }, scope)
      // The Host's SourceSession confirms a management mutation itself; the test client asks for it
      // explicitly, which also proves the Source still refuses an unconfirmed write.
      await expect(fixture.runtime.mutate('mutate', { action: 'remove', target: 'user', oldText: 'short answers' } as never, { confirmed: false as never })).rejects.toThrow(/confirmation/u)
      const sessions = {
        runtime: { mutate: (operation: string, input: unknown) => fixture.runtime.mutate(operation, input as never, { confirmed: true }) },
        documents: {
          // SourceSession.read unwraps the management envelope; the test client hands it back whole.
          read: async (operation: string, input?: unknown) => (await fixture.documents.read(operation, input as never)).value,
          mutate: (operation: string, input: unknown) => fixture.documents.mutate(operation, input as never, { confirmed: true }),
        },
      } as unknown as MnemonReconcileSessions
      const outcome = await applyReconcileOperations(result.operations, sourceApplier(sessions), new AbortController().signal)
      expect(outcome).toEqual({ applied: 3, failures: [] })

      const after = (await fixture.runtime.read('snapshot')).value as unknown as RuntimeMemorySnapshot
      expect(after.entries.map(item => item.content).sort()).toEqual(['Keep the changelog short', 'Prefer concise answers'])
      const archived = (await fixture.documents.read('snapshot')).value as unknown as DocumentSnapshot
      expect(archived.documents.find(item => item.id === createdId)?.status).toBe('archived')
    })
  })
})
