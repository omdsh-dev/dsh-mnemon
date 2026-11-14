import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { CONTINUATION_TEXT, startWithContinuationTurns } from '../src/host/continuation-turn.ts'
import type { HostAgent, HostPreStepDecision, HostSubagentActivation, HostSubagentResult, HostSubagentRun, HostSubagentsService, HostUserMessage, ToolExecution } from '../src/host/dsh.ts'
import { startGuardedChild, startGuardedReview } from '../src/host/review-tools.ts'
import { childComposition, startSubagent } from '../src/host/subagent-start.ts'

describe('subagent startup and composition', () => {
  const agent = (id: string) => ({ id, status: 'idle', session: { header: {} } }) as unknown as HostAgent

  function request(signal = new AbortController().signal) {
    return {
      label: 'Consolidate local user profile',
      prompt: [{ type: 'text' as const, text: 'Run local USER.md compaction now.' }],
      parent: agent('parent'),
      signal,
      agentOptions: { maxTokens: 8_192 },
      maxDepth: 1,
      toolFilter: { allow: ['mnemon_subagent_result'] },
      persona: 'You are the local USER.md compactor.',
    }
  }

  function task(signal = new AbortController().signal) {
    const { toolFilter: _toolFilter, persona: _persona, ...rest } = request(signal)
    return rest
  }

  const dsh020Provider = () => ({ capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, prepareContinuable: () => {} })

  function activations() {
    const result = Promise.withResolvers<HostSubagentResult>()
    const dispose = vi.fn(async () => {})
    const activation: HostSubagentActivation = { childId: 'child-1', messageId: 'message-1', result: result.promise, dispose }
    const startActivation = vi.fn(async (_spec: Parameters<NonNullable<HostSubagentsService['startActivation']>>[0]) => activation)
    const subagents = { list: () => ['spawn'], getProvider: () => undefined, startActivation } as unknown as HostSubagentsService
    return { subagents, startActivation, result, dispose }
  }

  describe('Starting a delegated child on the running DSH (#356)', () => {
    it('omits catalog names from the older nested activation contract', async () => {
      const host = activations()
      await startSubagent(host.subagents, undefined, 'spawn', { ...task(), name: 'mnemon-write-test' })
      const spec = host.startActivation.mock.calls[0]![0]
      expect(spec).not.toHaveProperty('name')
      expect(spec.request).not.toHaveProperty('name')
    })

    it('starts a caller-delivered activation where DSH has replaced start', async () => {
      const host = activations()
      const child = agent('child-1')
      const input = task()
      const agents = { get: vi.fn((id: string) => id === 'child-1' ? child : undefined), isOwnedBy: vi.fn((id: string, owner: HostAgent) => id === 'child-1' && owner === input.parent) }

      const run = await startSubagent(host.subagents, agents, 'spawn', input)

      expect(host.startActivation).toHaveBeenCalledWith({
        childId: expect.stringMatching(/^mnemon-run-v1-[0-9a-f-]{36}$/),
        provider: 'spawn',
        label: 'Consolidate local user profile',
        request: {
          prompt: input.prompt,
          parent: input.parent,
          agentOptions: { maxTokens: 8_192 },
          maxDepth: 1,
        },
        signal: input.signal,
        delivery: 'caller',
      })
      expect(run.id).toBe('child-1')
      expect(run.localAgent).toBe(child)
      host.result.resolve({ output: [], stopReason: 'completed' })
      await expect(run.result).resolves.toEqual({ output: [], stopReason: 'completed' })
      await run.dispose()
      expect(host.dispose).toHaveBeenCalledOnce()
    })

    it('keeps the child it found once the activation releases it before settling', async () => {
      const host = activations()
      const input = task()
      const live = new Map([['child-1', agent('child-1')]])
      const agents = { get: (id: string) => live.get(id), isOwnedBy: () => true }
      const run = await startSubagent(host.subagents, agents, 'spawn', input)
      const child = run.localAgent
      setTimeout(() => { live.delete('child-1'); host.result.resolve({ output: [], stopReason: 'error' }) }, 0)

      await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
      expect(live.has('child-1')).toBe(false)
      expect(child?.id).toBe('child-1')
      expect(run.localAgent).toBe(child)
    })

    it('prefers activations when a DSH offers both APIs', async () => {
      const host = activations()
      const start = vi.fn()
      const subagents = { ...host.subagents, start } as HostSubagentsService

      await startSubagent(subagents, undefined, 'spawn', task())

      expect(host.startActivation).toHaveBeenCalledOnce()
      expect(start).not.toHaveBeenCalled()
    })

    it('disposes an activation it cannot hand over', async () => {
      const host = activations()
      const agents = { get: () => { throw new Error('registry unavailable') } }

      await expect(startSubagent(host.subagents, agents, 'spawn', task())).rejects.toThrow('registry unavailable')
      expect(host.dispose).toHaveBeenCalledOnce()
    })

    it('names no local child that the parent does not own', async () => {
      const host = activations()
      const agents = { get: () => agent('child-1'), isOwnedBy: () => false }

      const run = await startSubagent(host.subagents, agents, 'spawn', task())

      expect(run.localAgent).toBeUndefined()
      expect('localAgent' in run).toBe(false)
    })

    it('disposes a running activation when the caller aborts, as a one-shot run stopped', async () => {
      const host = activations()
      const controller = new AbortController()
      const run = await startSubagent(host.subagents, undefined, 'spawn', task(controller.signal))
      expect(host.dispose).not.toHaveBeenCalled()

      controller.abort()

      expect(host.dispose).toHaveBeenCalledOnce()
      host.result.resolve({ output: [], stopReason: 'aborted' })
      await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    })

    it('disposes an activation whose caller aborted while it was starting', async () => {
      const host = activations()
      const controller = new AbortController()
      host.startActivation.mockImplementationOnce(async () => {
        controller.abort()
        return { childId: 'child-1', result: host.result.promise, dispose: host.dispose }
      })

      await startSubagent(host.subagents, undefined, 'spawn', task(controller.signal))

      expect(host.dispose).toHaveBeenCalledOnce()
    })

    it('leaves a settled activation alone when the caller aborts later', async () => {
      const host = activations()
      const controller = new AbortController()
      const run = await startSubagent(host.subagents, undefined, 'spawn', task(controller.signal))
      host.result.resolve({ output: [], stopReason: 'completed' })
      await run.result

      controller.abort()

      expect(host.dispose).not.toHaveBeenCalled()
    })

    it('starts a one-shot run unchanged on DSH 0.2.0, whose provider takes the persona and tool filter in the request', async () => {
      const run = { id: 'child-1', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: vi.fn(async () => {}) }
      const start = vi.fn(async () => run)
      const subagents = { list: () => ['spawn'], getProvider: dsh020Provider, start } as unknown as HostSubagentsService
      const on = vi.fn()
      const input = request()

      await expect(startSubagent(subagents, { get: () => agent('child-1') }, 'spawn', input, { on })).resolves.toBe(run)
      expect(start).toHaveBeenCalledWith('spawn', input)
      expect(on).not.toHaveBeenCalled()
    })

    it('says why no memory subagent can start on a DSH with neither API', async () => {
      const subagents = { list: () => ['spawn'], getProvider: () => undefined } as unknown as HostSubagentsService

      await expect(startSubagent(subagents, undefined, 'spawn', request())).rejects.toThrow('This DSH has neither subagents.startActivation nor subagents.start, so dsh-mnemon cannot start its memory subagent')
    })
  })

  const DSH_021_CAPABILITIES = { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }
  type CreatedListener = (payload: { agent: HostAgent }) => unknown
  const localProvider = () => ({ capabilities: DSH_021_CAPABILITIES, prepareContinuable: () => {} })

  function composingHost({ publish = true, restrict = true, stranger }: { publish?: boolean; restrict?: boolean; stranger?: HostAgent } = {}) {
    const listeners = new Set<CreatedListener>()
    const on = vi.fn((name: string, listener: CreatedListener, _options?: { prepend?: boolean }) => {
      if (name !== 'agent/created') throw new Error('unexpected event ' + name)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    })
    const sections: unknown[] = []
    const restrictions: unknown[] = []
    const getSectionOrder = vi.fn((name: string) => name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 99)
    const scope = () => ({
      systemPrompt: { section: (section: unknown) => { sections.push(section) }, getSectionOrder },
      tools: restrict ? { restrict: (filter: unknown) => { restrictions.push(filter) } } : {},
    })
    const child = { ...agent('child-1'), ctx: scope() } as unknown as HostAgent
    const owners = new Map<string, HostAgent>()
    const agents = { get: (id: string) => id === 'child-1' ? child : undefined, isOwnedBy: (id: string, owner: HostAgent) => owners.get(id) === owner }
    const result = Promise.withResolvers<HostSubagentResult>()
    const dispose = vi.fn(async () => {})
    const startActivation = vi.fn(async (spec: Parameters<NonNullable<HostSubagentsService['startActivation']>>[0]) => {
      if (stranger !== undefined) for (const listener of [...listeners]) await listener({ agent: stranger })
      if (publish) {
        owners.set('child-1', spec.request.parent)
        for (const listener of [...listeners]) await listener({ agent: child })
      }
      return { childId: 'child-1', messageId: 'message-1', result: result.promise, dispose }
    })
    const subagents = { list: () => ['spawn'], getProvider: localProvider, startActivation } as unknown as HostSubagentsService
    return { subagents, agents, publications: { on }, listeners, startActivation, dispose, result, child, sections, restrictions, getSectionOrder, scope }
  }

  describe('Composing a delegated child where DSH no longer takes its persona and tools', () => {
    it('tells which providers take the composition in the request and which leave it to Mnemon', () => {
      const activations = { startActivation: vi.fn() } as unknown as HostSubagentsService
      expect(childComposition({} as HostSubagentsService, dsh020Provider())).toBe('request')
      expect(childComposition(activations, localProvider())).toBe('publication')
      expect(childComposition(activations, { capabilities: DSH_021_CAPABILITIES })).toBeUndefined()
      expect(childComposition({} as HostSubagentsService, localProvider())).toBeUndefined()
      expect(childComposition(activations, { capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false } })).toBeUndefined()
      expect(childComposition(activations, undefined)).toBeUndefined()
    })

    it('composes before other plugins see the child', async () => {
      const host = composingHost()

      await startSubagent(host.subagents, host.agents, 'spawn', request(), host.publications)

      expect(host.publications.on).toHaveBeenCalledWith('agent/created', expect.any(Function), { prepend: true })
    })

    it('composes each of two overlapping starts under one parent with its own persona', async () => {
      const listeners = new Set<CreatedListener>()
      const on = (_name: string, listener: (...args: never[]) => unknown) => { listeners.add(listener as CreatedListener); return () => { listeners.delete(listener as CreatedListener) } }
      const sections = new Map<string, unknown[]>()
      const child = (id: string) => ({ ...agent(id), ctx: {
        systemPrompt: { section: (section: { text: string }) => { sections.set(id, [...sections.get(id) ?? [], section.text]) }, getSectionOrder: () => 0 },
        tools: { restrict: () => {} },
      } }) as unknown as HostAgent
      const children = new Map([['first', child('first')], ['second', child('second')]])
      const parent = agent('parent')
      const agents = { get: (id: string) => children.get(id), isOwnedBy: () => true }
      const firstMayPublish = Promise.withResolvers<void>()
      const startActivation = vi.fn(async (spec: Parameters<NonNullable<HostSubagentsService['startActivation']>>[0]) => {
        const id = spec.label === 'First' ? 'first' : 'second'
        if (id === 'first') await firstMayPublish.promise
        for (const listener of [...listeners]) await listener({ agent: children.get(id)! })
        if (id === 'second') firstMayPublish.resolve()
        return { childId: id, result: new Promise<HostSubagentResult>(() => {}), dispose: vi.fn(async () => {}) }
      })
      const subagents = { list: () => ['spawn'], getProvider: localProvider, startActivation } as unknown as HostSubagentsService
      const start = (label: string, persona: string) => startSubagent(subagents, agents, 'spawn', { ...request(), parent, label, persona }, { on })

      const [first, second] = await Promise.all([start('First', 'You are the first task.'), start('Second', 'You are the second task.')])

      expect([first.id, second.id]).toEqual(['first', 'second'])
      expect(sections.get('first')).toEqual(['You are the first task.'])
      expect(sections.get('second')).toEqual(['You are the second task.'])
    })

    it('refuses to start without a way to stop observing, and disposes a run it cannot hand over cleanly', async () => {
      const host = composingHost()
      await expect(startSubagent(host.subagents, host.agents, 'spawn', request(), { on: () => undefined })).rejects.toThrow('could not observe the memory subagent DSH creates')
      expect(host.startActivation).not.toHaveBeenCalled()

      const failing = composingHost()
      const on = (name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }) => {
        failing.publications.on(name, listener as CreatedListener, options)
        return () => { throw new Error('observer disposal failed') }
      }
      await expect(startSubagent(failing.subagents, failing.agents, 'spawn', request(), { on })).rejects.toThrow('observer disposal failed')
      expect(failing.dispose).toHaveBeenCalledOnce()
    })

    it('gives the child its persona and tool filter in its own scope as DSH 0.2.1 publishes it', async () => {
      const host = composingHost()
      const input = request()

      const run = await startSubagent(host.subagents, host.agents, 'spawn', input, host.publications)

      const spec = host.startActivation.mock.calls[0]![0]
      expect(spec).toMatchObject({ provider: 'spawn', label: 'Consolidate local user profile', delivery: 'caller' })
      expect(spec.request).toEqual({ prompt: input.prompt, parent: input.parent, agentOptions: { maxTokens: 8_192 }, maxDepth: 1 })
      expect(host.sections).toEqual([{ name: 'deployment:persona-prefix', order: 0, text: 'You are the local USER.md compactor.' }])
      expect(host.getSectionOrder).toHaveBeenCalledWith('DEPLOYMENT_PERSONA_PREFIX')
      expect(host.restrictions).toEqual([{ allow: ['mnemon_subagent_result'] }])
      expect(run.id).toBe('child-1')
      expect(run.localAgent).toBe(host.child)
      expect(host.listeners.size).toBe(0)
      host.result.resolve({ output: [], stopReason: 'completed' })
      await expect(run.result).resolves.toEqual({ output: [], stopReason: 'completed' })
    })

    it('composes only its own child when another Agent is published meanwhile', async () => {
      const stranger = { ...agent('stranger'), ctx: { systemPrompt: { section: vi.fn(), getSectionOrder: () => 0 }, tools: { restrict: vi.fn() } } } as unknown as HostAgent
      const host = composingHost({ stranger })

      await startSubagent(host.subagents, host.agents, 'spawn', request(), host.publications)

      expect(stranger.ctx.systemPrompt!.section).not.toHaveBeenCalled()
      expect(stranger.ctx.tools!.restrict).not.toHaveBeenCalled()
      expect(host.restrictions).toHaveLength(1)
    })

    it('disposes and refuses a child it did not see created', async () => {
      const host = composingHost({ publish: false })

      await expect(startSubagent(host.subagents, host.agents, 'spawn', request(), host.publications))
        .rejects.toThrow('dsh-mnemon did not see memory subagent child-1 created')
      expect(host.dispose).toHaveBeenCalledOnce()
      expect(host.listeners.size).toBe(0)
    })

    it('lets DSH roll back a child whose scope cannot restrict its tools, before it runs', async () => {
      const host = composingHost({ restrict: false })

      await expect(startSubagent(host.subagents, host.agents, 'spawn', request(), host.publications))
        .rejects.toThrow('no tool restriction of its own')
      expect(host.sections).toEqual([])
      expect(host.listeners.size).toBe(0)
    })

    it('says why a child cannot be composed without observing its publication', async () => {
      const host = composingHost()

      await expect(startSubagent(host.subagents, host.agents, 'spawn', request())).rejects.toThrow('This DSH takes no subagent persona or tool filter at start')
      expect(host.startActivation).not.toHaveBeenCalled()
    })
  })
})

