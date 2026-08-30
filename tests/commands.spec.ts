import { describe, expect, it, vi } from 'vitest'
import { createMnemonCommand } from "../src/host/commands.ts"
import type { HostAgent } from "../src/host/dsh.ts"
import { resolveConfig } from '../src/host/config.ts'
import type { MnemonAgentRuntimeSource, MnemonRuntimeGraph } from '../src/host/runtime.ts'
import type { MnemonSubagentCoordinator } from "../src/host/subagent.ts"

function runtime(fixture: { config: { writeEnabled: boolean; defaultRecallLimit: number }; status?: () => Promise<unknown> }): MnemonAgentRuntimeSource {
  const config = resolveConfig(fixture.config)
  return {
    config,
    forAgent: () => ({ config, source: () => ({ read: fixture.status }) }) as unknown as MnemonRuntimeGraph,
    bindAgentRuntime: () => () => {},
  }
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

describe('/mnemon command', () => {
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
    expect(result).toEqual({ kind: 'success', text: 'Mnemon 记忆 Agent 已处理：stored · 记忆体 project' })
  })
})
