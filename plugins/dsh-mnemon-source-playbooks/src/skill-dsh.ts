import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import { randomUUID } from 'node:crypto'
import { sep } from 'node:path'
import { agentMemoryScope, type DshWorkspaceAdapter } from 'dsh-mnemon-workspace-kit/dsh'
import { skillAuthoringContract, type SkillPorts } from './skill-engine.ts'
import { skillBundle, type SkillStore, type SkillValidationResult } from './skill-store.ts'
import { redactSkillText } from './skill-bundle.ts'

function executionOutcome(result: ToolExecutionResult, label: string, command: string, toolCallId: string, signal?: AbortSignal): SkillValidationResult {
  if (signal?.aborted) return { label, command, toolCallId, status: 'cancelled', exitCode: null, output: 'Command cancelled before validation completed' }
  if (result.isError) return { label, command, toolCallId, status: 'blocked', exitCode: null, output: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }
  const value = result.value as { kind?: string; exitCode?: number | null; timedOut?: boolean; aborted?: boolean; stdout?: { text?: string }; stderr?: { text?: string }; sandbox?: { runnerFailed?: boolean; denied?: boolean } }
  if (!value || value.kind !== 'foreground' || typeof value.exitCode !== 'number' && value.exitCode !== null) return { label, command, toolCallId, status: 'failed', exitCode: null, output: 'DSH did not return a completed foreground command result' }
  const status = value.aborted ? 'cancelled' : !value.timedOut && !value.sandbox?.runnerFailed && !value.sandbox?.denied && value.exitCode === 0 ? 'passed' : 'failed'
  return { label, command, toolCallId, status, exitCode: value.exitCode ?? null, output: [value.stdout?.text, value.stderr?.text, value.timedOut ? 'Command timed out' : '', value.aborted ? 'Command cancelled' : ''].filter(Boolean).join('\n') }
}

/** UI checks traverse the same scoped tools and approval policy as agent calls. */
export function nativeSkillPorts(ctx: Context, adapter: DshWorkspaceAdapter): SkillPorts {
  return {
    async generate(scope, basis, base, instruction, signal) {
      const agent = await adapter.live(scope.sessionId!, scope, signal), { provider, model } = agent.options
      if (!provider || !model) throw new Error('Select a model in the current DSH session first')
      let text = '', completed = false
      const input = { basis, existingSkill: base ? { title: base.title, bundle: skillBundle(base), digest: base.data.contentDigest } : null, operatorInstruction: instruction }
      for await (const chunk of ctx.llm.stream({ provider, model, system: skillAuthoringContract, messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(input) }], source: { kind: 'plugin', plugin: 'dsh-mnemon-source-playbooks', form: 'recall' } })], tools: [], maxTokens: 20000, signal })) {
        signal.throwIfAborted()
        if (chunk.type === 'text-delta') { text += chunk.text; if (text.length > 105_000) throw new Error('Skill authoring output exceeds its limit') }
        if (chunk.type === 'finish') { if (chunk.reason.kind !== 'stop') throw new Error('The skill model stopped without a complete candidate: ' + chunk.reason.kind); completed = true }
      }
      if (!completed) throw new Error('The skill authoring stream ended before completion')
      return text
    },
    async validate(scope, directory, check, signal) {
      const agent = await adapter.live(scope.sessionId!, scope, signal), callId = ('mnemon-skill-check:' + randomUUID()) as ToolCallId
      const args = { command: check.command, workdir: directory, description: 'Validate reviewed skill: ' + check.label, timeoutMs: 30000 }
      const schemas = ctx.tools.schemas(agent)
      if (schemas.some(schema => schema.name === 'bash')) return executionOutcome(await ctx.tools.execute({ name: 'bash', arguments: args, agent, callId, signal }), check.label, check.command, callId, signal)
      if (!schemas.some(schema => schema.name === 'run_code') || !ctx.tools.get('bash', agent)) throw new Error('The current DSH preset does not expose its native bash tool')
      const runtime = ctx.get('codeRuntime') as { language?: string } | undefined
      if (runtime?.language !== 'typescript') throw new Error('This validation adapter requires the DSH TypeScript tool transport')
      let nested: ToolExecutionResult | undefined
      const stop = ctx.on('tools/result', (exec, result) => { if (exec.rootCallId === callId && exec.name === 'bash') nested = result })
      try {
        const outer = await ctx.tools.execute({ name: 'run_code', arguments: { code: 'const result = await tools.bash(' + JSON.stringify(args) + '); console.log(JSON.stringify(result));', description: 'Validate reviewed skill: ' + check.label }, agent, callId, signal })
        return executionOutcome(outer.isError ? outer : nested ?? outer, check.label, check.command, callId, signal)
      } finally { stop() }
    },
  }
}

/** Native loads and exact resource-path executions stay distinct from model claims. */
export function installSkillObservations(ctx: Context, skills: SkillStore, sourceInstanceKey: string): () => Promise<void> {
  const abort = new AbortController(), pending = new Set<Promise<void>>()
  const stop = ctx.on('tools/result', (exec, result) => {
    if (!exec.agent || String(exec.rootCallId).startsWith('mnemon-skill-check:') || !['skill', 'bash'].includes(exec.name) || pending.size >= 64 || abort.signal.aborted) return
    const scope = agentMemoryScope(exec.agent), args = exec.arguments as { name?: string; command?: string; workdir?: string }
    const task = (async () => {
      const records = (await skills.snapshot(scope, abort.signal)).records
      const matches = records.filter(record => record.kind === 'skill-version' && record.state === 'active' && record.data.enabled !== false && (exec.name === 'skill'
        ? !result.isError && skillBundle(record).name === args.name && (result.value as { resourceBase?: { kind?: string; path?: string } } | undefined)?.resourceBase?.kind === 'directory' && (result.value as { resourceBase?: { path?: string } }).resourceBase?.path === record.data.directory
        : typeof record.data.directory === 'string' && (args.workdir === record.data.directory || args.workdir?.startsWith(record.data.directory + sep) || args.command?.includes(record.data.directory + sep))))
      for (const record of matches.slice(0, 4)) {
        const outcome = exec.name === 'bash' ? executionOutcome(result, 'Native skill execution', args.command ?? '', String(exec.callId)) : undefined
        const event = await skills.event(scope, record.id, { eventKey: String(exec.callId) + ':' + record.id, kind: exec.name === 'skill' ? 'native-load' : 'execution', content: outcome ? `Native shell command: ${outcome.status}; exit=${outcome.exitCode}. This is the overall command outcome, not proof of each inner script.\nCommand: ${args.command ?? ''}\n${outcome.output}` : 'The DSH skill tool loaded this published version.', verifiedByHuman: false, ...(outcome ? { concern: outcome.status !== 'passed', status: outcome.status, ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}) } : {}) }, abort.signal)
        if (event && outcome) ctx.emit('mnemon-workspace/activity', { sourceInstanceKey, eventKey: event.id, scope, kind: 'skill-executed', title: record.title, summary: redactSkillText(event.content), level: outcome.status === 'passed' ? 'info' : 'warning', recordId: record.id, artifactId: record.id, artifactDigest: String(record.data.contentDigest), status: outcome.status, ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}), verifiedByHuman: false })
      }
    })().catch(error => { if (!abort.signal.aborted) ctx.logger('mnemon-skills').warn('Skill observation failed: %s', String(error)) })
    pending.add(task); void task.finally(() => pending.delete(task))
  })
  return async () => { stop(); abort.abort(); await Promise.allSettled([...pending]) }
}
