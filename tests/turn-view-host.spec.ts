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
import type { RuntimeMemoryConfig } from '../src/host/protocol.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { dsh021, dshVersion, executeTool, loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

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

async function fixture(mode: Mode, start = true, runtimeMemory?: RuntimeMemoryConfig, snapshotCompaction = false) {
  const f = await compositionFixture({ idleReview: { enabled: false }, ...(runtimeMemory === undefined ? {} : { runtimeMemory }) })
  // Both named tools and unbound, exact Route/Action ids must reach the model.
  await f.mount(documents, { instanceId: 'extra-documents', config: { dataDir: join(f.root, 'extra-documents') } })
  await f.mount(runtime, { instanceId: 'extra-runtime', config: { dataDir: join(f.root, 'extra-runtime') } })
  const unmountScoped = await f.mount(scoped, { instanceId: 'scoped', config: { sourceKeys: [
    'source:mnemon-source-runtime', 'source:mnemon-source-documents', 'source:mnemon-source-memory-spaces',
    'source:extra-documents', 'source:extra-runtime',
  ] } })
  await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic turn-view retained fact.' })
  const ctx = new Context()
  const compactionContext = ctx.isolate('compaction')
  let stop: (() => void) | undefined
  let stopTools: (() => void) | undefined
  let coordinator: MnemonSubagentCoordinator | undefined
  const close = async () => { stop?.(); stopTools?.(); coordinator?.dispose(); await ctx.fiber.dispose(); await f.dispose() }
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    if (snapshotCompaction) {
      await ctx.plugin((await import(requireDsh.resolve('@deepseek-ai/dsh-token-meter'))).default)
      await compactionContext.plugin((await import('../src/compaction.ts')).default, { auto: false, retainTokens: 50 })
    }
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
    const lifecycle = new MnemonLifecycle(host, coordinator, f.live.config, f.live)
    const stopLifecycle = () => { stop?.(); stop = undefined }
    const startLifecycle = () => { stopLifecycle(); stop = lifecycle.start() }
    if (start) startLifecycle()
    const requests: Array<{ sessionId: string; turn: number | undefined; viewId: string | undefined; strategyType: string | undefined; grantSources: string[]; text: string; messages: GenerateOptions['messages']; tools: GenerateOptions['tools']; system: GenerateOptions['system']; purpose: GenerateOptions['purpose'] }> = []
    const receipts: Array<{ sessionId: string; name: string; isError: boolean; text: string }> = []
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error); return undefined })
    const calls = new Map<string, number>()
    ctx.llm.registerAdapter(['fixture'], new ScriptedAdapter(options => {
      const pin = f.graph.composableTurns.activeTurn(String(options.sessionId))
      requests.push({ sessionId: String(options.sessionId), turn: pin === undefined ? undefined : Number(pin.turnId.split(':').at(-1)), viewId: pin?.view.id,
        strategyType: pin?.view.strategyTypeId, grantSources: pin?.view.readGrants.map(grant => grant.sourceInstanceKey) ?? [],
        text: JSON.stringify(options.messages.filter(message => message.role === 'user')), messages: options.messages, tools: options.tools, system: options.system, purpose: options.purpose })
      if (options.purpose === 'compaction') return 'Synthetic checkpoint of the ordinary conversation.'
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
    const turn = async (agent: Agent, ownRequest = false, text = 'Read synthetic memory status and documents.') => {
      agent.followup(createUserMessage({ source: ownRequest ? { kind: 'dsh-mnemon', form: 'instructions' } : { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
      if (errors.length > 0) throw errors.shift()
    }
    return { ...f, ctx, compactionContext, lifecycle, requests, receipts, startLifecycle, stopLifecycle, create, turn, close, unmountScoped }
  } catch (error) { await close(); throw error }
}

function expectWake(text: string, inheritRuntime = true) {
  if (inheritRuntime) expect(text).toContain('Synthetic turn-view retained fact.')
  else expect(text).not.toContain('Synthetic turn-view retained fact.')
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

it.each((['native', 'ptc'] as const).flatMap(mode => [false, true].flatMap(bypassAssembly => [undefined, false, true].map(inheritToSubagents => ({ mode, bypassAssembly, inheritToSubagents })))))('presents a child View once per turn: %j', async ({ mode, bypassAssembly, inheritToSubagents }) => {
  const f = await fixture(mode, true, inheritToSubagents === undefined ? undefined : { inheritToSubagents })
  if (bypassAssembly) f.ctx.on('system-prompt/assemble', async assembly => assembly, { prepend: true })
  const parent = await f.create()
  const child = await f.ctx.agents.create({ sessionId: SessionId('turn-view-child'), parentAgent: parent.agent,
    meta: { origin: 'subagent', parentSession: parent.agent.id, cwd: f.workspace }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  try {
    await f.turn(child.agent)
    expect(f.receipts.map(({ name, isError }) => ({ name, isError }))).toEqual([
      { name: 'mnemon_status', isError: false }, { name: 'mnemon_document_search', isError: false },
    ])
    expect(f.requests.map(request => request.turn)).toEqual([1, 1, 1])
    for (const request of f.requests) {
      expectWake(request.text, inheritToSubagents === true)
      expect(request.messages.filter(message => message.role === 'user'
        && message.source?.kind === 'dsh-mnemon' && message.source.form === 'recall')).toHaveLength(1)
    }
    await f.turn(child.agent)
    expect(f.requests.map(request => request.turn)).toEqual([1, 1, 1, 2, 2, 2])
    for (const request of f.requests.slice(3)) {
      expectWake(request.text, inheritToSubagents === true)
      expect(request.messages.filter(message => message.role === 'user'
        && message.source?.kind === 'dsh-mnemon' && message.source.form === 'recall')).toHaveLength(2)
    }
    expect(child.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'dsh-mnemon' && event.data.source.form === 'recall')).toHaveLength(2)
    expect(f.graph.composableTurns.activeTurn(child.agent.id)).toBeUndefined()
    expect(f.graph.composableTurns.activeTurn(parent.agent.id)).toBeUndefined()
    expectWake(f.lifecycle.memoryView(child.agent.id)!.memoryText, inheritToSubagents === true)
  } finally { await child.dispose(); await parent.dispose(); await f.close() }
}, 20_000)

it('captures the current inheritance choice for new children across live settings changes', async () => {
  const f = await fixture('native')
  const parent = await f.create()
  const children: Awaited<ReturnType<typeof f.ctx.agents.create>>[] = []
  const create = async (name: string) => {
    const child = await f.ctx.agents.create({ sessionId: SessionId(name), parentAgent: parent.agent,
      meta: { origin: 'subagent', parentSession: parent.agent.id, cwd: f.workspace }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    children.push(child)
    return child
  }
  const swap = (inheritToSubagents: boolean) => f.live.swap(createRuntimeGraph(resolveConfig({ ...f.config,
    runtimeMemory: { ...f.config.runtimeMemory, inheritToSubagents },
  }), f.workspace, f.extensions))
  const check = async (child: typeof children[number], expected: boolean) => {
    const start = f.requests.length
    await f.turn(child.agent)
    for (const request of f.requests.slice(start)) expectWake(request.text, expected)
    expectWake(f.lifecycle.memoryView(child.agent.id)!.memoryText, expected)
  }
  try {
    const before = await create('before-toggle')
    await check(before, false)
    swap(true)
    const enabled = await create('enabled-child')
    await check(enabled, true)
    const prefix = f.requests.at(-1)!.messages
    await check(before, false)
    swap(false)
    await check(await create('disabled-child'), false)
    await check(enabled, true)
    expect(f.requests.at(-1)!.messages.slice(0, prefix.length)).toEqual(prefix)
    expect(f.receipts.every(receipt => !receipt.isError)).toBe(true)
  } finally { for (const child of children.reverse()) await child.dispose(); await parent.dispose(); await f.close() }
}, 20_000)

it('injects the captured parent View after the parent finishes and newer memory is stored', async () => {
  const f = await fixture('native', true, { inheritToSubagents: true })
  await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'user', content: 'Synthetic delegated user preference.' })
  const parent = await f.create()
  let child: Awaited<ReturnType<typeof f.ctx.agents.create>> | undefined
  const stop = f.ctx.on('tools/execute', async (execution, next) => {
    const result = await next()
    if (execution.agent === parent.agent && execution.name === 'mnemon_status' && child === undefined) {
      child = await f.ctx.agents.create({ sessionId: SessionId('captured-view-child'), parentAgent: parent.agent,
        meta: { origin: 'subagent', parentSession: parent.agent.id, cwd: f.workspace }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    }
    return result
  })
  try {
    await f.turn(parent.agent)
    expect(child).toBeDefined()
    const capturedView = f.requests[0]!.viewId
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic parent-only later fact.' })
    await f.turn(parent.agent)
    expect(f.requests.at(-1)!.text).toContain('Synthetic parent-only later fact.')
    await f.turn(child!.agent)
    const childRequests = f.requests.filter(request => request.sessionId === child!.agent.id)
    expect(childRequests).toHaveLength(3)
    for (const request of childRequests) {
      expectWake(request.text)
      expect(request.text).toContain('Synthetic delegated user preference.')
      expect(request.text).not.toContain('Synthetic parent-only later fact.')
      expect(request.viewId).toBe(capturedView)
    }
  } finally { stop(); await child?.dispose(); await parent.dispose(); await f.close() }
}, 20_000)

it.each(['disabled', 'reject', 'abort'] as const)('does not inject child memory when the step is %s', async gate => {
  const f = await fixture('native')
  const parent = await f.create()
  const child = await f.ctx.agents.create({ sessionId: SessionId('gated-view-child'), parentAgent: parent.agent,
    meta: { origin: 'subagent', parentSession: parent.agent.id, cwd: f.workspace }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  if (gate === 'disabled') f.config.lifecycleEnabled = false
  else child.agent.ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (gate === 'reject') return { kind: 'reject' }
    agent.cancel({ kind: 'user' })
    return next()
  })
  try {
    await f.turn(child.agent)
    if (gate === 'disabled') {
      expect(f.requests).toHaveLength(3)
      for (const request of f.requests) expect(request.text).not.toContain('Synthetic turn-view retained fact.')
    } else expect(f.requests).toEqual([])
    expect(child.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'dsh-mnemon' && event.data.source.form === 'recall')).toHaveLength(0)
    expect(f.graph.composableTurns.activeTurn(child.agent.id)).toBeUndefined()
  } finally { await child.dispose(); await parent.dispose(); await f.close() }
})

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

function bm25Messages(messages: GenerateOptions['messages']) {
  return messages.filter(message => message.role === 'user' && message.source?.kind === 'dsh-mnemon'
    && (message.source.form === 'bm25-recall' || message.source.form === 'bm25-invalidation'))
}

it('retains eager Runtime and the original tool surface with BM25 omitted or off', async () => {
  const projected = []
  for (const config of [undefined, { bm25Recall: false }]) {
    const f = await fixture('native', true, config)
    const handle = await f.create()
    try {
      await f.turn(handle.agent, false, 'Borealis')
      const request = f.requests[0]!
      expectWake(request.text)
      expect(request.text).not.toContain('source:mnemon-source-runtime/search')
      expect(bm25Messages(request.messages)).toEqual([])
      projected.push({ context: snapshots(request.messages).map(message => message.content), tools: request.tools })
    } finally { await handle.dispose(); await f.close() }
  }
  expect(projected[0]).toEqual(projected[1])
})

const supportsSnapshotCompaction = dshVersion === '0.2.1-rc.5' || /^0\.2\.2(?:-rc\.(?:[2-9]|[1-9]\d+))?$/u.test(dshVersion)

it.each([
  ['native', false], ['ptc', false],
  ...(supportsSnapshotCompaction ? [['native', true], ['ptc', true]] as const : []),
] as const)('appends only BM25 hits and keeps %s request prefixes on resume (Mnemon compaction %s)', async (mode, snapshotCompaction) => {
  const f = await fixture(mode, true, { bm25Recall: true }, snapshotCompaction)
  execFileSync('git', ['init', '--quiet', '-b', 'main', f.workspace])
  let handle = await f.create()
  try {
    const runtime = f.graph.source('runtime')
    const documents = f.graph.source('documents')
    const original = 'Glacier deployment uses an amber queue.'
    const corrected = 'Glacier deployment uses a violet queue.'
    const pinned = 'Ship only through the signed pipeline.'
    await runtime.mutate('mutate', { action: 'add', target: 'memory', content: original, branches: ['main'] })
    await runtime.mutate('mutate', { action: 'add', target: 'memory', content: pinned })
    await runtime.mutate('pin', { target: 'memory', content: pinned, pinned: true })
    await runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Use short explanations.' })
    const { document } = await documents.mutate<{ document: { id: string } }>('mutate', {
      action: 'create', title: 'Glacier 部署手册', content: 'BODY_CANARY_ONLY',
    })
    await documents.mutate('mutate', { action: 'create', title: '任务中断后继续执行', content: 'OTHER_BODY_CANARY_ONLY' })

    for (const query of ['继续', 'Glacier 部署', 'Glacier 部署']) await f.turn(handle.agent, false, query)
    expect(bm25Messages(f.requests[0]!.messages)).toHaveLength(0)
    expect(f.requests[0]!.text).toContain(pinned)
    expect(f.requests[0]!.text).toContain('Use short explanations.')
    expect(f.requests[0]!.text).toContain('source:mnemon-source-runtime/search')
    expect(f.requests[0]!.text).not.toContain('Synthetic turn-view retained fact.')
    expect(f.requests[0]!.text).not.toContain(original)
    const delivered = bm25Messages(f.requests[3]!.messages)
    expect(delivered).toHaveLength(1)
    const initial = JSON.stringify(delivered[0]!.content)
    expect(initial).toContain(original)
    expect(initial).toContain('Glacier 部署手册')
    expect(initial).toContain(document.id)
    expect(initial).not.toContain('BODY_CANARY_ONLY')
    expect(bm25Messages(f.requests[6]!.messages)).toEqual(delivered)
    const surface = handle.agent.session.surface.contentGeneration

    await runtime.mutate('mutate', { action: 'replace', target: 'memory', oldText: original, content: corrected })
    await documents.mutate('mutate', { action: 'update', id: document.id, title: 'Glacier 生产部署' })
    await f.turn(handle.agent, false, 'Glacier 部署')
    const updated = bm25Messages(f.requests[9]!.messages)
    expect(updated).toHaveLength(2)
    const latest = JSON.stringify(updated[1]!.content)
    expect(latest).toContain('Disregard superseded or removed references')
    expect(latest).toContain(corrected)
    expect(latest).toContain('Glacier 生产部署')

    await runtime.mutate('mutate', { action: 'remove', target: 'memory', oldText: corrected })
    await f.turn(handle.agent, false, '火星气压')
    const expired = bm25Messages(f.requests[12]!.messages)
    expect(expired).toHaveLength(3)
    expect(expired[2]?.source).toMatchObject({ form: 'bm25-invalidation' })
    expect(JSON.stringify(expired[2]!.content)).toContain('Disregard superseded or removed references')
    expect(JSON.stringify(expired[2]!.content)).not.toContain(corrected)

    await handle.dispose()
    handle = await f.ctx.agents.resume({ resumeSessionId: SessionId('turn-view-parent'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    await f.turn(handle.agent, false, 'Glacier 部署')
    expect(bm25Messages(f.requests[15]!.messages)).toEqual(expired)
    // Compare the actual adapter input, including the system envelope and tools.
    for (const index of [3, 6, 9, 12, 15]) {
      const before = f.requests[index - 1]!
      const after = f.requests[index]!
      expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages))
      expect(after.system).toBe(before.system)
      expect(after.tools).toEqual(before.tools)
    }
    expect(handle.agent.session.surface.contentGeneration).toBe(surface)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'dsh-mnemon' && event.data.source.form === 'bm25-recall')).toHaveLength(2)

    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/other'], { cwd: f.workspace })
    await f.turn(handle.agent, false, '火星气压')
    expect(bm25Messages(f.requests[18]!.messages)).toHaveLength(0)
    expect(f.requests[18]!.text).toContain(pinned)
  } finally { await handle.dispose(); await f.close() }
}, 20_000)

it('pushes bounded Memory Space and Document summary indexes on step 1 without breaking prompt cache (issue 701)', async () => {
  const f = await fixture('native', true, { indexPush: true }, supportsSnapshotCompaction)
  const handle = await f.create()
  try {
    const documents = f.graph.source('documents')
    const spaces = f.graph.source('memory-spaces')
    const activeSpace = await f.memorySpace()
    await spaces.mutate('body-update', {
      memoryBodyId: activeSpace.id,
      name: 'Release Architecture',
      description: 'Quartz failover topology and canary rollback thresholds.',
      active: true,
    })
    await spaces.mutate('body-create', {
      name: 'Team Runbooks',
      description: 'General onboarding notes unrelated to failover.',
      active: true,
      providerId: 'holographic',
      connection: { dataPath: join(f.root, 'team-facts.json') },
    })
    const inactiveSpace = await spaces.mutate<{ id: string }>('body-create', {
      name: 'Hidden Archive',
      description: 'Quartz secret inactive space that must never be pushed.',
      active: false,
      providerId: 'holographic',
      connection: { dataPath: join(f.root, 'inactive-facts.json') },
    })
    const { document } = await documents.mutate<{ document: { id: string } }>('mutate', {
      action: 'create',
      title: 'Deployment Checklist',
      description: 'Quartz cluster verification steps before promotion.',
      content: 'FULL_BODY_MARKER_MUST_NOT_BE_PUSHED '.repeat(30),
    })
    const { document: withoutDescription } = await documents.mutate<{ document: { id: string } }>('mutate', {
      action: 'create',
      title: 'Escrow Checklist',
      content: 'Quartz requires checking the escrow checkpoint. ' + 'Follow the written runbook. '.repeat(12) + 'PRIVATE_BODY_TAIL',
    })

    // Unrelated query adds no recall message while preserving full eager Runtime memory.
    await f.turn(handle.agent, false, '继续')
    expect(bm25Messages(f.requests[0]!.messages)).toHaveLength(0)
    expect(f.requests[0]!.text).toContain('Synthetic turn-view retained fact.')

    // Matching query pushes Space name/description and Document title/description without full body or inactive spaces.
    await f.turn(handle.agent, false, 'Quartz failover verification')
    const delivered = bm25Messages(f.requests[3]!.messages)
    expect(delivered).toHaveLength(1)
    const initial = JSON.stringify(delivered[0]!.content)
    expect(initial).toContain(activeSpace.id)
    expect(initial).toContain('Release Architecture')
    expect(initial).toContain('Quartz failover topology')
    expect(initial).toContain(document.id)
    expect(initial).toContain('Deployment Checklist')
    expect(initial).toContain('Quartz cluster verification steps')
    expect(initial).toContain(withoutDescription.id)
    expect(initial).toContain('Quartz requires checking the escrow checkpoint.')
    expect(initial).not.toContain('PRIVATE_BODY_TAIL')
    expect(initial).not.toContain(inactiveSpace.id)
    expect(initial).not.toContain('Hidden Archive')
    expect(initial).not.toContain('FULL_BODY_MARKER_MUST_NOT_BE_PUSHED')
    const surfaceGeneration = handle.agent.session.surface.contentGeneration

    // Repeated query deduplicates without adding another block or busting the prefix.
    await f.turn(handle.agent, false, 'Quartz failover verification')
    expect(bm25Messages(f.requests[6]!.messages)).toEqual(delivered)

    // Deactivating the Space and updating the Document description invalidates old refs and pushes the updated summary.
    await spaces.mutate('body-update', { memoryBodyId: activeSpace.id, active: false })
    await documents.mutate('mutate', { action: 'update', id: document.id, description: 'Quartz revised promotion runbook.' })
    await f.turn(handle.agent, false, 'Quartz revised promotion')
    const updated = bm25Messages(f.requests[9]!.messages)
    expect(updated).toHaveLength(2)
    const latest = JSON.stringify(updated[1]!.content)
    expect(latest).toContain('Disregard superseded or removed references')
    expect(latest).toContain('Quartz revised promotion runbook.')
    expect(latest).not.toContain(activeSpace.id)

    for (const index of [3, 6, 9]) {
      const before = f.requests[index - 1]!
      const after = f.requests[index]!
      expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages))
      expect(after.system).toBe(before.system)
      expect(after.tools).toEqual(before.tools)
    }
    expect(handle.agent.session.surface.contentGeneration).toBe(surfaceGeneration)

    if (supportsSnapshotCompaction) {
      expect(await f.compactionContext.compaction.compactNow(handle.agent, new AbortController().signal)).not.toBeNull()
      const summary = f.requests.find(request => request.purpose === 'compaction')!
      expect(bm25Messages(summary.messages)).toHaveLength(0)
      expect(JSON.stringify(summary.messages)).not.toContain('Quartz failover topology')
    }
  } finally { await handle.dispose(); await f.close() }
}, 20_000)

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

it.runIf(supportsSnapshotCompaction)('appends corrections and deletion to an empty snapshot without changing the full request prefix', async () => {
  const f = await fixture('native', true, undefined, true)
  const handle = await f.create()
  const memory = f.graph.source('runtime')
  try {
    await f.turn(handle.agent)
    const generation = handle.agent.session.surface.contentGeneration
    let fact = 'Synthetic turn-view retained fact.'
    for (let revision = 1; revision <= 5; revision++) {
      const before = f.requests.at(-1)!
      const nextRequest = f.requests.length
      const correction = `Synthetic corrected fact ${revision}.`
      await memory.mutate('mutate', { action: 'replace', target: 'memory', oldText: fact, content: correction })
      fact = correction
      await f.turn(handle.agent)
      const corrected = f.requests[nextRequest]!
      expect(corrected.messages.slice(0, before.messages.length)).toEqual(before.messages)
      expect(corrected.tools).toEqual(before.tools)
      expect(snapshots(corrected.messages)).toHaveLength(revision + 1)
      expect(JSON.stringify(snapshots(corrected.messages).at(-1)?.content)).toContain(correction)
    }

    const beforeDelete = f.requests.at(-1)!
    const nextRequest = f.requests.length
    await memory.mutate('mutate', { action: 'remove', target: 'memory', oldText: fact })
    await f.turn(handle.agent)
    const deleted = f.requests[nextRequest]!
    expect(deleted.messages.slice(0, beforeDelete.messages.length)).toEqual(beforeDelete.messages)
    expect(deleted.tools).toEqual(beforeDelete.tools)
    expect(snapshots(deleted.messages)).toHaveLength(7)
    expect(JSON.stringify(snapshots(deleted.messages).at(-1)?.content)).toContain('<runtime-memory-file name=\\"MEMORY.md\\">\\n(empty)')
    expect(handle.agent.session.surface.contentGeneration).toBe(generation)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'developer/message' && event.data.message.source.kind === 'dsh-mnemon')).toHaveLength(0)
  } finally { await handle.dispose(); await f.close() }
})

it.runIf(supportsSnapshotCompaction)('filters Runtime before a manual checkpoint even before the correction was appended', async () => {
  const f = await fixture('native', true, undefined, true)
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    await f.turn(handle.agent)
    await f.graph.source('runtime').mutate('mutate', {
      action: 'replace', target: 'memory', oldText: 'Synthetic turn-view retained fact.', content: 'Synthetic corrected before compaction.',
    })
    const result = await f.compactionContext.compaction.compactNow(handle.agent, new AbortController().signal)
    expect(result).not.toBeNull()
    const summaryRequests = f.requests.filter(request => request.purpose === 'compaction')
    expect(summaryRequests).toHaveLength(1)
    expect(summaryRequests[0]!.text).not.toContain('Synthetic turn-view retained fact.')
    expect(summaryRequests[0]!.text).not.toContain('Synthetic corrected before compaction.')
    expect(summaryRequests[0]!.text).toContain('Read synthetic memory status and documents.')
    expect(summaryRequests[0]!.text).toContain('MNEMON VIEW TOOLS')
    await f.turn(handle.agent)
    const after = f.requests.at(-1)!
    expect(snapshots(after.messages)).toHaveLength(1)
    expect(after.text).toContain('Synthetic corrected before compaction.')
    expect(after.text).not.toContain('Synthetic turn-view retained fact.')
    expect(handle.agent.session.snapshotEvents().some(event =>
      event.type === 'user/message' && JSON.stringify(event.data.content).includes('Synthetic turn-view retained fact.'))).toBe(true)
  } finally { await handle.dispose(); await f.close() }
})

it.runIf(supportsSnapshotCompaction)('retires an entry whose scope changes even on the same Git branch', async () => {
  const f = await fixture('native', true, undefined, true)
  execFileSync('git', ['init', '--quiet', '-b', 'main', f.workspace])
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    await f.graph.source('runtime').mutate('mutate', {
      action: 'replace', target: 'memory', oldText: 'Synthetic turn-view retained fact.',
      content: 'Synthetic turn-view retained fact.', branches: ['restricted'],
    })
    await f.turn(handle.agent)
    for (const request of f.requests.slice(3)) {
      expect(request.text).not.toContain('Synthetic turn-view retained fact.')
      expect(snapshots(request.messages)).toHaveLength(1)
    }
  } finally { await handle.dispose(); await f.close() }
})

it.runIf(supportsSnapshotCompaction)('restores the current Runtime snapshot when compaction lands during request routing', async () => {
  const f = await fixture('native', true, undefined, true)
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    const session = handle.agent.session
    const snapshotSeq = session.surface.nodes.find(seq => {
      const event = session.eventAt(seq)
      return event?.type === 'user/message' && event.data.source.kind === 'dsh-mnemon' && event.data.source.form === 'memory-snapshot'
    })!
    const lastReply = session.surface.nodes.findLast(seq => session.eventAt(seq)?.type === 'assistant/message')!
    let compacted = false
    f.ctx.on('agent/request', async (request, next) => {
      const route = await next()
      if (!compacted && request.agent === handle.agent) {
        compacted = true
        await f.compactionContext.compaction.compactRegion(snapshotSeq, lastReply, handle.agent, request.signal)
      }
      return route
    })
    await f.turn(handle.agent)
    const summary = f.requests.find(request => request.purpose === 'compaction')!
    expect(summary.text).not.toContain('Synthetic turn-view retained fact.')
    const after = f.requests.filter(request => request.purpose !== 'compaction').slice(3)
    for (const request of after) {
      expect(snapshots(request.messages)).toHaveLength(1)
      expect(request.text).toContain('Synthetic turn-view retained fact.')
    }
    expect(session.surface.nodes).not.toContain(snapshotSeq)
  } finally { await handle.dispose(); await f.close() }
})

