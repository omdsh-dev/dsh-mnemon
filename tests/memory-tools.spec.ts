import { readFileSync } from 'node:fs'
import * as dshTools from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { MnemonAnchorPage } from '../src/client/anchor.ts'
import { TurnActivityProjection } from '../src/host/activity.ts'
import type { namedToolPresentation } from '../src/host/activity-presentation.ts'
import { createMnemonCommand } from '../src/host/commands.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { HostAgent, HostAgentContext, HostContextShape, HostSessionEvent, HostToolExecutionInput, ToolDefinition } from '../src/host/dsh.ts'
import { MemoryExecutions } from '../src/host/memory-executions.ts'
import { MEMORY_TOOLS, memoryTool, type MemoryToolPage } from '../src/host/protocol.ts'
import { mutationResultCommitted } from '../src/host/receipts.ts'
import { agentScope, type MnemonAgentRuntimeSource, type MnemonRuntimeGraph } from '../src/host/runtime.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { AutomaticReviewAdmission } from '../src/host/review-admission.ts'
import { executeHostTool, usesToolBatchExecution } from '../src/host/tool-execution.ts'
import { registerTools } from '../src/host/tools.ts'
import { modelMemoryWake, presentMemoryWake, unofferedViewId } from '../src/host/view-presentation.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { toolContributions } from './fixtures/tool-contributions.ts'
import { cleanupSubagentFixtures, parent, releases } from './fixtures/subagent-coordinator.ts'
import { requireDsh } from './helpers/installed-dsh.ts'

