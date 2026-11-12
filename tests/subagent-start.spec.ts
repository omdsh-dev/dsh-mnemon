import { describe, expect, it, vi } from 'vitest'
import type { HostAgent, HostSubagentActivation, HostSubagentResult, HostSubagentsService } from '../src/host/dsh.ts'
import { childComposition, startSubagent } from '../src/host/subagent-start.ts'

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

/** A task as Mnemon starts it on DSH 0.2.1, its persona and tool filter already taken into the child's own scope. */
function task(signal = new AbortController().signal) {
  const { toolFilter: _toolFilter, persona: _persona, ...rest } = request(signal)
  return rest
}

/** DSH 0.2.0's spawn provider, which takes the persona and tool filter in the start request. */
const dsh020Provider = () => ({ capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, prepareContinuable: () => {} })

/** DSH 0.2.1: `start` is gone and every child is a managed activation. */
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
    // As on DSH 0.2.1: the child is resident when startActivation resolves and leaves the
    // registry before the result settles, at least one model turn later.
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

/** DSH 0.2.1: no provider takes a persona or tool filter, and a child joins its parent's composition. */
const DSH_021_CAPABILITIES = { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }

type CreatedListener = (payload: { agent: HostAgent }) => unknown

/** DSH 0.2.1's spawn provider: it prepares local activations, so DSH creates its children in this process. */
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
    // Another plugin's child, published meanwhile, belongs to another parent.
    if (stranger !== undefined) for (const listener of [...listeners]) await listener({ agent: stranger })
    if (publish) {
      owners.set('child-1', spec.request.parent)
      // DSH awaits each creation listener after composing the child; a failure rolls the child back.
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
    // A provider that runs its children elsewhere has nothing for Mnemon to compose here.
    expect(childComposition(activations, { capabilities: DSH_021_CAPABILITIES })).toBeUndefined()
    // DSH 0.2.0 has no activations: a provider omitting both capabilities is refused there as before.
    expect(childComposition({} as HostSubagentsService, localProvider())).toBeUndefined()
    expect(childComposition(activations, { capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false } })).toBeUndefined()
    expect(childComposition(activations, undefined)).toBeUndefined()
  })

  it('composes before other plugins see the child', async () => {
    const host = composingHost()

    await startSubagent(host.subagents, host.agents, 'spawn', request(), host.publications)

    // Cordis stops a serial event at the first listener that returns a value; Mnemon's runs first.
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
      // The first child is published only after the second start has published its own.
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
    // Publication is observed only while the child starts.
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
    // Nothing is registered: the persona alone would leave the parent's tools in reach.
    expect(host.sections).toEqual([])
    expect(host.listeners.size).toBe(0)
  })

  it('says why a child cannot be composed without observing its publication', async () => {
    const host = composingHost()

    await expect(startSubagent(host.subagents, host.agents, 'spawn', request())).rejects.toThrow('This DSH takes no subagent persona or tool filter at start')
    expect(host.startActivation).not.toHaveBeenCalled()
  })
})
