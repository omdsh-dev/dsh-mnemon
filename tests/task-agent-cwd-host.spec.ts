import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, expect, it } from 'vitest'
import type { HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { startSubagent } from '../src/host/subagent-start.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { dsh021, loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

// A task Agent runs background memory work, such as Runtime maintenance, outside any conversation,
// and Mnemon reads from its cwd which workspace's memory it works on. DSH 0.2.1 checks an Agent's
// working directory before each step and stops it once that and its session's original directory
// are gone. So for a workspace whose folder was deleted or moved, the task keeps that workspace as
// its cwd and works from an existing directory; its children inherit both (#361). DSH 0.2.0 checks
// no directory, which leaves nothing to check there.

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))

const TASK_STEP = 'Run the maintenance step.'
const CHILD_STEP = 'Run the child step.'

/** Only the model is scripted: each request gets the reply its instruction asks for. */
class ScriptedAdapter extends LlmAdapter {
  readonly replies: string[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const asked = options.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    const reply = asked.some(text => text.includes(CHILD_STEP)) ? 'Child step done.'
      : asked.some(text => text.includes(TASK_STEP)) ? 'Maintenance step done.' : 'Hello back.'
    this.replies.push(reply)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const disposers: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose() })

/**
 * A real DSH host with Mnemon's lifecycle and DSH's spawn provider. `registry` lists the
 * workspaces of DSH's Web workspace registry; without it the host has none, as Headless.
 */
async function host(registry?: (fixture: { root: string; workspace: string }) => string[]) {
  const f = await compositionFixture()
  const ctx = new Context()
  let stop: (() => void) | undefined
  disposers.push(async () => { stop?.(); await ctx.fiber.dispose(); await f.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await loadTools(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await loadWorkingDirectory(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['scripted'], adapter)
  if (registry !== undefined) {
    const workspaces = registry(f).map((path, index) => ({ id: `workspace-${index}`, title: `Workspace ${index}`, path }))
    ctx.provide('workspaceRegistry', { list: () => workspaces, get: (id: string) => workspaces.find(workspace => workspace.id === id) })
  }
  const dsh = ctx as unknown as HostContextShape
  const coordinator = new MnemonSubagentCoordinator(dsh.subagents, f.live, dsh)
  const lifecycle = new MnemonLifecycle(dsh, coordinator, f.config, f.live)
  registerTools(dsh, f.live, coordinator, f.extensions)
  stop = lifecycle.start()
  // An ordinary conversation supplies the task Agent's model route.
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'scripted', model: 'fixture' }, { cwd: f.workspace })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  const workingDirectory = dsh.get('workingDirectory') as { get(session: unknown): string }

  /** A maintenance step under a task Agent for `workspace`, then a child of that task, as Mnemon starts one. */
  async function maintain(workspace: string) {
    return lifecycle.runRuntimeMaintenanceTask({ storage: 'workspace', workspaceId: workspace }, new AbortController().signal, async task => {
      const agent = ctx.agents.get(SessionId(task.id))!
      agent.followup(createUserMessage({ content: [{ type: 'text', text: TASK_STEP }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const children: Agent[] = []
      const stopWatching = ctx.on('agent/created', ({ agent: created }): undefined => {
        if (created.session.header.origin === 'subagent') children.push(created)
      })
      try {
        const run = await startSubagent(dsh.subagents, dsh.agents, 'spawn', {
          label: 'Mnemon test child', prompt: [{ type: 'text', text: CHILD_STEP }], parent: task, signal: new AbortController().signal,
        })
        const result = await run.result
        await run.dispose()
        const child = children.find(candidate => candidate.id === run.id)
        return {
          task: { cwd: agent.session.header.cwd, workingDirectory: workingDirectory.get(agent.session) },
          child: { cwd: child?.session.header.cwd, workingDirectory: child === undefined ? undefined : workingDirectory.get(child.session), result },
        }
      } finally {
        stopWatching()
      }
    })
  }
  return { f, adapter, maintain }
}

it.skipIf(!dsh021)('runs a task Agent and its child for a workspace whose folder is gone, from the first existing workspace', async () => {
  const h = await host(({ root, workspace }) => [join(root, 'moved-project'), workspace])
  const gone = join(h.f.root, 'deleted-project')

  const outcome = await h.maintain(gone)

  // Both keep the workspace whose memory the task works on, and work from one that exists.
  const existing = realpathSync(h.f.workspace)
  expect(outcome).toMatchObject({
    task: { cwd: gone, workingDirectory: existing },
    child: { cwd: gone, workingDirectory: existing, result: { output: [{ type: 'text', text: 'Child step done.' }], stopReason: 'completed' } },
  })
  // DSH did not stop the task's own step either.
  expect(h.adapter.replies).toEqual(['Hello back.', 'Maintenance step done.', 'Child step done.'])
}, 20_000)

it.skipIf(!dsh021)('works from the directory DSH started in when no registered workspace exists', async () => {
  const h = await host()
  const gone = join(h.f.root, 'deleted-project')

  const outcome = await h.maintain(gone)

  const started = realpathSync(process.cwd())
  expect(outcome).toMatchObject({ task: { cwd: gone, workingDirectory: started }, child: { cwd: gone, workingDirectory: started, result: { stopReason: 'completed' } } })
  expect(h.adapter.replies).toEqual(['Hello back.', 'Maintenance step done.', 'Child step done.'])
}, 20_000)