describe('memory tool table', () => {
  const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })

  /** Every tool the Host registers, the result tool of delegated children included, in registration order. */
  function registered(): ToolDefinition[] {
    const tools: ToolDefinition[] = []
    const register = (tool: ToolDefinition) => { tools.push(tool); return () => {} }
    const coordinator = new MnemonSubagentCoordinator({} as never, {} as never, { tools: { register }, on: () => () => {} } as never)
    registerTools({ tools: { register } } as unknown as HostContextShape, {} as never, coordinator, toolContributions())
    return tools
  }

  /**
   * What DSH shows the model of a tool: its name, description and input schema, deferLoading when a
   * tool sets it, and the output schema the TypeScript declarations of Code Mode type its result with.
   */
  function modelVisible(tool: ToolDefinition) {
    const deferred = (tool as { deferLoading?: unknown }).deferLoading === true
    return { name: tool.name, description: tool.description, parameters: tool.parameters, ...(deferred ? { deferLoading: true as const } : {}), output: tool.output.schema }
  }

  it('describes hot-memory eligibility without treating transient facts as low priority (#655)', () => {
    const tool = registered().find(tool => tool.name === 'mnemon_runtime_memory')!
    expect(tool.description).toContain('durable user-authored')
    expect(tool.description).toContain('Project records')
    expect(tool.description).toContain('otherwise skip')
    expect(tool.description).toContain('explicitly chooses Runtime')
    expect(JSON.stringify(tool.parameters)).not.toContain('low for transient facts')
    expect(JSON.stringify(tool.parameters)).not.toContain('project, environment, decisions, and lessons')
  })

  it('documents per-action required fields in mnemon_runtime_memory while keeping DSH schema compatibility (#746)', async () => {
    const tool = registered().find(item => item.name === 'mnemon_runtime_memory')!
    expect(() => dshTools.assertObjectJsonSchema(tool.parameters)).not.toThrow()
    const parameters = tool.parameters as {
      type: string
      required: string[]
      properties: Record<string, { description?: string }>
    }
    expect(parameters.type).toBe('object')
    expect(parameters.required).toEqual(['action', 'target'])
    expect(parameters.properties.action?.description).toContain('requires content')
    expect(parameters.properties.action?.description).toContain('requires old_text and content')
    expect(parameters.properties.action?.description).toContain('requires old_text')
    expect(parameters.properties.content?.description).toContain('Required for action=add and action=replace')
    expect(parameters.properties.old_text?.description).toContain('Required for action=replace and action=remove')
    const codeMode: Pick<typeof dshTools, 'renderToolsSdk' | 'renderToolsSdkPy'> = typeof dshTools.renderToolsSdk === 'function'
      ? dshTools
      : await import(requireDsh.resolve('@deepseek-ai/dsh-tool-executor-ptc'))
    const sdkEntry = modelVisible(tool)
    const tsSdk = codeMode.renderToolsSdk([sdkEntry])
    const pySdk = codeMode.renderToolsSdkPy([sdkEntry])
    expect(tsSdk).toContain('mnemon_runtime_memory: {')
    expect(tsSdk).toContain('content?: string;')
    expect(tsSdk).toContain('old_text?: string;')
    expect(tsSdk).not.toContain('mnemon_runtime_memory: unknown;')
    expect(pySdk).toContain('class MnemonRuntimeMemoryArgs(TypedDict):')
    expect(pySdk).toContain('content: NotRequired[str]')
    expect(pySdk).toContain('old_text: NotRequired[str]')
  })

  it('has a row for every memory tool the Host registers, in registration order, and for nothing else', () => {
    const names = registered().map(tool => tool.name)
    // The result tool delegated children finish with runs no Source operation, so it has no row.
    expect(names.filter(name => name !== 'mnemon_subagent_result')).toEqual(Object.keys(MEMORY_TOOLS))
    expect(memoryTool('mnemon_subagent_result')).toBeUndefined()
    expect(memoryTool('toString')).toBeUndefined()
  })

  it('keeps every model-visible tool name, description, input and output schema byte-identical', () => {
    // A checkout that turns line endings into CRLF changes no byte the model sees.
    const fixture = readFileSync(new URL('./fixtures/model-tools.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(JSON.stringify(registered().map(modelVisible), null, 2) + '\n').toBe(fixture)
  })

  it('types the pages as anchor pages, and records activity only for the tools that read or write', () => {
    expectTypeOf<MemoryToolPage>().toEqualTypeOf<MnemonAnchorPage>()
    expectTypeOf<Parameters<typeof namedToolPresentation>[0]>().toEqualTypeOf<'mnemon_recall' | 'mnemon_related' | 'mnemon_document_search'
      | 'mnemon_document_create' | 'mnemon_document_manage' | 'mnemon_runtime_memory' | 'mnemon_remember' | 'mnemon_link' | 'mnemon_forget'
      | 'mnemon_memory_body_create' | 'mnemon_memory_body_update' | 'mnemon_memory_body_merge'>()
  })

  it('records the Source and operation each named tool runs, as its activity always named them', () => {
    const recorded = Object.fromEntries(registered().flatMap(tool => {
      const present = tool.output.presentationMeta
      if (present === undefined) return []
      const meta = present({}, {}) as { kind: string; sourceTypeId?: string; operationId: string }
      return [[tool.name, [meta.kind, meta.sourceTypeId, meta.operationId]]]
    }))
    expect(recorded).toEqual({
      // Without the call that served it, a generic View call records its tool's own operation.
      mnemon_view_route: ['read', undefined, 'view-route'],
      mnemon_view_action: ['write', undefined, 'view-action'],
      mnemon_recall: ['read', 'memory-spaces', 'recall'],
      mnemon_related: ['read', 'memory-spaces', 'related'],
      mnemon_document_search: ['read', 'documents', 'search'],
      mnemon_document_create: ['write', 'documents', 'create'],
      mnemon_document_manage: ['write', 'documents', 'manage'],
      mnemon_runtime_memory: ['write', 'runtime', 'mutate'],
      mnemon_remember: ['write', 'memory-spaces', 'remember'],
      mnemon_link: ['write', 'memory-spaces', 'link'],
      mnemon_forget: ['write', 'memory-spaces', 'forget'],
      mnemon_memory_body_create: ['write', 'memory-spaces', 'manage-spaces'],
      mnemon_memory_body_update: ['write', 'memory-spaces', 'manage-spaces'],
      mnemon_memory_body_merge: ['write', 'memory-spaces', 'manage-spaces'],
    })
    // Inspections read health or the catalog, not memory, and record no activity.
    for (const [name, tool] of Object.entries(MEMORY_TOOLS)) {
      if (tool.kind === 'inspect') expect(recorded[name]).toBeUndefined()
      else if ('sourceTypeId' in tool) expect(recorded[name]).toEqual([tool.kind, tool.sourceTypeId, tool.operation])
    }
  })

  it('binds every Source operation a named tool runs, on the Starter instance of each Source type, as before', () => {
    const runtime = 'source:mnemon-source-runtime', documents = 'source:mnemon-source-documents', spaces = 'source:mnemon-source-memory-spaces'
    const other = 'source:mnemon-source-runtime-global'
    const instances = [[runtime, 'runtime'], [documents, 'documents'], [spaces, 'memory-spaces'], [other, 'runtime']] as const
    const route = (key: string, id: string) => ({ id: `${key}/${id}`, sourceInstanceKey: key, sourceRouteId: id, readGrantId: `${key}/grant`, description: id, inputSchema: {}, maxCalls: 1 })
    const offer = (key: string, id: string) => ({ id: `${key}/${id}`, sourceInstanceKey: key, sourceActionId: id, description: id, inputSchema: {} })
    const view = {
      id: 'view:every-operation', digest: 'every-operation', projection: [],
      readGrants: instances.map(([key, type]) => ({ id: `${key}/grant`, sourceInstanceKey: key, schema: `dsh-mnemon.${type}/v1` })),
      routes: [route(documents, 'search'), route(spaces, 'inspect'), route(spaces, 'recall'), route(spaces, 'related')],
      actionOffers: [offer(runtime, 'mutate'), offer(documents, 'manage'), offer(documents, 'create'), offer(spaces, 'remember'), offer(spaces, 'link'),
        offer(spaces, 'forget'), offer(spaces, 'manage-spaces'), offer(other, 'mutate')],
    }
    const generation = { sourceInstances: () => instances.map(([sourceInstanceKey, sourceTypeId]) => ({ sourceInstanceKey, sourceTypeId })) }
    const lines = presentMemoryWake(generation as never, view as never).text.split('\n')
    expect(lines.filter(line => line.startsWith('MNEMON VIEW TOOLS'))).toEqual(['MNEMON VIEW TOOLS (available in this View): mnemon_document_search, '
      + 'mnemon_memory_bodies / mnemon_status, mnemon_recall, mnemon_related, mnemon_runtime_memory, mnemon_document_manage, mnemon_document_create, '
      + 'mnemon_remember, mnemon_link, mnemon_forget, mnemon_memory_body_create / mnemon_memory_body_update / mnemon_memory_body_merge'])
    // The other runtime instance keeps its exact offer for mnemon_view_action.
    const routes = lines.find(line => line.startsWith('MNEMON VIEW ROUTES'))!
    expect(JSON.parse(routes.slice(routes.indexOf(': ') + 2))).toEqual([{ source: other, routes: [], actions: [{ id: `${other}/mutate`, description: 'mutate', inputSchema: {} }] }])
  })

  it('counts each settled call in the counter it always added to', () => {
    const names = [...Object.keys(MEMORY_TOOLS), 'mnemon_subagent_result', 'mnemon_notes_digest']
    // One turn per call, so each turn shows exactly which counter its call added to.
    const events = names.flatMap((name, index): HostSessionEvent[] => [
      { type: 'tool/call', seq: index * 2 + 1, data: { turn: index + 1, step: 1, callId: `call-${index}`, name, arguments: '{}' } },
      { type: 'tool/result', seq: index * 2 + 2, data: { turn: index + 1, step: 1, message: { source: { callId: `call-${index}` } } } },
    ])
    const activities = new TurnActivityProjection().snapshot(events).activities
    expect(activities.map(activity => activity.names)).toEqual(names.map(name => [name]))
    const counters = ['recalls', 'writes', 'documentSearches', 'inspections', 'failures'] as const
    const counted = Object.fromEntries(activities.map(activity => [activity.names[0], counters.filter(counter => activity[counter] > 0)]))
    expect(counted).toEqual({
      mnemon_view_route: [],
      mnemon_view_action: [],
      mnemon_memory_bodies: ['inspections'],
      mnemon_recall: ['recalls'],
      mnemon_related: ['recalls'],
      mnemon_status: ['inspections'],
      mnemon_document_search: ['documentSearches'],
      mnemon_document_create: ['writes'],
      mnemon_document_manage: ['writes'],
      mnemon_runtime_memory: ['writes'],
      mnemon_remember: ['writes'],
      mnemon_link: ['writes'],
      mnemon_forget: ['writes'],
      mnemon_memory_body_create: ['writes'],
      mnemon_memory_body_update: ['writes'],
      mnemon_memory_body_merge: ['writes'],
      mnemon_subagent_result: [],
      mnemon_notes_digest: [],
    })
  })

  it('names the tools the default View binds exactly as the model has read them', async () => {
    const f = await compositionFixture()
    fixtures.push(f)
    await f.memorySpace()
    const turn = await f.graph.composableTurns.beginTurn('root:tools', { storage: 'custom', workspaceId: f.workspace, agentId: 'root' })
    const named = modelMemoryWake(f.graph, turn).text.split('\n').filter(line => line.startsWith('MNEMON VIEW TOOLS'))
    expect(named).toEqual(['MNEMON VIEW TOOLS (available in this View): mnemon_document_search, mnemon_memory_bodies / mnemon_status, mnemon_recall, mnemon_related, '
      + 'mnemon_runtime_memory, mnemon_document_manage, mnemon_document_create, mnemon_memory_body_create / mnemon_memory_body_update / mnemon_memory_body_merge, '
      + 'mnemon_remember, mnemon_forget'])
  })

  it('lists only scoped tools and leaves pinned authority and Runtime content intact (#656)', async () => {
    const f = await compositionFixture()
    fixtures.push(f)
    await f.memorySpace()
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic retained context.' })
    const turn = await f.graph.composableTurns.beginTurn('root:restricted', { storage: 'custom', workspaceId: f.workspace, agentId: 'root' })
    const before = structuredClone(turn.view)
    const allowed = new Set(['mnemon_recall', 'mnemon_status', 'mnemon_runtime_memory', 'mnemon_document_search', 'mnemon_document_create'])
    const agent = { ctx: { tools: { get(name: string, scope: HostAgent) { expect(this).toBe(agent.ctx.tools); expect(scope).toBe(agent); return allowed.has(name) ? {} : undefined } } } } as HostAgent
    const wake = modelMemoryWake(f.graph, turn, true, agent)
    expect(wake.text).toContain('Synthetic retained context.')
    expect(wake.text.split('\n').find(line => line.startsWith('MNEMON VIEW TOOLS'))).toBe('MNEMON VIEW TOOLS (available in this View): mnemon_document_search, mnemon_status, mnemon_recall, mnemon_runtime_memory, mnemon_document_create')
    expect(wake.text).not.toContain('MNEMON VIEW ROUTES')
    expect(turn.view).toEqual(before)
    expect(wake.viewDigest).toBe(turn.view.digest)
    expect(modelMemoryWake(f.graph, turn).text).toContain('mnemon_remember')
    expect(modelMemoryWake(f.graph, turn, true, { ctx: { tools: { get: () => ({}) } } } as unknown as HostAgent)).toEqual(modelMemoryWake(f.graph, turn))
    expect(modelMemoryWake(f.graph, turn, true, { ctx: {} } as HostAgent)).toEqual(modelMemoryWake(f.graph, turn))
    allowed.clear()
    const blocked = modelMemoryWake(f.graph, turn, true, agent)
    expect(blocked.text).not.toContain('MNEMON VIEW TOOLS')
    expect(blocked.text).not.toContain('MNEMON VIEW ROUTES')
    expect(blocked.text).toContain('Synthetic retained context.')
    expect(turn.view).toEqual(before)
  })

  it.each(['mnemon_view_route', 'mnemon_view_action'])('offers exact generic ids only through visible %s (#656)', async name => {
    const f = await compositionFixture()
    fixtures.push(f)
    await f.memorySpace()
    const turn = await f.graph.composableTurns.beginTurn('root:generic', { storage: 'custom', workspaceId: f.workspace, agentId: 'root' })
    const agent = { ctx: { tools: { get: (tool: string) => tool === name ? {} : undefined } } } as unknown as HostAgent
    const wake = modelMemoryWake(f.graph, turn, true, agent)
    expect(wake.text).not.toContain('MNEMON VIEW TOOLS')
    const line = wake.text.split('\n').find(text => text.startsWith('MNEMON VIEW ROUTES'))!
    expect(line).toContain(`use ${name} by exact id`)
    if (name === 'mnemon_view_route') expect(unofferedViewId(f.graph, turn, 'route', 'recall', agent)).not.toContain('call that tool')
    else expect(unofferedViewId(f.graph, turn, 'action', 'remember', agent)).not.toContain('call that tool')
    const offers = JSON.parse(line.slice(line.indexOf(': ') + 2)) as Array<{ routes: unknown[]; actions: unknown[] }>
    expect(offers.flatMap(offer => name === 'mnemon_view_route' ? offer.routes : offer.actions).length).toBeGreaterThan(0)
    expect(offers.flatMap(offer => name === 'mnemon_view_route' ? offer.actions : offer.routes)).toEqual([])
  })
})

