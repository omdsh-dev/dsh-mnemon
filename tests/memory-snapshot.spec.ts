import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as runtime from 'dsh-mnemon-source-runtime'
import type { RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'
import * as capture from 'dsh-mnemon-strategy-auto-capture'
import * as light from 'dsh-mnemon-strategy-light-context'
import * as scoped from 'dsh-mnemon-strategy-scoped'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComposableMemoryView } from '../src/core/contracts/index.ts'
import type { HostContextShape, HostMessageSource, HostSession } from '../src/host/dsh.ts'
import { applyMemoryViewGuidance, registerGuidance, RUNTIME_MEMORY_CONTEXT_NAME, SNAPSHOT_GUIDANCE, withoutMemoryViewContext } from '../src/host/guidance.ts'
import { prepareMemorySnapshot } from '../src/host/memory-snapshot.ts'
import { memorySnapshotState, type MemorySnapshotState } from '../src/host/memory-snapshot-state.ts'
import { modelMemoryWake } from '../src/host/view-presentation.ts'
import { truncateMemoryText } from '../src/sdk/index.ts'
import { compositionFixture } from './fixtures/composition.ts'

describe('memory snapshot surface updates', () => {
  const previous = 'MNEMON RUNTIME MEMORY SNAPSHOT\nRevision: synthetic-r1\nMetadata lines are annotations.\n\nContents of USER.md (user profile; entries: 1; UTF-8 bytes: 20/100)\n<runtime-memory-file name="USER.md">\nSynthetic preference.\n</runtime-memory-file>\n\nContents of MEMORY.md (working reference; entries: 1; UTF-8 bytes: 18/100)\n<runtime-memory-file name="MEMORY.md">\nSynthetic old fact.\n</runtime-memory-file>'
  const recent = 'MNEMON RUNTIME MEMORY SNAPSHOT\nEntry annotations default to importance=normal and ages=0d.\n\nUSER.md (user profile)\n<runtime-memory-file name="USER.md">\nSynthetic preference.\n</runtime-memory-file>\n\nMEMORY.md (working reference)\n<runtime-memory-file name="MEMORY.md">\nSynthetic recent fact.\n</runtime-memory-file>'
  const current = 'Full current View: {{model}}, $HOME, 中文 and <quoted-memory> are literal.\n' + 'Retain every character. '.repeat(600)

  function fixture() {
    const session = Session.create(SessionId('snapshot-projection'))
    const append = (text: string, source: HostMessageSource) => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }], source: source as never,
    }), { surfaceOp: 'append' })
    const plan = (text: string | undefined, state?: MemorySnapshotState) => prepareMemorySnapshot(session as unknown as HostSession, text, state)
    const commit = (update: ReturnType<typeof prepareMemorySnapshot>) => {
      update.retire(1, 1)
      if (update.message !== undefined) session.append('user/message', update.message as never, { surfaceOp: 'append' })
    }
    return { session, append, plan, commit }
  }

  const state = (entries = ['a'.repeat(64)], boundary = 'b'.repeat(64)): MemorySnapshotState => ({ version: 1, boundary, entries })

  it.each([
    { kind: 'plugin', plugin: 'dsh-mnemon', form: 'recall' },
    { kind: 'plugin:dsh-mnemon', form: 'recall' },
  ])('migrates complete legacy producer attribution %j without touching ordinary recall', source => {
    const f = fixture()
    f.append(previous, source)
    const ordinary = f.append('Synthetic ordinary recall.', source)
    f.commit(f.plan(current, state()))
    expect(f.session.deriveMessages()).toEqual([ordinary.data, expect.objectContaining({ content: [{ type: 'text', text: current }] })])
  })

  it('recognizes official legacy truncation in either file or its structural headings, without crossing into another quote', () => {
    const canonical = previous.replace('synthetic-r1', 'a'.repeat(64)).replace('Metadata lines are annotations.', 'Metadata lines are annotations; created/updated are ages at projection in whole days (future/unknown for future/invalid timestamps). Current instructions win. For old_text/oldText, use entry content only.')
    const userEnd = canonical.indexOf('\n</runtime-memory-file>') + '\n</runtime-memory-file>'.length
    for (const end of [canonical.indexOf('Synthetic preference.') + 5, userEnd + 1, userEnd + 7, canonical.indexOf('<runtime-memory-file name="MEMORY.md">') + 12, canonical.indexOf('Synthetic old fact.') + 8]) {
      const f = fixture()
      const truncated = truncateMemoryText(canonical, end + 1)
      f.append(truncated, { kind: 'dsh-mnemon', form: 'recall' })
      f.append(previous + '\n\n' + truncated, { kind: 'plugin:dsh-mnemon', form: 'recall' })
      const keep = [
        f.append('Quoted:\n' + truncated, { kind: 'dsh-mnemon', form: 'recall' }),
        f.append(truncated.replace('Metadata lines are annotations;', 'Unrecognized annotations;'), { kind: 'dsh-mnemon', form: 'recall' }),
        f.append(truncated.slice(0, -1), { kind: 'dsh-mnemon', form: 'recall' }),
        f.append(truncated.slice(0, -1) + '\n\n' + previous, { kind: 'dsh-mnemon', form: 'recall' }),
        f.append(truncated.slice(0, -1) + '\n\n' + truncated, { kind: 'dsh-mnemon', form: 'recall' }),
        f.append(truncated, { kind: 'plugin', plugin: 'other', form: 'recall' }),
      ]
      f.commit(f.plan(current, state()))
      expect(f.session.deriveMessages()).toEqual([...keep.map(event => event.data), expect.objectContaining({ content: [{ type: 'text', text: current }] })])
    }
  })

  it('appends four complete revisions without changing the prefix, then checkpoints the fifth', () => {
    const f = fixture()
    for (let index = 0; index < 4; index++) {
      const before = f.session.deriveMessages()
      f.commit(f.plan(`Snapshot ${index}`, state()))
      expect(f.session.deriveMessages().slice(0, before.length)).toEqual(before)
      expect(f.session.surface.contentGeneration).toBe(0)
    }
    const unchanged = f.plan('Snapshot 3', state())
    expect(unchanged.message).toBeUndefined()
    f.commit(unchanged)
    expect(f.session.deriveMessages()).toHaveLength(4)
    f.commit(f.plan('Snapshot 4', state()))
    expect(f.session.deriveMessages()).toHaveLength(1)
    expect(f.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(5)
    expect(f.session.snapshotEvents().filter(event => event.type === 'developer/message').map(event => event.sourceEventSeqs)).toEqual([[0], [1], [2], [3]])
  })

  it('counts UTF-8 bytes, admits exactly 64 KiB, and retains an oversized current snapshot in full', () => {
    const f = fixture()
    const first = '中'.repeat(10_000)
    const second = 'x'.repeat(65_536 - Buffer.byteLength(first))
    f.commit(f.plan(first, state()))
    f.commit(f.plan(second, state()))
    expect(f.session.deriveMessages()).toHaveLength(2)
    f.commit(f.plan('one byte beyond the group budget', state()))
    expect(f.session.deriveMessages()).toHaveLength(1)
    const huge = '完整保留'.repeat(8_000)
    f.commit(f.plan(huge, state()))
    expect(f.session.deriveMessages()).toHaveLength(1)
    expect(f.session.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: huge }])
    const before = f.session.snapshotEvents()
    f.commit(f.plan(huge, state()))
    expect(f.session.snapshotEvents()).toEqual(before)
  })

  it('checkpoints changed authority even with identical text, and retires removed or corrected facts', () => {
    const f = fixture()
    f.commit(f.plan('identical text', state()))
    const old = f.session.deriveMessages()[0]
    f.commit(f.plan('identical text', state(undefined, 'c'.repeat(64))))
    expect(f.session.deriveMessages()).toHaveLength(1)
    expect(f.session.deriveMessages()[0]).not.toEqual(old)
    f.commit(f.plan('a new fact', state(['d'.repeat(64)], 'c'.repeat(64))))
    expect(f.session.deriveMessages()).toHaveLength(1)
  })

  it('restores the append budget from durable metadata and migrates unmarked snapshots once', () => {
    const f = fixture()
    f.append('old format', { kind: 'dsh-mnemon', form: 'memory-snapshot' })
    f.commit(f.plan('old format', state()))
    expect(f.session.snapshotEvents().filter(event => event.type === 'developer/message')).toHaveLength(1)
    for (const text of ['second', 'third']) f.commit(f.plan(text, state()))
    const restored = Session.create(SessionId('snapshot-projection'), f.session.snapshotEvents())
    const before = restored.snapshotEvents()
    const same = prepareMemorySnapshot(restored as unknown as HostSession, 'third', state())
    expect(same.message).toBeUndefined()
    same.retire(2, 1)
    expect(restored.snapshotEvents()).toEqual(before)
    const next = prepareMemorySnapshot(restored as unknown as HostSession, 'fourth', state())
    next.retire(2, 1)
    restored.append('user/message', next.message as never, { surfaceOp: 'append' })
    expect(restored.deriveMessages()).toHaveLength(4)
    const checkpoint = prepareMemorySnapshot(restored as unknown as HostSession, 'fifth', state())
    checkpoint.retire(2, 1)
    restored.append('user/message', checkpoint.message as never, { surfaceOp: 'append' })
    expect(restored.deriveMessages()).toHaveLength(1)
  })

  it('retires only complete owned snapshots and preserves interleaved messages verbatim', () => {
    const f = fixture()
    const old = f.append(previous, { kind: 'dsh-mnemon', form: 'recall' })
    const keep = [
      f.append(previous, { kind: 'user' }),
      f.append(previous, { kind: 'other-source', form: 'recall' }),
      f.append(previous, { kind: 'other-source', form: 'memory-snapshot' }),
      f.append(previous, { kind: 'dsh-mnemon', form: 'instructions' }),
      f.append('A recalled Source passage, not a complete snapshot.', { kind: 'dsh-mnemon', form: 'recall' }),
      f.append('Quoted passage:\n' + recent, { kind: 'dsh-mnemon', form: 'recall' }),
      f.append(recent.slice(0, recent.lastIndexOf('\n</runtime-memory-file>')), { kind: 'dsh-mnemon', form: 'recall' }),
    ]
    const latest = f.append(recent, { kind: 'dsh-mnemon', form: 'recall' })
    const before = f.session.snapshotEvents()
    const update = f.plan(current)
    expect(f.session.snapshotEvents()).toEqual(before)
    f.commit(update)

    expect(f.session.deriveMessages()).toEqual([...keep.map(event => event.data), update.message])
    expect(f.session.snapshotEvents().slice(0, before.length)).toEqual(before)
    const retirements = f.session.snapshotEvents().filter(event => event.type === 'developer/message')
    expect(retirements.map(event => event.sourceEventSeqs)).toEqual([[old.seq], [latest.seq]])
    expect(retirements.every(event => event.data.message.content.length === 0)).toBe(true)
    expect(update.message?.role).toBe('user')
    expect(update.message?.content).toEqual([{ type: 'text', text: current }])
  })

  it('keeps one unchanged latest snapshot, including after reconstructing the surface', () => {
    const f = fixture()
    const first = f.append(current, { kind: 'dsh-mnemon', form: 'memory-snapshot' })
    const newest = f.append(current, { kind: 'dsh-mnemon', form: 'memory-snapshot' })
    const update = f.plan(current)
    expect(update.message).toBeUndefined()
    f.commit(update)
    expect(f.session.deriveMessages()).toEqual([newest.data])
    expect(f.session.eventAt(first.seq)).toBe(first)
    const restored = Session.create(SessionId('snapshot-projection'), f.session.snapshotEvents())
    const resume = prepareMemorySnapshot(restored as unknown as HostSession, current)
    const before = restored.snapshotEvents()
    expect(resume.message).toBeUndefined()
    resume.retire(2, 1)
    expect(restored.snapshotEvents()).toEqual(before)
  })

  it.each([undefined, '', '  '])('retires a removed projection without adding an empty model message: %j', text => {
    const f = fixture()
    f.append(current, { kind: 'dsh-mnemon', form: 'memory-snapshot' })
    const update = f.plan(text)
    expect(update.message).toBeUndefined()
    f.commit(update)
    expect(f.session.deriveMessages()).toEqual([])
    const revived = f.plan(current)
    expect(revived.message?.content).toEqual([{ type: 'text', text: current }])
  })
})

