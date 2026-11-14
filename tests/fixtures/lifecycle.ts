import { vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryExecutions } from '../../src/host/memory-executions.ts'
import { resolveConfig } from '../../src/host/config.ts'
import type {
  CreateHostAgentOptions,
  HostAgent,
  HostAgentContext,
  HostContextShape,
  HostPreStepDecision,
  HostSessionEvent,
  HostUserMessage,
} from '../../src/host/dsh.ts'
import { MnemonLifecycle } from '../../src/host/lifecycle.ts'
import type { MemoryStrategyWorkflow } from '../../src/core/contracts/index.ts'
import type { MnemonSubagentCoordinator } from '../../src/host/subagent.ts'
import { sessionLog } from './session-log.ts'

type Listener = (...args: unknown[]) => unknown

// A task Agent's directory must exist: DSH 0.2.1 checks it before every step.
export const directories = mkdtempSync(join(tmpdir(), 'mnemon-lifecycle-'))
export const workspaceTwo = mkdtempSync(join(directories, 'workspace-two-'))
export const registryWorkspace = mkdtempSync(join(directories, 'registry-workspace-'))

export function cleanupLifecycleDirectories(): void {
  rmSync(directories, { recursive: true, force: true })
}

export function userMessage(text = 'Continue the project'): HostUserMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

export function durableCandidate(filler = 97): HostUserMessage {
  return userMessage(`Please remember this durable architecture rationale: ${'x'.repeat(filler)}`)
}

export function watermarkFile(directory: string, sessionId = 'session-1'): string {
  return join(directory, 'state', 'idle-review', createHash('sha256').update(sessionId).digest('hex') + '.json')
}

export function writeWatermark(directory: string, payload: string | object, sessionId = 'session-1'): string {
  mkdirSync(join(directory, 'state', 'idle-review'), { recursive: true })
  const filename = watermarkFile(directory, sessionId)
  writeFileSync(filename, typeof payload === 'string' ? payload : JSON.stringify(payload))
  return filename
}

/** The Layered strategy as published before 0.5.10, declaring nothing, and as it ships now. */
export const LAYERED = [
  ['undeclared', undefined],
  ['declared', { 'default-three-tier': ['idle-review', 'runtime-capacity'] }],
] as const satisfies ReadonlyArray<readonly [string, Partial<Record<string, readonly MemoryStrategyWorkflow[]>> | undefined]>

/** The View fields Core takes from the Strategy that composed it, one generation per Strategy. */
export function composedBy(typeId: string): { strategyTypeId: string; strategyInstanceKey: string; runtimeGeneration: string } {
  return { strategyTypeId: typeId, strategyInstanceKey: `strategy:${typeId}`, runtimeGeneration: `fixture-generation:${typeId}` }
}