describe('Host tool execution contracts', () => {
  type HostTools = NonNullable<HostAgentContext['tools']>
  const input: HostToolExecutionInput = {
    callId: 'synthetic-admission', name: 'mnemon_subagent_result', arguments: { requestId: 'synthetic-challenge', result: {} },
    agent: { id: 'synthetic-parent' } as HostAgent, signal: new AbortController().signal,
  }
  function batchHost(execute: (input: unknown) => Promise<unknown>): HostTools {
    return { setExecutor: () => undefined, execute: execute as NonNullable<HostTools['execute']> }
  }

  it('uses the legacy contract once and keeps its owning service receiver', async () => {
    let received: unknown
    const result = { isError: false }
    const tools: HostTools = { async execute(value) { expect(this).toBe(tools); received = value; return result } }
    expect(usesToolBatchExecution(tools)).toBe(false)
    expect(await executeHostTool(tools, input)).toBe(result)
    expect(received).toBe(input)
  })

  it.each([false, true])('retains the matching authoritative batch outcome (isError=%s)', async isError => {
    const received: unknown[] = []
    const result = { isError }
    const tools = batchHost(async function (this: HostTools, value) {
      expect(this).toBe(tools)
      received.push(value)
      return { results: [{ callId: input.callId, result }], additionalContexts: [], concluded: false }
    })
    expect(usesToolBatchExecution(tools)).toBe(true)
    expect(await executeHostTool(tools, input)).toBe(result)
    expect(received).toEqual([{
      calls: [{ type: 'tool-call', id: 'synthetic-admission', name: 'mnemon_subagent_result', arguments: '{"requestId":"synthetic-challenge","result":{}}' }],
      agent: input.agent, signal: input.signal,
    }])
  })

  it.each([
    undefined,
    { results: [] },
    { results: [{ callId: 'foreign-call', result: { isError: false } }] },
    { results: [{ callId: input.callId, result: { isError: false } }, { callId: input.callId, result: { isError: true } }] },
    { results: [{ callId: input.callId, result: {} }] },
    { results: { length: 1, 0: { callId: input.callId, result: { isError: false } } } },
  ])('rejects malformed batch outcomes without another dispatch: %j', async outcome => {
    let calls = 0
    const tools = batchHost(async () => { calls++; return outcome })
    await expect(executeHostTool(tools, input)).rejects.toThrow('did not return the requested call outcome')
    expect(calls).toBe(1)
  })

  it('preserves executor failures without trying another input shape', async () => {
    const failure = new Error('Synthetic executor failure after dispatch')
    let calls = 0
    const tools = batchHost(async () => { calls++; throw failure })
    await expect(executeHostTool(tools, input)).rejects.toBe(failure)
    expect(calls).toBe(1)
  })

  it('rejects an unavailable tool execution service', async () => {
    await expect(executeHostTool({}, input)).rejects.toThrow('unavailable')
  })

  it('omits agent for standalone batch execution when undefined', async () => {
    const received: unknown[] = []
    const result = { isError: false }
    const tools = batchHost(async value => {
      received.push(value)
      return { results: [{ callId: input.callId, result }], additionalContexts: [], concluded: false }
    })
    const { agent: _omitted, ...standalone } = input
    expect(await executeHostTool(tools, standalone)).toBe(result)
    expect(received).toEqual([{
      calls: [{ type: 'tool-call', id: 'synthetic-admission', name: 'mnemon_subagent_result', arguments: '{"requestId":"synthetic-challenge","result":{}}' }],
      signal: input.signal,
    }])
    expect('agent' in (received[0] as Record<string, unknown>)).toBe(false)
  })
})

