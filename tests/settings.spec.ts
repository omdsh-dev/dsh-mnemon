import { describe, expect, it, vi } from 'vitest'
import { Config, resolveConfig } from '../src/host/config.ts'
import type { HostConnectionHandle, HostCredentialsService, HostSettingsService, SettingsOperation } from "../src/host/dsh.ts"
import { createSettingsHandler, migrateLegacyDisplayMode, registerSettingsRpc } from "../src/host/settings.ts"
import { MNEMON_SETTINGS_CHANNEL, type SettingsOperation as ProtocolSettingsOperation } from "../src/host/protocol.ts"

describe('Mnemon settings bridge', () => {
  it('exposes and mutates only the Mnemon namespace through a revision fence', async () => {
    let revision = 2
    let value = { store: 'base', timeoutMs: 10000 }
    let user: Record<string, unknown> = {}
    const mutate = vi.fn(async (_namespace: string, ops: Array<{ op: string; path: string[]; value?: unknown }>, expected?: number) => {
      expect(expected).toBe(revision)
      for (const op of ops) {
        if (op.op === 'set') user[op.path[0]!] = op.value
        else delete user[op.path[0]!]
      }
      value = { ...value, ...user }
      revision += 1
    })
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate,
      describe: () => [{ ns: 'mnemon', value, base: { store: 'base', timeoutMs: 10000 }, user, revision, applies: 'restart' as const }],
    } as unknown as HostSettingsService
    const handler = createSettingsHandler(settings)

    const read = await handler('get', {})
    expect(read).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ revision: 2, writable: true }) }))

    const ops = [
      { op: 'set', path: ['store'], value: 'settings-store' },
      { op: 'set', path: ['idleReviewMs'], value: 45000 },
      { op: 'set', path: ['tabEnabled'], value: false },
      { op: 'set', path: ['runtimeUserScope'], value: 'global' },
      { op: 'set', path: ['embedding'], value: { enabled: true, endpoint: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b' } },
      { op: 'set', path: ['runtimeMemory'], value: { inheritToSubagents: true, memoryLimitBytes: 20480, userLimitBytes: 10240, maintenanceMaxTokens: 32768 } },
      { op: 'set', path: ['taskAgentModel'], value: { mode: 'fixed', provider: 'deepseek', model: 'deepseek-chat' } },
    ]
    const written = await handler('mutate', { expectedRevision: 2, ops })
    expect(mutate).toHaveBeenCalledWith('mnemon', ops, 2)
    expect(written).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ revision: 3, user: { store: 'settings-store', idleReviewMs: 45000, tabEnabled: false, runtimeUserScope: 'global', embedding: { enabled: true, endpoint: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b' }, runtimeMemory: { inheritToSubagents: true, memoryLimitBytes: 20480, userLimitBytes: 10240, maintenanceMaxTokens: 32768 }, taskAgentModel: { mode: 'fixed', provider: 'deepseek', model: 'deepseek-chat' } } }) }))
  })

  it.each(['sidebar', 'builtin'] as const)('accepts live displayMode=%s and resetting the preference', async displayMode => {
    const mutate = vi.fn(async () => {})
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate,
      describe: () => [{ ns: 'mnemon', value: {}, revision: 0, applies: 'live' as const }],
    } as unknown as HostSettingsService
    const handler = createSettingsHandler(settings)
    const op = { op: 'set', path: ['displayMode'], value: displayMode }
    await expect(handler('mutate', { ops: [op], expectedRevision: 0 })).resolves.toMatchObject({ ok: true })
    expect(mutate).toHaveBeenCalledWith('mnemon', [op], 0)
    await expect(handler('mutate', { ops: [{ op: 'unset', path: ['displayMode'] }] })).resolves.toMatchObject({ ok: true })
  })

  it('rejects unsupported settings fields', async () => {
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate: vi.fn(),
      describe: () => [{ ns: 'mnemon', value: {}, revision: 0, applies: 'restart' as const }],
    } as unknown as HostSettingsService
    const response = await createSettingsHandler(settings)('mutate', { ops: [{ op: 'set', path: ['other'], value: true }] })
    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'settings-rejected', details: { ns: 'mnemon' } }),
    }))
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('accepts only Boolean Layer switches from the Web settings surface', async () => {
    const mutate = vi.fn(async () => {})
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate,
      describe: () => [{ ns: 'mnemon', value: {}, revision: 0, applies: 'live' as const }],
    } as unknown as HostSettingsService
    const handler = createSettingsHandler(settings)
    const switchOp = { op: 'set', path: ['memoryTopology', 'layers', 'documents', 'enabled'], value: false }

    await expect(handler('mutate', { ops: [switchOp] })).resolves.toMatchObject({ ok: true })
    expect(mutate).toHaveBeenCalledWith('mnemon', [switchOp], undefined)

    await expect(handler('mutate', { ops: [{ ...switchOp, value: 'off' }] })).resolves.toMatchObject({ ok: false })
    await expect(handler('mutate', { ops: [{ op: 'set', path: ['memoryTopology'], value: {} }] })).resolves.toMatchObject({ ok: false })
    await expect(handler('mutate', { ops: [{ op: 'set', path: ['memoryTopology', 'layers', 'documents', 'participation'], value: {} }] })).resolves.toMatchObject({ ok: false })
  })

  it('accepts the whole persistence strategy through the Mnemon namespace', async () => {
    const persistenceStrategy = {
      mode: 'automatic',
      providerId: 'mnemon-native',
      prompt: 'Prefer shared project memory.',
      rules: {
        allowedProviderIds: ['mnemon-native', 'openviking'],
        dataBoundary: 'allow-remote',
        requiredCapabilities: ['graph'],
        preference: 'shared-first',
      },
      providerConnections: { openviking: { targetUri: 'viking://resources/team' } },
    }
    const mutate = vi.fn(async () => {})
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate,
      describe: () => [{ ns: 'mnemon', value: { persistenceStrategy }, revision: 1, applies: 'restart' as const }],
    } as unknown as HostSettingsService

    await expect(createSettingsHandler(settings)('mutate', {
      ops: [{ op: 'set', path: ['persistenceStrategy'], value: persistenceStrategy }],
    })).resolves.toMatchObject({ ok: true })
    expect(mutate).toHaveBeenCalledWith('mnemon', [
      { op: 'set', path: ['persistenceStrategy'], value: persistenceStrategy },
    ], undefined)
  })

  it('lets the settings page switch Git sync on, and reads the switch back', async () => {
    const mutate = vi.fn(async () => {})
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate,
      describe: () => [{ ns: 'mnemon', value: { syncEnabled: false }, revision: 0, applies: 'live' as const }],
    } as unknown as HostSettingsService
    const handler = createSettingsHandler(settings)
    const on = { op: 'set', path: ['syncEnabled'], value: true }

    // The switch is the whole gate for the Git channel, so the one profile write it
    // makes has to be accepted here; a rejected write would leave the block open with
    // nothing behind it.
    await expect(handler('mutate', { ops: [on] })).resolves.toMatchObject({ ok: true })
    expect(mutate).toHaveBeenCalledWith('mnemon', [on], undefined)
    // Switching it back off is the same write, so a reader can close the block again.
    const off = { op: 'set', path: ['syncEnabled'], value: false }
    await expect(handler('mutate', { ops: [off] })).resolves.toMatchObject({ ok: true })
    expect(mutate).toHaveBeenLastCalledWith('mnemon', [off], undefined)
  })
  it('keeps the startup-only remote access setting immutable from the Web bridge', async () => {
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate: vi.fn(),
      describe: () => [{ ns: 'mnemon', value: { remoteAccess: 'read-only' }, revision: 0, applies: 'live' as const }],
    } as unknown as HostSettingsService
    await expect(createSettingsHandler(settings)('mutate', {
      ops: [{ op: 'set', path: ['remoteAccess'], value: 'trusted-host' }],
    })).resolves.toMatchObject({ ok: false, error: { code: 'settings-rejected' } })
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('exposes live browser interaction settings through a separate namespace', async () => {
    let revision = 4
    let value = { turnBar: false, saveAction: false }
    const mutate = vi.fn(async (_namespace: string, ops: Array<{ op: string; path: string[]; value?: unknown }>) => {
      value = { ...value, ...Object.fromEntries(ops.filter(op => op.op === 'set').map(op => [op.path[0], op.value])) }
      revision += 1
    })
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate,
      describe: () => [
        { ns: 'mnemon', value: {}, revision: 1, applies: 'restart' as const },
        { ns: 'mnemon-ui', value, base: { turnBar: false, saveAction: false }, user: {}, revision, applies: 'live' as const },
      ],
    } as unknown as HostSettingsService
    const handler = createSettingsHandler(settings)

    await expect(handler('get', { namespace: 'mnemon-ui' })).resolves.toMatchObject({ ok: true, value: { applies: 'live', revision: 4 } })
    const ops = [
      { op: 'set', path: ['turnBar'], value: true },
      { op: 'set', path: ['saveAction'], value: true },
    ]
    await expect(handler('mutate', { namespace: 'mnemon-ui', expectedRevision: 4, ops })).resolves.toMatchObject({ ok: true, value: { revision: 5 } })
    expect(mutate).toHaveBeenCalledWith('mnemon-ui', ops, 4)

    await expect(handler('mutate', { namespace: 'mnemon-ui', ops: [{ op: 'set', path: ['toolviews'], value: true }] })).resolves.toMatchObject({ ok: false })
  })

  it('exposes 技能管理 settings through their own namespace, one known field at a time', async () => {
    const mutate = vi.fn(async () => {})
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate,
      describe: () => [
        { ns: 'mnemon', value: {}, revision: 2, applies: 'live' as const },
        { ns: 'mnemon-skills', value: { evolution: false }, revision: 2, applies: 'live' as const },
      ],
    } as unknown as HostSettingsService
    const handler = createSettingsHandler(settings)
    await expect(handler('get', { namespace: 'mnemon-skills' })).resolves.toMatchObject({ ok: true, value: { applies: 'live', revision: 2 } })
    const ops = [{ op: 'set', path: ['evolution'], value: true }, { op: 'set', path: ['allowCreate'], value: false }, { op: 'set', path: ['allowUpdate'], value: true }, { op: 'set', path: ['idleSeconds'], value: 30 }]
    await expect(handler('mutate', { namespace: 'mnemon-skills', expectedRevision: 2, ops })).resolves.toMatchObject({ ok: true })
    expect(mutate).toHaveBeenCalledWith('mnemon-skills', ops, 2)
    await expect(handler('mutate', { namespace: 'mnemon-skills', ops: [{ op: 'set', path: ['dataDir'], value: '/elsewhere' }] })).resolves.toMatchObject({ ok: false })
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('refuses every write to the retired toolviews preference while legacy clients keep their interaction paths', async () => {
    const mutate = vi.fn(async () => {})
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate,
      describe: () => [
        { ns: 'mnemon', value: {}, revision: 0, applies: 'live' as const },
        { ns: 'mnemon-ui', value: {}, revision: 0, applies: 'live' as const },
      ],
    } as unknown as HostSettingsService
    const handler = createSettingsHandler(settings)
    for (const request of [
      { ops: [{ op: 'set', path: ['conversationInteraction', 'toolviews'], value: true }] },
      { ops: [{ op: 'unset', path: ['conversationInteraction', 'toolviews'] }] },
      { namespace: 'mnemon-ui', ops: [{ op: 'unset', path: ['toolviews'] }] },
    ]) {
      await expect(handler('mutate', request)).resolves.toMatchObject({ ok: false, error: { code: 'settings-rejected' } })
    }
    expect(mutate).not.toHaveBeenCalled()
    const legacy = { op: 'set', path: ['conversationInteraction', 'turnBar'], value: false }
    await expect(handler('mutate', { ops: [legacy] })).resolves.toMatchObject({ ok: true })
    expect(mutate).toHaveBeenCalledWith('mnemon', [legacy], undefined)
  })
})