describe('activation-owned master compatibility (official rc.1 keeps the older contract)', () => {
  type Created = (event: { agent: HostAgent }) => unknown
  type Spec = { parent: HostAgent; childId?: string; prompt: unknown; signal: AbortSignal; [key: string]: unknown }

  function activationHost(options: { guardFails?: boolean; foreignPublication?: boolean; hold?: boolean } = {}) {
    const listeners: Created[] = []
    const live = new Map<string, HostAgent>()
    const roots = new Map<HostAgent, HostAgent>()
    const parent = { id: 'parent', session: { header: {} }, ctx: {} } as HostAgent
    live.set(parent.id, parent)
    const publications: Array<{ agent: HostAgent; sections: unknown[]; restrictions: unknown[]; guards: Set<(execution: ToolExecution) => string | undefined> }> = []
    const firstSteps: Array<{ id: string; sections: unknown[]; restrictions: unknown[]; outside: string | undefined }> = []
    const disposals: string[] = []
    const rootOf = vi.fn((agent: HostAgent) => {
      if (agent === parent) return parent
      if (live.get(agent.id) === agent && roots.has(agent)) return roots.get(agent)!
      throw Object.assign(new Error('agent has no active runtime owner'), { code: 'UNAUTHORIZED' })
    })
    const on = (_name: string, callback: (...args: never[]) => unknown, config?: { prepend?: boolean }) => {
      const listener = callback as Created
      if (_name !== 'agent/created') return () => {}
      if (config?.prepend) listeners.unshift(listener); else listeners.push(listener)
      return () => { const index = listeners.indexOf(listener); if (index !== -1) listeners.splice(index, 1) }
    }
    const makeChild = (id: string) => {
      const sections: unknown[] = [], restrictions: unknown[] = []
      const guards = new Set<(execution: ToolExecution) => string | undefined>()
      const child = { id, session: { header: { origin: 'subagent', parentSession: parent.id } }, ctx: {
        on: () => () => {},
        systemPrompt: { section: (value: unknown) => { sections.push(value) }, getSectionOrder: () => 0 },
        tools: {
          restrict: (value: unknown) => { restrictions.push(value) },
          guard: (value: (execution: ToolExecution) => string | undefined) => {
            if (options.guardFails) throw new Error('cannot install guard')
            guards.add(value)
            return () => { guards.delete(value) }
          },
        },
      } } as unknown as HostAgent
      publications.push({ agent: child, sections, restrictions, guards })
      return publications.at(-1)!
    }
    const startActivation = vi.fn(async (spec: Spec) => {
      if (spec.parent !== parent) throw new Error('activation requires an explicit live parent')
      if (typeof spec.childId !== 'string') throw new Error('this test requires a caller-reserved child identity')
      const entry = makeChild(spec.childId)
      live.set(entry.agent.id, entry.agent)
      const result = Promise.withResolvers<HostSubagentResult>()
      const dispose = async () => {
        disposals.push(entry.agent.id)
        live.delete(entry.agent.id)
        roots.delete(entry.agent)
        result.resolve({ output: [], stopReason: 'cancelled' })
      }
      try {
        if (options.foreignPublication) {
          const foreign = makeChild('foreign-child')
          const impostor = makeChild(entry.agent.id)
          for (const listener of [...listeners]) await listener({ agent: foreign.agent })
          for (const listener of [...listeners]) await listener({ agent: impostor.agent })
        }
        for (const listener of [...listeners]) await listener({ agent: entry.agent })
        roots.set(entry.agent, parent)
        firstSteps.push({ id: entry.agent.id, sections: [...entry.sections], restrictions: [...entry.restrictions], outside: [...entry.guards].map(guard => guard({ agent: entry.agent, name: 'outside', signal: spec.signal } as ToolExecution)).find(Boolean) })
        if (!options.hold) result.resolve({ output: [], stopReason: 'completed' })
        return { childId: entry.agent.id, result: result.promise, dispose }
      } catch (error) {
        await dispose()
        throw error
      }
    })
    const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }, prepareContinuable: () => {} }
    const subagents = { rootOf, getProvider: () => provider, startActivation } as unknown as HostSubagentsService
    const host = { agents: { get: (id: string) => live.get(id), list: () => [...live.values()] }, subagents, on }
    const input = (persona: string, signal = new AbortController().signal) => ({ parent, label: persona, prompt: [{ type: 'text' as const, text: persona }], persona, toolFilter: { allow: ['mnemon_subagent_result'] }, signal, maxDepth: 1, agentOptions: { provider: 'chosen', model: 'chosen-model', reasoningEffort: 'high', maxTokens: 4096 } })
    const start = (persona: string, signal?: AbortSignal) => startSubagent(subagents, host.agents, 'spawn', input(persona, signal), host)
    return { host, parent, subagents, rootOf, startActivation, start, input, live, publications, firstSteps, disposals, listeners }
  }

  it('uses flattened startup and a reserved identity while preserving composition and model routing', async () => {
    const f = activationHost({ foreignPublication: true })
    const run = await f.start('Isolated memory writer')
    const spec = f.startActivation.mock.calls[0]![0]
    expect(spec).toMatchObject({ parent: f.parent, childId: run.id, provider: 'spawn', delivery: 'caller', maxDepth: 1, agentOptions: f.input('').agentOptions })
    expect(spec).not.toHaveProperty('request')
    expect(f.firstSteps).toEqual([expect.objectContaining({ id: run.id, sections: [expect.objectContaining({ text: 'Isolated memory writer' })], restrictions: [{ allow: ['mnemon_subagent_result'] }] })])
    expect(f.publications.slice(1).map(entry => [entry.sections, entry.restrictions])).toEqual([[[], []], [[], []]])
    expect(run.localAgent).toBe(f.publications[0]!.agent)
    await run.dispose()
  })

  it('attaches the review guard before the first step without querying unpublished membership', async () => {
    const f = activationHost()
    const run = await startGuardedReview(f.host, f.parent, ['mnemon_subagent_result'], () => startWithContinuationTurns(f.host, f.parent, () => f.start('Reviewer')))
    expect(f.firstSteps[0]!.outside).toBeTruthy()
    expect(f.listeners).toEqual([])
    await run.dispose()
    expect(f.publications[0]!.guards.size).toBe(0)
  })

  it('keeps overlapping same-parent tasks scoped to their own persona and guard', async () => {
    const f = activationHost()
    const run = (name: string) => startGuardedChild(f.host, f.parent, () => f.start(name), () => `guard:${name}`, { purpose: name })
    const [a, b] = await Promise.all([run('A'), run('B')])
    expect(a.id).not.toBe(b.id)
    for (const step of f.firstSteps) {
      const persona = (step.sections[0] as { text: string }).text
      expect(step.outside).toBe(`guard:${persona}`)
    }
    await Promise.all([a.dispose(), b.dispose()])
  })

  it('rolls back failed guard installation before any first step, including optional guarded workflows', async () => {
    const f = activationHost({ guardFails: true })
    await expect(startGuardedChild(f.host, f.parent, () => f.start('Writer'), () => undefined, { purpose: 'write', optional: true })).rejects.toThrow('cannot install guard')
    expect(f.firstSteps).toEqual([])
    expect([...f.live.values()]).toEqual([f.parent])
    expect(f.disposals).toHaveLength(1)
  })

  it('does not lend its identity, persona or guard to a nested same-parent start', async () => {
    const f = activationHost()
    let enter = true
    let nested: Awaited<ReturnType<typeof f.start>> | undefined
    f.host.on('agent/created', (async () => {
      if (!enter) return
      enter = false
      nested = await f.start('Independent nested task')
    }) as never)
    const outer = await startGuardedReview(f.host, f.parent, ['mnemon_subagent_result'],
      () => startWithContinuationTurns(f.host, f.parent, () => f.start('Outer review')))
    expect(nested!.id).not.toBe(outer.id)
    expect(f.firstSteps.find(step => step.id === nested!.id)?.outside).toBeUndefined()
    expect(f.firstSteps.find(step => step.id === outer.id)?.outside).toBeTruthy()
    expect(f.firstSteps.map(step => step.sections)).toEqual([
      [expect.objectContaining({ text: 'Independent nested task' })],
      [expect.objectContaining({ text: 'Outer review' })],
    ])
    await Promise.all([outer.dispose(), nested!.dispose()])
  })

  it('disposes the exact active child on cancellation after startup', async () => {
    const f = activationHost({ hold: true })
    const controller = new AbortController()
    const run = await f.start('Cancellable task', controller.signal)
    controller.abort()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.disposals).toEqual([run.id])
    expect([...f.live.values()]).toEqual([f.parent])
  })
})