describe('AutomaticReviewAdmission under DSH 0.2.2 batch Auto review (issue 704)', () => {
  type ResultListener = (execution: { callId?: string; rootCallId?: string; agent?: HostAgent; name?: string; signal: AbortSignal }, result: { isError: boolean }) => void
  type PreExecuteListener = (execution: { callId?: string; rootCallId?: string; agent?: HostAgent; name?: string; signal: AbortSignal }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>

  function createBatchAutoHarness(options: {
    rootPtc?: boolean
    executableVisible?: boolean
    guardDeny?: (execution: { name?: string; agent?: HostAgent; parent?: symbol }) => string | undefined
    rootAsk?: boolean
  } = {}) {
    const resultListeners = new Set<ResultListener>()
    const preListeners: PreExecuteListener[] = []
    const dispatches: Array<{ name: string; agent: HostAgent | undefined }> = []
    const guardChecks: Array<{ name: string | undefined; agent: HostAgent | undefined; nested: boolean }> = []
    const host = {
      on(event: string, listener: (...args: never[]) => unknown, opts?: { prepend?: boolean }) {
        if (event === 'tools/result') {
          resultListeners.add(listener as unknown as ResultListener)
          return () => { resultListeners.delete(listener as unknown as ResultListener) }
        }
        if (event === 'tools/pre-execute') {
          const fn = listener as unknown as PreExecuteListener
          if (opts?.prepend) preListeners.unshift(fn)
          else preListeners.push(fn)
          return () => {
            const index = preListeners.indexOf(fn)
            if (index >= 0) preListeners.splice(index, 1)
          }
        }
        return () => undefined
      },
    }
    const admission = new AutomaticReviewAdmission(host)
    const runPre = async (execution: { callId?: string; rootCallId?: string; agent?: HostAgent; name?: string; signal: AbortSignal }): Promise<{ kind: string }> => {
      const dispatch = (index: number): Promise<{ kind: string }> => {
        const listener = preListeners[index]
        if (listener === undefined) return Promise.resolve({ kind: options.rootAsk ? 'ask' : 'allow' })
        return listener(execution, () => dispatch(index + 1))
      }
      return dispatch(0)
    }
    const openEvents: HostSessionEvent[] = [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    ]
    const tools = {
      setExecutor: () => undefined,
      executable: (name: string) => name === 'mnemon_subagent_result' && options.executableVisible === false ? undefined : { name },
      checkGuards: (execution: { name?: string; agent?: HostAgent; parent?: symbol }) => {
        guardChecks.push({ name: execution.name, agent: execution.agent, nested: execution.parent !== undefined })
        const reason = options.guardDeny?.(execution)
        return reason === undefined ? undefined : { reason }
      },
      execute: async (batch: { calls: { id: string; name: string; arguments: string }[]; agent?: HostAgent; signal: AbortSignal }) => {
        const call = batch.calls[0]!
        dispatches.push({ name: call.name, agent: batch.agent })
        if (batch.agent !== undefined) {
          return {
            results: [{ callId: call.id, result: { isError: true } }],
            additionalContexts: [],
            concluded: false,
          }
        }
        const rootPtc = options.rootPtc === true
        if (rootPtc && call.name !== 'run_code') {
          return { results: [{ callId: call.id, result: { isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } } }], additionalContexts: [], concluded: false }
        }
        const parsed = JSON.parse(call.arguments) as { requestId?: string; code?: string }
        const args = call.name === 'run_code'
          ? JSON.parse(parsed.code!.match(/mnemon_subagent_result\((.+)\)$/u)![1]!) as { requestId: string }
          : parsed
        const execution = {
          callId: call.id,
          rootCallId: call.id,
          name: 'mnemon_subagent_result',
          signal: batch.signal,
          ...(batch.agent === undefined ? {} : { agent: batch.agent }),
        }
        const pre = await runPre(execution)
        if (pre.kind !== 'allow') {
          return { results: [{ callId: call.id, result: { isError: true } }], additionalContexts: [], concluded: false }
        }
        const acknowledged = admission.acknowledge(args, execution)
        const outcome = { isError: !acknowledged }
        for (const listener of [...resultListeners]) listener(execution, outcome)
        return { results: [{ callId: call.id, result: outcome }], additionalContexts: [], concluded: false }
      },
    }
    const agent = {
      id: 'auto-batch-parent',
      status: 'running',
      session: {
        seq: openEvents.length,
        snapshotEvents: (from = 0, to = openEvents.length) => openEvents.slice(from, to),
        eventAt: (seq: number) => openEvents[seq],
        surface: { nodes: [] },
      },
      ctx: {
        tools,
        get: (name: string) => name === 'permissionPresets' ? { current: () => 'auto' } : undefined,
        on: () => () => undefined,
        effect: () => () => undefined,
      },
    } as unknown as HostAgent
    return { admission, agent, dispatches, guardChecks }
  }

  it("uses the standalone native probe with the agent's result tool guard under Auto", async () => {
    const h = createBatchAutoHarness()
    expect(await h.admission.check(h.agent, new AbortController().signal)).toBe(true)
    expect(h.admission.status(h.agent)).toEqual({ state: 'available', checkedAt: expect.any(String) })
    expect(h.dispatches).toEqual([{ name: 'mnemon_subagent_result', agent: undefined }])
    expect(h.guardChecks).toEqual([
      { name: 'mnemon_subagent_result', agent: h.agent, nested: false },
    ])
  })

  it('rejects admission when agent-scoped checkGuards denies mnemon_subagent_result or run_code under Auto', async () => {
    const deniedTool = createBatchAutoHarness({
      guardDeny: exec => exec.agent !== undefined && exec.name === 'mnemon_subagent_result' ? 'Blocked by agent guard.' : undefined,
    })
    expect(await deniedTool.admission.check(deniedTool.agent, new AbortController().signal)).toBe(false)
    expect(deniedTool.admission.status(deniedTool.agent)).toMatchObject({ state: 'unavailable', reason: 'handler-not-reached' })
    expect(deniedTool.dispatches).toEqual([])

    const deniedPtc = createBatchAutoHarness({
      rootPtc: true,
      guardDeny: exec => exec.agent !== undefined && exec.name === 'run_code' ? 'Blocked run_code.' : undefined,
    })
    expect(await deniedPtc.admission.check(deniedPtc.agent, new AbortController().signal)).toBe(false)
    expect(deniedPtc.admission.status(deniedPtc.agent)).toMatchObject({ state: 'unavailable', reason: 'handler-not-reached' })
    expect(deniedPtc.dispatches).toEqual([{ name: 'mnemon_subagent_result', agent: undefined }])
  })

  it('retains the scoped probe when an Auto host cannot check agent guards', async () => {
    const h = createBatchAutoHarness()
    delete h.agent.ctx.tools!.checkGuards
    expect(await h.admission.check(h.agent, new AbortController().signal)).toBe(false)
    expect(h.dispatches.length).toBeGreaterThan(0)
    expect(h.dispatches.every(dispatch => dispatch.agent === h.agent)).toBe(true)
  })

  it('rejects admission when executable hides mnemon_subagent_result under Auto', async () => {
    const h = createBatchAutoHarness({ executableVisible: false })
    expect(await h.admission.check(h.agent, new AbortController().signal)).toBe(false)
    expect(h.admission.status(h.agent)).toMatchObject({ state: 'unavailable', reason: 'handler-not-reached' })
    expect(h.dispatches).toEqual([])
  })

  it('preserves approval-required without trying run_code when root executor is native under Auto', async () => {
    const h = createBatchAutoHarness({ rootAsk: true })
    expect(await h.admission.check(h.agent, new AbortController().signal)).toBe(false)
    expect(h.admission.status(h.agent)).toMatchObject({ state: 'unavailable', reason: 'approval-required' })
    expect(h.dispatches).toEqual([{ name: 'mnemon_subagent_result', agent: undefined }])
  })

  it('falls back to standalone run_code when the root executor itself is PTC under Auto', async () => {
    const h = createBatchAutoHarness({ rootPtc: true })
    expect(await h.admission.check(h.agent, new AbortController().signal)).toBe(true)
    expect(h.dispatches).toEqual([
      { name: 'mnemon_subagent_result', agent: undefined },
      { name: 'run_code', agent: undefined },
    ])
    expect(h.guardChecks).toEqual([
      { name: 'mnemon_subagent_result', agent: h.agent, nested: false },
      { name: 'run_code', agent: h.agent, nested: false },
      { name: 'mnemon_subagent_result', agent: h.agent, nested: true },
    ])
  })
})