describe('canonical builtin configuration', () => {
  function fixture(options: { base?: Record<string, unknown>; user?: Record<string, unknown>; writable?: boolean } = {}) {
    const base = options.base ?? {}
    let user = structuredClone(options.user ?? {})
    let revision = 3
    const conflict = () => Object.assign(new Error('settings changed concurrently'), { code: 'SETTINGS_CONFLICT' })
    const mutate = vi.fn(async (namespace: string, ops: SettingsOperation[], expected?: number) => {
      expect(namespace).toBe('mnemon')
      if (expected !== undefined && expected !== revision) throw conflict()
      for (const op of ops) {
        expect(op.path).toHaveLength(1)
        if (op.op === 'set') user[op.path[0]!] = op.value
        else delete user[op.path[0]!]
      }
      revision += 1
    })
    const settings = {
      writable: options.writable ?? true,
      register: vi.fn(),
      describe: () => [{ ns: 'mnemon', base, user: structuredClone(user), value: Config({ ...base, ...user }), revision, applies: 'live' as const }],
      mutate,
      onUpdated: () => () => {},
    } satisfies HostSettingsService
    return {
      settings, mutate, conflict,
      stored: () => structuredClone(user),
      externalEdit: (patch: Record<string, unknown>) => { user = { ...user, ...patch }; revision += 1 },
    }
  }

  const canonicalOp = { op: 'set', path: ['displayMode'], value: 'builtin' }

  it.each(['user', 'base'] as const)('migrates legacy %s configuration with one fenced leaf edit', async source => {
    const value = fixture({ [source]: { displayMode: 'buildin' }, user: { timeoutMs: 25000, ...(source === 'user' ? { displayMode: 'buildin' } : {}) } })
    await migrateLegacyDisplayMode(value.settings)
    expect(value.mutate).toHaveBeenCalledExactlyOnceWith('mnemon', [canonicalOp], 3)
    expect(value.stored()).toEqual({ timeoutMs: 25000, displayMode: 'builtin' })
    await migrateLegacyDisplayMode(value.settings)
    expect(value.mutate).toHaveBeenCalledTimes(1)
  })

  it.each(['sidebar', 'builtin'] as const)('preserves an explicit %s override above a legacy profile base', async displayMode => {
    const value = fixture({ base: { displayMode: 'buildin' }, user: { displayMode } })
    await migrateLegacyDisplayMode(value.settings)
    expect(value.mutate).not.toHaveBeenCalled()
    expect(value.stored()).toEqual({ displayMode })
  })

  it.each([undefined, 'sidebar', 'builtin'] as const)('does not pin already canonical or absent configuration: %s', async displayMode => {
    const value = fixture({ base: displayMode === undefined ? {} : { displayMode } })
    await migrateLegacyDisplayMode(value.settings)
    expect(value.mutate).not.toHaveBeenCalled()
    expect(value.stored()).toEqual({})
  })

  it('recognizes legacy read-only settings without attempting a write or misreporting the raw document', async () => {
    const value = fixture({ user: { displayMode: 'buildin' }, writable: false })
    await migrateLegacyDisplayMode(value.settings)
    expect(value.mutate).not.toHaveBeenCalled()
    await expect(createSettingsHandler(value.settings)('get', {})).resolves.toMatchObject({
      ok: true, value: { value: { displayMode: 'builtin' }, user: { displayMode: 'buildin' }, writable: false },
    })
  })

  it('never overwrites a newer explicit Sidebar choice', async () => {
    const value = fixture({ user: { displayMode: 'buildin' } })
    value.mutate.mockImplementationOnce(async () => {
      value.externalEdit({ displayMode: 'sidebar' })
      throw value.conflict()
    })
    await migrateLegacyDisplayMode(value.settings)
    expect(value.mutate).toHaveBeenCalledTimes(1)
    expect(value.stored()).toEqual({ displayMode: 'sidebar' })
  })

  it('retries an unrelated concurrent edit with its new revision and preserves it', async () => {
    const value = fixture({ user: { displayMode: 'buildin', timeoutMs: 10000 } })
    value.mutate.mockImplementationOnce(async () => {
      value.externalEdit({ timeoutMs: 20000 })
      throw value.conflict()
    })
    await migrateLegacyDisplayMode(value.settings)
    expect(value.mutate).toHaveBeenNthCalledWith(2, 'mnemon', [canonicalOp], 4)
    expect(value.stored()).toEqual({ displayMode: 'builtin', timeoutMs: 20000 })
  })

  it('surfaces persistence failures without pretending the stored alias was changed', async () => {
    const value = fixture({ user: { displayMode: 'buildin' } })
    value.mutate.mockRejectedValue(new Error('test persistence unavailable'))
    await expect(migrateLegacyDisplayMode(value.settings)).rejects.toThrow('persistence unavailable')
    expect(value.stored()).toEqual({ displayMode: 'buildin' })
    await expect(createSettingsHandler(value.settings)('get', {})).resolves.toMatchObject({ ok: true, value: { value: { displayMode: 'builtin' } } })
  })

  it('canonicalizes an external legacy edit again without repeated writes after convergence', async () => {
    const value = fixture({ user: { displayMode: 'buildin' } })
    await migrateLegacyDisplayMode(value.settings)
    value.externalEdit({ displayMode: 'buildin', tabEnabled: false })
    await migrateLegacyDisplayMode(value.settings)
    await migrateLegacyDisplayMode(value.settings)
    expect(value.mutate).toHaveBeenCalledTimes(2)
    expect(value.stored()).toEqual({ displayMode: 'builtin', tabEnabled: false })
  })

  it('accepts an old client write but persists and returns only builtin', async () => {
    const value = fixture()
    const op = { op: 'set', path: ['displayMode'], value: 'buildin' }
    await expect(createSettingsHandler(value.settings)('mutate', { ops: [op], expectedRevision: 3 })).resolves.toMatchObject({
      ok: true, value: { value: { displayMode: 'builtin' }, user: { displayMode: 'builtin' }, revision: 4 },
    })
    expect(value.mutate).toHaveBeenCalledExactlyOnceWith('mnemon', [canonicalOp], 3)
    expect(op.value).toBe('buildin')
  })

  it.each(['built-in', 'Builtin', '', true])('rejects unsupported placement %s before persisting', async displayMode => {
    const value = fixture()
    await expect(createSettingsHandler(value.settings)('mutate', { ops: [{ op: 'set', path: ['displayMode'], value: displayMode }] })).resolves.toMatchObject({ ok: false })
    expect(value.mutate).not.toHaveBeenCalled()
  })
})