describe('memory snapshot authority boundaries', () => {
  function view(): ComposableMemoryView {
    return {
      id: 'view:one', digest: 'one', createdAt: '2026-08-12T08:00:00Z',
      runtimeGeneration: 'generation:one', strategyInstanceKey: 'strategy:one', strategyTypeId: 'test',
      scope: { storage: 'custom', workspaceId: '/synthetic/workspace' }, explanation: 'Synthetic composition.',
      consistency: { mode: 'exact-snapshot', sourceRevisions: { runtime: 'one' } },
      projection: [{ id: 'runtime/projection', sourceInstanceKey: 'runtime', mode: 'eager', text: 'Synthetic full state.', revision: 'one',
        provenance: { sourceTypeId: 'runtime', snapshot: { version: 1, scope: 'a'.repeat(64), entries: ['b'.repeat(64)] } } }],
      readGrants: [{ id: 'grant:one', sourceInstanceKey: 'other', revision: 'unchanged', consistency: 'namespace-pinned-live-read', schema: 'opaque/v1',
        value: { namespace: ['synthetic-one', 'synthetic-two'], opaque: 'synthetic-private-grant' } }],
      routes: [{ id: 'other/read', sourceInstanceKey: 'other', sourceRouteId: 'read', description: 'Synthetic route.', capability: 'read',
        inputSchema: {}, readGrantId: 'grant:one', maxCalls: 4 }],
      actionOffers: [{ id: 'runtime/mutate', sourceInstanceKey: 'runtime', sourceActionId: 'mutate', description: 'Synthetic write.', capability: 'write', inputSchema: {} }],
    }
  }

  it('does not checkpoint on content/revision/time changes within Source-certified scope', () => {
    const previous = view()
    const next = structuredClone(previous)
    next.id = 'view:two'; next.digest = 'two'; next.createdAt = '2026-08-13T08:00:00Z'
    next.consistency.sourceRevisions.runtime = 'two'
    next.projection[0]!.revision = 'two'
    next.projection[0]!.text = 'Synthetic revised complete state with different age annotations.'
    expect(memorySnapshotState(next)).toEqual(memorySnapshotState(previous))
    const serialized = JSON.stringify(memorySnapshotState(next))
    expect(serialized).not.toContain('synthetic-private-grant')
    expect(serialized).not.toContain('/synthetic/workspace')
  })

  it.each([
    ['scope', (value: ComposableMemoryView) => { value.scope.workspaceId = '/synthetic/other' }],
    ['storage', (value: ComposableMemoryView) => { value.scope.storage = 'workspace' }],
    ['generation', (value: ComposableMemoryView) => { value.runtimeGeneration = 'generation:two' }],
    ['Source removal', (value: ComposableMemoryView) => { value.projection = [] }],
    ['Source mode', (value: ComposableMemoryView) => { value.projection[0]!.mode = 'routed' }],
    ['grant removal', (value: ComposableMemoryView) => { value.readGrants = [] }],
    ['opaque grant narrowing', (value: ComposableMemoryView) => { value.readGrants[0]!.value = { namespace: ['synthetic-one'], opaque: 'synthetic-private-grant' } }],
    ['Route removal', (value: ComposableMemoryView) => { value.routes = [] }],
    ['Action removal', (value: ComposableMemoryView) => { value.actionOffers = [] }],
    ['Strategy guidance', (value: ComposableMemoryView) => { value.guidance = { system: 'Changed trusted policy.' } }],
    ['unavailable Source', (value: ComposableMemoryView) => { value.diagnostics = [{ code: 'source-unavailable', message: 'Unavailable.' }] }],
  ] as const)('checkpoints %s even when the rendered snapshot is identical', (_name, change) => {
    const previous = view()
    const next = structuredClone(previous)
    change(next)
    expect(memorySnapshotState(next)!.boundary).not.toBe(memorySnapshotState(previous)!.boundary)
  })

  it('compares unknown Source provenance in full and canonicalizes opaque JSON object keys', () => {
    const previous = view()
    previous.projection[0]!.provenance = { sourceTypeId: 'runtime', snapshot: { version: 2, scope: 'a'.repeat(64), entries: [] } }
    const next = structuredClone(previous)
    next.projection[0]!.text = 'Unknown future projection.'
    expect(memorySnapshotState(next)!.boundary).not.toBe(memorySnapshotState(previous)!.boundary)
    const reordered = structuredClone(previous)
    reordered.readGrants[0]!.value = { opaque: 'synthetic-private-grant', namespace: ['synthetic-one', 'synthetic-two'] }
    expect(memorySnapshotState(reordered)).toEqual(memorySnapshotState(previous))
  })
})