describe('Host durable completion evidence', () => {
  const committed = { status: 'succeeded', completion: 'committed', committedAt: '2026-08-31T00:00:00.000Z' }

  it('accepts explicit Core commits in both View and named tool results', () => {
    expect(mutationResultCommitted(committed)).toBe(true)
    expect(mutationResultCommitted({ action: 'stored', memoryReceipt: committed })).toBe(true)
  })

  it.each(['accepted', 'candidate', 'partial', 'failed', 'unknown'])('does not retire data on %s completion', completion => {
    expect(mutationResultCommitted({ action: 'stored', success: true, memoryReceipt: { ...committed, completion } })).toBe(false)
    expect(mutationResultCommitted({ ...committed, completion })).toBe(false)
  })

  it.each([
    { ...committed, status: 'failed' }, { ...committed, committedAt: undefined }, { ...committed, committedAt: 'invalid' },
    { ...committed, completion: 'unexpected' }, null, [], true,
  ])('rejects an incomplete or invalid commit envelope: %j', memoryReceipt => {
    expect(mutationResultCommitted({ action: 'stored', memoryReceipt })).toBe(false)
  })

  it.each([
    { success: true }, { ok: true }, { stored: Infinity }, { action: 'stored', status: 'partial' },
    { action: 'stored', state: 'candidate' }, { action: 'stored', errors: 1 }, { imported: 1, errors: ['failed row'] },
    { action: 'stored', status: 'queued' }, { action: 'stored', committed: false },
  ])('does not infer durability from ambiguous Source management output: %j', result => {
    expect(mutationResultCommitted(result)).toBe(false)
  })

  it.each([{ action: 'added' }, { status: 'committed' }, { imported: 1, errors: 0 }, { durable: true }])('retains explicit Source management completion: %j', result => {
    expect(mutationResultCommitted(result)).toBe(true)
  })
})