describe('embedding credentials through the settings bridge', () => {
  const key = 'fixture-embedding-key'
  const endpoint = 'https://embedding.example.test/v1'
  function fixture(embedding: Record<string, unknown> = {}) {
    let value = { embedding: { enabled: true, endpoint, model: 'fixture', ...embedding } }
    let revision = 1
    const records = new Map<string, unknown>()
    const credentials: HostCredentialsService = {
      describeRecord: async reference => ({ configured: records.has(reference), writable: true }),
      readRecord: vi.fn(async reference => records.get(reference)),
      modifyRecord: vi.fn(async (reference, update) => { const next = await update(records.get(reference)); records.set(reference, next); return next }),
      deleteRecord: vi.fn(async reference => { records.delete(reference) }),
    }
    const settings = {
      writable: true,
      describe: () => [{ ns: 'mnemon', value, base: value, user: value, revision, applies: 'live' }],
      mutate: vi.fn(async (_namespace: string, operations: ProtocolSettingsOperation[], expected?: number) => {
        if (expected !== revision) throw new Error('settings conflict')
        for (const operation of operations) {
          if (operation.op === 'set') value = { ...value, [operation.path[0]!]: operation.value }
          else {
            const next = { ...value } as Record<string, unknown>
            delete next[operation.path[0]!]
            value = next as typeof value
          }
        }
        revision++
      }),
    } as unknown as HostSettingsService
    const handler = createSettingsHandler(settings, () => credentials)
    const save = (patch: Record<string, unknown>, expectedRevision = revision) => handler('mutate', {
      expectedRevision, ops: [{ op: 'set', path: ['embedding'], value: { ...value.embedding, apiKey: '', ...patch } }],
    })
    return { settings, credentials, records, handler, save, value: () => value }
  }

  it('stores a verified endpoint-bound grant and persists only its reference, retaining it on ordinary edits', async () => {
    const f = fixture()
    const response = await f.save({ apiKey: key })
    expect(response.ok).toBe(true)
    expect(JSON.stringify(response)).not.toContain(key)
    expect(JSON.stringify(f.value())).not.toContain(key)
    const reference = (f.value().embedding as Record<string, unknown>).apiKeyRef as string
    expect(f.records.get(reference)).toEqual({ kind: 'grant', payload: { version: 1, endpoint, apiKey: key } })
    expect(await f.save({ model: 'another-model' })).toMatchObject({ ok: true })
    expect(f.records.size).toBe(1)
    expect(f.value().embedding).toMatchObject({ apiKey: '', apiKeyRef: reference, model: 'another-model' })
  })

  it('redacts legacy values everywhere without changing them until a successful migration', async () => {
    const f = fixture({ apiKey: key })
    const read = await f.handler('get', {})
    expect(JSON.stringify(read)).not.toContain(key)
    expect(read).toMatchObject({ ok: true, value: { value: { embedding: { apiKeyStorage: 'legacy', apiKeyConfigured: true } } } })
    expect(f.value().embedding).toMatchObject({ apiKey: key })
    expect(await f.save({})).toMatchObject({ ok: true })
    expect(JSON.stringify(f.value())).not.toContain(key)
    expect(f.records.size).toBe(1)
  })

  it('never writes plaintext when storage is unavailable, and supports an explicit environment variable instead', async () => {
    const f = fixture({ apiKey: key })
    const handler = createSettingsHandler(f.settings)
    const response = await handler('mutate', { ops: [{ op: 'set', path: ['embedding'], value: { enabled: true, endpoint, model: 'fixture', apiKey: '' } }] })
    expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining('credentials storage is unavailable') } })
    expect(f.value().embedding).toMatchObject({ apiKey: key })
    expect(JSON.stringify(response)).not.toContain(key)
    expect(await f.save({ apiKeyEnv: 'FIXTURE_EMBED_KEY' })).toMatchObject({ ok: true })
    expect(f.value().embedding).toMatchObject({ apiKey: '', apiKeyRef: '', apiKeyEnv: 'FIXTURE_EMBED_KEY' })
    expect(f.records.size).toBe(0)
  })

  it('retains the old key if credential readback fails or profile persistence loses its revision race', async () => {
    const f = fixture({ apiKey: key })
    vi.mocked(f.credentials.readRecord).mockResolvedValueOnce(undefined)
    expect(await f.save({})).toMatchObject({ ok: false })
    expect(f.records.size).toBe(0)
    expect(f.value().embedding).toMatchObject({ apiKey: key })
    vi.mocked(f.settings.mutate).mockRejectedValueOnce(new Error('settings conflict'))
    expect(await f.save({})).toMatchObject({ ok: false })
    expect(f.records.size).toBe(0)
    expect(f.value().embedding).toMatchObject({ apiKey: key })
    expect(await f.save({}, 0)).toMatchObject({ ok: false })
    expect(f.records.size).toBe(0)
  })

  it('lets only the revision winner retain its new credential during concurrent saves', async () => {
    const f = fixture()
    const results = await Promise.all([f.save({ apiKey: 'fixture-first' }), f.save({ apiKey: 'fixture-second' })])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(f.records.size).toBe(1)
    expect(f.records.has((f.value().embedding as Record<string, unknown>).apiKeyRef as string)).toBe(true)
  })

  it('does not implicitly forward an existing credential to a changed endpoint, preserves rollback records on failed commits, and cleans up superseded records on commit', async () => {
    const f = fixture()
    await f.save({ apiKey: key })
    const initialRef = (f.value().embedding as Record<string, unknown>).apiKeyRef as string
    expect(f.records.has(initialRef)).toBe(true)

    expect(await f.save({ endpoint: 'https://another.example.test/v1' })).toMatchObject({ ok: false })
    expect(f.value().embedding.endpoint).toBe(endpoint)
    expect(f.records.has(initialRef)).toBe(true)

    // Failed profile commit retains the previous credential record for rollback safety.
    vi.mocked(f.settings.mutate).mockRejectedValueOnce(new Error('disk error'))
    expect(await f.save({ endpoint: 'http://localhost:11434', clearApiKey: true })).toMatchObject({ ok: false })
    expect(f.records.has(initialRef)).toBe(true)

    // Committed clearApiKey deletes the superseded credential record.
    expect(await f.save({ endpoint: 'http://localhost:11434', clearApiKey: true })).toMatchObject({ ok: true })
    expect(f.value().embedding).toMatchObject({ endpoint: 'http://localhost:11434', apiKey: '', apiKeyRef: '', apiKeyEnv: '' })
    expect(f.records.size).toBe(0)
    expect(JSON.stringify(f.value())).not.toContain('clearApiKey')
  })

  it('deletes superseded credential records when rotating keys, switching to apiKeyEnv, or unsetting embedding', async () => {
    const f = fixture()
    await f.save({ apiKey: 'first-secret-key' })
    const firstRef = (f.value().embedding as Record<string, unknown>).apiKeyRef as string
    expect(f.records.size).toBe(1)

    // Key rotation deletes firstRef and keeps only secondRef.
    expect(await f.save({ apiKey: 'second-secret-key' })).toMatchObject({ ok: true })
    const secondRef = (f.value().embedding as Record<string, unknown>).apiKeyRef as string
    expect(secondRef).not.toBe(firstRef)
    expect(f.records.has(firstRef)).toBe(false)
    expect(f.records.has(secondRef)).toBe(true)
    expect(f.records.size).toBe(1)

    // Switching to apiKeyEnv deletes secondRef.
    expect(await f.save({ apiKeyEnv: 'ROTATED_EMBED_KEY' })).toMatchObject({ ok: true })
    expect(f.records.size).toBe(0)

    // Saving a key and unsetting ['embedding'] deletes the stored credential record.
    expect(await f.save({ apiKey: 'third-secret-key', apiKeyEnv: '' })).toMatchObject({ ok: true })
    expect(f.records.size).toBe(1)
    expect(await f.handler('mutate', {
      expectedRevision: 5,
      ops: [{ op: 'unset', path: ['embedding'] }],
    })).toMatchObject({ ok: true })
    expect(f.records.size).toBe(0)
  })

  it.each([null, '', false, -1, 1.5, Number.NaN])('rejects malformed expectedRevision (%j) instead of coercing it', async invalidRevision => {
    const f = fixture()
    const response = await f.handler('mutate', {
      expectedRevision: invalidRevision,
      ops: [{ op: 'unset', path: ['displayMode'] }],
    })
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'settings-rejected', message: 'expectedRevision must be a non-negative integer' },
    })
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('rejects arbitrary credential references and invalid settings before writing a record', async () => {
    const f = fixture()
    for (const patch of [{ apiKeyRef: 'dsh-mnemon/github' }, { apiKeyEnv: 'INVALID NAME' }, { apiKey: key, apiKeyEnv: 'ENV' }, { apiKey: key, endpoint: 'https://secret:secret@example.test/' }]) {
      expect(await f.save(patch)).toMatchObject({ ok: false })
    }
    expect(f.records.size).toBe(0)
  })

  it('retains environment references through the published profile schema and resolved runtime configuration', () => {
    const config = Config({ embedding: { enabled: true, endpoint, model: 'fixture', apiKeyEnv: 'FIXTURE_EMBED_KEY' } })
    expect(config.embedding?.apiKeyEnv).toBe('FIXTURE_EMBED_KEY')
    expect(resolveConfig(config).embedding.apiKeyEnv).toBe('FIXTURE_EMBED_KEY')
    expect(() => resolveConfig({ embedding: { apiKeyEnv: 'BAD NAME' } })).toThrow('apiKeyEnv')
  })

  it('normalizes documents.limitBytes and skills directory overrides across schema, resolver, and settings facade', async () => {
    const defaults = resolveConfig({})
    expect(defaults.documents).toEqual({ limitBytes: 10_485_760 })
    expect(defaults.skills.dshHome).toBeUndefined()
    expect(defaults.skills.agentsHome).toBeUndefined()

    const configured = Config({
      documents: { limitBytes: 25_165_824 },
      skills: { dshHome: '  /custom/dsh  ', agentsHome: '   ' },
    })
    expect(configured.documents?.limitBytes).toBe(25_165_824)
    expect(configured.skills?.dshHome).toBe('/custom/dsh')
    expect(configured.skills?.agentsHome).toBeUndefined()
    const resolved = resolveConfig(configured)
    expect(resolved.documents).toEqual({ limitBytes: 25_165_824 })
    expect(resolved.skills.dshHome).toBe('/custom/dsh')
    expect(resolved.skills.agentsHome).toBeUndefined()

    expect(() => Config({ documents: { limitBytes: 0 } })).toThrow()
    expect(() => Config({ documents: { limitBytes: 104_857_601 } })).toThrow()

    const mutate = vi.fn(async () => {})
    const settings = {
      writable: true,
      register: vi.fn(),
      mutate,
      describe: () => [
        { ns: 'mnemon', value: {}, revision: 1, applies: 'live' as const },
        { ns: 'mnemon-skills', value: {}, revision: 1, applies: 'live' as const },
      ],
    } as unknown as HostSettingsService
    const handler = createSettingsHandler(settings)

    await expect(handler('mutate', {
      expectedRevision: 1,
      ops: [{ op: 'set', path: ['documents'], value: { limitBytes: 20_971_520 } }],
    })).resolves.toMatchObject({ ok: true })
    expect(mutate).toHaveBeenCalledWith('mnemon', [{ op: 'set', path: ['documents'], value: { limitBytes: 20_971_520 } }], 1)

    await expect(handler('mutate', {
      ops: [{ op: 'set', path: ['documents'], value: { limitBytes: 0 } }],
    })).resolves.toMatchObject({ ok: false, error: { code: 'settings-rejected' } })

    const skillDirOps = [
      { op: 'set', path: ['dshHome'], value: '/custom/dsh' },
      { op: 'set', path: ['agentsHome'], value: '/custom/agents' },
    ]
    await expect(handler('mutate', {
      namespace: 'mnemon-skills',
      expectedRevision: 1,
      ops: skillDirOps,
    })).resolves.toMatchObject({ ok: true })
    expect(mutate).toHaveBeenCalledWith('mnemon-skills', skillDirOps, 1)

    await expect(handler('mutate', {
      namespace: 'mnemon-skills',
      ops: [{ op: 'unset', path: ['dshHome'] }, { op: 'unset', path: ['agentsHome'] }],
    })).resolves.toMatchObject({ ok: true })
  })
})