export function fixture(
  config = resolveConfig({ cliPath: '/fake/mnemon' }),
  options: {
    inactive?: boolean
    directory?: string
    sessionId?: string
    taskModelRoute?: boolean
    workspaces?: Array<{ path: string }>
    sessionModel?: { provider: string; model: string; reasoningEffort?: string }
    conversationOptions?: { provider: string; model: string; reasoningEffort?: string }
    workingDirectory?: { set: (agent: HostAgent, path: string, signal?: AbortSignal) => Promise<string> }
    strategyWorkflows?: Partial<Record<string, readonly MemoryStrategyWorkflow[]>> | undefined
  } = {},
) {
  const agentListeners = new Map<string, Listener>()
  const rootListeners = new Map<string, Listener>()
  const agentSections: Array<{ name: string; order: number; text: () => string }> = []
  const agentContexts: Array<{ name: string; order: number; text: () => string }> = []
  const promptAssemblies: Array<{ sections: Array<{ name: string; text: string }>; contexts: Array<{ name: string; text: string }> }> = []
  const events: HostSessionEvent[] = []
  const followup = vi.fn()
  const steer = vi.fn()
  const taskAgents: HostAgent[] = []
  const disposedTaskAgents: string[] = []
  const taskModelRoute = options.taskModelRoute !== false
  const sessionModel = options.sessionModel
  const defaultModel = { currentSelection: vi.fn((): { provider: string; model: string; reasoningEffort?: string } => ({ provider: 'deepseek', model: 'deepseek-chat' })) }
  const llm = {
    listProviders: vi.fn(() => [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'openai', name: 'OpenAI' },
    ]),
    listModels: vi.fn(async (provider: string): Promise<Array<{ id: string; name: string; description?: string; inputModalities?: readonly string[] }>> => provider === 'openai'
      ? [{ id: 'gpt-5', name: 'GPT-5', description: 'General reasoning' }]
      : [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
  }
  const agentPresets = {
    resolve: vi.fn(async () => ({ id: 'default' })),
    mount: vi.fn(async () => ({ id: 'default' })),
  }
  // DSH appends an admitted step batch to the Session log and its surface.
  const admit = (listener: Listener): Listener => async (...args) => {
    const decision = await listener(...args) as HostPreStepDecision
    if (decision.kind === 'enter') {
      for (const message of decision.messages) events.push({ type: 'user/message', seq: events.length, data: { ...message } })
    }
    return decision
  }
  let contextActive = !options.inactive
  const agentCtx = {
    fiber: { assertActive() { if (!contextActive) throw Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' }) } },
    on: vi.fn((name: string, listener: Listener) => {
      agentListeners.set(name, name === 'agent/pre-step' ? admit(listener) : listener)
      return () => agentListeners.delete(name)
    }),
    effect: vi.fn((callback: () => (() => unknown) | void) => {
      const cleanup = callback()
      return () => cleanup?.()
    }),
    get: vi.fn((name: string) => name === 'systemPrompt'
      ? {
          section: (value: { name: string; order: number; text: () => string }) => {
            agentSections.push(value)
            return () => undefined
          },
          context: (value: { name: string; order: number; text: () => string }) => {
            agentContexts.push(value)
            return () => undefined
          },
        }
      : undefined),
  } as unknown as HostAgentContext
  const agent = {
    id: options.sessionId ?? 'session-1',
    status: 'idle',
    ...(options.conversationOptions !== undefined ? { options: options.conversationOptions } : taskModelRoute ? { options: { provider: 'deepseek', model: 'deepseek-chat' } } : {}),
    session: {
      ...sessionLog(events),
      ...(sessionModel === undefined ? {} : { requestHeader: () => ({ config: sessionModel }) }),
    },
    ctx: agentCtx,
    followup,
    steer,
    inject: vi.fn(),
    cancel: vi.fn(),
  } satisfies HostAgent
  const coordinator = {
    isFinishedTask: () => false,
    inheritTaskContinuation: () => {},
    canReview: vi.fn(() => true),
    checkReviewAccess: vi.fn(async () => true),
    recall: vi.fn(async (_agent, request) => ({ query: request.query, mode: 'smart', results: [] })),
    write: vi.fn(async () => ({ delegated: true, runId: 'write-child', provider: 'spawn', summary: 'No durable memory', action: 'skipped', memoryBodyIds: [] })),
    answer: vi.fn(async () => ({ answer: 'SQLite.', citations: [], delegation: { runId: 'answer-child', provider: 'spawn' } })),
    review: vi.fn(async () => ({ delegated: true, runId: 'review-child', provider: 'fork', summary: 'No durable change', action: 'skipped', memoryBodyIds: [] })),
    maintainMetadata: vi.fn(async () => ({ delegated: true, runId: 'metadata-child', provider: 'spawn', summary: 'updated', updates: [] })),
    archiveDocument: vi.fn(async () => ({ success: true, action: 'archived', document: { id: 'doc-1' } })),
    document: vi.fn(async () => ({ success: true, action: 'created', document: { id: 'doc-2' } })),
    placeProvider: vi.fn(async () => ({ providerId: 'mnemon-native', reason: 'local', confidence: 'high' })),
    snapshot: vi.fn(() => ({ recalls: 0, writes: 0, answers: 0, reviews: 0, failures: 0 })),
  } as unknown as MnemonSubagentCoordinator
  const createTaskAgent = vi.fn(async (taskOptions: CreateHostAgentOptions) => {
    const taskCtx = {
      on: vi.fn(() => () => undefined),
      effect: vi.fn((callback: () => (() => unknown) | void) => {
        const cleanup = callback()
        return () => cleanup?.()
      }),
    } as unknown as HostAgentContext
    const taskAgent = {
      id: taskOptions.sessionId,
      status: 'idle' as const,
      ...(taskOptions.agentOptions === undefined ? {} : { options: taskOptions.agentOptions }),
      session: { header: taskOptions.meta ?? {}, ...sessionLog() },
      ctx: taskCtx,
      followup: vi.fn(),
      steer: vi.fn(),
      inject: vi.fn(),
      cancel: vi.fn(),
    } satisfies HostAgent
    // DSH runs setup on the unpublished Agent, as setup(agent.ctx, agent).
    await taskOptions.setup?.(taskCtx, taskAgent)
    taskAgents.push(taskAgent)
    rootListeners.get('agent/created')?.({ agent: taskAgent })
    return {
      agent: taskAgent,
      dispose: vi.fn(async () => {
        disposedTaskAgents.push(taskAgent.id)
        const index = taskAgents.indexOf(taskAgent)
        if (index >= 0) taskAgents.splice(index, 1)
      }),
    }
  })
  const ctx = {
    agents: { get: (id: string) => id === agent.id ? agent : taskAgents.find(candidate => candidate.id === id), roots: () => [agent, ...taskAgents], create: createTaskAgent },
    get: vi.fn((name: string) => name === 'agentDefaultModel' && taskModelRoute
      ? defaultModel
      : name === 'agentPresets'
        ? agentPresets
        : name === 'llm'
          ? llm
          : name === 'workspaceRegistry' && options.workspaces !== undefined
            ? { get: (id: string) => options.workspaces!.find(workspace => workspace.path === id), list: () => options.workspaces! }
            : name === 'workingDirectory'
              ? options.workingDirectory
              : undefined),
    on: vi.fn((name: string, listener: Listener) => {
      rootListeners.set(name, listener)
      return () => rootListeners.delete(name)
    }),
  } as unknown as HostContextShape
  const pinnedTurns = new Map<string, object>()
  const composableTurns = {
    activeTurn: vi.fn(() => [...pinnedTurns.values()].at(-1)),
    beginTurn: vi.fn(async (turnId: string, scope: object) => {
      const turn = turnId.slice(turnId.lastIndexOf(':') + 1)
      const context = {
        turnId,
        view: {
          id: `view-${turn}`,
          digest: `digest-${turn}`,
          ...composedBy(config.memoryTopology.strategyId),
          createdAt: '2026-08-23T00:00:00.000Z',
          scope,
          projection: [],
          readGrants: [],
          routes: [],
          actionOffers: [],
        },
        scope,
        startedAt: '2026-08-23T00:00:00.000Z',
      }
      pinnedTurns.set(turnId, context)
      return context
    }),
    turn: vi.fn((turnId: string) => pinnedTurns.get(turnId)),
    memoryWake: vi.fn((viewId: string) => ({
      viewId,
      viewDigest: viewId.replace('view-', 'digest-'),
      text: `Pinned Wake ${viewId}`,
      sections: [{ layerId: 'runtime', mode: 'eager', text: `Pinned Wake ${viewId}` }],
    })),
    endTurn: vi.fn((turnId: string) => pinnedTurns.delete(turnId)),
  }
  const runtimeBinding = {
    // Each generation holds the definition of the Strategy that composed its Views, as Core's does;
    // a Strategy without a declaration in the test declares none, as the Layered one before 0.5.10.
    forAgent: vi.fn((_agent: HostAgent) => ({
      config,
      directory: options.directory,
      composableTurns,
      memoryComposition: {
        generation: (id: string) => {
          const typeId = id.slice('fixture-generation:'.length)
          const workflows = options.strategyWorkflows?.[typeId]
          return {
            sourceInstances: () => [],
            strategy: {
              instanceKey: `strategy:${typeId}`,
              definition: { manifest: { typeId, ...(workflows === undefined ? {} : { workflows: [...workflows] }) } },
            },
          }
        },
      },
    })),
    bindAgentRuntime: vi.fn((_agentId: string, _graph: unknown): (() => void) => () => undefined),
  }
  const runtimeSource = { ...runtimeBinding, executions: new MemoryExecutions(runtimeBinding as never) }
  const lifecycle = new MnemonLifecycle(ctx, coordinator, config, runtimeSource as never)
  const stop = lifecycle.start()

  const assemblePrompt = async (turn: number) => {
    const hasOpenTurn = events.some(event => event.type === 'turn/start' && event.data.turn === turn)
      && !events.some(event => event.type === 'turn/end' && event.data.turn === turn)
    if (!hasOpenTurn) events.push({ type: 'turn/start', data: { turn } })
    const listener = agentListeners.get('system-prompt/assemble')
    if (listener === undefined) throw new Error('system-prompt/assemble listener missing')
    const assembly = {
      sections: agentSections.map(section => ({ name: section.name, text: section.text() })),
      contexts: agentContexts.map(context => ({ name: context.name, text: context.text() })),
      tools: [],
      variables: {},
    }
    const assembled = await listener(assembly, { agent, signal: new AbortController().signal }, async () => assembly) as typeof assembly
    promptAssemblies.push(assembled)
    return assembled
  }
  const preStep = async (messages: HostUserMessage[], turn: number, step = 1): Promise<HostPreStepDecision> => {
    // Match the real DSH order: turn/start -> systemPrompt.assemble -> agent/pre-step.
    await assemblePrompt(turn)
    const listener = agentListeners.get('agent/pre-step')
    if (listener === undefined) throw new Error('pre-step listener missing')
    return await listener({ agent, messages, turn, step, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages })) as HostPreStepDecision
  }
  const turnStopping = async (turn: number) => {
    const listener = agentListeners.get('agent/turn-stopping')
    if (listener === undefined) throw new Error('turn-stopping listener missing')
    const signal = new AbortController().signal
    await agentListeners.get('agent/request')?.({ agent, turn, step: 1, signal }, async () => ({}))
    await listener({ agent, turn, signal })
    if (!events.some(event => event.type === 'turn/end' && event.data.turn === turn)) {
      const event = { type: 'turn/end', data: { turn } }
      events.push(event)
      agentListeners.get('session/event')?.(agent.session, event)
    }
  }
  return { deactivateContext: () => { contextActive = false }, agent, agentListeners, agentSections, agentContexts, promptAssemblies, events, followup, steer, lifecycle, coordinator, composableTurns, runtimeSource, createTaskAgent, disposedTaskAgents, defaultModel, llm, agentPresets, assemblePrompt, preStep, turnStopping, stop }
}

export async function completeDurableTurns(
  value: ReturnType<typeof fixture>,
  start = 1,
  end = 2,
  filler = 300,
): Promise<void> {
  for (let turn = start; turn <= end; turn += 1) {
    await value.preStep([durableCandidate(filler)], turn)
    await value.turnStopping(turn)
  }
}

// The DSH-owned Session codec, resolved exactly as the installed host resolves it.
export const requireDsh = createRequire(realpathSync(new URL('../../node_modules/@deepseek-ai/dsh/package.json', import.meta.url)))