describe('/mnemon command', () => {
  function runtime(fixture: { config: { writeEnabled: boolean; defaultRecallLimit: number; embedding?: { enabled: boolean } }; status?: () => Promise<unknown> }): MnemonAgentRuntimeSource {
    const config = resolveConfig(fixture.config)
    const source = {
      config,
      forAgent: () => ({ config, source: () => ({ read: fixture.status }) }) as unknown as MnemonRuntimeGraph,
      bindAgentRuntime: () => () => {},
    }
    return { ...source, executions: new MemoryExecutions(source) }
  }

  const agent = { id: 'session-1', session: { header: {} } } as HostAgent
  function invocation(rawInput: string) {
    return { agent, rawInput, signal: new AbortController().signal }
  }

  function coordinator(overrides: Partial<MnemonSubagentCoordinator> = {}): MnemonSubagentCoordinator {
    return {
      recall: vi.fn(async (_agent, request) => ({ query: request.query, mode: 'smart', results: [] })),
      related: vi.fn(async () => ({ query: 'related', mode: 'related', results: [] })),
      remember: vi.fn(async () => ({ delegated: true, runId: 'child-1', provider: 'spawn', summary: '', action: 'stored', memoryBodyIds: ['project'] })),
      write: vi.fn(async () => ({ delegated: true, runId: 'child-1', provider: 'spawn', summary: '', action: 'forgotten', memoryBodyIds: ['project'] })),
      ...overrides,
    } as unknown as MnemonSubagentCoordinator
  }

  it('renders status without involving the model', async () => {
    const service = {
      config: { writeEnabled: true, defaultRecallLimit: 10 },
      status: vi.fn(async () => ({
        healthy: true,
        version: '0.1.2',
        cliPath: '/usr/local/bin/mnemon',
        dataDir: '/tmp/mnemon',
        store: 'project',
        mnemonDefaultStore: 'default',
        dshActiveStores: ['project'],
        writeEnabled: true,
        defaultRecallLimit: 10,
        stats: { totalInsights: 3, edgeCount: 2, deletedInsights: 1 },
      })),
    }
    const result = await createMnemonCommand(runtime(service), coordinator()).handler(invocation('status'))
    expect(result).toEqual(expect.objectContaining({
      kind: 'success',
      text: expect.stringMatching(/default=default[\s\S]*DSH 已激活: project/u),
    }))
    expect(service.status).toHaveBeenCalledOnce()
  })

  it('reports Mnemon Native as optional when its CLI is missing', async () => {
    const service = {
      config: { writeEnabled: true, defaultRecallLimit: 10 },
      status: vi.fn(async () => ({
        healthy: true, commandFound: false, cliPath: 'mnemon', dataDir: '/tmp/mnemon', mnemonDefaultStore: 'default',
        dshActiveStores: ['mem0-notes'], writeEnabled: true, defaultRecallLimit: 10, stats: { totalInsights: 4, edgeCount: 0, deletedInsights: 0 },
      })),
    }
    const result = await createMnemonCommand(runtime(service), coordinator()).handler(invocation('status'))
    expect(result).toEqual(expect.objectContaining({ kind: 'success', text: expect.stringMatching(/^Mnemon Native: 未安装 CLI[\s\S]*DSH 已激活: mem0-notes[\s\S]*有效记忆: 4/u) }))
    expect((result as { text: string }).text).not.toContain('CLI: mnemon')
  })

  it('runs a bounded recall and includes full ids', async () => {
    const service = {
      config: { writeEnabled: true, defaultRecallLimit: 20 },
    }
    const memoryCoordinator = coordinator({
      recall: vi.fn(async () => ({ query: '为什么使用 SQLite', mode: 'smart', results: [{ id: 'memory-full-id', content: '选择 SQLite 以便本地优先', score: 0.8, memoryBodyId: 'project' }] })),
    })
    const result = await createMnemonCommand(runtime(service), memoryCoordinator).handler(invocation('recall 为什么使用 SQLite'))
    expect(memoryCoordinator.recall).toHaveBeenCalledWith(agent, { query: '为什么使用 SQLite', limit: 10 }, expect.any(AbortSignal))
    expect(result).toEqual(expect.objectContaining({ kind: 'success', text: expect.stringContaining('memory-full-id') }))
  })

  it('says when a recall or related query did not run, instead of that nothing was found (#389)', async () => {
    const service = { config: { writeEnabled: true, defaultRecallLimit: 10 } }
    const memoryCoordinator = coordinator({
      recall: vi.fn(async () => ({ query: '站会', mode: 'smart', results: [], notRun: true as const, budgetExhausted: true as const })),
      related: vi.fn(async () => ({ query: 'related:memory-full-id', mode: 'related', results: [], notRun: true as const })),
    })
    const command = createMnemonCommand(runtime(service), memoryCoordinator)
    expect(await command.handler(invocation('recall 站会'))).toEqual({ kind: 'error', text: '本回合的召回次数已用完，“站会”没有查询。' })
    expect(await command.handler(invocation('related memory-full-id'))).toEqual({ kind: 'error', text: expect.stringContaining('ID memory-full-id 没有查询') })
  })

  it('rejects mutation subcommands in read-only mode', async () => {
    const remember = vi.fn()
    const service = { config: { writeEnabled: false, defaultRecallLimit: 10 }, remember }
    const result = await createMnemonCommand(runtime(service), coordinator()).handler(invocation('remember 永久记住这条'))
    expect(result).toEqual({ kind: 'error', text: 'Mnemon 当前为只读模式，不能写入记忆。' })
    expect(remember).not.toHaveBeenCalled()
  })

  it('returns the memory subagent write receipt', async () => {
    const service = {
      config: { writeEnabled: true, defaultRecallLimit: 10 },
    }
    const result = await createMnemonCommand(runtime(service), coordinator()).handler(invocation('remember 一条稳定记忆'))
    expect(result).toEqual({ kind: 'success', text: 'Mnemon 记忆 Agent 已处理：stored · 记忆空间 project' })
  })

  // With the embedding settings at their default no embedding service is set up, and the line says so without alarm;
  // once DSH manages them, a configured service did not answer.
  const noService = '\n这条记忆暂未生成向量：当前没有可用的嵌入服务，它暂不参与语义匹配，关键词检索不受影响。连接嵌入服务后，可在 Mnemon Native 嵌入设置的「测试状态」中补齐。'
  const failed = '\n未生成向量：嵌入没有成功，这条记忆暂时不参与语义匹配。嵌入服务可用后，可在 Mnemon Native 嵌入设置的「测试状态」中补齐。'
  it.each([
    ['stored', false, noService],
    ['stored', true, failed],
    ['skipped', false, ''],
    ['skipped', true, ''],
  ])('says when a %s write saved its memory without a vector, DSH managing the embedding: %s (#388)', async (action, managed, line) => {
    const service = { config: { writeEnabled: true, defaultRecallLimit: 10, embedding: { enabled: managed } } }
    const memoryCoordinator = coordinator({
      remember: vi.fn(async () => ({ delegated: true as const, runId: 'run-1', provider: 'spawn', summary: '', action, memoryBodyIds: ['project'],
        unembedded: [{ memoryBodyId: 'project', id: 'memory-1' }], hint: 'Saved without a vector.' })),
    })
    const result = await createMnemonCommand(runtime(service), memoryCoordinator).handler(invocation('remember 一条稳定记忆'))
    // A write that put no memory anywhere says nothing about one.
    expect(result).toEqual({ kind: 'success', text: `Mnemon 记忆 Agent 已处理：${action} · 记忆空间 project${line}` })
  })

  it('reports an explicit forget only after a forgotten receipt', async () => {
    const memoryCoordinator = coordinator()
    const result = await createMnemonCommand(runtime({ config: { writeEnabled: true, defaultRecallLimit: 10 } }), memoryCoordinator)
      .handler(invocation('forget memory-exact-id'))
    expect(memoryCoordinator.write).toHaveBeenCalledWith(agent, 'forget', { id: 'memory-exact-id' }, expect.any(AbortSignal))
    expect(result).toEqual({ kind: 'success', text: '已软删除 Mnemon 记忆：memory-exact-id' })
  })

  it.each(['skipped', 'failed', 'accepted', 'unknown'])('does not report deletion after a %s worker receipt', async action => {
    const memoryCoordinator = coordinator({ write: vi.fn(async () => ({
      delegated: true as const, runId: 'child-1', provider: 'spawn', summary: 'No deletion was committed.', action, memoryBodyIds: [],
    })) })
    const result = await createMnemonCommand(runtime({ config: { writeEnabled: true, defaultRecallLimit: 10 } }), memoryCoordinator)
      .handler(invocation('forget memory-exact-id'))
    expect(result.kind).toBe('error')
    expect(result.text).toContain('No deletion was committed.')
    expect(result.text).not.toContain('已软删除')
  })
})

