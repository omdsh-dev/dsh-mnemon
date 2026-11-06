import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as documents from 'dsh-mnemon-source-documents'
import * as runtime from 'dsh-mnemon-source-runtime'
import * as scoped from 'dsh-mnemon-strategy-scoped'
import * as lightContext from 'dsh-mnemon-strategy-light-context'
import { expect, it, vi } from 'vitest'
import type { HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { createRuntimeGraph } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { dsh021, executeTool, loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

type Mode = 'native' | 'ptc'
type Reply = string | { name: string; args: Record<string, unknown> }

/** Only model choices are scripted; Agent turns, scopes, tools and storage are published DSH. */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0
  constructor(private readonly reply: (options: GenerateOptions) => Reply) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.reply(options)
    const id = `turn-view-${++this.calls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
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
    yield { type: 'finish', reason: { kind: typeof reply === 'string' ? 'stop' : 'tool-calls' } }
  }
}

async function fixture(mode: Mode, start = true) {
  const f = await compositionFixture({ idleReview: { enabled: false } })
  // Both named tools and unbound, exact Route/Action ids must reach the model.
  await f.mount(documents, { instanceId: 'extra-documents', config: { dataDir: join(f.root, 'extra-documents') } })
  await f.mount(runtime, { instanceId: 'extra-runtime', config: { dataDir: join(f.root, 'extra-runtime') } })
  const unmountScoped = await f.mount(scoped, { instanceId: 'scoped', config: { sourceKeys: [
    'source:mnemon-source-runtime', 'source:mnemon-source-documents', 'source:mnemon-source-memory-spaces',
    'source:extra-documents', 'source:extra-runtime',
  ] } })
  await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic turn-view retained fact.' })
  const ctx = new Context()
  let stop: (() => void) | undefined
  let stopTools: (() => void) | undefined
  let coordinator: MnemonSubagentCoordinator | undefined
  const close = async () => { stop?.(); stopTools?.(); coordinator?.dispose(); await ctx.fiber.dispose(); await f.dispose() }
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin((await import(requireDsh.resolve('@deepseek-ai/dsh-session-query'))).default)
    await ctx.plugin(SystemPrompt)
    if (mode === 'ptc') {
      for (const [name, config] of [
        ['dsh-fs-local', { cwd: f.workspace }], ['dsh-subprocess-local', {}], ['dsh-sandbox-local', {}],
        ['dsh-sandbox-policy', { mode: 'read-only', workspaceRoot: f.workspace }], ['dsh-ptc-runtime-node', {}],
      ] as const) await ctx.plugin((await import(requireDsh.resolve(`@deepseek-ai/${name}`))).default, config)
    }
    const selectPtc = await loadTools(ctx, mode === 'ptc' && !dsh021 ? 'both' : 'native')
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await loadWorkingDirectory(ctx)
    await ctx.plugin(SubagentRuntime)
    const host = ctx as unknown as HostContextShape
    coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
    stopTools = registerTools(host, f.live, coordinator, f.extensions)
    const lifecycle = new MnemonLifecycle(host, coordinator, f.config, f.live)
    const stopLifecycle = () => { stop?.(); stop = undefined }
    const startLifecycle = () => { stopLifecycle(); stop = lifecycle.start() }
    if (start) startLifecycle()
    const requests: Array<{ sessionId: string; turn: number | undefined; viewId: string | undefined; strategyType: string | undefined; grantSources: string[]; text: string; messages: GenerateOptions['messages']; tools: GenerateOptions['tools'] }> = []
    const receipts: Array<{ sessionId: string; name: string; isError: boolean; text: string }> = []
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error); return undefined })
    const calls = new Map<string, number>()
    ctx.llm.registerAdapter(['fixture'], new ScriptedAdapter(options => {
      const pin = f.graph.composableTurns.activeTurn(String(options.sessionId))
      requests.push({ sessionId: String(options.sessionId), turn: pin === undefined ? undefined : Number(pin.turnId.split(':').at(-1)), viewId: pin?.view.id,
        strategyType: pin?.view.strategyTypeId, grantSources: pin?.view.readGrants.map(grant => grant.sourceInstanceKey) ?? [],
        text: JSON.stringify(options.messages.filter(message => message.role === 'user')), messages: options.messages, tools: options.tools })
      const count = calls.get(String(options.sessionId)) ?? 0
      calls.set(String(options.sessionId), count + 1)
      const step = count % 3
      if (step === 2) return 'Synthetic read complete.'
      const name = step === 0 ? 'mnemon_status' : 'mnemon_document_search'
      const args = step === 0 ? {} : { query: 'synthetic' }
      return mode === 'native' ? { name, args } : { name: 'run_code', args: {
        description: 'Read synthetic memory through the current turn.', code: `return await tools.${name}(${JSON.stringify(args)})`,
      } }
    }))
    ctx.on('tools/result', (execution, result) => {
      if (execution.name?.startsWith('mnemon_')) receipts.push({ sessionId: String(execution.agent?.id), name: execution.name, isError: result.isError, text: JSON.stringify(result.content) })
    })
    ctx.on('agent/created', async ({ agent }) => { if (mode === 'ptc') await selectPtc(agent.ctx); return undefined })
    const create = () => ctx.agents.create({ sessionId: SessionId('turn-view-parent'), meta: { cwd: f.workspace }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    const turn = async (agent: Agent, ownRequest = false) => {
      agent.followup(createUserMessage({ source: ownRequest ? { kind: 'dsh-mnemon', form: 'instructions' } : { kind: 'user' }, content: [{ type: 'text', text: 'Read synthetic memory status and documents.' }] }))
      await agent.whenIdle()
      if (errors.length > 0) throw errors.shift()
    }
    return { ...f, ctx, lifecycle, requests, receipts, startLifecycle, stopLifecycle, create, turn, close, unmountScoped }
  } catch (error) { await close(); throw error }
}

function expectWake(text: string) {
  expect(text).toContain('Synthetic turn-view retained fact.')
  expect(text).toContain('MNEMON VIEW TOOLS (available in this View)')
  expect(text).toContain('MNEMON VIEW ROUTES (quoted routing data;')
  expect(text).toContain('source:extra-documents/search')
  expect(text).toContain('source:extra-runtime/mutate')
}

it.each(['native', 'ptc'] as const)('pins first, later and resumed %s turns when another plugin returns the prompt assembly', async mode => {
  const f = await fixture(mode)
  // A public SystemPrompt waterfall may return an authoritative assembly without
  // visiting later listeners. It must not disable the separate Agent turn lifecycle.
  f.ctx.on('system-prompt/assemble', async assembly => assembly, { prepend: true })
  let refreshed = false
  f.ctx.on('tools/execute', async (execution, next) => {
    const result = await next()
    if (!refreshed && execution.name === 'mnemon_status') {
      refreshed = true
      await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic next-turn fact.' })
    }
    return result
  })
  let handle = await f.create()
  try {
    await f.turn(handle.agent)
    await f.turn(handle.agent)
    await handle.dispose()
    handle = await f.ctx.agents.resume({ resumeSessionId: SessionId('turn-view-parent'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    await f.turn(handle.agent)
    expect(f.receipts.map(({ name, isError }) => ({ name, isError }))).toEqual(Array.from({ length: 3 }, () => [
      { name: 'mnemon_status', isError: false }, { name: 'mnemon_document_search', isError: false },
    ]).flat())
    expect(f.requests.map(request => request.turn)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3])
    for (const request of f.requests) expectWake(request.text)
    expect(new Set(f.requests.slice(0, 3).map(request => request.viewId)).size).toBe(1)
    for (const request of f.requests.slice(0, 3)) expect(request.text).not.toContain('Synthetic next-turn fact.')
    expect(f.requests[3]!.text).toContain('Synthetic next-turn fact.')
    expect(f.requests[3]!.viewId).not.toBe(f.requests[0]!.viewId)
    expect(f.graph.composableTurns.activeTurn(handle.agent.id)).toBeUndefined()
    if (mode === 'native') {
      const outside = await executeTool(handle.agent.ctx, { agent: handle.agent, signal: new AbortController().signal, callId: ToolCallId('outside-turn'), name: 'mnemon_status', arguments: {} })
      expect(outside.isError).toBe(true)
      expect(JSON.stringify(outside.content)).toContain('View pinned to the current turn')
    }
  } finally { await handle.dispose(); await f.close() }
}, 20_000)

it('adopts an Agent when lifecycle registration arrives during its first prompt assembly', async () => {
  const f = await fixture('native', false)
  let installed = false
  f.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    // DSH already captured this waterfall's callbacks, so the newly registered
    // assembly hook cannot run until the next step. The pre-step hook can run now.
    if (!installed) { installed = true; f.startLifecycle() }
    return next()
  })
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    expect(f.receipts.map(receipt => receipt.isError)).toEqual([false, false])
    expectWake(f.requests[0]!.text)
    expect(f.requests[0]!.turn).toBe(1)
    expect(f.graph.composableTurns.activeTurn(handle.agent.id)).toBeUndefined()
  } finally { await handle.dispose(); await f.close() }
}, 20_000)

it('pins a delegated child when prompt middleware omits later assembly listeners', async () => {
  const f = await fixture('native')
  f.ctx.on('system-prompt/assemble', async assembly => assembly, { prepend: true })
  const parent = await f.create()
  const child = await f.ctx.agents.create({ sessionId: SessionId('turn-view-child'), parentAgent: parent.agent,
    meta: { origin: 'subagent', parentSession: parent.agent.id, cwd: f.workspace }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  try {
    await f.turn(child.agent)
    expect(f.receipts.map(({ name, isError }) => ({ name, isError }))).toEqual([
      { name: 'mnemon_status', isError: false }, { name: 'mnemon_document_search', isError: false },
    ])
    expect(f.requests.map(request => request.turn)).toEqual([1, 1, 1])
    expectWake(f.requests[0]!.text)
    expect(f.graph.composableTurns.activeTurn(child.agent.id)).toBeUndefined()
    expect(f.graph.composableTurns.activeTurn(parent.agent.id)).toBeUndefined()
  } finally { await child.dispose(); await parent.dispose(); await f.close() }
}, 20_000)

it.each(['reject', 'abort'] as const)('does not create a View when a step will %s after prompt middleware replaces the assembly', async outcome => {
  const f = await fixture('native')
  f.ctx.on('system-prompt/assemble', async assembly => assembly, { prepend: true })
  f.ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (outcome === 'reject') return { kind: 'reject' }
    agent.cancel({ kind: 'user' })
    return next()
  })
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    expect(f.requests).toEqual([])
    expect(f.receipts).toEqual([])
    expect(f.lifecycle.memoryView(handle.agent.id)).toBeUndefined()
    expect(f.graph.composableTurns.activeTurn(handle.agent.id)).toBeUndefined()
  } finally { await handle.dispose(); await f.close() }
})

it('retains execution policy when a View is prepared by the accepted step', async () => {
  const f = await fixture('native')
  f.ctx.on('system-prompt/assemble', async assembly => assembly, { prepend: true })
  const handle = await f.create()
  handle.agent.ctx.tools.guard(execution => execution.name === 'mnemon_status' ? 'Synthetic policy denied status.' : undefined)
  try {
    await f.turn(handle.agent)
    expect(f.receipts.map(({ name, isError }) => ({ name, isError }))).toEqual([
      { name: 'mnemon_status', isError: true }, { name: 'mnemon_document_search', isError: false },
    ])
    expect(f.receipts[0]!.text).toContain('Synthetic policy denied status.')
    expectWake(f.requests[0]!.text)
  } finally { await handle.dispose(); await f.close() }
})

it.each(['native', 'ptc'] as const)('preserves the full request prefix until the snapshot budget checkpoints, including %s resume', async mode => {
  const f = await fixture(mode)
  let handle = await f.create()
  try {
    await f.turn(handle.agent)
    const generation = handle.agent.session.surface.contentGeneration
    expect(f.requests[0]!.strategyType).toBe('default-three-tier')
    expect(f.requests[0]!.grantSources).toEqual(expect.arrayContaining(['source:mnemon-source-documents', 'source:mnemon-source-memory-spaces']))
    await f.graph.source('runtime').mutate('mutate', {
      action: 'add', target: 'memory', content: 'Synthetic revised snapshot fact.',
    })
    await f.turn(handle.agent)
    expect(f.requests[3]!.messages.slice(0, f.requests[2]!.messages.length)).toEqual(f.requests[2]!.messages)
    expect(handle.agent.session.surface.contentGeneration).toBe(generation)
    await f.graph.source('runtime').mutate('mutate', {
      action: 'add', target: 'memory', content: 'Synthetic latest snapshot fact.',
    })
    await f.turn(handle.agent)
    await f.turn(handle.agent)
    await handle.dispose()
    handle = await f.ctx.agents.resume({ resumeSessionId: SessionId('turn-view-parent'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    await f.turn(handle.agent)

    const counts = f.requests.map(request => request.text.match(/Synthetic turn-view retained fact\./gu)?.length ?? 0)
    console.info('Snapshot counts by model request:', counts.join(', '))
    expect(counts).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3])
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'request/header' && (event.data.reason === 'series' || event.data.startsSeries))).toHaveLength(0)
    for (const request of f.requests.slice(3)) expect(request.text).toContain('Synthetic revised snapshot fact.')
    for (const request of f.requests.slice(6)) expect(request.text).toContain('Synthetic latest snapshot fact.')
    for (const request of f.requests) {
      expectWake(request.text)
      expect(request.messages.some(message => message.role === 'developer' && message.source.kind === 'dsh-mnemon')).toBe(false)
    }
    const audit = handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'dsh-mnemon' && event.data.source.form === 'memory-snapshot')
    expect(audit).toHaveLength(3)
    for (const content of ['Synthetic fourth fact.', 'Synthetic fifth fact.']) {
      await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content })
      await f.turn(handle.agent)
    }
    expect(f.requests.slice(15).map(request => request.text.match(/Synthetic turn-view retained fact\./gu)?.length ?? 0)).toEqual([4, 4, 4, 1, 1, 1])
    expect(handle.agent.session.surface.contentGeneration).toBeGreaterThan(generation)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'request/header' && (event.data.reason === 'series' || event.data.startsSeries))).toHaveLength(1)
    await handle.dispose()
    handle = await f.ctx.agents.resume({ resumeSessionId: SessionId('turn-view-parent'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    await f.turn(handle.agent)
    expect(f.requests.slice(21).map(request => snapshots(request.messages).length)).toEqual([1, 1, 1])
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-mnemon' && event.data.source.form === 'memory-snapshot')).toHaveLength(5)
    const latest = f.requests.at(-1)!
    expect(latest.text).toContain('Synthetic fifth fact.')
    expect(latest.messages.some(message => message.role === 'developer' && message.source.kind === 'dsh-mnemon')).toBe(false)
    for (let index = 1; index < f.requests.length; index++) {
      if (index === 18) continue // Only the budget checkpoint may change the prefix.
      const previous = f.requests[index - 1]!
      const current = f.requests[index]!
      expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages)
      expect(current.tools).toEqual(previous.tools)
    }
    console.info('Complete request prefixes stable across additive updates/resume; one budget checkpoint across 24 requests.')
  } finally { await handle.dispose(); await f.close() }
}, 20_000)

it('retires a resumed legacy snapshot backlog without changing other producer messages', async () => {
  const f = await fixture('native')
  let handle = await f.create()
  try {
    await f.turn(handle.agent)
    const snapshot = handle.agent.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'dsh-mnemon' && event.data.source.form === 'memory-snapshot')
    if (snapshot?.type !== 'user/message') throw new Error('Expected the first complete memory snapshot')
    const block = snapshot.data.content[0]
    if (block?.type !== 'text') throw new Error('Expected a text snapshot')
    const append = (text: string, source: object) => handle.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }], source: source as never,
    }), { surfaceOp: 'append' }).data
    const legacy = [append(block.text, { kind: 'dsh-mnemon', form: 'recall' })]
    const keep = [
      append('Synthetic user-authored text.', { kind: 'user' }),
      append('Synthetic unrelated recall.', { kind: 'dsh-mnemon', form: 'recall' }),
      append('Synthetic Source guidance.', { kind: 'dsh-mnemon', form: 'instructions' }),
      append(block.text, { kind: 'other-source', form: 'memory-snapshot' }),
    ]
    legacy.push(append(block.text, { kind: 'dsh-mnemon', form: 'recall' }))
    await handle.dispose()
    handle = await f.ctx.agents.resume({ resumeSessionId: SessionId('turn-view-parent'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic post-upgrade fact.' })
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) {
      const ids = request.messages.flatMap(message => 'id' in message ? [message.id] : [])
      for (const message of keep) expect(request.messages).toContainEqual(message)
      for (const message of [snapshot.data, ...legacy]) expect(ids).not.toContain(message.id)
      expect(request.messages.filter(message => message.role === 'user' && 'source' in message
        && message.source.kind === 'dsh-mnemon' && message.source.form === 'memory-snapshot')).toHaveLength(1)
      expect(request.messages.some(message => message.role === 'developer' && message.source.kind === 'dsh-mnemon')).toBe(false)
      expect(request.text).toContain('Synthetic post-upgrade fact.')
    }
    const audit = handle.agent.session.snapshotEvents()
    for (const message of [snapshot.data, ...legacy, ...keep]) {
      expect(audit.some(event => event.type === 'user/message' && event.data.id === message.id)).toBe(true)
    }
    const retirements = audit.filter(event => event.type === 'developer/message')
      .filter(event => event.data.message.source.kind === 'dsh-mnemon')
    expect(retirements).toHaveLength(3)
    for (const retirement of retirements) {
      expect(retirement.data.message.content).toEqual([])
      expect(retirement.sourceEventSeqs).toHaveLength(1)
    }
  } finally { await handle.dispose(); await f.close() }
}, 20_000)

function snapshots(messages: GenerateOptions['messages']) {
  return messages.filter(message => message.role === 'user' && message.source?.kind === 'dsh-mnemon' && message.source.form === 'memory-snapshot')
}

it('immediately checkpoints corrected and deleted facts while preserving their audit', async () => {
  const f = await fixture('native')
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic removable fact.' })
    await f.turn(handle.agent)
    expect(snapshots(f.requests.at(-1)!.messages)).toHaveLength(2)
    await f.graph.source('runtime').mutate('mutate', { action: 'replace', target: 'memory', oldText: 'Synthetic turn-view retained fact.', content: 'Synthetic corrected fact.' })
    await f.turn(handle.agent)
    for (const request of f.requests.slice(6)) {
      expect(snapshots(request.messages)).toHaveLength(1)
      expect(request.text).not.toContain('Synthetic turn-view retained fact.')
      expect(request.text).toContain('Synthetic corrected fact.')
    }
    await f.graph.source('runtime').mutate('mutate', { action: 'remove', target: 'memory', oldText: 'Synthetic removable fact.' })
    await f.turn(handle.agent)
    for (const request of f.requests.slice(9)) {
      expect(snapshots(request.messages)).toHaveLength(1)
      expect(request.text).not.toContain('Synthetic removable fact.')
    }
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-mnemon' && event.data.source.form === 'memory-snapshot')).toHaveLength(4)
  } finally { await handle.dispose(); await f.close() }
})

it('appends age annotations without changing the preceding model request', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-12T08:00:00.000Z'))
  const f = await fixture('native')
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    const generation = handle.agent.session.surface.contentGeneration
    vi.setSystemTime(new Date('2026-08-13T08:00:00.000Z'))
    await f.turn(handle.agent)
    expect(snapshots(f.requests[3]!.messages)).toHaveLength(2)
    expect(f.requests[3]!.messages.slice(0, f.requests[2]!.messages.length)).toEqual(f.requests[2]!.messages)
    expect(handle.agent.session.surface.contentGeneration).toBe(generation)
    expect(f.requests[3]!.text).toContain('created=1d')
  } finally { await handle.dispose(); await f.close(); vi.useRealTimers() }
})

it('checkpoints a withdrawn ReadGrant even when the full model snapshot is identical', async () => {
  const f = await fixture('native')
  const handle = await f.create()
  try {
    const created = await f.graph.source('documents').mutate<{ document: { id: string } }>('mutate', { action: 'create', title: 'Synthetic grant', content: 'Synthetic document.' })
    await f.turn(handle.agent)
    const previous = snapshots(f.requests[0]!.messages)[0]!
    await f.graph.source('documents').mutate('archive', { id: created.document.id })
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) {
      const current = snapshots(request.messages)
      expect(current).toHaveLength(1)
      expect(current[0]!.content).toEqual(previous.content)
      expect(current[0]!.id).not.toBe(previous.id)
    }
  } finally { await handle.dispose(); await f.close() }
})

it('checkpoints a branch switch before any request can see the previous branch fact', async () => {
  const f = await fixture('native')
  execFileSync('git', ['init', '--quiet', '-b', 'main', f.workspace])
  const handle = await f.create()
  try {
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic main-only fact.', branches: ['main'] })
    await f.turn(handle.agent)
    expect(f.requests[0]!.text).toContain('Synthetic main-only fact.')
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/other'], { cwd: f.workspace })
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) {
      expect(snapshots(request.messages)).toHaveLength(1)
      expect(request.text).not.toContain('Synthetic main-only fact.')
      expect(request.text).toContain('Synthetic turn-view retained fact.')
    }
  } finally { await handle.dispose(); await f.close() }
})

it('checkpoints copied history on a workspace boundary even with identical visible memory', async () => {
  const f = await fixture('native')
  const handle = await f.create()
  let other: Awaited<ReturnType<typeof f.create>> | undefined
  try {
    await f.turn(handle.agent)
    const previous = snapshots(f.requests[0]!.messages)[0]!
    const workspace = join(f.root, 'other-workspace')
    mkdirSync(workspace)
    other = await f.ctx.agents.create({ sessionId: SessionId('other-workspace'), meta: { cwd: workspace }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    other.agent.session.append('user/message', previous as never, { surfaceOp: 'append' })
    await f.turn(other.agent)
    for (const request of f.requests.slice(3)) {
      const current = snapshots(request.messages)
      expect(current).toHaveLength(1)
      expect(current[0]!.content).toEqual(previous.content)
      expect(current[0]!.id).not.toBe(previous.id)
    }
  } finally { await other?.dispose(); await handle.dispose(); await f.close() }
})

it('clears revoked Runtime projection permission before requests on the new generation', async () => {
  const f = await fixture('native')
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    const next = resolveConfig({ ...f.config, memoryTopology: { ...f.config.memoryTopology,
      layers: { ...f.config.memoryTopology.layers, runtime: { ...f.config.memoryTopology.layers.runtime,
        participation: { ...f.config.memoryTopology.layers.runtime!.participation, projection: 'off' } } } } })
    f.live.swap(createRuntimeGraph(next, f.workspace, f.extensions))
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) expect(request.text).not.toContain('Synthetic turn-view retained fact.')
  } finally { await handle.dispose(); await f.close() }
})

it.each(['disabled', 'own-request', 'no-view'] as const)('does not let the %s injection gate retain superseded snapshots', async gate => {
  const f = await fixture('native')
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    await f.graph.source('runtime').mutate('mutate', { action: 'remove', target: 'memory', oldText: 'Synthetic turn-view retained fact.' })
    if (gate === 'disabled') f.config.lifecycleEnabled = false
    if (gate === 'no-view') { await f.unmountScoped(); await f.releases[3]!() }
    await f.turn(handle.agent, gate === 'own-request')
    expect(f.requests.slice(3)).toHaveLength(3)
    for (const request of f.requests.slice(3)) {
      expect(snapshots(request.messages)).toHaveLength(0)
      expect(request.text).not.toContain('Synthetic turn-view retained fact.')
    }
  } finally { await handle.dispose(); await f.close() }
})

it('does not write retirements before step/start when an empty first batch defers the request', async () => {
  const f = await fixture('native')
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    await f.graph.source('runtime').mutate('mutate', { action: 'remove', target: 'memory', oldText: 'Synthetic turn-view retained fact.' })
    const stop = f.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind === 'reject' ? decision : { kind: 'enter', messages: [] }
    })
    await f.turn(handle.agent)
    expect(f.requests).toHaveLength(3)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'developer/message' && event.data.message.source.kind === 'dsh-mnemon')).toHaveLength(0)
    stop()
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) {
      expect(snapshots(request.messages)).toHaveLength(1)
      expect(request.text).not.toContain('Synthetic turn-view retained fact.')
    }
  } finally { await handle.dispose(); await f.close() }
})

it.each(['reject', 'abort'] as const)('does not retire existing snapshots when a changed View will %s', async outcome => {
  const f = await fixture('native')
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    await f.graph.source('runtime').mutate('mutate', { action: 'remove', target: 'memory', oldText: 'Synthetic turn-view retained fact.' })
    const stop = f.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (outcome === 'reject') return { kind: 'reject' }
      agent.cancel({ kind: 'user' })
      return next()
    })
    await f.turn(handle.agent)
    expect(f.requests).toHaveLength(3)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'developer/message' && event.data.message.source.kind === 'dsh-mnemon')).toHaveLength(0)
    stop()
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) expect(request.text).not.toContain('Synthetic turn-view retained fact.')
  } finally { await handle.dispose(); await f.close() }
})

it.each(['earlier-normal', 'earlier-prepend', 'later-normal', 'later-prepend', 'later-scoped-prepend'] as const)('retires snapshots when %s request middleware returns without next', async priority => {
  const f = await fixture('native')
  const hook = async () => ({ provider: 'fixture', model: 'fixture' })
  let stop: (() => void) | undefined
  if (priority.startsWith('earlier')) stop = f.ctx.on('agent/request', hook, { prepend: priority === 'earlier-prepend' })
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    if (priority.startsWith('later')) {
      const ctx = priority === 'later-scoped-prepend' ? handle.agent.ctx : f.ctx
      stop = ctx.on('agent/request', hook, { prepend: priority !== 'later-normal' })
    }
    await f.graph.source('runtime').mutate('mutate', { action: 'remove', target: 'memory', oldText: 'Synthetic turn-view retained fact.' })
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) {
      expect(snapshots(request.messages)).toHaveLength(1)
      expect(request.text).not.toContain('Synthetic turn-view retained fact.')
    }
  } finally { stop?.(); await handle.dispose(); await f.close() }
})

it('cancels the real Host request with a visible hook failure if a retirement cannot append', async () => {
  const f = await fixture('native')
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    await f.graph.source('runtime').mutate('mutate', { action: 'remove', target: 'memory', oldText: 'Synthetic turn-view retained fact.' })
    f.ctx.on('agent/request', async () => ({ provider: 'fixture', model: 'fixture' }), { prepend: true })
    const session = handle.agent.session
    const append = session.append.bind(session)
    const failing = vi.spyOn(session, 'append').mockImplementation((...args) => {
      if (args[0] === 'developer/message') throw new Error('Synthetic retirement append failure.')
      return Reflect.apply(append, session, args)
    })
    await f.turn(handle.agent)
    expect(f.requests).toHaveLength(3)
    expect(f.lifecycle.snapshot(handle.agent.id).current?.lastError).toContain('snapshot checkpoint failed')
    expect(session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data).toMatchObject({
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: expect.stringContaining('snapshot checkpoint failed') } },
    })
    failing.mockRestore()
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) expect(request.text).not.toContain('Synthetic turn-view retained fact.')
  } finally { await handle.dispose(); await f.close() }
})

it.each(['cancel', 'dispose'] as const)('drops a queued checkpoint when the accepted step will %s before publication finishes', async outcome => {
  const f = await fixture('native')
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    await f.graph.source('runtime').mutate('mutate', { action: 'remove', target: 'memory', oldText: 'Synthetic turn-view retained fact.' })
    const stop = f.ctx.on('session/event', (session, event) => {
      if (session !== handle.agent.session || event.type !== 'step/start') return
      if (outcome === 'dispose') f.stopLifecycle()
      handle.agent.cancel({ kind: 'hook', reason: 'Synthetic accepted-step cancellation.' }, { keepInbox: true })
    })
    await f.turn(handle.agent)
    expect(f.requests).toHaveLength(3)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'developer/message' && event.data.message.source.kind === 'dsh-mnemon')).toHaveLength(0)
    stop()
    if (outcome === 'dispose') f.startLifecycle()
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) expect(request.text).not.toContain('Synthetic turn-view retained fact.')
  } finally { await handle.dispose(); await f.close() }
})

it.each(['earlier', 'later'] as const)('finishes an accepted checkpoint when an %s step observer unloads the lifecycle', async order => {
  const f = await fixture('native', false)
  const handle = await f.create()
  let armed = false
  const install = () => f.ctx.on('session/event', (session, event) => {
    if (armed && session === handle.agent.session && event.type === 'step/start') f.stopLifecycle()
  })
  let stop: (() => void) | undefined
  try {
    if (order === 'earlier') stop = install()
    f.startLifecycle()
    await f.turn(handle.agent)
    await f.graph.source('runtime').mutate('mutate', { action: 'remove', target: 'memory', oldText: 'Synthetic turn-view retained fact.' })
    if (order === 'later') stop = install()
    armed = true
    await f.turn(handle.agent)
    expect(f.requests.slice(3)).toHaveLength(3)
    for (const request of f.requests.slice(3)) {
      expect(snapshots(request.messages)).toHaveLength(1)
      expect(request.text).not.toContain('Synthetic turn-view retained fact.')
    }
  } finally { stop?.(); await handle.dispose(); await f.close() }
})

it.each([
  { kind: 'dsh-mnemon', form: 'recall' },
  { kind: 'plugin:dsh-mnemon', form: 'recall' },
])('retires an official light-context legacy snapshot from %j', async source => {
  const f = await fixture('native')
  await f.mount(lightContext, { instanceId: 'light-context' })
  await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic long fact. ' + 'x'.repeat(6_000) })
  let handle = await f.create()
  try {
    await f.turn(handle.agent)
    const snapshot = snapshots(f.requests[0]!.messages)[0]!
    const block = snapshot.content[0]
    if (block?.type !== 'text') throw new Error('Expected the real Source projection')
    expect(block.text).toContain('…\n\n')
    expect(block.text.split('MNEMON RUNTIME MEMORY SNAPSHOT')[1]!.match(/<\/runtime-memory-file>/gu)).toHaveLength(1)
    const legacy = createUserMessage({ source: source as never, content: [{ type: 'text', text: block.text }] })
    handle.agent.session.append('user/message', legacy, { surfaceOp: 'append' })
    const keep = [
      createUserMessage({ source: { kind: 'other-source', form: 'recall' } as never, content: legacy.content }),
      createUserMessage({ source: source as never, content: [{ type: 'text', text: 'Quoted Source passage:\n' + block.text }] }),
      createUserMessage({ source: source as never, content: [{ type: 'text', text: 'Synthetic ordinary recall…' }] }),
    ]
    for (const message of keep) handle.agent.session.append('user/message', message, { surfaceOp: 'append' })
    await handle.dispose()
    handle = await f.ctx.agents.resume({ resumeSessionId: SessionId('turn-view-parent'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    await f.graph.source('runtime').mutate('mutate', { action: 'remove', target: 'memory', oldText: 'Synthetic turn-view retained fact.' })
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) {
      expect(request.messages.some(message => message.id === legacy.id)).toBe(false)
      for (const message of keep) expect(request.messages).toContainEqual(message)
      expect(JSON.stringify(snapshots(request.messages))).not.toContain('Synthetic turn-view retained fact.')
    }
    expect(handle.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === legacy.id)).toBe(true)
  } finally { await handle.dispose(); await f.close() }
})