describe('continuation turns for delegated children', () => {
  type PreStep = (payload: { messages: HostUserMessage[]; step: number; signal: AbortSignal }, next: () => Promise<HostPreStepDecision>) => Promise<HostPreStepDecision>
  type RequestError = (payload: { turn: number; step: number; failure: { message: string; code: string }; signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>

  function host() {
    const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>()
    const owners = new Map<string, HostAgent>()
    const value = {
      agents: { isOwnedBy: (id: string, parent: HostAgent) => owners.get(id) === parent },
      on: vi.fn((name: string, listener: (...args: unknown[]) => unknown) => {
        const set = listeners.get(name) ?? new Set()
        set.add(listener)
        listeners.set(name, set)
        return () => { set.delete(listener) }
      }),
    }
    const created = (agent: HostAgent, parent: HostAgent) => {
      owners.set(agent.id, parent)
      for (const listener of listeners.get('agent/created') ?? []) listener({ agent })
    }
    return { value, created, observers: () => listeners.get('agent/created')?.size ?? 0 }
  }

  function agent(id: string) {
    const handlers = new Map<string, { handler: unknown; options: unknown }>()
    const stops: Array<ReturnType<typeof vi.fn>> = []
    const append = vi.fn()
    const value = { id, session: { append }, ctx: { on: vi.fn((name: string, handler: unknown, options?: unknown) => {
      handlers.set(name, { handler, options })
      const stop = vi.fn()
      stops.push(stop)
      return stop
    }) } } as unknown as HostAgent
    return {
      value, handlers, stops, append,
      preStep: () => handlers.get('agent/pre-step')!.handler as PreStep,
      requestError: () => handlers.get('agent/request-error')!.handler as RequestError,
    }
  }

  function run(id: string, child?: HostAgent): HostSubagentRun & { disposed: ReturnType<typeof vi.fn> } {
    const disposed = vi.fn(async () => {})
    return { id, ...(child === undefined ? {} : { localAgent: child }), result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: disposed, disposed }
  }

  const user = (text: string, kind = 'user'): HostUserMessage => ({ id: 'message-' + text, role: 'user', content: [{ type: 'text', text }], source: { kind } })
  const live = new AbortController().signal
  const refusal = { message: 'SERVER: no user query found in messages', code: 'SERVER_ERROR' }

  async function started() {
    const h = host()
    const parent = agent('parent').value
    const child = agent('child')
    const value = await startWithContinuationTurns(h.value, parent, async () => {
      h.created(child.value, parent)
      return run('child', child.value)
    })
    return { h, parent, child, run: value }
  }

  it('retries malformed completion arguments once per child, including its first step (issue 636)', async () => {
    const { child } = await started()
    const next = vi.fn(async () => undefined)
    const failure = { code: 'MALFORMED_RESPONSE', message: 'Tool call "mnemon_subagent_result": Expected comma or closing brace at position 647' }
    expect(await child.requestError()({ turn: 1, step: 1, failure, signal: live }, next)).toEqual({ kind: 'retry' })
    expect(child.append).toHaveBeenCalledExactlyOnceWith('user/message', expect.objectContaining({
      source: { kind: 'dsh-mnemon', form: 'instructions' },
      content: [{ type: 'text', text: expect.stringContaining('Do not repeat completed writes') }],
    }), { surfaceOp: 'append' })
    for (const step of [1, 2]) await child.requestError()({ turn: 1, step, failure, signal: live }, next)
    expect(next).toHaveBeenCalledTimes(2)
    expect(child.append).toHaveBeenCalledOnce()
  })

  it.each([
    { code: 'MALFORMED_RESPONSE', message: 'Tool call "mnemon_remember": Invalid JSON' },
    { code: 'RATE_LIMITED', message: 'Tool call "mnemon_subagent_result": rate limit' },
    { code: 'MALFORMED_RESPONSE', message: 'Other malformed provider response' },
  ])('does not retry unrelated response failures ($code, $message)', async failure => {
    const { child } = await started()
    const next = vi.fn(async () => undefined)
    await child.requestError()({ turn: 1, step: 1, failure, signal: live }, next)
    expect(next).toHaveBeenCalledOnce()
    expect(child.append).not.toHaveBeenCalled()
  })

  it('does not install recovery listeners on a disposed published child', async () => {
    const h = host(), parent = agent('parent').value, child = agent('disposed-child')
    const ctx = new Context()
    const fiber = await ctx.plugin({ name: 'mnemon-disposed-context', apply() {} })
    await fiber.dispose()
    Object.assign(child.value.ctx, { fiber })
    const active = await startWithContinuationTurns(h.value, parent, async () => {
      h.created(child.value, parent)
      return run(child.value.id, child.value)
    })
    expect(child.value.ctx.on).not.toHaveBeenCalled()
    expect(h.observers()).toBe(0)
    await active.dispose()
  })

  it('changes nothing until a server refuses a request without a user query', async () => {
    const { child, run: active } = await started()
    expect(active.localAgent).toBe(child.value)
    expect([...child.handlers.values()].map(entry => entry.options)).toEqual([{ prepend: true }, { prepend: true }])
    await expect(child.preStep()({ messages: [], step: 2, signal: live }, async () => ({ kind: 'enter', messages: [] }))).resolves.toEqual({ kind: 'enter', messages: [] })
    const next = vi.fn(async () => ({ kind: 'retry' }))
    await child.requestError()({ turn: 1, step: 2, failure: { message: '429 Too Many Requests', code: 'RATE_LIMITED' }, signal: live }, next)
    await child.requestError()({ turn: 1, step: 1, failure: refusal, signal: live }, next)
    await child.requestError()({ turn: 1, step: 2, failure: refusal, signal: AbortSignal.abort() }, next)
    expect(next).toHaveBeenCalledTimes(3)
    expect(child.append).not.toHaveBeenCalled()
    await expect(child.preStep()({ messages: [], step: 3, signal: live }, async () => ({ kind: 'enter', messages: [] }))).resolves.toEqual({ kind: 'enter', messages: [] })
  })

  it('ends a refused step with a user turn, retries it once, then ends each later continuation the same way', async () => {
    const { child } = await started()
    const next = vi.fn(async () => undefined)
    await expect(child.requestError()({ turn: 1, step: 4, failure: refusal, signal: live }, next)).resolves.toEqual({ kind: 'retry' })
    expect(next).not.toHaveBeenCalled()
    expect(child.append).toHaveBeenCalledExactlyOnceWith('user/message', expect.objectContaining({
      role: 'user', content: [{ type: 'text', text: CONTINUATION_TEXT }], source: { kind: 'dsh-mnemon', form: 'instructions' },
    }), { surfaceOp: 'append' })
    await child.requestError()({ turn: 1, step: 4, failure: refusal, signal: live }, next)
    expect(next).toHaveBeenCalledOnce()
    expect(child.append).toHaveBeenCalledOnce()
    const step = child.preStep()
    const continued = await step({ messages: [], step: 5, signal: live }, async () => ({ kind: 'enter', messages: [], startsRequestSeries: true } as HostPreStepDecision))
    expect(continued).toMatchObject({ kind: 'enter', startsRequestSeries: true, messages: [{ role: 'user', content: [{ type: 'text', text: CONTINUATION_TEXT }] }] })
    const steer = user('Also check the archive.')
    await expect(step({ messages: [steer], step: 6, signal: live }, async () => ({ kind: 'enter', messages: [steer] }))).resolves.toEqual({ kind: 'enter', messages: [steer] })
    const blank = user('  ', 'runtime-context')
    const padded = await step({ messages: [blank], step: 6, signal: live }, async () => ({ kind: 'enter', messages: [blank] }))
    expect(padded.kind === 'enter' && padded.messages.map(message => message.content)).toEqual([[{ type: 'text', text: '  ' }], [{ type: 'text', text: CONTINUATION_TEXT }]])
    await expect(step({ messages: [steer], step: 7, signal: live }, async () => ({ kind: 'enter', messages: [] }))).resolves.toEqual({ kind: 'enter', messages: [] })
    await expect(step({ messages: [], step: 1, signal: live }, async () => ({ kind: 'enter', messages: [] }))).resolves.toEqual({ kind: 'enter', messages: [] })
    await expect(step({ messages: [], step: 5, signal: live }, async () => ({ kind: 'reject' }))).resolves.toEqual({ kind: 'reject' })
    await expect(step({ messages: [], step: 5, signal: AbortSignal.abort() }, async () => ({ kind: 'enter', messages: [] }))).resolves.toEqual({ kind: 'enter', messages: [] })
  })

  it('leaves a refused step to the next handler where the session cannot take a message', async () => {
    const h = host()
    const parent = agent('parent').value
    const child = agent('child')
    Object.assign(child.value, { session: {} })
    await startWithContinuationTurns(h.value, parent, async () => { h.created(child.value, parent); return run('child', child.value) })
    const next = vi.fn(async () => undefined)
    await child.requestError()({ turn: 1, step: 4, failure: refusal, signal: live }, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('attaches only to the child its own start creates under the parent', async () => {
    const h = host()
    const parent = agent('parent').value
    const child = agent('child')
    const other = agent('other')
    const late = agent('late')
    const active = await startWithContinuationTurns(h.value, parent, async () => {
      h.created(other.value, agent('someone-else').value)
      h.created(child.value, parent)
      return run('child', child.value)
    })
    expect(child.handlers.size).toBe(2)
    expect(other.handlers.size).toBe(0)
    expect(h.observers()).toBe(0)
    h.created(late.value, parent)
    expect(late.handlers.size).toBe(0)
    await active.dispose()
    expect(child.stops.map(stop => stop.mock.calls.length)).toEqual([1, 1])
  })

  it('separates overlapping starts by their async context', async () => {
    const h = host()
    const parent = agent('parent').value
    const first = agent('first')
    const second = agent('second')
    let publishSecond!: () => void
    const secondPublished = new Promise<void>(resolve => { publishSecond = resolve })
    const one = startWithContinuationTurns(h.value, parent, async () => {
      await secondPublished
      h.created(first.value, parent)
      return run('first', first.value)
    })
    const two = startWithContinuationTurns(h.value, parent, async () => {
      h.created(second.value, parent)
      publishSecond()
      return run('second', second.value)
    })
    await Promise.all([one, two])
    expect(first.handlers.size).toBe(2)
    expect(second.handlers.size).toBe(2)
  })

  it('releases what it attached when the start fails', async () => {
    const h = host()
    const parent = agent('parent').value
    const child = agent('child')
    await expect(startWithContinuationTurns(h.value, parent, async () => {
      h.created(child.value, parent)
      throw new Error('provider rolled back the child')
    })).rejects.toThrow('provider rolled back the child')
    expect(child.stops.map(stop => stop.mock.calls.length)).toEqual([1, 1])
    expect(h.observers()).toBe(0)
  })

  it('leaves a child without these hooks, or a host without creation events, as it was', async () => {
    const h = host()
    const parent = agent('parent').value
    const bare = { id: 'bare', session: {}, ctx: {} } as unknown as HostAgent
    const active = await startWithContinuationTurns(h.value, parent, async () => {
      h.created(bare, parent)
      return run('bare', bare)
    })
    expect(active.id).toBe('bare')
    await active.dispose()
    const plain = run('plain')
    const result = await startWithContinuationTurns({ on: () => undefined }, parent, async () => plain)
    expect(result.id).toBe('plain')
    await result.dispose()
    expect(plain.disposed).toHaveBeenCalledOnce()
  })
})