describe('memory tool cards', () => {
  /** The cards DSH shows of a tool call and its result in the conversation. */
  interface ToolCards {
    presentCall?(args: unknown): unknown
    presentResult?(args: unknown, value: unknown): unknown
  }

  it('shows every memory tool call and result with the card it always had, in registration order', () => {
    const tools: ToolDefinition[] = []
    const register = (tool: ToolDefinition) => { tools.push(tool); return () => {} }
    registerTools({ tools: { register } } as unknown as HostContextShape, {} as never, new MnemonSubagentCoordinator({} as never, {} as never), toolContributions())
    const args = { routeId: 'documents/search', offerId: 'runtime/mutate', query: 'release gates', id: 'm1', title: 'Release design', action: 'add', target: 'memory' }
    const cards = tools.map(tool => [tool.name, (tool as ToolCards).presentCall?.(args), (tool as ToolCards).presentResult?.(args, {})])
    expect(cards).toEqual([
      ['mnemon_view_route', { card: 'generic', title: 'Query composable memory', kind: 'search', rawInput: 'documents/search' }, { card: 'generic', title: 'Composable memory evidence ready' }],
      ['mnemon_view_action', { card: 'generic', title: 'Apply composable memory action', kind: 'edit', rawInput: 'runtime/mutate' }, { card: 'generic', title: 'Composable memory receipt ready' }],
      ['mnemon_memory_bodies', { card: 'generic', title: 'Inspect Mnemon Memory Spaces', kind: 'search' }, { card: 'generic', title: 'Mnemon Memory Spaces ready' }],
      ['mnemon_recall', { card: 'generic', title: 'Recall Mnemon memory', kind: 'search', rawInput: 'release gates' }, { card: 'generic', title: 'Mnemon recall complete' }],
      ['mnemon_related', { card: 'generic', title: 'Traverse Mnemon graph', kind: 'search', rawInput: 'm1' }, { card: 'generic', title: 'Mnemon graph traversal complete' }],
      ['mnemon_status', { card: 'generic', title: 'Check Mnemon status', kind: 'other' }, { card: 'generic', title: 'Mnemon status checked' }],
      ['mnemon_document_search', { card: 'generic', title: 'Search Mnemon Documents', kind: 'search', rawInput: 'release gates' }, { card: 'generic', title: 'Mnemon Documents ready' }],
      ['mnemon_document_create', { card: 'generic', title: 'Create Mnemon Document', kind: 'edit', rawInput: 'Release design' }, { card: 'generic', title: 'Mnemon Document created' }],
      ['mnemon_document_manage', { card: 'generic', title: 'add Mnemon Document', kind: 'edit', rawInput: 'Release design' }, { card: 'generic', title: 'Mnemon Document processed' }],
      ['mnemon_runtime_memory', { card: 'generic', title: 'add runtime memory memory', kind: 'edit' }, { card: 'generic', title: 'Runtime memory updated' }],
      ['mnemon_remember', { card: 'generic', title: 'Write Mnemon memory', kind: 'edit' }, { card: 'generic', title: 'Mnemon memory processed' }],
      ['mnemon_link', { card: 'generic', title: 'Link Mnemon insights', kind: 'edit' }, { card: 'generic', title: 'Mnemon insights linked' }],
      ['mnemon_forget', { card: 'generic', title: 'Forget Mnemon insight', kind: 'edit', rawInput: 'm1' }, { card: 'generic', title: 'Mnemon insight forgotten' }],
      ['mnemon_memory_body_create', { card: 'generic', title: 'Create Memory Space', kind: 'edit' }, { card: 'generic', title: 'Memory Space created' }],
      ['mnemon_memory_body_update', { card: 'generic', title: 'Update Mnemon Memory Space', kind: 'edit' }, { card: 'generic', title: 'Mnemon Memory Space updated' }],
      ['mnemon_memory_body_merge', { card: 'generic', title: 'Merge Mnemon Memory Spaces', kind: 'edit' }, { card: 'generic', title: 'Mnemon Memory Spaces merged' }],
    ])
  })
})

