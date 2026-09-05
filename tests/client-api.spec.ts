import { describe, expect, it, vi } from 'vitest'
import type { ClientConnectionHandle } from "../src/host/dsh.ts"
import { MnemonClient } from '../src/client/api.ts'

describe('MnemonClient product transport', () => {
  it('keeps Source management scoped to its instance, workspace and revision', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { revision: 'r2', value: {} } }))
    const client = new MnemonClient({ rpc: { call } } as ClientConnectionHandle, 'session-1', 'workspace-1')
    await client.readSourceManagement('source:spaces', 'body-reconnect', { memoryBodyId: 'project' })
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-read', 'source-management-read', {
      sourceInstanceKey: 'source:spaces', operation: 'body-reconnect', input: { memoryBodyId: 'project' }, sessionId: 'session-1', workspaceId: 'workspace-1',
    })
    await client.mutateSourceManagement('source:spaces', 'body-update', { memoryBodyId: 'project', name: 'Project' }, 'r2', true)
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-write', 'source-management-mutate', {
      sourceInstanceKey: 'source:spaces', operation: 'body-update', input: { memoryBodyId: 'project', name: 'Project' }, expectedRevision: 'r2', confirmed: true,
      sessionId: 'session-1', workspaceId: 'workspace-1',
    })
  })

  it.each([403, 404])('never widens Source activation authority after HTTP %i', async status => {
    const call = vi.fn(async () => { throw new Error(`HTTP ${status}`) })
    const client = new MnemonClient({ rpc: { call } } as ClientConnectionHandle, 'session-1', 'workspace-1')
    await expect(client.assistSource('source:spaces', 'activation', { memoryBodyId: 'project', active: true }, 'r1', true)).rejects.toThrow(`HTTP ${status}`)
    expect(call.mock.calls).toEqual([['/dsh-mnemon-activation', 'source-assistance', {
      sourceInstanceKey: 'source:spaces', operation: 'activation', input: { memoryBodyId: 'project', active: true }, expectedRevision: 'r1', confirmed: true,
      sessionId: 'session-1', workspaceId: 'workspace-1',
    }]])
  })

  it('shares one bulk projection across all turn tails until the durable cursor advances', async () => {
    let cursor = 7
    const call = vi.fn(async (_channel: string, endpoint: string) => {
      expect(endpoint).toBe('turn-activities')
      return {
        ok: true as const,
        value: {
          cursor,
          activities: [
            { turn: 1, count: 1, names: ['mnemon_recall'], recalls: 1, writes: 0, documentSearches: 0, inspections: 0, failures: 0 },
            { turn: 2, count: 1, names: ['mnemon_status'], recalls: 0, writes: 0, documentSearches: 0, inspections: 1, failures: 0 },
          ],
        },
      }
    })
    const connection = { rpc: { call } } as ClientConnectionHandle
    const client = new MnemonClient(connection, 'session-1')

    const [first, second] = await Promise.all([client.turnActivity(1, 5), client.turnActivity(2, 7)])
    expect(first?.recalls).toBe(1)
    expect(second?.inspections).toBe(1)
    expect(call).toHaveBeenCalledTimes(1)

    await client.turnActivity(1, 7)
    expect(call).toHaveBeenCalledTimes(1)

    cursor = 10
    await client.turnActivity(2, 10)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('routes native backup operations to the selected workspace', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { root: '/workspace/.mnemon', scope: 'workspace' } }))
    const client = new MnemonClient({ rpc: { call } } as ClientConnectionHandle, 'session-1', 'workspace-1')

    await client.packTarget()

    expect(call).toHaveBeenCalledWith(expect.any(String), 'target', { sessionId: 'session-1', workspaceId: 'workspace-1' })
  })

  it('routes provider service settings independently from Memory Spaces', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { providerId: 'mem0', configured: true, settings: { endpoint: 'http://127.0.0.1:8888' }, configuredSecrets: [] } }))
    const client = new MnemonClient({ rpc: { call } } as ClientConnectionHandle, 'session-1', 'workspace-1')

    await client.updateProviderService({ providerId: 'mem0', settings: { endpoint: 'http://127.0.0.1:8888', mode: 'self-hosted' }, enabled: true })

    expect(call).toHaveBeenCalledWith(expect.any(String), 'provider-service-update', {
      providerId: 'mem0', settings: { endpoint: 'http://127.0.0.1:8888', mode: 'self-hosted' }, enabled: true, sessionId: 'session-1', workspaceId: 'workspace-1',
    })
  })

  it('loads redacted Provider settings through the read channel and never masks an authentication rejection', async () => {
    const call = vi.fn(async (channel: string) => {
      if (channel === '/dsh-mnemon-read') return { ok: true as const, value: { providers: [], items: [], generatedAt: 'now' } }
      throw new Error(`unexpected channel: ${channel}`)
    })
    const client = new MnemonClient({ rpc: { call } } as ClientConnectionHandle, 'session-1')

    await client.providerServices()
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-read', 'provider-services', { sessionId: 'session-1' })

    call.mockReset()
    call.mockRejectedValue(new Error('transport failure for /dsh-mnemon-write/provider-services: HTTP 403'))
    await expect(client.providerServices()).rejects.toThrow('HTTP 403')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('does not retry an unavailable Provider catalog on a write endpoint', async () => {
    const call = vi.fn(async () => ({ ok: false as const, error: { code: 'bad-request' as const, message: 'unknown read endpoint: provider-services', details: { issues: [] } } }))
    const client = new MnemonClient({ rpc: { call } } as ClientConnectionHandle)
    await expect(client.providerServices()).rejects.toThrow('unknown read endpoint')
    expect(call.mock.calls).toEqual([['/dsh-mnemon-read', 'provider-services', {}]])
  })

  it('loads the independent task Agent model catalog without a session dependency', async () => {
    const catalog = {
      effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const },
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
      failures: [],
    }
    const call = vi.fn(async () => ({ ok: true as const, value: catalog }))
    const client = new MnemonClient({ rpc: { call } } as ClientConnectionHandle)

    await expect(client.taskAgentModels()).resolves.toEqual(catalog)
    expect(call).toHaveBeenCalledWith(expect.any(String), 'task-agent-models', {})
  })

  it('checks Mnemon embedding status in the selected runtime scope', async () => {
    const status = { available: true, model: 'qwen3-embedding:0.6b', totalInsights: 5, embedded: 4, coverage: '80%' }
    const call = vi.fn(async () => ({ ok: true as const, value: status }))
    const client = new MnemonClient({ rpc: { call } } as ClientConnectionHandle, 'session-1', 'workspace-1')

    await expect(client.embeddingStatus()).resolves.toEqual(status)
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'embedding-status', {
      sessionId: 'session-1', workspaceId: 'workspace-1',
    })
  })
})