describe('Source-neutral View guidance', () => {
  it('distinguishes the latest projected state from deletion in persistent storage', () => {
    expect(SNAPSHOT_GUIDANCE).toContain('latest snapshot supersedes')
    expect(SNAPSHOT_GUIDANCE).toContain('does not imply deletion from storage')
  })

  it('uses pinned Strategy instructions and removes stale default instructions on a Strategy switch', () => {
    const assembly = {
      sections: [{ name: 'host', text: 'Host protocol' }, { name: 'mnemon:routing', text: 'stale routing' },
        { name: 'mnemon:strategy', text: 'stale strategy' }, { name: 'mnemon:runtime-memory-protocol', text: 'stale legacy' }],
      contexts: [{ name: RUNTIME_MEMORY_CONTEXT_NAME, text: 'stale context' }],
    }
    const selected = { guidance: { system: 'Trusted instruction {{model}}', routing: 'Selected routing' } } as ComposableMemoryView
    const result = applyMemoryViewGuidance(assembly, selected)
    expect(result.sections).toEqual([{ name: 'host', text: 'Host protocol' }, { name: 'mnemon:snapshot-history', text: SNAPSHOT_GUIDANCE },
      { name: 'mnemon:strategy', text: 'Trusted instruction {{model}}' }, { name: 'mnemon:routing', text: 'Selected routing' }])
    expect(result.contexts).toEqual([])
    expect(assembly.sections).toHaveLength(4)
    const custom = applyMemoryViewGuidance(result, {} as ComposableMemoryView, false)
    expect(custom.sections).toEqual([{ name: 'host', text: 'Host protocol' }, { name: 'mnemon:snapshot-history', text: SNAPSHOT_GUIDANCE }])
    expect(applyMemoryViewGuidance(custom, undefined).sections).toEqual([{ name: 'host', text: 'Host protocol' }])
  })

  it('registers only View-based guidance and respects the existing preference', () => {
    const section = vi.fn()
    const prompted = { get: (name: string) => name === 'systemPrompt' ? { section } : undefined }
    const inject = vi.fn((_services: string[], callback: (ctx: unknown) => void) => callback(prompted))
    const ctx = { inject } as unknown as HostContextShape
    const preference = { routingGuidance: true }
    registerGuidance(ctx, preference)
    expect(inject).toHaveBeenCalledWith(['systemPrompt'], expect.any(Function))
    const render = section.mock.calls[0]![0].text
    expect(render()).toContain('only for offered ids')
    expect(render()).toContain('An action offer is not authorization')
    expect(render()).not.toMatch(/Documents|Memory Spaces|mnemon_recall|mnemon_runtime_memory/)
    preference.routingGuidance = false
    expect(render()).toBe('')
  })

  it('keeps View snapshots out of shared context while leaving other contributors unchanged', () => {
    const other = { name: 'other-plugin', text: 'Stable context {{model}}.' }
    const assembly = {
      sections: [{ name: 'host', text: 'Host protocol' }],
      contexts: [{ name: RUNTIME_MEMORY_CONTEXT_NAME, text: 'Inherited stale View' }, other],
      tools: [], variables: { model: 'deepseek' },
    }
    const result = withoutMemoryViewContext(assembly)
    expect(result.sections).toBe(assembly.sections)
    expect(result.contexts).toEqual([other])
    expect(result.contexts[0]).toBe(other)
    expect(renderContextSnapshot(result)).toContain('Stable context deepseek.')
    expect(assembly.contexts).toHaveLength(2)
    expect(withoutMemoryViewContext({ contexts: [] })).toEqual({ contexts: [] })
  })
})