it.runIf(supportsSnapshotCompaction)('filters eager and BM25 memory together before a manual checkpoint', async () => {
  const f = await fixture('native', true, { bm25Recall: true }, true)
  const handle = await f.create()
  try {
    const runtime = f.graph.source('runtime')
    const old = 'Comet runs on the amber queue.'
    const removed = 'Comet uses the secret cobalt queue.'
    const corrected = 'Comet runs on the violet queue.'
    const profile = 'Prefer the synthetic profile setting.'
    await runtime.mutate('mutate', { action: 'add', target: 'user', content: profile })
    await runtime.mutate('mutate', { action: 'add', target: 'memory', content: old })
    await runtime.mutate('mutate', { action: 'add', target: 'memory', content: removed })
    await f.turn(handle.agent, false, 'Comet')
    await f.turn(handle.agent, false, 'Read synthetic memory status and documents.')
    expect(f.requests[0]!.text).toContain(old)
    expect(f.requests[0]!.text).toContain(removed)
    expect(f.requests[0]!.text).toContain(profile)
    await runtime.mutate('mutate', { action: 'replace', target: 'memory', oldText: old, content: corrected })
    await runtime.mutate('mutate', { action: 'remove', target: 'memory', oldText: removed })

    expect(await f.compactionContext.compaction.compactNow(handle.agent, new AbortController().signal)).not.toBeNull()
    const summary = f.requests.find(request => request.purpose === 'compaction')!
    const summaryInput = JSON.stringify(summary.messages)
    for (const fact of [old, removed, corrected, profile]) expect(summaryInput).not.toContain(fact)
    expect(bm25Messages(summary.messages)).toHaveLength(0)
    expect(summary.text).toContain('Read synthetic memory status and documents.')
    expect(summary.text).toContain('MNEMON VIEW TOOLS')

    await f.turn(handle.agent, false, 'Comet')
    const after = f.requests.at(-1)!
    expect(after.text).toContain(corrected)
    expect(after.text).toContain(profile)
    expect(after.text).not.toContain(old)
    expect(after.text).not.toContain(removed)
    expect(snapshots(after.messages)).toHaveLength(1)
  } finally { await handle.dispose(); await f.close() }
})

