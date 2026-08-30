import { describe, expect, it, vi } from 'vitest'
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import { registerAgentMemoryViewContext, registerMemoryPromptInterpolation, applyAgentMemoryViewWake, registerGuidance, RUNTIME_MEMORY_CONTEXT_NAME } from '../src/host/guidance.ts'
import type { MemoryWake } from '../src/core/contracts/index.ts'

describe('Source-neutral View Wake interpolation', () => {
  it('registers only View-based guidance and respects the existing preference', () => {
    const section = vi.fn()
    const ctx = { get: () => ({ section }) } as unknown as HostContextShape
    const preference = { routingGuidance: true }
    registerGuidance(ctx, preference)
    const render = section.mock.calls[0]![0].text
    expect(render()).toContain('only for offered ids')
    expect(render()).toContain('An action offer is not authorization')
    expect(render()).not.toMatch(/Documents|Memory Spaces|mnemon_recall|mnemon_runtime_memory/)
    preference.routingGuidance = false
    expect(render()).toBe('')
  })

  it('preserves all interpolation syntax in Source data without duplicating a protocol', () => {
    const variables = new Map<string, () => string>()
    const context = vi.fn()
    const section = vi.fn()
    const stopContext = vi.fn()
    context.mockReturnValue(stopContext)
    const prompt = { context, section, variable: (name: string, provider: () => string) => variables.set(name, provider) }
    const ctx = { get: () => prompt } as unknown as HostContextShape
    const agent = { ctx } as unknown as HostAgent
    const text = ['Empty: {{}}', 'Unicode: {{变量}}', 'Spaces: {{ 变量 }}', '{{model}} {{unknown}}', '{{a}}{{b}} {{{nested}}} {{{{}}}}', '{{mnemon_runtime_memory_literal_open_braces}}', '{{unterminated and stray }}'].join('\n')
    let wake: MemoryWake | undefined = { viewId: 'view:1', viewDigest: 'digest:1', text, sections: [] }
    registerMemoryPromptInterpolation(ctx)
    const stop = registerAgentMemoryViewContext(agent, () => wake)
    const registered = context.mock.calls[0]![0]
    const assembly = {
      sections: [{ name: 'other', text: 'Model {{model}}.' }],
      contexts: [{ name: registered.name, text: registered.text() }], tools: [],
      variables: { model: 'deepseek', ...Object.fromEntries([...variables].map(([name, provider]) => [name, provider()])) },
    }
    expect(renderPrompt(assembly)).toBe('Model deepseek.')
    expect(renderContextSnapshot(assembly)).toContain(text)
    expect(section).not.toHaveBeenCalled()
    wake = undefined
    expect(registered.text()).toBe('')
    stop()
    expect(stopContext).toHaveBeenCalledOnce()
  })
  it('replaces the assembly context with the immutable Wake and leaves unrelated sections intact', () => {
    const assembly = { sections: [{ name: 'host', text: 'Host protocol' }], contexts: [{ name: RUNTIME_MEMORY_CONTEXT_NAME, text: 'stale' }] }
    const wake = { viewId: 'view:1', viewDigest: 'digest:1', text: 'Current memory', sections: [] }
    expect(applyAgentMemoryViewWake(assembly, wake)).toEqual({
      sections: assembly.sections, contexts: [{ name: RUNTIME_MEMORY_CONTEXT_NAME, text: 'Current memory' }],
    })
    expect(applyAgentMemoryViewWake(assembly, undefined).contexts[0]?.text).toBe('')
  })
})
