import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as learning from 'dsh-mnemon-source-learning'
import * as playbooks from 'dsh-mnemon-source-playbooks'
import * as tasks from 'dsh-mnemon-source-tasks'
import * as workspace from 'dsh-mnemon-strategy-workspace'
import * as cycle from 'dsh-mnemon-strategy-learning-cycle'
import type { RecordSnapshot, RecordValue } from 'dsh-mnemon/source-sdk'
import type { MemoryJsonValue } from '../src/core/contracts/index.ts'
import { expect, it } from 'vitest'
import type { HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { createRuntimeGraph } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { liveFlash, PROVIDER, SessionReads, sanitized, type FlashAudit } from './fixtures/flash-quality/live.ts'

const MODEL = 'deepseek-flash'
it.skipIf(process.env.MNEMON_RUN_LEARNING_FLASH !== '1')('closes the optional learning loop with a real Flash agent and published DSH services', async () => {
  const report: FlashAudit & { checks: string[]; turns: string[]; snapshots: unknown[] } = { scenario: 'optional-learning-feedback', modelCalls: [], toolErrors: [], modelsReturned: [], maxConcurrentModels: 0, checks: [], turns: [], snapshots: [] }
  const wire = await liveFlash(report, 24, MODEL)
  const f = await compositionFixture({ cliPath: process.env.MNEMON_NATIVE_TEST_CLI ?? '/opt/homebrew/bin/mnemon', recallMode: 'guided', writebackMode: 'guided', idleReviewMs: 600_000 })
  const ctx = new Context()
  let stop: (() => void) | undefined
  const sessionId = SessionId('learning-acceptance'), scope = { storage: 'custom' as const, workspaceId: f.workspace, sessionId, agentId: sessionId }
  const sourceKey = (typeId: string) => f.extensions.contributionSnapshot().sources.find(source => source.definition.manifest.typeId === typeId)!.instanceKey
  async function read(typeId = 'learning'): Promise<RecordSnapshot> {
    const lease = f.live.snapshot().memoryComposition.acquire()
    try { const result = await lease.generation.executeManagement({ scope, sourceInstanceKey: sourceKey(typeId), mode: 'read', operation: 'snapshot', input: {} , confirmed: false }); return result.value as unknown as RecordSnapshot }
    finally { lease.release() }
  }
  async function mutate(typeId: string, operation: string, input: MemoryJsonValue) {
    const lease = f.live.snapshot().memoryComposition.acquire()
    try { return await lease.generation.executeManagement({ scope, sourceInstanceKey: sourceKey(typeId), mode: 'mutate', operation, input, expectedRevision: (await read(typeId)).revision, confirmed: true }) }
    finally { lease.release() }
  }
  async function settled(test: (snapshot: RecordSnapshot) => boolean) {
    const deadline = Date.now() + 150_000
    while (true) { const snapshot = await read(); if (test(snapshot)) return snapshot; if (Date.now() > deadline) throw new Error('Learning observation did not settle'); await new Promise(resolve => setTimeout(resolve, 200)) }
  }
  const digest = (snapshot: RecordSnapshot) => snapshot.records.map(record => ({ kind: record.kind, state: record.state, title: record.title, content: record.content, data: record.data, signals: record.signals }))
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(SessionReads); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(SubagentRuntime); await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }); await ctx.plugin(wire.fork, { providerName: 'fork' })
    ctx.llm.registerAdapter([PROVIDER], wire.adapter)
    ctx.provide('mnemonMemory', f.extensions.service)
    ctx.provide('workspaceRegistry', { resolveByPath: async (path: string) => ({ id: 'acceptance', path }), list: () => [{ id: 'acceptance', path: f.workspace }] } as never)
    const entryIds = new WeakMap<object, string>()
    ctx.provide('loader', { locate: (fiber: object) => entryIds.get(fiber) } as never)
    async function mount(module: { name: string; inject: string[]; apply(ctx: Context, config: any): void }, config: object) {
      await ctx.plugin({ ...module, apply(context: Context, value: object) { entryIds.set(context.fiber, module.name); module.apply(context, value) } }, config)
    }
    await mount(learning, { dataDir: f.config.dataDir!, model: MODEL, provider: PROVIDER })
    await mount(playbooks, { dataDir: f.config.dataDir! })
    await mount(tasks, { dataDir: f.config.dataDir! })
    await f.mount(workspace, { instanceId: 'workspace-policy' })
    await f.mount(cycle, { instanceId: 'learning-policy', config: { interval: 2 } })
    const config = resolveConfig({ ...f.config, memoryTopology: { ...f.config.memoryTopology, strategyId: 'workspace' } })
    f.live.swap(createRuntimeGraph(config, f.workspace, f.extensions))
    const host = ctx as unknown as HostContextShape
    const coordinator: MnemonSubagentCoordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host, () => ({ provider: PROVIDER, model: MODEL }), () => 6000, (scope, signal, operation) => lifecycle.runRuntimeMaintenanceTask(scope, signal, operation))
    const lifecycle = new MnemonLifecycle(host, coordinator, config, f.live)
    registerTools(host, f.live, coordinator)
    ctx.on('tools/result', (execution, result) => { if (result.isError) report.toolErrors.push(execution.name + ': ' + sanitized(result.content)) })
    ctx.on('agent/error', ({ error }) => report.toolErrors.push(sanitized(error)))
    stop = lifecycle.start()
    const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: PROVIDER, model: MODEL, maxTokens: 4000 }, meta: { cwd: f.workspace } })
    async function turn(text: string, human = true) {
      const before = handle.agent.session.snapshotEvents().length
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: human ? { kind: 'user' } : { kind: 'plugin', plugin: 'mnemon-acceptance', form: 'recall' } }))
      await handle.agent.whenIdle()
      report.turns.push(handle.agent.session.snapshotEvents().slice(before).filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n'))
      expect(report.toolErrors).toEqual([])
    }
    await turn('For future code reviews, I prefer short answers, at most two paragraphs. Please acknowledge this preference. Do not execute commands or create files.')
    await settled(snapshot => Number(snapshot.records.find(record => record.kind === 'cycle')?.data.rounds) >= 1)
    await turn('To confirm my usual review style across projects: keep answers concise and within two paragraphs. This is a stable preference, not a temporary instruction. Our release workflow is to verify the published version and check peer compatibility before deployment.')
    await settled(snapshot => Number(snapshot.records.find(record => record.kind === 'cycle')?.data.rounds) >= 2)
    await turn('Please complete the available learning review using only inspected evidence. Keep suggestions pending for human review. Do not write files or duplicate these suggestions into other Sources.')
    let snapshot = await settled(snapshot => snapshot.records.some(record => record.kind === 'run') && Number(snapshot.records.find(record => record.kind === 'cycle')?.data.outcomes) >= 3)
    report.snapshots.push(digest(snapshot))
    const proposals = snapshot.records.filter(record => record.kind === 'proposal')
    expect(proposals.length).toBeGreaterThan(0); expect(proposals.every(record => record.state === 'pending')).toBe(true)
    const preference = proposals.find(record => record.data.category === 'preference')!
    expect(preference).toBeDefined(); expect(preference.data.humanKeys).toHaveLength(2)
    report.checks.push('human evidence captured; real Flash review persisted; stable preference pending with independent signals')
    await mutate('learning', 'approve', { id: preference.id, version: preference.version })
    const adopted = (await read()).records.find(record => record.id === preference.id)!
    await mutate('learning', 'record-feedback', { id: adopted.id, version: adopted.version, verdict: 'outdated', quote: 'Long technical investigations now need complete evidence even when that takes more than two paragraphs.', eventKey: 'acceptance-feedback' })
    snapshot = await read()
    expect(snapshot.records.find(record => record.id === preference.id)?.data.needsReview).toBe(true)
    const rounds = Number(snapshot.records.find(record => record.kind === 'cycle')!.data.rounds)
    await turn('Review the new explicit feedback and suggest a scoped correction if supported. Keep the adopted original unchanged until a human approves a revision.', false)
    snapshot = await settled(snapshot => Number(snapshot.records.find(record => record.kind === 'cycle')?.data.completedFeedback) >= 1)
    expect(Number(snapshot.records.find(record => record.kind === 'cycle')!.data.rounds)).toBe(rounds)
    expect(snapshot.records.find(record => record.id === preference.id)).toMatchObject({ state: 'active', content: preference.content })
    report.checks.push('explicit negative feedback reopened review; plugin wake did not count as a human turn; original remained active')
    const created = await mutate('tasks', 'create', { kind: 'project', title: 'Validate release artifact', content: 'Check the packaged plugin peer declarations.', scope: 'project' })
    const task = (created.value as unknown as RecordSnapshot).records.find(record => record.title === 'Validate release artifact')!
    await mutate('tasks', 'complete', { id: task.id, version: task.version })
    snapshot = await settled(snapshot => snapshot.records.some(record => record.kind === 'observation' && record.data.recordId === task.id))
    expect(snapshot.records.find(record => record.kind === 'observation' && record.data.recordId === task.id)?.data.origin).toBe('task-outcome')
    report.checks.push('actual task completion returned as outcome evidence')
    await mutate('learning', 'review-now', {})
    snapshot = await settled(snapshot => snapshot.records.find(record => record.kind === 'cycle')?.data.status === 'idle')
    expect(snapshot.records.some(record => record.kind === 'failure')).toBe(false)
    report.checks.push('manual review used the same real Flash model and persisted completion')
    report.snapshots.push(digest(snapshot))
    expect(report.modelsReturned).toEqual([MODEL]); expect(await wire.drain()).toEqual([])
    await handle.dispose()
  } finally {
    stop?.(); await ctx.fiber.dispose(); await f.dispose(); await wire.dispose()
    if (process.env.MNEMON_LEARNING_FLASH_REPORT) writeFileSync(process.env.MNEMON_LEARNING_FLASH_REPORT, JSON.stringify({ requestedModel: MODEL, ...report }, (_key, value) => typeof value === 'string' ? value.replaceAll(f.root, '[fixture]').replaceAll(process.env.DEEPSEEK_API_KEY ?? '[no-key]', '[credential]') : value, 2) + '\n')
  }
}, 600_000)