for (const revoke of [false, true]) {
  it.runIf(supportsSnapshotCompaction)(`revalidates both memory projections during request compaction (revoke: ${revoke})`, async () => {
    const f = await fixture('native', true, { bm25Recall: true }, true)
    const handle = await f.create()
    try {
      const runtime = f.graph.source('runtime')
      const hit = 'Kepler uses the synthetic quartz queue.'
      const profile = 'Use the synthetic Kepler profile.'
      await runtime.mutate('mutate', { action: 'add', target: 'user', content: profile })
      await runtime.mutate('mutate', { action: 'add', target: 'memory', content: hit })
      await f.turn(handle.agent, false, 'Kepler')
      expect(f.requests[0]!.text).toContain(hit)
      expect(f.requests[0]!.text).toContain(profile)
      const session = handle.agent.session
      const start = session.surface.nodes.find(seq => {
        const event = session.eventAt(seq)
        return event?.type === 'user/message' && event.data.source.kind === 'dsh-mnemon'
          && event.data.source.form === 'memory-snapshot'
      })!
      const end = session.surface.nodes.findLast(seq => session.eventAt(seq)?.type === 'assistant/message')!

      let compacted = false
      const stop = f.ctx.on('agent/request', async (request, next) => {
        const route = await next()
        if (!compacted && request.agent === handle.agent) {
          compacted = true
          if (revoke) {
            const topology = f.config.memoryTopology
            const layer = topology.layers.runtime!
            const config = resolveConfig({ ...f.config, memoryTopology: { ...topology, layers: { ...topology.layers,
              runtime: { ...layer, participation: { ...layer.participation, projection: 'off', recall: 'off' } } } } })
            f.live.swap(createRuntimeGraph(config, f.workspace, f.extensions))
          }
          expect(await f.compactionContext.compaction.compactRegion(start, end, handle.agent, request.signal)).not.toBeNull()
        }
        return route
      })
      try { await f.turn(handle.agent, false, 'Kepler') } finally { stop() }
      const summary = f.requests.find(request => request.purpose === 'compaction')!
      expect(JSON.stringify(summary.messages)).not.toContain(hit)
      expect(JSON.stringify(summary.messages)).not.toContain(profile)
      const after = f.requests.slice(3).filter(request => request.purpose !== 'compaction')
      expect(after.length).toBeGreaterThan(0)
      for (const request of after) {
        expect(request.text.includes(hit)).toBe(!revoke)
        expect(request.text.includes(profile)).toBe(!revoke)
      }
      if (revoke) {
        await f.turn(handle.agent, false, 'Kepler')
        expect(f.requests.at(-1)!.text).not.toContain(hit)
        expect(f.requests.at(-1)!.text).not.toContain(profile)
      }
    } finally { await handle.dispose(); await f.close() }
  })
}

