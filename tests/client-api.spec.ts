import { describe, expect, it, vi } from 'vitest'
import type { ClientConnectionHandle } from "../src/host/dsh.ts"
import { MnemonClient } from '../src/client/api.ts'
import { MNEMON_READ_CHANNEL, MNEMON_SYNC_CHANNEL } from '../src/host/protocol.ts'

describe('MnemonClient product transport', () => {
  it('keeps Source management scoped to its instance, workspace and revision', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { revision: 'r2', value: {} } }))
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-1', 'workspace-1')
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
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-1', 'workspace-1')
    await expect(client.assistSource('source:spaces', 'activation', { memoryBodyId: 'project', active: true }, 'r1', true)).rejects.toThrow(`HTTP ${status}`)
    expect(call.mock.calls).toEqual([['/dsh-mnemon-activation', 'source-assistance', {
      sourceInstanceKey: 'source:spaces', operation: 'activation', input: { memoryBodyId: 'project', active: true }, expectedRevision: 'r1', confirmed: true,
      sessionId: 'session-1', workspaceId: 'workspace-1',
    }]])
  })

  it('routes a paired remote client through namespaced shared endpoints', async () => {
    const call = vi.fn(async (_channel: string, _endpoint: string, _payload: unknown) => ({
      ok: true as const,
      value: { ok: true as const, value: {} },
    }))
    const client = new MnemonClient({ isLoopback: false, rpc: { call } } as ClientConnectionHandle, 'session-1')
    await client.statusSummary()
    await client.mutateSourceManagement('source:spaces', 'body-update', {}, 'r1', true)
    await client.assistSource('source:spaces', 'activation', { memoryBodyId: 'project', active: true }, 'r1', true)
    await client.packTarget()
    await client.applyView({ expectedRevision: 'view-1', strategyTypeId: 'default-three-tier', entries: {} })

    expect(call.mock.calls.map(([channel, endpoint, payload]) => [channel, endpoint, (payload as { args: { endpoint: string } }).args.endpoint])).toEqual([
      ['/api', 'dshMnemon/read', 'status-summary'],
      ['/api', 'dshMnemon/write', 'source-management-mutate'],
      ['/api', 'dshMnemon/activation', 'source-assistance'],
      ['/api', 'dshMnemon/pack', 'target'],
      ['/api', 'dshMnemon/viewWrite', 'apply'],
    ])
    expect(call.mock.calls[0]?.[2]).toEqual({ args: { endpoint: 'status-summary', payload: { sessionId: 'session-1' } } })
  })

  it.each(['dsh-app:', 'file:'])('keeps a %s window the application serves itself on the local channels', async protocol => {
    // DSH Desktop serves its window from dsh-app://app/ and reports no loopback Connection.
    vi.stubGlobal('location', { protocol, hostname: protocol === 'file:' ? '' : 'app' })
    try {
      const call = vi.fn(async () => ({ ok: true as const, value: { healthy: true } }))
      const client = new MnemonClient({ isLoopback: false, rpc: { call } } as ClientConnectionHandle)

      await client.statusSummary()

      expect(call).toHaveBeenCalledWith(MNEMON_READ_CHANNEL, 'status-summary', {})
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('routes an application window through the Gateway when DSH declares a transport that does not own the Host', async () => {
    vi.stubGlobal('location', { protocol: 'dsh-app:', hostname: 'app' })
    vi.stubGlobal('__DSH_TRANSPORT__', { ownsHost: false })
    try {
      const call = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value: { healthy: true } } }))
      const client = new MnemonClient({ isLoopback: false, rpc: { call } } as ClientConnectionHandle)

      await client.statusSummary()

      expect(call).toHaveBeenCalledWith('/api', 'dshMnemon/read', { args: { endpoint: 'status-summary', payload: {} } })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('uses the page origin when a remote desktop reports host ownership as loopback', async () => {
    vi.stubGlobal('location', { hostname: 'rsi.example' })
    try {
      const call = vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: { healthy: true } },
      }))
      const client = new MnemonClient({ isLoopback: true, rpc: { call } } as ClientConnectionHandle)

      await client.statusSummary()

      expect(call).toHaveBeenCalledWith('/api', 'dshMnemon/read', {
        args: { endpoint: 'status-summary', payload: {} },
      })
    } finally {
      vi.unstubAllGlobals()
    }
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
    const connection = { rpc: { call }, isLoopback: true } as ClientConnectionHandle
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
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-1', 'workspace-1')

    await client.packTarget()

    expect(call).toHaveBeenCalledWith(expect.any(String), 'target', { sessionId: 'session-1', workspaceId: 'workspace-1' })
  })

  it('routes repository sync through its own channel and confirms both directions', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: {} }))
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-1', 'workspace-1')

    await client.syncStatus()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'status', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.configureSync({ repoUrl: 'https://example.test/owner/repo.git', token: 'ghp_secret' })
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'configure', {
      repoUrl: 'https://example.test/owner/repo.git', token: 'ghp_secret', sessionId: 'session-1', workspaceId: 'workspace-1',
    })
    // A null token clears the stored credential instead of writing one.
    await client.configureSync({ token: null })
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'configure', { token: null, sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.pushSync()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'push', { confirmed: true, sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.pushSync('Sync memory')
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'push', { message: 'Sync memory', confirmed: true, sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.previewSync()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'preview', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.pullSync()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'pull', { confirmed: true, sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.pullSync(['runtime'])
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'pull', {
      components: ['runtime'], confirmed: true, sessionId: 'session-1', workspaceId: 'workspace-1',
    })
  })

  it('routes the read-only backup history and memory diff without asking to write', async () => {
    const call = vi.fn(async (_channel: string, _endpoint: string, _payload: Record<string, unknown>) => ({ ok: true as const, value: {} }))
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-1', 'workspace-1')

    await client.syncBackups()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'backups', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.syncBackups(5)
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'backups', { limit: 5, sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.syncDiff()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'diff', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    // Neither read carries a confirmation: they change nothing on either side.
    expect(call.mock.calls.every(([, , payload]) => payload.confirmed === undefined)).toBe(true)
  })

  it('sends the reviewer guidance only when it holds something, and only the chosen operations', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: {} }))
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-1', 'workspace-1')

    await client.reconcile()
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-review', 'reconcile', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.reconcile('   ')
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-review', 'reconcile', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.reconcile('  Merge the two duplicates.  ')
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-review', 'reconcile', {
      guidance: 'Merge the two duplicates.', sessionId: 'session-1', workspaceId: 'workspace-1',
    })

    // Applying nothing named is the whole plan; naming positions applies exactly those.
    await client.applyReview('review-1')
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-review', 'apply', { id: 'review-1', sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.applyReview('review-1', [2, 0])
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-review', 'apply', {
      id: 'review-1', operations: [2, 0], sessionId: 'session-1', workspaceId: 'workspace-1',
    })

    // An empty selection is still a selection: the Host answers with nothing applied.
    await client.applyReview('review-1', [])
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-review', 'apply', {
      id: 'review-1', operations: [], sessionId: 'session-1', workspaceId: 'workspace-1',
    })
  })

  it('routes GitHub sign-in and the repository picker through the sync channel', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: {} }))
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-1', 'workspace-1')

    await client.githubStatus()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'github-status', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.githubStart()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'github-start', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.githubPoll()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'github-poll', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.githubCancel()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'github-cancel', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.githubSignOut()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'github-signout', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.githubRepositories()
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'github-repositories', { sessionId: 'session-1', workspaceId: 'workspace-1' })

    await client.githubCreateRepository('mnemon-memory', true)
    expect(call).toHaveBeenLastCalledWith(MNEMON_SYNC_CHANNEL, 'github-create', {
      name: 'mnemon-memory', private: true, sessionId: 'session-1', workspaceId: 'workspace-1',
    })
  })

  it('routes provider service settings independently from Memory Spaces', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { providerId: 'mem0', configured: true, settings: { endpoint: 'http://127.0.0.1:8888' }, configuredSecrets: [] } }))
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-1', 'workspace-1')

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
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-1')

    await client.providerServices()
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-read', 'provider-services', { sessionId: 'session-1' })

    call.mockReset()
    call.mockRejectedValue(new Error('transport failure for /dsh-mnemon-write/provider-services: HTTP 403'))
    await expect(client.providerServices()).rejects.toThrow('HTTP 403')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('does not retry an unavailable Provider catalog on a write endpoint', async () => {
    const call = vi.fn(async () => ({ ok: false as const, error: { code: 'bad-request' as const, message: 'unknown read endpoint: provider-services', details: { issues: [] } } }))
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle)
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
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle)

    await expect(client.taskAgentModels()).resolves.toEqual(catalog)
    expect(call).toHaveBeenCalledWith(expect.any(String), 'task-agent-models', {})
  })

  it('asks for the route of the conversation the settings page belongs to', async () => {
    const catalog = {
      effective: { provider: 'ai', model: 'space-bunny', source: 'session' as const },
      groups: [],
      failures: [],
    }
    const call = vi.fn(async () => ({ ok: true as const, value: catalog }))
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-9', 'workspace-2')

    await expect(client.taskAgentModels(false)).resolves.toEqual(catalog)
    expect(call).toHaveBeenCalledWith(expect.any(String), 'task-agent-models', { includeCatalog: false, sessionId: 'session-9', workspaceId: 'workspace-2' })
  })

  it('checks Mnemon embedding status in the selected runtime scope', async () => {
    const status = { available: true, model: 'qwen3-embedding:0.6b', totalInsights: 5, embedded: 4, coverage: '80%' }
    const call = vi.fn(async () => ({ ok: true as const, value: status }))
    const client = new MnemonClient({ rpc: { call }, isLoopback: true } as ClientConnectionHandle, 'session-1', 'workspace-1')

    await expect(client.embeddingStatus()).resolves.toEqual(status)
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'embedding-status', {
      sessionId: 'session-1', workspaceId: 'workspace-1',
    })
  })
})
