import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from 'schemastery'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { DshWorkspaceAdapter } from 'dsh-mnemon-workspace-kit/dsh'
import { createLearningSource } from './source.ts'
import { learningContract, reviewPrompt, type LearningPort } from './runner.ts'
import type { LearningConfig } from './learning.ts'
export const name = 'dsh-mnemon-source-learning'
export const inject = ['mnemonMemory', 'agents', 'sessionQuery', 'workspaceRegistry', 'llm']
export type Config = LearningConfig
export const Config = z.object({ dataDir: z.string(), captureFeedback: z.boolean().default(true), captureOutcomes: z.boolean().default(true), autoAcceptFacts: z.boolean().default(false), autoAcceptPreferences: z.boolean().default(false), evidenceLimit: z.number().min(100).max(5000).default(1000), provider: z.string(), model: z.string() }) as z<Config>
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Learning', 'zh-CN': '经验整理' }, description: { en: 'Review independent evidence, adopt durable learning and track explicit feedback.', 'zh-CN': '整理独立证据、审核可复用经验，并跟踪明确反馈。' }, roles: ['source'], provides: [{ id: 'source' }, { id: 'source.learning-context' }] })
export function apply(ctx: Context, config: Config = {}): void {
  if (config.evidenceLimit !== undefined && (!Number.isInteger(config.evidenceLimit) || config.evidenceLimit < 100 || config.evidenceLimit > 5000)) throw new Error('Learning evidence limit must be 100–5000')
  const adapter = new DshWorkspaceAdapter({ agents: ctx.agents, sessionQuery: ctx.sessionQuery, workspaceRegistry: ctx.workspaceRegistry })
  const port: LearningPort = { async complete(scope, window, signal) {
    let selection = ctx.agents.get(SessionId(scope.sessionId!))?.options
    if (!selection) { const observation = await adapter.observe(scope.sessionId!, scope, signal); try { const event = observation.events.findLast(event => event.type === 'request/header'); if (event?.type === 'request/header') selection = event.data.header.config } finally { observation[Symbol.dispose]() } }
    const provider = config.provider || selection?.provider, model = config.model || selection?.model
    if (!provider || !model) throw new Error('Choose a model or send a message in the selected session first')
    const messages = [createUserMessage({ content: [{ type: 'text', text: reviewPrompt(window) }], source: { kind: 'plugin', plugin: name, form: 'recall' } })]
    let text = '', completed = false
    // Reasoning models share this allowance between deliberation and JSON output.
    for await (const chunk of ctx.llm.stream({ provider, model, messages, system: learningContract, tools: [], maxTokens: 16000, signal, sessionId: SessionId(crypto.randomUUID()) })) {
      signal.throwIfAborted()
      if (chunk.type === 'text-delta') { text += chunk.text; if (text.length > 30_000) throw new Error('Learning output exceeded its limit') }
      if (chunk.type === 'finish') { if (chunk.reason.kind !== 'stop') throw new Error('Learning model did not finish normally: ' + chunk.reason.kind + '; evidence remains available for another review'); completed = true }
    }
    if (!completed) throw new Error('Learning stream ended before completion')
    return text
  } }
  installMemory(ctx, { plugin: memoryPlugin, sources: [createLearningSource(config, port, ctx)] }, { effectiveDigest: memoryConfigurationDigest(config) })
}
export { createLearningSource }
