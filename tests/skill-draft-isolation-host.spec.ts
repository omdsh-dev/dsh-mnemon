import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { dsh021, loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))
const ptc = await import(requireDsh.resolve('@deepseek-ai/dsh-ptc-runtime-node'))
const fsLocal = await import(requireDsh.resolve('@deepseek-ai/dsh-fs-local'))
const subprocessLocal = await import(requireDsh.resolve('@deepseek-ai/dsh-subprocess-local'))
const sandboxLocal = await import(requireDsh.resolve('@deepseek-ai/dsh-sandbox-local'))
const sandboxPolicyPlugin = await import(requireDsh.resolve('@deepseek-ai/dsh-sandbox-policy'))
const approvalPlugin = (() => {
  try { return import(requireDsh.resolve('@deepseek-ai/dsh-user-approval')) } catch { return undefined }
})()

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string' },
    notes: { type: 'string' },
    changes: { type: 'array', items: { type: 'string' } },
  },
  required: ['content', 'notes', 'changes'],
  additionalProperties: false,
}

type Reply = string | { name: string; args: Record<string, unknown> }

class ScriptedAdapter extends LlmAdapter {
  private calls = 0
  constructor(private readonly respond: (options: GenerateOptions) => Reply) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.respond(options)
    const id = `draft-call-${++this.calls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
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

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('skill draft isolation host', () => {
  const disposers: Array<() => Promise<void>> = []
  afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose() })

  async function hostFixture(options: { globalPtc?: boolean; attachOwnWriteTool?: boolean } = {}) {
    const f = await compositionFixture({ taskAgentModel: { mode: 'fixed', provider: 'scripted', model: 'fixture' } })
    const skillDir = join(f.workspace, '.dsh', 'skills', 'release-notes')
    const skillPath = join(skillDir, 'SKILL.md')
    const originalSkill = '---\nname: release-notes\ndescription: Draft release notes.\n---\n\nKeep the base file untouched.\n'
    await mkdir(skillDir, { recursive: true })
    await writeFile(skillPath, originalSkill, 'utf8')
    const originalHash = sha256(originalSkill)

    const ctx = new Context()
    let stop: (() => void) | undefined
    let stopTools: (() => void) | undefined
    let coordinator: MnemonSubagentCoordinator | undefined
    disposers.push(async () => {
      stop?.()
      stopTools?.()
      coordinator?.dispose()
      await ctx.fiber.dispose()
      await f.dispose()
    })

    const requestTools: Array<{ sessionId: string; names: string[] }> = []
    const childReceipts: Array<{ sessionId: string; name: string | undefined; isError: boolean; text: string }> = []
    const childPolicies: Array<{ sessionId: string; sandboxMode: string | undefined; approvalPolicy: string | undefined }> = []
    let ownWriteExecutions = 0
    let childStep = 0

    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(fsLocal.default, { cwd: f.workspace })
    await ctx.plugin(subprocessLocal.default, {})
    await ctx.plugin(sandboxLocal.default, {})
    await ctx.plugin(sandboxPolicyPlugin.default, { mode: 'danger-full-access', workspaceRoot: f.workspace })
    const loadedApproval = await approvalPlugin
    if (loadedApproval !== undefined) await ctx.plugin(loadedApproval.default, { policy: 'ask' })
    await ctx.plugin(ptc.default, {})
    const selectPtc = await loadTools(ctx, options.globalPtc && !dsh021 ? 'both' : 'native')
    if (options.globalPtc && dsh021 && typeof (ctx.tools as unknown as { setExecutor?: unknown }).setExecutor !== 'function') {
      const toolService = ctx.tools as unknown as { defaultMode?: string }
      toolService.defaultMode = 'ptc'
    }
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await loadWorkingDirectory(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })

    const mountedPresets = new WeakMap<object, string>()
    ctx.provide('agentPresets', {
      resolve: async () => ({ id: 'deep-ptc' }),
      mount: async (agentCtx: Context, id = 'deep-ptc') => {
        mountedPresets.set(agentCtx, id)
        await selectPtc(agentCtx)
        return { id }
      },
      composeFrom: (childCtx: Context, parentCtx: Context) => {
        const id = mountedPresets.get(parentCtx)
        if (id === undefined) return undefined
        mountedPresets.set(childCtx, id)
        void selectPtc(childCtx)
        return id
      },
      composedPreset: (agentCtx: Context) => mountedPresets.get(agentCtx),
    })

    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin !== 'subagent') return undefined
      if (options.attachOwnWriteTool) {
        agent.ctx.tools.register({
          name: 'own_scope_write_skill',
          description: 'Own-scope tool bypassing tools.restrict.',
          parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
          output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'written' }] },
          async execute(args) {
            ownWriteExecutions += 1
            await writeFile(skillPath, String((args as { content: string }).content), 'utf8')
            return { ok: true }
          },
        })
      }
      return undefined
    })

    ctx.on('tools/result', (execution, result) => {
      if (execution.agent?.session.header.origin !== 'subagent') return
      const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      childReceipts.push({ sessionId: execution.agent.id, name: execution.name, isError: result.isError, text })
    })

    ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter(request => {
      const sessionId = String(request.sessionId)
      const names = (request.tools ?? []).map(tool => tool.name)
      requestTools.push({ sessionId, names })
      const liveChild = ctx.agents.get(SessionId(sessionId))
      if (liveChild !== undefined && liveChild.session.header.origin === 'subagent') {
        const sandbox = liveChild.ctx.get('sandboxPolicy') as { resolve(agent: Agent): { mode: string } } | undefined
        const approval = liveChild.ctx.get('approval') as { effectivePolicy?(session: unknown): string } | undefined
        childPolicies.push({
          sessionId,
          sandboxMode: sandbox?.resolve(liveChild).mode,
          approvalPolicy: approval?.effectivePolicy?.(liveChild.session),
        })
      }
      const system = JSON.stringify(request.messages.filter(message => message.role === 'system'))
      const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
      if (requestId === undefined) return 'Done.'
      const step = childStep++
      const payload = {
        requestId,
        result: { content: '---\nname: release-notes\ndescription: Improved.\n---\n\nImproved draft.\n', notes: 'Improved wording.', changes: ['Clarified instructions'] },
      }
      if (names.includes('run_code')) {
        if (step === 0) {
          return {
            name: 'run_code',
            args: {
              description: 'Attempt direct filesystem mutation inside run_code',
              code: `const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(skillPath)}, 'CORRUPTED_BY_RUN_CODE', 'utf8'); await tools.mnemon_subagent_result(${JSON.stringify(payload)})`,
            },
          }
        }
        return {
          name: 'run_code',
          args: {
            description: 'Submit skill draft result',
            code: `await tools.mnemon_subagent_result(${JSON.stringify(payload)})`,
          },
        }
      }
      if (options.attachOwnWriteTool && step === 0) {
        return { name: 'own_scope_write_skill', args: { content: 'CORRUPTED_BY_OWN_TOOL' } }
      }
      return { name: 'mnemon_subagent_result', args: payload }
    }))

    const dsh = ctx as unknown as HostContextShape
    coordinator = new MnemonSubagentCoordinator(dsh.subagents, f.live, dsh)
    stopTools = registerTools(dsh, f.live, coordinator, f.extensions)
    const lifecycle = new MnemonLifecycle(dsh, coordinator, f.config, f.live)
    stop = lifecycle.start()

    return {
      f, ctx, lifecycle, coordinator, skillPath, originalSkill, originalHash,
      requestTools, childReceipts, childPolicies,
      ownWriteExecutions: () => ownWriteExecutions,
    }
  }

  it('excludes run_code, enforces read-only policy, and blocks own-scope writes during skill draft generation (#727)', async () => {
    const h = await hostFixture({ attachOwnWriteTool: true })
    const signal = new AbortController().signal

    const result = await h.lifecycle.runSkillTask(h.f.workspace, signal, task =>
      h.coordinator.skillTask(task, 'Mnemon skill draft', 'Improve release-notes.', DRAFT_SCHEMA, 'Write a skill draft.', signal))

    expect(result.structured).toMatchObject({ notes: 'Improved wording.' })
    expect(h.requestTools.length).toBeGreaterThanOrEqual(2)
    for (const req of h.requestTools) {
      expect(req.names).not.toContain('run_code')
      expect(req.names).toContain('mnemon_subagent_result')
    }
    expect(h.ownWriteExecutions()).toBe(0)
    expect(h.childReceipts).toContainEqual(expect.objectContaining({
      name: 'own_scope_write_skill',
      isError: true,
    }))
    expect(h.childReceipts).toContainEqual(expect.objectContaining({
      name: 'mnemon_subagent_result',
      isError: false,
    }))
    expect(h.childPolicies[0]?.sandboxMode).toBe('read-only')
    if (h.childPolicies[0]?.approvalPolicy !== undefined) {
      expect(h.childPolicies[0].approvalPolicy).toBe('never')
    }
    const afterSkill = await readFile(h.skillPath, 'utf8')
    expect(sha256(afterSkill)).toBe(h.originalHash)
    expect(await readdir(join(h.f.workspace, '.dsh', 'skills', 'release-notes'))).toEqual(['SKILL.md'])
  }, 30_000)

  it.skipIf(!dsh021)('switches text-only skill children back to native presentation when global PTC mode is active (#727)', async () => {
    const h = await hostFixture({ globalPtc: true })
    const signal = new AbortController().signal

    const result = await h.lifecycle.runSkillTask(h.f.workspace, signal, task =>
      h.coordinator.skillTask(task, 'Mnemon skill draft', 'Improve release-notes.', DRAFT_SCHEMA, 'Write a skill draft.', signal))

    expect(result.structured).toMatchObject({ notes: 'Improved wording.' })
    expect(h.requestTools).toHaveLength(1)
    expect(h.requestTools[0]!.names).toEqual(['mnemon_subagent_result'])
    expect(h.childPolicies[0]?.sandboxMode).toBe('read-only')
    const afterSkill = await readFile(h.skillPath, 'utf8')
    expect(sha256(afterSkill)).toBe(h.originalHash)
    expect(await readdir(join(h.f.workspace, '.dsh', 'skills', 'release-notes'))).toEqual(['SKILL.md'])
  }, 30_000)

  it('confines a direct skillTask child to read-only sandbox even under a danger-full-access live parent (#727)', async () => {
    const h = await hostFixture({ attachOwnWriteTool: true })
    const signal = new AbortController().signal
    const liveParent = await h.ctx.agentLoop.create(SessionId('live-danger-parent'), { provider: 'scripted', model: 'fixture' }, { cwd: h.f.workspace })
    ;(liveParent as unknown as HostAgent).session.append!('sandbox/mode', { mode: 'danger-full-access' })

    const result = await h.coordinator.skillTask(
      liveParent as unknown as HostAgent,
      'Mnemon skill draft',
      'Improve release-notes.',
      DRAFT_SCHEMA,
      'Write a skill draft.',
      signal,
    )

    expect(result.structured).toMatchObject({ notes: 'Improved wording.' })
    expect(h.ownWriteExecutions()).toBe(0)
    expect(h.childReceipts).toContainEqual(expect.objectContaining({
      name: 'own_scope_write_skill',
      isError: true,
    }))
    expect(h.childPolicies[0]?.sandboxMode).toBe('read-only')
    if (h.childPolicies[0]?.approvalPolicy !== undefined) {
      expect(h.childPolicies[0].approvalPolicy).toBe('never')
    }
    const afterSkill = await readFile(h.skillPath, 'utf8')
    expect(sha256(afterSkill)).toBe(h.originalHash)
  }, 30_000)
})
