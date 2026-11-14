import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import * as cordis from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as store from '@deepseek-ai/dsh-client-store'
import type { ConversationNodeAssembler, ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import * as reactDom from 'react-dom'
import { describe, expect, it, vi } from 'vitest'
import * as zod from 'zod'
import { retiredMemorySnapshot } from '../src/client/retired-memory-snapshot.ts'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { dsh021, executeTool, loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))
const fork = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-fork-in-process'))
const sessionApi = await import(requireDsh.resolve('@deepseek-ai/dsh-session'))
const format = await import(requireDsh.resolve('@deepseek-ai/dsh-session-format-v3-to-v4'))
const ptc = await import(requireDsh.resolve('@deepseek-ai/dsh-ptc-runtime-node'))
const ptcServices = await Promise.all(['dsh-fs-local', 'dsh-subprocess-local', 'dsh-sandbox-local', 'dsh-sandbox-policy']
  .map(name => import(requireDsh.resolve(`@deepseek-ai/${name}`))))

describe('idle review tool access host', () => {
async function fixture(provider: 'spawn' | 'fork' = 'spawn', persistWatermark = false, codeMode = false, autoReview = false, publicationWrites = false) {
  const f = await compositionFixture({ idleReviewMs: 5_000, idleReview: { provider, persistWatermark, minIntervalMs: 5_000, maxPerSession: 2 } })
  const body = publicationWrites ? await f.memorySpace() : undefined
  const ctx = new Context()
  const modelCalls: string[] = []
  const children: string[] = []
  let foregroundCall = false
  let foregroundExecutions = 0
  let preset = 'danger-full-access'
  class Model extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      modelCalls.push(String(options.sessionId))
      if (autoReview && options.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.startsWith('ENVIRONMENT\n')))) {
        const text = '{"risk":"low","decision":"allow"}'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (String(options.sessionId) === 'parent-denied' && foregroundCall) {
        foregroundCall = false
        const name = codeMode ? 'run_code' : 'fixture_echo'
        const args = JSON.stringify(codeMode ? { code: 'return await tools.fixture_echo({})', description: 'Synthetic foreground action' } : {})
        const id = `foreground-${modelCalls.length}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (String(options.sessionId) !== 'parent-denied' && (publicationWrites || !options.messages.some(message => message.role === 'tool'))) {
        const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
        const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
        const ptc = options.tools?.some(tool => tool.name === 'run_code') && !options.tools?.some(tool => tool.name === 'mnemon_subagent_result')
        const write = JSON.stringify(options.messages).includes('[dsh-mnemon:delegated write]')
        const mutation = !publicationWrites || options.messages.some(message => message.role === 'tool') ? undefined : write
          ? { name: 'mnemon_remember', input: { memoryBodyId: body!.id, content: 'Synthetic publication-safe memory.' } }
          : { name: 'mnemon_runtime_memory', input: { action: 'add', target: 'memory', content: 'Synthetic publication-safe runtime.' } }
        const tool = mutation?.name ?? 'mnemon_subagent_result'
        const name = ptc ? 'run_code' : tool
        const id = (publicationWrites ? `fixture-result-${modelCalls.length}` : 'fixture-result') as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
        const result = { requestId, result: { action: !publicationWrites ? 'skipped' : write ? 'stored' : 'added', summary: 'Synthetic review completed.', memoryBodyIds: publicationWrites && write ? [body!.id] : [], documentIds: [] } }
        const input = mutation?.input ?? result
        const args = JSON.stringify(ptc ? { code: `await tools.${tool}(${JSON.stringify(input)})`, description: 'Complete synthetic review' } : input)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Synthetic project decision acknowledged.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic project decision acknowledged.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
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
  ctx.llm.registerAdapter(['fixture'], new Model())
  ctx.tools.register({ name: 'fixture_echo', description: 'Synthetic read-only foreground check.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
    async execute() { foregroundExecutions++; return {} } })
  if (autoReview) {
    // Use the published Auto reviewer and real durable call history. Only its
    // preset selection and risk-model output are deterministic local fixtures.
    ctx.provide('permissionPresets', { current: () => preset, set: () => { preset = 'danger-full-access' }, registerAuto: () => () => undefined })
    ctx.provide('approval', { overrideOf: () => 'never' })
    await ctx.plugin(await import(requireDsh.resolve('@deepseek-ai/dsh-experimental-auto-review')))
  }
  ctx.on('agent/created', ({ agent }) => { if (String(agent.id) !== 'parent-denied') children.push(agent.id); return undefined })
  if (publicationWrites) ctx.on('agent/created', (({ agent }: { agent: HostAgent }) => agent.session.header?.origin === 'subagent' ? 1 : undefined) as never)
  const host = ctx as unknown as HostContextShape
  const coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
  const stopTools = registerTools(host, f.live, coordinator, f.extensions)
  const lifecycle = new MnemonLifecycle(host, coordinator, f.live.config, f.live)
  const stop = lifecycle.start()
  const parent = await ctx.agentLoop.create(SessionId('parent-denied'), { provider: 'fixture', model: 'synthetic' }, { cwd: f.workspace })
  if (codeMode) await selectPtc(parent.ctx)
  const turn = async () => {
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Please remember this project decision: ' + 'Checkpoints stay in SQLite. '.repeat(20) }] }))
    await parent.whenIdle()
  }
  const duringStep = async (run: () => Promise<void>) => {
    const stop = parent.ctx.on('agent/request', async (_payload, next) => { await run(); return next() }, { prepend: true })
    try { await turn() } finally { stop() }
  }
  return { ...f, ctx, coordinator, lifecycle, parent, turn, duringStep, modelCalls, children, body,
    enableAuto: () => { preset = 'auto' },
    foreground: async () => { foregroundCall = true; await turn(); return foregroundExecutions },
    async close() {
    stop(); stopTools(); coordinator.dispose(); vi.useRealTimers(); await ctx.fiber.dispose(); await f.dispose()
  } }
}

async function assertReloadable(f: Awaited<ReturnType<typeof fixture>>) {
  const session = f.parent.session
  const header = { ...session.header, delegationDepth: session.header.delegationDepth ?? 0 }
  const events = session.snapshotEvents()
  let openStep = false
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/end') openStep = false
    if (event.type === 'step/start') openStep = true
    if (event.type === 'tool/ptc-dispatch-start') expect(openStep, 'PTC dispatch must have an owning step (issue 602)').toBe(true)
  }
  format.restoreReleasedV4Artifact({ header, inheritedEventCount: 0, events }, sessionApi.KNOWN_SESSION_EVENT_TYPES)
  // Exercise the actual persisted reader too: an empty surface assertion
  // misses invalid PTC audit records, which can reject the entire history.
  const reader = new Context()
  await reader.plugin(JsonlSessionPersistence, { root: join(f.root, 'reload'), compression: 'none' })
  try {
    const writer = await reader.sessionPersistence.create(header)
    try { await writer.append(events); await writer.flush() } finally { await writer.close() }
    const handle = await reader.sessionPersistence.open(session.id, 'read')
    try { expect((await handle.read()).events).toEqual(events) } finally { await handle.close() }
  } finally { await reader.fiber.dispose() }
}

// Cordis serial publication stops on a non-null/false/undefined return. A
// plugin's accidental `return array.push(agent)` must not skip Mnemon's guard.
it.each([
  { purpose: 'review', provider: 'spawn', codeMode: false },
  { purpose: 'review', provider: 'fork', codeMode: false },
  { purpose: 'review', provider: 'spawn', codeMode: true },
  { purpose: 'write', provider: 'spawn', codeMode: false },
  { purpose: 'write', provider: 'spawn', codeMode: true },
] as const)('installs $purpose setup before a bailing creation observer ($provider, PTC=$codeMode, issue 629)', async ({ purpose, provider, codeMode }) => {
  const f = await fixture(provider, false, codeMode, false, true)
  try {
    f.live.config.idleReview.enabled = false
    await f.turn()
    f.live.config.idleReview.runtimeMemory = true
    const agent = f.parent as unknown as HostAgent
    const signal = new AbortController().signal
    const result = purpose === 'review'
      ? await f.coordinator.review(agent, signal)
      : await f.coordinator.remember(agent, { content: 'Synthetic durable decision.' }, signal)
    expect(result).toMatchObject({ delegated: true, action: purpose === 'write' ? 'stored' : 'added' })
    if (purpose === 'review') expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [expect.objectContaining({ content: 'Synthetic publication-safe runtime.' })] })
    else expect(await f.graph.source('memory-spaces').read('list', { memoryBodyIds: [f.body!.id] })).toMatchObject({ items: [expect.objectContaining({ content: 'Synthetic publication-safe memory.' })] })
    expect(f.children).toHaveLength(1)
    expect(f.modelCalls).toContain(f.children[0])
    expect(f.ctx.agents.get(SessionId(f.children[0]!))).toBeUndefined()
  } finally { await f.close() }
}, 20_000)


it('completes automatic idle review despite a bailing creation observer (issue 629)', async () => {
  const f = await fixture('spawn', false, false, false, true)
  try {
    f.live.config.idleReview.runtimeMemory = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await f.turn()
    await f.turn()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(f.coordinator.snapshot().reviews).toBe(1), { timeout: 10_000 })
    expect(f.lifecycle.snapshot('parent-denied').current).toMatchObject({ reviewRunning: false, lastReviewAction: 'added' })
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [expect.objectContaining({ content: 'Synthetic publication-safe runtime.' })] })
    expect(f.children).toHaveLength(1)
    await assertReloadable(f)
  } finally { await f.close() }
}, 20_000)

it('keeps a completed PTC conversation loadable after automatic review', async () => {
  const f = await fixture('spawn', false, true)
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await f.turn()
    await f.turn()
    const closed = f.parent.session.snapshotEvents()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(f.parent.session.snapshotEvents().some(event => event.type === 'tool/ptc-dispatch')).toBe(true), { timeout: 10_000 })
    await vi.waitFor(() => expect(f.coordinator.snapshot().reviews).toBe(1), { timeout: 10_000 })
    await assertReloadable(f)
    expect(f.parent.session.snapshotEvents().filter(event => event.type.startsWith('tool/'))).toEqual(closed.filter(event => event.type.startsWith('tool/')))
  } finally { await f.close() }
}, 20_000)

it.each([false, true])('recovers admission in a later real step without bypassing guards (PTC=%s, issue 635)', async codeMode => {
  const f = await fixture('spawn', true, codeMode)
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await f.turn()
    const before = f.modelCalls.length
    // Simulate a restored executor/preset becoming usable after its first request.
    f.parent.ctx.tools.guard(exec => f.modelCalls.length === before && exec.name.startsWith('mnemon_') ? 'Synthetic temporarily unavailable admission.' : undefined)
    await f.foreground()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(f.coordinator.snapshot().reviews).toBe(1))
    expect(f.lifecycle.snapshot('parent-denied').current).toMatchObject({ idleReviewAttempts: 1 })
    await assertReloadable(f)
  } finally { await f.close() }
}, 20_000)

it('reports bounded admission diagnostics through mnemon_status without private errors (issue 635)', async () => {
  const f = await fixture()
  try {
    f.live.config.idleReview.enabled = false
    const agent = f.parent as unknown as HostAgent
    expect(f.coordinator.reviewAccessStatus(agent)).toEqual({ state: 'unchecked' })
    await f.duringStep(async () => {
      const stop = f.parent.ctx.on('tools/execute', async (exec, next) => {
        if (exec.name === 'mnemon_subagent_result') throw new Error('SYNTHETIC_PRIVATE_ERROR_DO_NOT_RETURN')
        return next()
      })
      expect(await f.coordinator.checkReviewAccess(agent, new AbortController().signal)).toBe(false)
      stop()
      const status = await executeTool(f.parent.ctx, { agent: f.parent, callId: ToolCallId('review-diagnostic'), name: 'mnemon_status', arguments: {}, signal: new AbortController().signal })
      expect(status).toMatchObject({ isError: false, value: { idleReviewAccess: { state: 'unavailable', reason: 'execution-error', checkedAt: expect.any(String) } } })
      expect(JSON.stringify(status)).not.toContain('SYNTHETIC_PRIVATE_ERROR')
      expect(await f.coordinator.checkReviewAccess(agent, new AbortController().signal)).toBe(true)
      expect(f.coordinator.reviewAccessStatus(agent)).toEqual({ state: 'available', checkedAt: expect.any(String) })
    })
  } finally { await f.close() }
})

it('never executes an admission probe outside a real open turn', async () => {
  const f = await fixture('spawn', false, true)
  try {
    const before = f.parent.session.snapshotEvents()
    expect(await f.coordinator.checkReviewAccess(f.parent as unknown as HostAgent, new AbortController().signal)).toBe(false)
    expect(f.coordinator.reviewAccessStatus(f.parent as unknown as HostAgent)).toMatchObject({ state: 'unavailable', reason: 'no-open-step' })
    expect(f.parent.session.snapshotEvents()).toEqual(before)
    expect(f.modelCalls).toEqual([])
  } finally { await f.close() }
})


it.each([false, true])('never probes between step/end and turn/end (PTC=%s)', async codeMode => {
  const f = await fixture('spawn', false, codeMode)
  try {
    f.live.config.idleReview.enabled = false
    let checked = false
    f.parent.ctx.on('agent/turn-stopping', async () => {
      const before = f.parent.session.snapshotEvents()
      expect(before.at(-1)?.type).toBe('step/end')
      expect(await f.coordinator.checkReviewAccess(f.parent as unknown as HostAgent, new AbortController().signal)).toBe(false)
      expect(f.parent.session.snapshotEvents()).toEqual(before)
      checked = true
    })
    await f.turn()
    expect(checked).toBe(true)
    await assertReloadable(f)
  } finally { await f.close() }
})

const hasAutoReview = (() => { try { requireDsh.resolve('@deepseek-ai/dsh-experimental-auto-review'); return true } catch { return false } })()
it.skipIf(!hasAutoReview).each([false, true])('keeps foreground tools usable after switching to published Auto review (PTC=%s)', async codeMode => {
  const f = await fixture('spawn', false, codeMode, true)
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await f.turn()
    await f.turn()
    f.enableAuto()
    expect(await f.foreground(), JSON.stringify(f.parent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data))).toBe(1)
    expect(await f.foreground()).toBe(2)
    await assertReloadable(f)
  } finally { await f.close() }
})

it('drains a timed-out PTC audit event before allowing step/end', async () => {
  const f = await fixture('spawn', false, true)
  let release: (() => void) | undefined
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await f.turn()
    f.parent.ctx.on('tools/ptc-dispatch-log', async (_dispatch, next) => {
      await new Promise<void>(resolve => { release = resolve })
      return next()
    })
    const stopping = f.turn()
    await vi.waitFor(() => expect(release).toBeDefined())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.parent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(1)
    release?.()
    await stopping
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.children).toEqual([])
    expect(f.lifecycle.snapshot('parent-denied').current).toMatchObject({ idleReviewAttempts: 0, idleReviewBlocked: 'tool-access' })
    await assertReloadable(f)
  } finally { release?.(); await f.close() }
}, 20_000)

// Removing execution-time admission would create one child per eligible turn
// even though get()/schema still expose every tool, as in issue #525.
const guardedCases = ([
  { provider: 'spawn', persist: false }, { provider: 'spawn', persist: true },
  { provider: 'fork', persist: false }, { provider: 'fork', persist: true },
] as const).flatMap(({ provider, persist }) => [false, true].map(codeMode => ({ provider, persist, codeMode })))
it.each(guardedCases)('does no model work under a session guard, then recovers ($provider, persist=$persist, PTC=$codeMode)', async ({ provider, persist, codeMode }) => {
  const f = await fixture(provider, persist, codeMode)
  try {
    let denied = true
    const guard = (exec: { name: string }) => denied && exec.name.startsWith('mnemon_') ? 'Synthetic policy response without permission keywords.' : undefined
    f.parent.ctx.tools.guard(guard)
    f.ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.guard(guard); return undefined })
    expect(f.parent.ctx.tools.get('mnemon_subagent_result', f.parent)).toBeDefined()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    for (let i = 0; i < 4; i++) {
      await f.turn(); await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(f.lifecycle.snapshot('parent-denied').current?.reviewRunning).toBe(false))
    }
    expect(f.children).toEqual([])
    expect(f.modelCalls).toEqual(['parent-denied', 'parent-denied', 'parent-denied', 'parent-denied'])
    expect(f.lifecycle.snapshot('parent-denied').current).toMatchObject({ idleReviewAttempts: 0, idleReviewBlocked: 'tool-access' })
    denied = false
    await f.turn(); await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(f.coordinator.snapshot().reviews).toBe(1))
    expect(f.children).toHaveLength(1)
    expect(f.lifecycle.snapshot('parent-denied').current?.idleReviewBlocked).toBeUndefined()
    expect(f.lifecycle.snapshot('parent-denied').current?.idleReviewAttempts).toBe(1)
    await assertReloadable(f)
  } finally { await f.close() }
}, 20_000)

// Success supplied by a wrapper cannot substitute for reaching Mnemon's own
// handler, and a post-policy rejection cannot be treated as permission.
it.each([false, true])('requires its exact handler and both authoritative tool outcomes (Code Mode=%s)', async codeMode => {
  const f = await fixture('spawn', false, codeMode)
  try {
    f.live.config.idleReview.enabled = false
    await f.duringStep(async () => {
      const agent = f.parent as unknown as HostAgent
      const signal = new AbortController().signal
      const schemas = JSON.stringify(f.parent.ctx.tools.schemas(f.parent))
      const surface = [...f.parent.session.surface.nodes]
      const shortcut = f.parent.ctx.on('tools/execute', async () => ({ isError: false, value: { recorded: true }, content: [] }))
      expect(await f.coordinator.checkReviewAccess(agent, signal)).toBe(false)
      shortcut()
      const post = f.parent.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'mnemon_subagent_result' ? { kind: 'block', feedback: [{ type: 'text', text: 'Synthetic post policy.' }] } : next())
      expect(await f.coordinator.checkReviewAccess(agent, signal)).toBe(false)
      if (codeMode) {
        const swallow = f.parent.ctx.on('tools/execute', async (exec, next) => {
          const result = await next()
          return exec.name === 'run_code' ? { isError: false, value: {}, content: [] } : result
        })
        expect(await f.coordinator.checkReviewAccess(agent, signal)).toBe(false)
        swallow()
      }
      post()
      const ask = f.parent.ctx.on('tools/pre-execute', async () => ({ kind: 'ask' }))
      expect(await f.coordinator.checkReviewAccess(agent, signal)).toBe(false)
      ask()
      const deny = f.parent.ctx.tools.guard(exec => exec.name.startsWith('mnemon_') ? 'Blocked without recognizable error text.' : undefined)
      expect(await f.coordinator.checkReviewAccess(agent, signal)).toBe(false)
      deny()
      expect(await f.coordinator.checkReviewAccess(agent, signal)).toBe(true)
      expect(f.children).toEqual([])
      expect(f.modelCalls).toEqual([])
      expect(f.parent.session.surface.nodes).toEqual(surface)
      expect(JSON.stringify(f.parent.ctx.tools.schemas(f.parent))).toBe(schemas)
    })
  } finally { await f.close() }
})

it('revokes a cancelled or timed-out challenge even when middleware ignores cancellation', async () => {
  const f = await fixture()
  try {
    f.live.config.idleReview.enabled = false
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await f.duringStep(async () => {
      const surface = [...f.parent.session.surface.nodes]
      let release: (() => void) | undefined
      let entered = false
      const stop = f.parent.ctx.on('tools/execute', async (_exec, next) => {
        entered = true
        await new Promise<void>(resolve => { release = resolve })
        return next()
    })
    const signal = new AbortController()
    const pending = f.coordinator.checkReviewAccess(f.parent as unknown as HostAgent, signal.signal)
    const cancelled = expect(pending).rejects.toBeDefined()
    await vi.waitFor(() => expect(entered).toBe(true))
    signal.abort()
    expect(await f.coordinator.checkReviewAccess(f.parent as unknown as HostAgent, new AbortController().signal)).toBe(false)
    release?.()
    await cancelled
    await vi.advanceTimersByTimeAsync(0)
    entered = false
    const timeout = f.coordinator.checkReviewAccess(f.parent as unknown as HostAgent, new AbortController().signal)
    await vi.waitFor(() => expect(entered).toBe(true))
    await vi.advanceTimersByTimeAsync(5_000)
    release?.()
    expect(await timeout).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    stop()
    expect(await f.coordinator.checkReviewAccess(f.parent as unknown as HostAgent, new AbortController().signal)).toBe(true)
    expect(f.modelCalls).toEqual([])
    expect(f.parent.session.surface.nodes).toEqual(surface)
    })
  } finally { await f.close() }
})
})

describe('review evidence host', () => {
  const foreignTool = 'mcp__aoci__aoci_overview'
  const chunks = Array.from({ length: 5 }, (_, chunk) => `COMPLETE_OVERVIEW_CHUNK_${chunk + 1}\n` + Array.from({ length: 67 }, (_, index) => `Synthetic module ${chunk * 67 + index + 1}: complete inherited index evidence.`).join('\n'))
  type Reply = string | { name: string; args: Record<string, unknown> }

  class ReviewAdapter extends LlmAdapter {
    private calls = 0
    constructor(private readonly respond: (options: GenerateOptions) => Reply) { super() }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const reply = this.respond(options)
      const id = `review-${++this.calls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
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

  it.each(['native', 'ptc'].flatMap(mode => ['fork', 'spawn'].map(provider => ({ mode, provider }))))('reuses checkpoint evidence and denies own-scope foreign execution with $provider in $mode mode', async ({ mode, provider }) => {
    const f = await compositionFixture()
    f.config.idleReview.provider = provider as 'fork' | 'spawn'
    const ctx = new Context()
    let stop: (() => void) | undefined
    const executions: string[] = []
    const childReceipts: Array<{ name: string | undefined; isError: boolean }> = []
    const children: Agent[] = []
    let parentCalls = 0
    let childCalls = 0
    let inheritedChunks = 0
    const attempted = Promise.withResolvers<void>()
    let providerReturned = false
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      if (mode === 'ptc') {
        for (const [index, service] of ptcServices.entries()) {
          await ctx.plugin(service.default, index === 0 ? { cwd: f.workspace } : index === 3 ? { mode: 'read-only', workspaceRoot: f.workspace } : {})
        }
        await ctx.plugin(ptc.default)
      }
      const selectPtc = await loadTools(ctx, mode === 'ptc' && !dsh021 ? 'both' : 'native')
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await loadWorkingDirectory(ctx)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(fork, { providerName: 'fork' })
      await ctx.plugin(spawn, { providerName: 'spawn' })
      ctx.llm.registerAdapter(['mock'], new ReviewAdapter(options => {
        if (options.sessionId === 'parent') return parentCalls < 5
          ? { name: foreignTool, args: { chunk: parentCalls++ } }
          : 'The complete overview is already in this checkpoint. No new durable user preference.'
        const system = options.system ?? JSON.stringify(options.messages.filter(message => message.role === 'system'))
        const terminal = system.match(/Completion protocol: call `([^`]+)`/u)?.[1]
        const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
        if (!terminal) throw new Error('review completion capability is missing')
        const call = (name: string, args: Record<string, unknown>): Reply => mode === 'native' ? { name, args } : {
          name: 'run_code', args: { description: 'Exercise the review boundary through Code Mode.', code: `return await tools[${JSON.stringify(name)}](${JSON.stringify(args)})` },
        }
        const step = childCalls++
        if (step === 0) {
          inheritedChunks = chunks.filter(chunk => JSON.stringify(options.messages).includes(JSON.stringify(chunk).slice(1, -1))).length
          return call(foreignTool, { chunk: 0 })
        }
        if (step === 1) return call('mnemon_document_search', { query: 'synthetic module overview', limit: 1 })
        const result = { summary: 'Complete inherited overview reviewed; no durable new assertion.', action: 'skipped', memoryBodyIds: [], documentIds: [] }
        return call(terminal, requestId === undefined ? result : { requestId, result })
      }))
      ctx.on('agent/created', async ({ agent }) => {
        if (agent.session.header.origin === 'subagent') {
          children.push(agent)
          if (mode === 'ptc') await selectPtc(agent.ctx)
        }
        agent.ctx.tools.register({
          name: foreignTool, description: 'Read one complete synthetic overview chunk.',
          parameters: { type: 'object', properties: { chunk: { type: 'integer', minimum: 0, maximum: 4 } }, required: ['chunk'], additionalProperties: false },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
          async execute(args) { executions.push(agent.id); return chunks[(args as { chunk: number }).chunk]! },
        })
      })
      ctx.on('tools/result', (execution, result) => {
        if (execution.agent?.session.header.origin === 'subagent') {
          childReceipts.push({ name: execution.name, isError: result.isError })
          if (execution.name === foreignTool) {
            expect(providerReturned).toBe(false)
            attempted.resolve()
          }
        }
      })
      const host = ctx as unknown as HostContextShape
      const holdBack = async <T extends { result: Promise<unknown>; dispose(): Promise<void> }>(started: Promise<T>): Promise<T> => {
        const run = await started
        try {
          await Promise.race([attempted.promise, run.result.then(() => { throw new Error('child completed before its foreign tool attempt') })])
        } catch (error) {
          await run.dispose()
          throw error
        }
        providerReturned = true
        return run
      }
      const service = {
        ...(typeof host.subagents.list === 'function' ? { list: () => host.subagents.list!() } : {}),
        ...(typeof host.subagents.rootOf === 'function' ? { rootOf: (agent: HostAgent) => host.subagents.rootOf!(agent) } : {}),
        getProvider: (name: string) => host.subagents.getProvider(name),
        ...(typeof host.subagents.start === 'function'
          ? { start: (...args: Parameters<NonNullable<typeof host.subagents.start>>) => holdBack(host.subagents.start!(...args)) }
          : {}),
        ...(typeof host.subagents.startActivation === 'function'
          ? { startActivation: (spec: Parameters<NonNullable<typeof host.subagents.startActivation>>[0]) => holdBack(host.subagents.startActivation!(spec)) }
          : {}),
      }
      const coordinator = new MnemonSubagentCoordinator(service, f.live, host)
      const lifecycle = new MnemonLifecycle(host, coordinator, f.config, f.live)
      registerTools(host, f.live, coordinator, f.extensions)
      stop = lifecycle.start()
      const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: f.workspace })
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the full synthetic overview once.' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      await coordinator.review(parent as unknown as HostAgent, new AbortController().signal)
      expect(inheritedChunks).toBe(5)
      expect(executions.filter(id => id === 'parent')).toHaveLength(5)
      expect(children).toHaveLength(1)
      expect(executions.filter(id => id !== 'parent')).toEqual([])
      expect(childReceipts.filter(receipt => receipt.name !== 'run_code')).toEqual([
        { name: foreignTool, isError: true },
        { name: 'mnemon_document_search', isError: false },
        { name: expect.stringMatching(/^mnemon_subagent_result(?:_|$)/u), isError: false },
      ])
      if (mode === 'ptc') expect(childReceipts.filter(receipt => receipt.name === 'run_code').map(receipt => receipt.isError)).toEqual([true, false, false])
      expect(coordinator.snapshot().reviews).toBe(1)
      const parentResult = await executeTool(ctx, { name: foreignTool, arguments: { chunk: 0 }, agent: parent,
        callId: 'after-review' as ToolExecutionInput['callId'], signal: new AbortController().signal })
      expect(parentResult.isError).toBe(false)
      expect(executions.filter(id => id === 'parent')).toHaveLength(6)
    } finally {
      stop?.()
      await ctx.fiber.dispose()
      await f.dispose()
    }
  }, 20_000)
})

describe('retired memory snapshot client projection', () => {
  const dependencies: Record<string, unknown> = {
    '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-store': store,
    '@deepseek-ai/dsh-client-ui-slots': slots, '@deepseek-ai/dsh-client-ui-primitives': primitives,
    react, 'react/jsx-runtime': jsx, 'react-dom': reactDom, zod,
  }
  let conversation!: typeof import('@deepseek-ai/dsh-client-ui-conversation/client')
  runInNewContext(readFileSync(requireDsh.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8'), {
    window: { __ModuleLoader__: { load(module: { factory: (require: (id: string) => unknown) => typeof conversation }) {
      conversation = module.factory(id => {
        if (!(id in dependencies)) throw new Error(`Undeclared browser test dependency: ${id}`)
        return dependencies[id]
      })
    } } },
    console,
  })

  type SessionEventLikeEntry = Parameters<ConversationNodeAssembler['append']>[0]

  function entry(seq: number, source: unknown = { kind: 'dsh-mnemon', form: 'memory-snapshot-retired' }, content: unknown = [], type = 'developer/message'): SessionEventLikeEntry {
    return { type: 'event', event: {
      seq, type, time: seq,
      data: { turn: 1, step: 1, message: { id: `message-${seq}`, role: 'developer', source, content } },
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0],
    } } as unknown as SessionEventLikeEntry
  }

  describe('retired memory snapshot presentation', () => {
    it.each([
      { kind: 'dsh-mnemon' }, { kind: 'plugin:dsh-mnemon' }, { kind: 'plugin', plugin: 'dsh-mnemon' },
    ])('recognizes only our empty retirement message: %j', source => {
      expect(retiredMemorySnapshot.match(entry(1, { ...source, form: 'memory-snapshot-retired' }).event))
        .toEqual({ id: 'message-1', role: 'start', exclusive: true })
    })

    it.each([
      entry(1, { kind: 'other', form: 'memory-snapshot-retired' }),
      entry(1, { kind: 'plugin', plugin: 'other', form: 'memory-snapshot-retired' }),
      entry(1, { kind: 'dsh-mnemon', form: 'memory-snapshot' }),
      entry(1, { kind: 'dsh-mnemon', form: 'recall' }),
      entry(1, { kind: 'dsh-mnemon', form: 'instructions' }),
      entry(1, null),
      entry(1, undefined, [{ type: 'text', text: 'Keep this message visible.' }]),
      entry(1, undefined, [{ type: 'text', text: '' }]),
      entry(1, undefined, undefined, 'user/message'),
    ])('preserves other producers, forms, roles and nonempty content (%#)', input => {
      expect(retiredMemorySnapshot.match(input.event)).toBeNull()
    })
  })

  function view(target: string): ConversationViewDefinition {
    return { target, create() {
      let nodes = new Map<string, ConversationViewNode>()
      return {
        empty: [],
        replace(input) { nodes = new Map(input.nodes.map(node => [node.key, node])); return [...nodes.values()] },
        apply(input) { for (const node of input.upserts) nodes.set(node.key, node); return [...nodes.values()] },
      }
    } }
  }

  describe.skipIf(typeof conversation.ConversationNodeAssembler !== 'function' || typeof conversation.ConversationEventRegistry !== 'function')('published conversation projection', () => {
    it.each(['before', 'after'])('suppresses generic Chat and fallback cards regardless of registration order (%s), retaining other targets', async order => {
      const ctx = new Context()
      try {
        const events = new conversation.ConversationEventRegistry(ctx)
        let stop: () => void = () => {}
        if (order === 'before') stop = events.register(retiredMemorySnapshot)
        const generic = (kind: string, target: string): ConversationNodeDefinition => ({
          kind, target,
          match: event => event.type === 'developer/message' ? { id: String(event.seq), role: 'start' } : null,
          start: (_context, match) => match.event,
          update: context => context.state,
          buildViewNode: context => ({ key: context.key, kind, id: context.id, target, data: context.state }),
        })
        const stopGeneric = events.register(generic('generic-developer', 'chat'))
        events.registerFallback(generic('unknown-context', 'chat'))
        events.register(generic('audit-message', 'audit'))
        if (order === 'after') stop = events.register(retiredMemorySnapshot)
        const views = [view('chat'), view('audit')]
        const assembler = new conversation.ConversationNodeAssembler(events, { entries: () => views })
        const history = [entry(1), entry(2), entry(3), entry(4, undefined, [{ type: 'text', text: 'Visible context' }])]
        const original = JSON.stringify(history)
        assembler.activateTarget('chat')
        assembler.activateTarget('audit')
        for (const event of history) assembler.append(event)
        assembler.flush()
        const visible = () => (assembler.snapshot('chat') as ConversationViewNode[]).map(node => node.id)
        const expected = dsh021 ? ['4'] : ['1', '2', '3', '4']
        expect(visible()).toEqual(expected)
        expect(assembler.snapshot('audit')).toHaveLength(4)
        assembler.replaceWindow(history, false)
        assembler.flush()
        expect(visible()).toEqual(expected)
        expect(JSON.stringify(history)).toBe(original)
        if (!dsh021) return
        stopGeneric()
        assembler.rebuildRegistry()
        assembler.flush()
        expect(visible()).toEqual(expected)
        expect(JSON.stringify(history)).toBe(original)
        stop()
        assembler.rebuildRegistry()
        assembler.flush()
        expect(visible()).toEqual(['1', '2', '3', '4'])
      } finally { await ctx.fiber.dispose() }
    })
  })
})
