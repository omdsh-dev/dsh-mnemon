import type { HostAgent, HostContextShape } from "./dsh.ts"
import type { ResolvedConfig } from './config.ts'
import type { MemoryWake } from "../core/contracts/index.ts"

export const GUIDANCE_SECTION_NAME = 'mnemon:routing'
export const RUNTIME_MEMORY_PROTOCOL_SECTION_NAME = 'mnemon:runtime-memory-protocol'
export const RUNTIME_MEMORY_CONTEXT_NAME = 'mnemon:runtime-memory'
export const ROUTING_GUIDANCE = 'Use memory only when needed. Search Mnemon Documents for substantial project records. Call mnemon_recall for durable history or exact prior details; never infer a missing historical rule. Put only new user facts or explicit save/correction requests in mnemon_runtime_memory; never cache retrieved evidence. A write exists only after its receipt.'
const RUNTIME_MEMORY_LITERAL_OPEN_BRACES_VARIABLE = 'mnemon_runtime_memory_literal_open_braces'
const LITERAL_OPEN_BRACES = '{{'

interface SystemPromptRegistry {
  section?: (value: { name: string; order: number; text: string | (() => string) }) => unknown
  context?: (value: { name: string; order: number; text: string | (() => string) }) => unknown
  variable?: (name: string, provider: () => string) => unknown
}

function systemPrompt(ctx: HostContextShape): SystemPromptRegistry | undefined {
  return ctx.get('systemPrompt') as SystemPromptRegistry | undefined
}

function scopedSystemPrompt(agent: HostAgent): SystemPromptRegistry | undefined {
  return agent.ctx.get?.('systemPrompt') as SystemPromptRegistry | undefined
}

export function memoryPromptText(value: string): string {
  return value.replaceAll(
    LITERAL_OPEN_BRACES,
    `{{${RUNTIME_MEMORY_LITERAL_OPEN_BRACES_VARIABLE}}}`,
  )
}

function disposer(...values: unknown[]): () => void {
  const disposes = values.filter((value): value is () => void => typeof value === 'function')
  return () => {
    for (let index = disposes.length - 1; index >= 0; index -= 1) disposes[index]!()
  }
}

/** Replace the already-materialized Agent protocol and context with the Wake pinned during assembly. */
export function applyAgentMemoryViewWake<T extends { sections: Array<{ name: string; text: string }>; contexts: Array<{ name: string; text: string }> }>(assembly: T, wake: MemoryWake | undefined): T {
  const sections = assembly.sections
  const rendered = wake === undefined ? '' : memoryPromptText(wake.text)
  let found = false
  const contexts = assembly.contexts.map(context => {
    if (context.name !== RUNTIME_MEMORY_CONTEXT_NAME) return context
    found = true
    return { ...context, text: rendered }
  })
  if (!found) contexts.push({ name: RUNTIME_MEMORY_CONTEXT_NAME, text: rendered })
  return { ...assembly, sections, contexts }
}

/** Register the non-recursive escape used by Source-provided View Wake contexts. */
export function registerMemoryPromptInterpolation(ctx: HostContextShape): void {
  systemPrompt(ctx)?.variable?.(RUNTIME_MEMORY_LITERAL_OPEN_BRACES_VARIABLE, () => LITERAL_OPEN_BRACES)
}

export function registerGuidance(ctx: HostContextShape, config?: Pick<ResolvedConfig, 'routingGuidance'>): void {
  systemPrompt(ctx)?.section?.({
    name: GUIDANCE_SECTION_NAME,
    order: 150,
    text: () => config?.routingGuidance === false ? '' : ROUTING_GUIDANCE,
  })
}

/** Project only the immutable Wake pinned by the root Agent lifecycle. */
export function registerAgentMemoryViewContext(agent: HostAgent, wake: () => MemoryWake | undefined): () => void {
  const prompt = scopedSystemPrompt(agent)
  const stopContext = prompt?.context?.({
    name: RUNTIME_MEMORY_CONTEXT_NAME,
    order: 145,
    text: () => {
      const current = wake()
      return current === undefined ? '' : memoryPromptText(current.text)
    },
  })
  return disposer(stopContext)
}