it.runIf(supportsSnapshotCompaction)('excludes a revoked View from compaction before another turn begins', async () => {
  const f = await fixture('native', true, undefined, true)
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    await f.turn(handle.agent)
    const next = resolveConfig({ ...f.config, memoryTopology: { ...f.config.memoryTopology,
      layers: { ...f.config.memoryTopology.layers, runtime: { ...f.config.memoryTopology.layers.runtime,
        participation: { ...f.config.memoryTopology.layers.runtime!.participation, projection: 'off' } } } } })
    f.live.swap(createRuntimeGraph(next, f.workspace, f.extensions))
    expect(await f.compactionContext.compaction.compactNow(handle.agent, new AbortController().signal)).not.toBeNull()
    const summary = f.requests.find(request => request.purpose === 'compaction')!
    expect(summary.text).not.toContain('Synthetic turn-view retained fact.')
    expect(summary.text).toContain('Read synthetic memory status and documents.')
    await f.turn(handle.agent)
    expect(f.requests.at(-1)!.text).not.toContain('Synthetic turn-view retained fact.')
  } finally { await handle.dispose(); await f.close() }
})

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

it('freezes open-session snapshots under snapshotRefresh=session-start while new sessions and live tools see updates', async () => {
  const f = await fixture('native', true, { snapshotRefresh: 'session-start', deferLowPriority: true })
  const createNamed = (id: string) => f.ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd: f.workspace },
    agentOptions: { provider: 'fixture', model: 'fixture' },
  })
  let sessionA = await createNamed('freeze-session-a')
  let sessionB = await createNamed('freeze-session-b')
  let sessionC: Awaited<ReturnType<typeof createNamed>> | undefined
  try {
    await f.turn(sessionA.agent)
    await f.turn(sessionB.agent)
    const initialA = f.requests.filter(request => request.sessionId === 'freeze-session-a')
    const initialB = f.requests.filter(request => request.sessionId === 'freeze-session-b')
    const generationA = sessionA.agent.session.surface.contentGeneration
    const generationB = sessionB.agent.session.surface.contentGeneration
    expect(snapshots(initialA.at(-1)!.messages)).toHaveLength(1)
    expect(snapshots(initialB.at(-1)!.messages)).toHaveLength(1)

    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic cross-session addition.' })
    await f.graph.source('runtime').mutate('mutate', {
      action: 'replace', target: 'memory', oldText: 'Synthetic turn-view retained fact.', content: 'Synthetic replaced retained fact.',
    })
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic deferred low note.', importance: 'low' })

    await f.turn(sessionA.agent)
    const liveReads: string[] = []
    const stopRead = f.ctx.on('tools/execute', async (execution, next) => {
      const result = await next()
      if (execution.agent?.id === 'freeze-session-b' && execution.name === 'mnemon_status') {
        const search = await executeTool(sessionB.agent.ctx, {
          agent: sessionB.agent,
          signal: new AbortController().signal,
          callId: ToolCallId('freeze-live-runtime-search'),
          name: 'mnemon_view_route',
          arguments: { routeId: 'source:mnemon-source-runtime/search', input: { query: 'Synthetic' } },
        })
        expect(search.isError).toBe(false)
        liveReads.push(JSON.stringify(search.content))
      }
      return result
    })
    try { await f.turn(sessionB.agent) } finally { stopRead() }
    expect(liveReads).toHaveLength(1)
    expect(liveReads[0]).toContain('Synthetic cross-session addition.')
    expect(liveReads[0]).toContain('Synthetic replaced retained fact.')
    expect(liveReads[0]).toContain('Synthetic deferred low note.')
    const afterA = f.requests.filter(request => request.sessionId === 'freeze-session-a')
    const afterB = f.requests.filter(request => request.sessionId === 'freeze-session-b')
    expect(snapshots(afterA.at(-1)!.messages)).toEqual(snapshots(initialA.at(-1)!.messages))
    expect(snapshots(afterB.at(-1)!.messages)).toEqual(snapshots(initialB.at(-1)!.messages))
    expect(afterA[3]!.messages.slice(0, initialA.at(-1)!.messages.length)).toEqual(initialA.at(-1)!.messages)
    expect(afterB[3]!.messages.slice(0, initialB.at(-1)!.messages.length)).toEqual(initialB.at(-1)!.messages)
    expect(sessionA.agent.session.surface.contentGeneration).toBe(generationA)
    expect(sessionB.agent.session.surface.contentGeneration).toBe(generationB)
    expect(sessionA.agent.session.snapshotEvents().filter(event => event.type === 'developer/message' && event.data.message.source.kind === 'dsh-mnemon' && event.data.message.source.form === 'memory-snapshot-retired')).toHaveLength(0)
    expect(sessionB.agent.session.snapshotEvents().filter(event => event.type === 'developer/message' && event.data.message.source.kind === 'dsh-mnemon' && event.data.message.source.form === 'memory-snapshot-retired')).toHaveLength(0)

    await sessionB.dispose()
    sessionB = await f.ctx.agents.resume({ resumeSessionId: SessionId('freeze-session-b'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    await f.turn(sessionB.agent)
    const resumedB = f.requests.filter(request => request.sessionId === 'freeze-session-b')
    expect(snapshots(resumedB.at(-1)!.messages)).toEqual(snapshots(initialB.at(-1)!.messages))

    sessionC = await createNamed('freeze-session-c')
    await f.turn(sessionC.agent)
    const initialC = f.requests.filter(request => request.sessionId === 'freeze-session-c')
    expect(snapshots(initialC.at(-1)!.messages)).toHaveLength(1)
    expect(initialC[0]!.text).toContain('Synthetic cross-session addition.')
    expect(initialC[0]!.text).toContain('Synthetic replaced retained fact.')
    expect(initialC[0]!.text).not.toContain('Synthetic turn-view retained fact.')

    f.live.swap(createRuntimeGraph(resolveConfig({
      ...f.config,
      runtimeMemory: { ...f.config.runtimeMemory, snapshotRefresh: 'on-change', deferLowPriority: true },
    }), f.workspace, f.extensions))
    await f.turn(sessionA.agent)
    const refreshedA = f.requests.filter(request => request.sessionId === 'freeze-session-a')
    expect(refreshedA.at(-1)!.text).toContain('Synthetic replaced retained fact.')
    expect(refreshedA.at(-1)!.text).toContain('Synthetic cross-session addition.')
    expect(refreshedA.at(-1)!.text).not.toContain('Synthetic turn-view retained fact.')
  } finally {
    await sessionC?.dispose()
    await sessionB.dispose()
    await sessionA.dispose()
    await f.close()
  }
}, 20_000)

it('keeps session-start frozen snapshots intact when Project Documents or Memory Spaces change while live tools see updates', async () => {
  const f = await fixture('native', true, { snapshotRefresh: 'session-start' })
  const firstSpace = await f.memorySpace()
  const handle = await f.create()
  try {
    await f.turn(handle.agent)
    const initialRequests = [...f.requests]
    const initialGeneration = handle.agent.session.surface.contentGeneration
    expect(snapshots(initialRequests.at(-1)!.messages)).toHaveLength(1)

    await f.graph.source('documents').mutate('mutate', {
      action: 'create', title: 'Synthetic idle review note', content: 'Synthetic document created after session start.',
    })
    const spaces = f.graph.source('memory-spaces')
    const secondSpace = await spaces.mutate<{ id: string }>('body-create', {
      name: 'Synthetic second space', description: 'Synthetic catalog addition.',
      providerId: 'holographic', active: true, connection: { dataPath: join(f.root, 'second-routed-facts.json') },
    })
    expect(secondSpace.id).not.toBe(firstSpace.id)
    await spaces.mutate('body-update', {
      memoryBodyId: secondSpace.id, description: 'Synthetic updated space description.',
    })

    const beforeReceipts = f.receipts.length
    await f.turn(handle.agent)
    const afterRequests = [...f.requests]
    const searchReceipt = f.receipts.slice(beforeReceipts).find(receipt => receipt.name === 'mnemon_document_search')
    expect(searchReceipt?.isError).toBe(false)
    expect(searchReceipt?.text).toContain('Synthetic idle review note')
    expect(snapshots(afterRequests.at(-1)!.messages)).toEqual(snapshots(initialRequests.at(-1)!.messages))
    expect(afterRequests[3]!.messages.slice(0, initialRequests.at(-1)!.messages.length)).toEqual(initialRequests.at(-1)!.messages)
    expect(handle.agent.session.surface.contentGeneration).toBe(initialGeneration)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'developer/message' && event.data.message.source.kind === 'dsh-mnemon' && event.data.message.source.form === 'memory-snapshot-retired')).toHaveLength(0)

    await spaces.mutate('body-update', { memoryBodyId: firstSpace.id, active: false })
    await f.turn(handle.agent)
    const afterScopeChange = handle.agent.session.surface.contentGeneration
    expect(afterScopeChange).toBeGreaterThan(initialGeneration)

    await spaces.mutate('body-update', { memoryBodyId: secondSpace.id, active: false })
    await f.turn(handle.agent)
    expect(handle.agent.session.surface.contentGeneration).toBeGreaterThan(afterScopeChange)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'developer/message' && event.data.message.source.kind === 'dsh-mnemon' && event.data.message.source.form === 'memory-snapshot-retired').length).toBeGreaterThan(0)
  } finally {
    await handle.dispose()
    await f.close()
  }
}, 20_000)

