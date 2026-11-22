import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { expect, it } from 'vitest'
import holographic from 'dsh-mnemon-provider-holographic'
import * as spaces from 'dsh-mnemon-source-memory-spaces'
import * as scoped from 'dsh-mnemon-strategy-scoped'
import * as general from 'dsh-mnemon-strategy-general'
import type { DocumentSnapshot } from 'dsh-mnemon-source-documents/contracts'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import type { Config } from '../src/host/protocol.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { registerMemoryWriteApproval } from '../src/host/write-approval.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))
const fork = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-fork-in-process'))
type Reply = string | { name: string; args: Record<string, unknown> }
type Respond = (options: GenerateOptions) => Reply | Promise<Reply>
class ScriptedAdapter extends LlmAdapter {
  private calls = 0
  constructor(private readonly respond: Respond) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = await this.respond(options)
    const id = `lifecycle-${++this.calls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
    if (typeof reply === 'string') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    } else {
      const args = JSON.stringify(reply.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: reply.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: reply.name, arguments: args } }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: typeof reply === 'string' ? 'stop' : 'tool-calls' } }
  }
}

async function harness(respond: Respond, configure?: (f: Awaited<ReturnType<typeof compositionFixture>>) => Promise<void>, codeMode = false, config: Config = {}) {
  const f = await compositionFixture(config)
  const ctx = new Context()
  let stop: (() => void) | undefined
  let stopTools: (() => void) | undefined
  let stopApproval: (() => void) | undefined
  let coordinator: MnemonSubagentCoordinator | undefined
  const dispose = async () => { stop?.(); stopApproval?.(); stopTools?.(); coordinator?.dispose(); await ctx.fiber.dispose(); await f.dispose() }
  try {
    await configure?.(f)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    if (codeMode) {
      for (const [name, config] of [
        ['dsh-fs-local', { cwd: f.workspace }], ['dsh-subprocess-local', {}], ['dsh-sandbox-local', {}],
        ['dsh-sandbox-policy', { mode: 'read-only', workspaceRoot: f.workspace }], ['dsh-ptc-runtime-node', {}],
      ] as const) await ctx.plugin((await import(requireDsh.resolve(`@deepseek-ai/${name}`))).default, config)
    }
    const selectPtc = await loadTools(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await loadWorkingDirectory(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(fork, { providerName: 'fork' })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(respond))
    const host = ctx as unknown as HostContextShape
    coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
    stopTools = registerTools(host, f.live, coordinator, f.extensions)
    stopApproval = registerMemoryWriteApproval(host, f.live)
    stop = new MnemonLifecycle(host, coordinator, f.config, f.live).start()
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: f.workspace })
    if (codeMode) await selectPtc(parent.ctx)
    const turn = async (text: string) => {
      parent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await parent.whenIdle()
    }
    return { ...f, ctx, coordinator, parent: parent as unknown as HostAgent, session: parent.session, turn, dispose }
  } catch (error) { await dispose(); throw error }
}

it('creates and immediately updates a Document through real Host tools in one General-strategy turn (#559)', async () => {
  let calls = 0
  let id = ''
  const f = await harness(async options => {
    if (calls++ === 0) return { name: 'mnemon_document_create', args: { title: 'Same-turn correction', content: 'Synthetic first draft.' } }
    if (calls === 2) {
      const snapshot = await f.graph.source('documents').read<DocumentSnapshot>('snapshot')
      id = snapshot.documents.find(document => document.title === 'Same-turn correction')!.id
      expect(JSON.stringify(options.messages)).toContain(id)
      return { name: 'mnemon_document_manage', args: { action: 'update', id, content: 'Synthetic corrected draft.' } }
    }
    return 'Corrected.'
  }, async f => {
    f.config.memoryTopology.strategyId = 'general'
    await f.mount(general, { instanceId: 'general' })
  })


  try {
    await f.turn('Create the synthetic draft, then correct it immediately.')
    expect(calls).toBe(3)
    expect(await f.graph.source('documents').read('document', { id })).toMatchObject({ content: 'Synthetic corrected draft.', revision: 2 })
    const receipts = f.parent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(receipts).toHaveLength(2)
    expect(JSON.stringify(receipts)).not.toContain('"isError":true')
  } finally { await f.dispose() }
}, 20_000)

it('keeps optional Runtime details out of the prompt and recalls them through a real Host Route (#364)', async () => {
  let calls = 0
  const f = await harness(options => {
    const messages = JSON.stringify(options.messages)
    if (calls++ === 0) {
      expect(messages).not.toContain('Synthetic optional port 8123')
      const view = f.live.forAgent(f.parent).composableTurns.activeTurn(f.parent.id)!.view
      const route = view.routes.find(route => route.sourceInstanceKey === 'source:mnemon-source-runtime')!
      expect(route).toBeDefined()
      return { name: 'mnemon_view_route', args: { routeId: route.id, input: { query: '8123' } } }
    }
    expect(messages).toContain('Synthetic optional port 8123')
    return 'The optional detail was retrieved.'
  }, async f => {
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic optional port 8123', importance: 'low' })
  }, false, { runtimeMemory: { deferLowPriority: true }, idleReview: { enabled: false } })
  try {
    await f.turn('Find the optional port detail.')
    expect(calls).toBe(2)
    const receipts = f.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(receipts).toHaveLength(1)
    expect(JSON.stringify(receipts)).not.toContain('"isError":true')
  } finally { await f.dispose() }
})
it('updates an already loaded Agent schema and keeps Documents/Runtime usable with Memory Spaces absent', async () => {
  const requests: string[][] = []
  let calls = 0
  const f = await harness(options => {
    requests.push((options.tools ?? []).map(tool => tool.name))
    if (calls++ === 0) return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'Synthetic retained runtime fact.' } }
    if (calls === 2) return { name: 'mnemon_document_create', args: { title: 'Synthetic record', content: 'Synthetic project record with no Memory Spaces.' } }
    return 'Done.'
  }, async f => { await f.releases[2]!() })
  try {
    await f.turn('Record the synthetic runtime fact and Document.')
    expect(requests[0]).toHaveLength(7)
    expect(requests[0]).not.toContain('mnemon_recall')
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [expect.objectContaining({ content: 'Synthetic retained runtime fact.' })] })
    expect(await f.graph.source('documents').read('snapshot')).toMatchObject({ activeCount: 1 })
    const receipts = f.parent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(receipts).toHaveLength(2)
    expect(JSON.stringify(receipts)).not.toContain('"isError":true')
    const release = await f.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
      await spaces.installMemorySpaces(ctx, [{ instanceId: holographic.id, module: holographic, config: undefined }])
    } }, { instanceId: 'mnemon-source-memory-spaces' })
    await f.turn('Inspect the next model schema.')
    expect(requests.at(-1)).toHaveLength(17)
    expect(requests.at(-1)).toContain('mnemon_recall')
    await release()
    await f.turn('Inspect the schema after disabling the Source again.')
    expect(requests.at(-1)).toHaveLength(7)
  } finally { await f.dispose() }
}, 20_000)

it.each(['add', 'replace'] as const)('persists well-formed Runtime %s metadata and continues the same conversation (#548)', async action => {
  const content = 'x'.repeat(158) + '\u{1F600}' + ' retained memory'
  const requests: GenerateOptions[] = []
  const f = await harness(options => {
    requests.push(options)
    if (requests.length === 1) return { name: 'mnemon_runtime_memory', args: {
      action, target: 'memory', content, ...(action === 'replace' ? { old_text: 'Synthetic original.' } : {}),
    } }
    return 'The synthetic memory is retained.'
  }, async f => {
    if (action === 'replace') await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic original.' })
  })
  const reader = new Context()
  try {
    await f.turn('Save this synthetic memory.')
    await f.turn('Continue this same conversation.')
    expect(requests).toHaveLength(3)
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [expect.objectContaining({ content })] })
    const events = f.parent.session.snapshotEvents()
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ data: { meta: { committed: true, item: { title: 'x'.repeat(158) + '…', excerpt: content } } } })

    // JSON.stringify escapes lone surrogates instead of rejecting them. Validate
    // decoded strings too: strict request decoders reject those escaped values.
    const assertStrings = (value: unknown): void => {
      if (typeof value === 'string') expect(value.isWellFormed()).toBe(true)
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(assertStrings)
    }
    requests.forEach(request => assertStrings(request.messages))
    await reader.plugin(JsonlSessionPersistence, { root: join(f.root, 'unicode-reload'), compression: 'none' })
    const session = f.session
    const writer = await reader.sessionPersistence.create({ ...session.header, delegationDepth: session.header.delegationDepth ?? 0 })
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    const handle = await reader.sessionPersistence.open(session.id, 'read')
    try {
      const restored = await handle.read()
      expect(restored.events).toEqual(events)
      assertStrings(restored.events)
    } finally { await handle.close() }
  } finally { await reader.fiber.dispose(); await f.dispose() }
}, 20_000)

it.each(['spawn', 'fork'] as const)('completes a %s review without result IDs and with only registered optional tools', async provider => {
  for (const absent of ['documents', 'runtime'] as const) {
    const childRequests: string[][] = []
    const f = await harness(options => {
      if (options.sessionId === 'parent') return 'A completed synthetic checkpoint.'
      childRequests.push((options.tools ?? []).map(tool => tool.name))
      if (childRequests.length > 1) return 'The synthetic completion was rejected.'
      const system = options.system ?? JSON.stringify(options.messages.filter(message => message.role === 'system'))
      const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
      if (!requestId) throw new Error('Missing completion capability')
      return { name: 'mnemon_subagent_result', args: { requestId, result: { summary: 'Checkpoint reviewed.', action: 'skipped' } } }
    }, async f => { f.config.idleReview.provider = provider; await f.releases[absent === 'documents' ? 1 : 0]!() })
    try {
      await f.turn('Review this synthetic checkpoint.')
      await expect(f.coordinator.review(f.parent, new AbortController().signal)).resolves.toMatchObject({
        delegated: true, action: 'skipped', summary: 'Checkpoint reviewed.', memoryBodyIds: [], documentIds: [],
      })
      expect(childRequests).toHaveLength(1)
      expect(childRequests[0]?.toSorted()).toEqual(absent === 'documents' ? ['mnemon_runtime_memory', 'mnemon_subagent_result']
        : ['mnemon_document_create', 'mnemon_document_search', 'mnemon_subagent_result'])
    } finally { await f.dispose() }
  }
}, 20_000)

it.each(['absent', 'read-only', 'scoped'] as const)('skips review without a writable target when Sources are %s', async state => {
  let childRequests = 0
  const f = await harness(options => {
    if (options.sessionId !== 'parent') childRequests++
    return 'Checkpoint.'
  }, async f => {
    if (state === 'absent') { await f.releases[0]!(); await f.releases[1]!() }
    if (state === 'read-only') f.config.writeEnabled = false
    if (state === 'scoped') await f.mount(scoped, { instanceId: 'scoped', config: { writableSourceKeys: [] } })
  })
  try {
    await f.turn('A synthetic checkpoint with no applicable writable target.')
    await expect(f.coordinator.review(f.parent, new AbortController().signal)).resolves.toMatchObject({ delegated: false, action: 'skipped' })
    expect(childRequests).toBe(0)
    if (state !== 'absent') expect(f.ctx.tools.schemas()).toHaveLength(17)
  } finally { await f.dispose() }
}, 20_000)

it('keeps a surviving in-flight Source call alive while another family is removed', async () => {
  let calls = 0
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let callSignal: AbortSignal | undefined
  const f = await harness(() => calls++ === 0
    ? { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'Synthetic in-flight fact.' } }
    : 'Saved.')
  try {
    f.ctx.on('tools/execute', async (execution, next) => {
      if (execution.name === 'mnemon_runtime_memory') {
        callSignal = execution.signal
        entered.resolve()
        await release.promise
      }
      return next()
    })
    const pending = f.turn('Save this synthetic fact.')
    await entered.promise
    await f.releases[2]!()
    expect(f.ctx.tools.schemas()).toHaveLength(7)
    expect(callSignal?.aborted).toBe(false)
    release.resolve()
    await pending
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [expect.objectContaining({ content: 'Synthetic in-flight fact.' })] })
  } finally { release.resolve(); await f.dispose() }
}, 20_000)

it('keeps global tool families while a workspace View selects only Runtime', async () => {
  const requests: string[][] = []
  const f = await harness(options => {
    requests.push((options.tools ?? []).map(tool => tool.name))
    return 'A narrow workspace View.'
  }, async f => { await f.mount(scoped, { instanceId: 'scoped', config: { sourceKeys: ['source:mnemon-source-runtime'] } }) })
  try {
    await f.turn('Use the narrow synthetic workspace View.')
    expect(requests[0]).toHaveLength(17)
    const turn = await f.graph.composableTurns.beginTurn('narrow-view', { storage: 'custom', workspaceId: f.workspace, agentId: f.parent.id, sessionId: f.parent.id })
    expect(turn.view.actionOffers.map(offer => offer.sourceInstanceKey)).toEqual(['source:mnemon-source-runtime'])
    expect(f.ctx.tools.schemas()).toHaveLength(17)
    f.graph.composableTurns.endTurn(turn.turnId)
  } finally { await f.dispose() }
}, 20_000)


it.each([false, true])('keeps the View tool list consistent with scoped visibility (PTC=%s, #656)', async codeMode => {
  const requests: GenerateOptions[] = []
  let restricted = true
  let calls = 0
  const content = 'Synthetic write through the allowed Runtime tool.'
  const f = await harness(options => {
    requests.push(options)
    if (calls++ % 2 === 1) return 'Synthetic tool check complete.'
    if (codeMode) return { name: 'run_code', args: {
      description: 'Check SDK visibility and write allowed synthetic Runtime context.',
      code: `await tools.mnemon_runtime_memory({action:'add',target:'memory',content:${JSON.stringify(content)}}); return 'sdk:' + typeof tools.mnemon_remember + '|' + typeof tools.mnemon_runtime_memory;`,
    } }
    return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content } }
  }, async f => { await f.memorySpace() }, codeMode)
  const allow = ['mnemon_runtime_memory', 'mnemon_recall', 'mnemon_status', 'mnemon_memory_bodies', 'mnemon_document_search', 'mnemon_document_create']
  const release = f.parent.ctx.tools!.restrict!({ allow }) as () => void
  const toolLine = (request: GenerateOptions) => request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? block.text.split('\n') : [])).filter(line => line.startsWith('MNEMON VIEW TOOLS')).at(-1)
  try {
    await f.turn('Use the allowed Runtime tool and inspect current memory tool availability.')
    expect(requests).toHaveLength(2)
    const limited = toolLine(requests[0]!)!
    for (const name of allow) expect(limited).toContain(name)
    for (const name of ['mnemon_remember', 'mnemon_forget', 'mnemon_related', 'mnemon_document_manage', 'mnemon_memory_body_create']) expect(limited).not.toContain(name)
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [expect.objectContaining({ content })] })
    if (codeMode) {
      expect(requests[0]!.tools?.map(tool => tool.name)).toEqual(['run_code'])
      expect(JSON.stringify(f.session.snapshotEvents().filter(event => event.type === 'tool/result'))).toContain('sdk:undefined|function')
    }
    release(); restricted = false
    await f.turn('The restriction is lifted; inspect availability again.')
    expect(toolLine(requests[2]!)).toContain('mnemon_remember')
    if (codeMode) expect(JSON.stringify(f.session.snapshotEvents().filter(event => event.type === 'tool/result'))).toContain('sdk:function|function')
  } finally { if (restricted) release(); await f.dispose() }
}, 30_000)


it('delivers the conservative Layered protocol and still honors an explicit Runtime destination (#655)', async () => {
  let calls = 0
  const f = await harness(options => {
    const visible = JSON.stringify(options)
    expect(visible).toContain('durable user-authored')
    expect(visible).toContain('Project records')
    expect(visible).toContain('explicitly chooses Runtime')
    if (calls++ === 0) return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'Synthetic project decision explicitly pinned by the user.', importance: 'low', branches: ['demo'] } }
    return 'Saved to Runtime as requested.'
  })
  try {
    await f.turn('Explicitly save this synthetic project decision to Runtime MEMORY.md, scoped to demo, with low importance.')
    expect(calls).toBe(2)
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [expect.objectContaining({ content: 'Synthetic project decision explicitly pinned by the user.', importance: 'low', branches: ['demo'] })] })
    const receipts = f.parent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(receipts).toHaveLength(1)
    expect(JSON.stringify(receipts)).not.toContain('"isError":true')
  } finally { await f.dispose() }
}, 20_000)

it.each([
  { mode: 'native', outcome: 'allowed-once' },
  { mode: 'native', outcome: 'rejected' },
  { mode: 'native', outcome: 'unavailable' },
  { mode: 'native', outcome: 'cancelled' },
  { mode: 'native', outcome: 'deny-rule' },
  { mode: 'native', outcome: 'never' },
  { mode: 'native', outcome: 'missing-service' },
  { mode: 'ptc', outcome: 'allowed-once' },
  { mode: 'ptc', outcome: 'rejected' },
  { mode: 'native', outcome: 'off' },
])('confirms Document replacement before writing on the real Host ($mode / $outcome, #140)', async ({ mode, outcome }) => {
  let calls = 0
  let asks = 0
  let id = ''
  const f = await harness(() => {
    if (calls++ !== 0) return 'Finished the requested operation.'
    const args = { action: 'update', id, content: 'Synthetic approved replacement.' }
    return mode === 'native' ? { name: 'mnemon_document_manage', args }
      : { name: 'run_code', args: { description: 'Update the synthetic document', code: `await tools.mnemon_document_manage(${JSON.stringify(args)})` } }
  }, async fixture => {
    await fixture.graph.source('documents').mutate('mutate', { action: 'create', title: 'Approval fixture', content: 'Synthetic original content.' })
    id = (await fixture.graph.source('documents').read<DocumentSnapshot>('snapshot')).documents[0]!.id
  }, mode === 'ptc', { confirmWrites: outcome !== 'off', idleReview: { enabled: false } })
  try {
    if (outcome !== 'missing-service') {
      const Approval = await import(requireDsh.resolve('@deepseek-ai/dsh-user-approval'))
      await f.ctx.plugin(Approval.default, { policy: outcome === 'never' ? 'never' : 'ask' })
      f.ctx.on('approval/request' as never, (async (request: { displayReason?: Record<string, string> }) => {
        asks++
        expect(request.displayReason?.zh).toContain('请确认本次记忆修改')
        expect(request.displayReason?.en).toContain('Review this memory change')
        for (const lang of ['ja', 'es', 'fr', 'de', 'ru', 'pt']) {
          expect(request.displayReason?.[lang]?.trim().length ?? 0, `displayReason.${lang}`).toBeGreaterThan(0)
        }
        expect((await f.graph.source('documents').read('document', { id }) as { content: string }).content).toBe('Synthetic original content.')
        return outcome
      }) as never)
    }
    if (outcome === 'deny-rule') f.parent.ctx.on('tools/pre-execute', (async () => ({ kind: 'deny', reason: 'Synthetic pre-existing denial' })) as never)
    await f.turn('Replace the synthetic document.')
    expect(calls).toBe(2)
    const allowed = outcome === 'allowed-once' || outcome === 'off'
    expect(await f.graph.source('documents').read('document', { id })).toMatchObject({ content: allowed ? 'Synthetic approved replacement.' : 'Synthetic original content.' })
    expect(asks).toBe(['never', 'missing-service', 'off', 'deny-rule'].includes(outcome) ? 0 : 1)
    const decided = f.session.snapshotEvents().filter(event => event.type === 'approval/decided')
    expect(decided).toHaveLength(['missing-service', 'off', 'deny-rule'].includes(outcome) ? 0 : 1)
  } finally { await f.dispose() }
}, 20_000)

it.each([false, true])('requires separate approval for named and generic memory writes in one turn (PTC=%s, #140)', async codeMode => {
  let calls = 0
  const asked: string[] = []
  const f = await harness(() => {
    const step = calls++
    if (step > (codeMode ? 0 : 1)) return 'Finished the synthetic write requests.'
    const offer = f.live.forAgent(f.parent).composableTurns.activeTurn(f.parent.id)!.view.actionOffers.find(offer => offer.sourceInstanceKey === 'source:mnemon-source-runtime')!
    const first = { action: 'add', target: 'memory', content: 'Approved synthetic fact.' }
    const second = { offerId: offer.id, input: { action: 'add', target: 'memory', content: 'Rejected synthetic fact.' } }
    if (codeMode) return { name: 'run_code', args: { description: 'Two synthetic memory writes', code: `await tools.mnemon_runtime_memory(${JSON.stringify(first)}); await tools.mnemon_view_action(${JSON.stringify(second)})` } }
    return step === 0 ? { name: 'mnemon_runtime_memory', args: first } : { name: 'mnemon_view_action', args: second }
  }, undefined, codeMode, { confirmWrites: true, idleReview: { enabled: false } })
  try {
    const Approval = await import(requireDsh.resolve('@deepseek-ai/dsh-user-approval'))
    await f.ctx.plugin(Approval.default, { policy: 'ask' })
    f.ctx.on('approval/request' as never, (async (request: { toolName: string }) => {
      asked.push(request.toolName)
      return asked.length === 1 ? 'allowed-once' : 'rejected'
    }) as never)
    await f.turn('Perform the two synthetic memory writes.')
    expect(asked).toEqual(['mnemon_runtime_memory', 'mnemon_view_action'])
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [{ content: 'Approved synthetic fact.' }] })
    const events = f.session.snapshotEvents().filter(event => event.type === 'approval/decided')
    expect(events).toHaveLength(2)
  } finally { await f.dispose() }
}, 20_000)

it('applies live write confirmation to an already-pinned View (#140)', async () => {
  let calls = 0
  let asks = 0
  const f = await harness(() => {
    if (calls++ !== 0) return 'Kept the original data.'
    // Composition has already pinned this turn while the preference was off.
    f.config.confirmWrites = true
    return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'Must not be silently written.' } }
  }, undefined, false, { confirmWrites: false, idleReview: { enabled: false } })
  try {
    const Approval = await import(requireDsh.resolve('@deepseek-ai/dsh-user-approval'))
    await f.ctx.plugin(Approval.default, { policy: 'ask' })
    f.ctx.on('approval/request' as never, (async () => { asks++; return 'rejected' }) as never)
    await f.turn('Try the synthetic memory write.')
    expect(asks).toBe(1)
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [] })
  } finally { await f.dispose() }
})