describe('Mnemon root/child tool split', () => {
  afterEach(cleanupSubagentFixtures)
  it('routes root and child reads and Runtime writes through the shared coordinator', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    const registered: ToolDefinition[] = []
    const root = parent()
    root.session.header!.cwd = f.workspace
    const child = parent('subagent')
    child.session.header!.cwd = f.workspace
    child.session.header!.parentSession = 'root'
    const scope = agentScope(root, f.config)
    const dispatch = await f.graph.composableTurns.beginTurn('root:tools', scope, 'test')
    f.graph.composableTurns.pinTurn('child:tools', agentScope(child, f.config), dispatch.view.id)
    const coordinator = { recall: vi.fn(async () => ({ results: [] })), related: vi.fn(async () => ({ results: [] })), runtime: vi.fn() } as unknown as MnemonSubagentCoordinator
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
    const signal = new AbortController().signal
    const hot = registered.find(tool => tool.name === 'mnemon_runtime_memory')!
    await hot.execute({ action: 'add', target: 'user', content: 'Concise' } as never, { agent: root, signal })
    expect(coordinator.runtime).toHaveBeenCalledWith(root, { action: 'add', target: 'user', content: 'Concise' }, signal)
    await hot.execute({ action: 'add', target: 'memory', content: 'Child fact' } as never, { agent: child, signal })
    expect(coordinator.runtime).toHaveBeenCalledWith(child, { action: 'add', target: 'memory', content: 'Child fact' }, signal)
    const recall = registered.find(tool => tool.name === 'mnemon_recall')!
    await recall.execute({ query: 'root query' } as never, { agent: root, signal })
    await recall.execute({ query: 'child query', memoryBodyIds: ['project'] } as never, { agent: child, signal })
    expect(coordinator.recall).toHaveBeenNthCalledWith(1, root, { query: 'root query' }, signal, { requirePinnedView: true })
    expect(coordinator.recall).toHaveBeenNthCalledWith(2, child, { query: 'child query', memoryBodyIds: ['project'] }, signal, { requirePinnedView: true })
    await registered.find(tool => tool.name === 'mnemon_related')!.execute({ id: 'm1', depth: 2, memoryBodyId: 'project' } as never, { agent: child, signal })
    expect(coordinator.related).toHaveBeenCalledWith(child, 'm1', 'project', signal, { depth: 2, requirePinnedView: true })
    expect(registered.some(tool => tool.name === 'mnemon_memory_zoom')).toBe(false)
    expect(JSON.stringify(recall.parameters)).not.toMatch(/viewId|viewNodeId|viewCapability/u)
    expect(registered.find(tool => tool.name === 'mnemon_memory_bodies')!.description).toContain('Never call it to route Recall')
    f.graph.composableTurns.endTurn('root:tools')
  })

  it('returns Source-owned bounded health evidence without control-plane paths', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    await f.memorySpace()
    const root = parent()
    root.session.header!.cwd = f.workspace
    await f.graph.composableTurns.beginTurn('root:health', agentScope(root, f.config), 'test')
    const registered: ToolDefinition[] = []
    const coordinator = { reviewAccessStatus: () => ({ state: 'unchecked' }) } as unknown as MnemonSubagentCoordinator
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
    const status = await registered.find(tool => tool.name === 'mnemon_status')!.execute({} as never, { agent: root, signal: new AbortController().signal })
    expect(status).toMatchObject({ memorySpaces: { active: 1 }, healthy: true })
    expect(JSON.stringify(status)).not.toMatch(/cliPath|dataDir|memoryBodyDirectory|dbPath|byCategory|topEntities|apiKey/)
    expect(JSON.stringify(status).length).toBeLessThan(5_000)
    f.graph.composableTurns.endTurn('root:health')
  })

  it('enforces configured automatic participation without a management escape in model tools', async () => {
    const f = await compositionFixture({ memoryTopology: { layers: { runtime: { participation: { write: 'manual' } }, 'memory-spaces': { enabled: false } } } })
    releases.push(f.dispose)
    const registered: ToolDefinition[] = []
    const coordinator = { recall: vi.fn(), runtime: vi.fn() } as unknown as MnemonSubagentCoordinator
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
    const signal = new AbortController().signal
    await expect(registered.find(tool => tool.name === 'mnemon_recall')!.execute({ query: 'blocked' } as never, { agent: parent(), signal })).rejects.toThrow('does not allow automatic recall')
    expect(() => registered.find(tool => tool.name === 'mnemon_runtime_memory')!.execute({ action: 'add', target: 'memory', content: 'blocked' } as never, { agent: parent(), signal })).toThrow('does not allow automatic write')
    await expect(registered.find(tool => tool.name === 'mnemon_memory_bodies')!.execute({} as never, { agent: parent(), signal })).rejects.toThrow('does not allow automatic maintenance')
    expect(coordinator.recall).not.toHaveBeenCalled()
    expect(coordinator.runtime).not.toHaveBeenCalled()
  })

  it('rejects missing conditional runtime tool fields with action context and a JSON example (#746)', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    const root = parent()
    root.session.header!.cwd = f.workspace
    await f.graph.composableTurns.beginTurn('root:runtime-required', agentScope(root, f.config), 'test')
    const registered: ToolDefinition[] = []
    const coordinator = { runtime: vi.fn(async () => ({ success: true })) } as unknown as MnemonSubagentCoordinator
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
    const hot = registered.find(tool => tool.name === 'mnemon_runtime_memory')!
    const signal = new AbortController().signal

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'add', target: 'memory', importance: 'critical', branches: ['master'] },
        'content is required for action=add (example: {"action":"add","target":"memory","content":"..."})'],
      [{ action: 'add', target: 'user', content: '   ' },
        'content is required for action=add (example: {"action":"add","target":"user","content":"..."})'],
      [{ action: 'replace', target: 'memory', old_text: 'Existing rule' },
        'content is required for action=replace (example: {"action":"replace","target":"memory","old_text":"...","content":"..."})'],
      [{ action: 'replace', target: 'user', content: 'Updated rule' },
        'old_text is required for action=replace (example: {"action":"replace","target":"user","old_text":"...","content":"..."})'],
      [{ action: 'replace', target: 'memory' },
        'old_text and content are required for action=replace (example: {"action":"replace","target":"memory","old_text":"...","content":"..."})'],
      [{ action: 'remove', target: 'memory' },
        'old_text is required for action=remove (example: {"action":"remove","target":"memory","old_text":"..."})'],
      [{ action: 'remove', target: 'user', old_text: ' \t ' },
        'old_text is required for action=remove (example: {"action":"remove","target":"user","old_text":"..."})'],
    ]
    for (const [args, expected] of cases) {
      expect(() => hot.execute(args as never, { agent: root, signal })).toThrow(expected)
    }
    expect(coordinator.runtime).not.toHaveBeenCalled()

    await hot.execute({ action: 'remove', target: 'memory', old_text: 'Existing rule' } as never, { agent: root, signal })
    expect(coordinator.runtime).toHaveBeenCalledWith(root, { action: 'remove', target: 'memory', oldText: 'Existing rule' }, signal)
    f.graph.composableTurns.endTurn('root:runtime-required')

    const readOnly = await compositionFixture({ writeEnabled: false })
    releases.push(readOnly.dispose)
    const readOnlyTools: ToolDefinition[] = []
    registerTools({ tools: { register: (tool: ToolDefinition) => { readOnlyTools.push(tool); return () => {} } } } as unknown as HostContextShape, readOnly.live, coordinator, readOnly.extensions)
    expect(() => readOnlyTools.find(tool => tool.name === 'mnemon_runtime_memory')!.execute(
      { action: 'add', target: 'memory' } as never,
      { agent: root, signal },
    )).toThrow('dsh-mnemon is configured read-only')
  })
})