it.runIf(supportsSnapshotCompaction)('refreshes a frozen snapshot left in the surface by stock DSH compaction', async () => {
  const f = await fixture('native', true, { snapshotRefresh: 'session-start' })
  try {
    await f.ctx.plugin((await import(requireDsh.resolve('@deepseek-ai/dsh-token-meter'))).default)
    const { BasicCompactionEngine } = await import(requireDsh.resolve('@deepseek-ai/dsh-compaction-basic'))
    await f.compactionContext.plugin(BasicCompactionEngine, { auto: false, retainTokens: 50 })
    const handle = await f.create()
    try {
      await f.turn(handle.agent)
      await f.turn(handle.agent, false, 'Second synthetic user turn.')
      const session = handle.agent.session
      const snapshotSeq = session.surface.nodes.find(seq => {
        const event = session.eventAt(seq)
        return event?.type === 'user/message' && event.data.source.kind === 'dsh-mnemon' && event.data.source.form === 'memory-snapshot'
      })!
      const laterUser = session.surface.nodes.find(seq => seq > snapshotSeq && session.eventAt(seq)?.type === 'user/message')!
      const lastReply = session.surface.nodes.findLast(seq => session.eventAt(seq)?.type === 'assistant/message')!
      await f.graph.source('runtime').mutate('mutate', { action: 'replace', target: 'memory',
        oldText: 'Synthetic turn-view retained fact.', content: 'Synthetic fact after checkpoint.' })
      let compacted = false
      const stop = f.ctx.on('agent/request', async (request, next) => {
        const route = await next()
        if (!compacted && request.agent === handle.agent) {
          compacted = true
          await f.compactionContext.compaction.compactRegion(laterUser, lastReply, handle.agent, request.signal)
          expect(session.surface.nodes).toContain(snapshotSeq)
        }
        return route
      })
      try { await f.turn(handle.agent) } finally { stop() }
      expect(compacted).toBe(true)
      const after = f.requests.at(-1)!
      expect(snapshots(after.messages)).toHaveLength(1)
      expect(after.text).toContain('Synthetic fact after checkpoint.')
      expect(after.text).not.toContain('Synthetic turn-view retained fact.')
    } finally { await handle.dispose() }
  } finally { await f.close() }
})