describe('LLM View publication boundary', () => {
  const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
  async function fixture() { const value = await compositionFixture(); fixtures.push(value); return value }
  afterEach(async () => { vi.useRealTimers(); for (const value of fixtures.splice(0)) await value.dispose() })

  it('omits every Runtime instance from child presentation while retaining other Sources and authority', async () => {
    const f = await fixture()
    await f.mount(runtime, { instanceId: 'extra-runtime', config: { dataDir: join(f.root, 'extra-runtime') } })
    await f.mount(scoped, { instanceId: 'scoped', config: { sourceKeys: [
      'source:mnemon-source-runtime', 'source:extra-runtime', 'source:mnemon-source-documents', 'source:mnemon-source-memory-spaces',
    ] } })
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'user', content: 'Synthetic profile preference.' })
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic working memory.' })
    const turn = await f.graph.composableTurns.beginTurn('filtered:1', { storage: 'custom', workspaceId: f.workspace })
    const viewBefore = structuredClone(turn.view)
    const root = modelMemoryWake(f.graph, turn)
    expect(root.sections.filter(section => section.layerId === 'runtime')).toHaveLength(2)
    const child = modelMemoryWake(f.graph, turn, false)
    expect(child.text).not.toContain('Synthetic profile preference.')
    expect(child.text).not.toContain('Synthetic working memory.')
    expect(child.sections).toEqual(root.sections.filter(section => section.layerId !== 'runtime'))
    expect(child.sections.length).toBeGreaterThan(0)
    expect(child.text).toContain('mnemon_runtime_memory')
    expect(child.text).toContain('source:extra-runtime/mutate')
    expect(child.text).toContain('mnemon_document_search')
    expect(child.viewId).toBe(root.viewId)
    expect(child.viewDigest).toBe(root.viewDigest)
    expect(turn.view).toEqual(viewBefore)
    expect(modelMemoryWake(f.graph, turn)).toEqual(root)
    f.graph.composableTurns.endTurn(turn.turnId)
  })

  it('describes default projections as bounded when metadata clips a store within both byte limits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-15T08:00:00.000Z'))
    const { graph, workspace } = await fixture()
    const source = graph.source('runtime')
    const empty = await source.read<RuntimeMemorySnapshot>('snapshot')
    const entries = (['user', 'memory'] as const).flatMap(target =>
      Array.from({ length: target === 'user' ? 500 : 1200 }, (_, index) => ({
        content: `${target === 'user' ? 'u' : 'm'}${index}`, target, importance: 'critical',
        created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
      })),
    )
    writeFileSync(empty.sourcePath, JSON.stringify({ version: 1, entries }))
    const stored = await source.read<RuntimeMemorySnapshot>('snapshot')
    expect(stored.targets.user.used).toBeLessThanOrEqual(stored.targets.user.limit)
    expect(stored.targets.memory.used).toBeLessThanOrEqual(stored.targets.memory.limit)
    const turn = await graph.composableTurns.beginTurn('metadata:dense', { storage: 'custom', workspaceId: workspace })
    const wake = modelMemoryWake(graph, turn)
    expect(wake.text).toContain('[importance=critical; created=14d; updated=14d]')
    expect(wake.text).not.toContain('\nm1199\n')
    expect(wake.guidance?.system).toContain('budget-limited projection')
    expect(wake.guidance?.system).toContain('absence is not evidence that an entry was deleted')
    expect(wake.guidance?.system).not.toContain('complete projection')
    expect((await source.read<RuntimeMemorySnapshot>('snapshot')).entries).toEqual(entries)
    graph.composableTurns.endTurn(turn.turnId)
  })

  it.each([false, true])('preserves Runtime metadata in model context and immutable turns (extensions=%s)', async extensions => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-01T08:00:00.000Z'))
      const f = await fixture()
      const source = f.graph.source('runtime')
      await source.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise replies.', importance: 'critical' })
      await source.mutate('mutate', { action: 'add', target: 'memory', content: 'Use pnpm.', importance: 'low' })
      if (extensions) {
        await f.mount(scoped, { instanceId: 'scoped' })
        await f.mount(light, { instanceId: 'light', config: { maxProjectionCharacters: 1500 } })
        await f.mount(capture, { instanceId: 'capture' })
      }
      vi.setSystemTime(new Date('2026-09-15T08:00:00.000Z'))
      const scope = { storage: 'custom' as const, workspaceId: f.workspace, agentId: 'agent' }
      const first = await f.graph.composableTurns.beginTurn('metadata:1', scope)
      const wake = modelMemoryWake(f.graph, first)
      expect(wake.text).toContain('[importance=critical; created=14d; updated=14d]\nPrefer concise replies.')
      expect(wake.text).toContain('[importance=low; created=14d; updated=14d]\nUse pnpm.')
      expect(wake.guidance?.system).toMatch(/current turn wins|Current user instructions win/u)
      if (extensions) {
        expect(first.view.strategyExtensions).toHaveLength(3)
        expect(first.view.projection.reduce((sum, fragment) => sum + fragment.text.length, 0)).toBeLessThanOrEqual(1500)
      }
      vi.setSystemTime(new Date('2026-09-16T08:00:00.000Z'))
      expect(await f.graph.composableTurns.beginTurn('metadata:1', scope)).toBe(first)
      expect(modelMemoryWake(f.graph, first)).toEqual(wake)
      const next = await f.graph.composableTurns.beginTurn('metadata:2', scope)
      expect(modelMemoryWake(f.graph, next).text).toContain('[importance=low; created=15d; updated=15d]\nUse pnpm.')
      expect(next.view.projection.find(fragment => fragment.sourceInstanceKey === 'source:mnemon-source-runtime')?.revision)
        .toBe(first.view.projection.find(fragment => fragment.sourceInstanceKey === 'source:mnemon-source-runtime')?.revision)
      f.graph.composableTurns.endTurn(first.turnId)
      f.graph.composableTurns.endTurn(next.turnId)
    } finally { vi.useRealTimers() }
  })

  it('projects exact hot memory and compact Source covers without disclosing namespaces or control-plane paths', async () => {
    const { graph, workspace, memorySpace } = await fixture()
    const body = await memorySpace()
    await graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Use immutable per-turn context.' })
    await graph.source('documents').mutate('mutate', { action: 'create', title: 'Private title', content: 'Detailed source document.' })
    const turn = await graph.composableTurns.beginTurn('agent:1', { storage: 'custom', workspaceId: workspace, agentId: 'agent' })
    const wake = graph.composableTurns.memoryWake(turn.view.id)
    expect(wake.text).toContain('Use immutable per-turn context.')
    expect(wake.text).toContain('1 active project Document')
    expect(wake.text).not.toContain(body.id)
    expect(wake.text).not.toContain('Private title')
    expect(wake.text).not.toContain('Detailed source document.')
    expect(wake.text).not.toContain(workspace)
    expect(turn.view.readGrants).toHaveLength(2)
    graph.composableTurns.endTurn(turn.turnId)
  })

  it('holds a turn immutable and observes committed Source changes only at the next boundary', async () => {
    const { graph, workspace } = await fixture()
    const scope = { storage: 'custom' as const, workspaceId: workspace, agentId: 'agent' }
    const turns = graph.composableTurns
    const source = graph.source('runtime')
    await source.mutate('mutate', { action: 'add', target: 'memory', content: 'First revision.' })
    const first = await turns.beginTurn('agent:1', scope)
    const wake = turns.memoryWake(first.view.id)
    await source.mutate('mutate', { action: 'add', target: 'memory', content: 'Second revision.' })
    await graph.source('documents').mutate('mutate', { action: 'create', title: 'Next View', content: 'Not eager content.' })
    expect(await turns.beginTurn('agent:1', scope)).toBe(first)
    expect(turns.memoryWake(first.view.id)).toEqual(wake)
    turns.endTurn(first.turnId)
    const next = await turns.beginTurn('agent:2', scope)
    expect(next.view.id).not.toBe(first.view.id)
    expect(turns.memoryWake(next.view.id).text).toContain('Second revision.')
    expect(turns.memoryWake(next.view.id).text).not.toContain('Not eager content.')
    turns.endTurn(next.turnId)
  })
})
