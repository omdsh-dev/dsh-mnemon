import { describe, expect, it, vi } from 'vitest'
import type { HostCredentialsService, HostSettingsService } from '../src/host/dsh.ts'
import { createSettingsHandler } from '../src/host/settings.ts'
import { Config, resolveConfig } from '../src/host/config.ts'
import type { SettingsOperation } from '../src/host/protocol.ts'

// Disposable fixture keys only. Neither settings readback nor a failed write may expose them.
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
    mutate: vi.fn(async (_namespace: string, operations: SettingsOperation[], expected?: number) => {
      if (expected !== revision) throw new Error('settings conflict')
      for (const operation of operations) if (operation.op === 'set') value = { ...value, [operation.path[0]!]: operation.value }
      revision++
    }),
  } as unknown as HostSettingsService
  const handler = createSettingsHandler(settings, () => credentials)
  const save = (patch: Record<string, unknown>, expectedRevision = revision) => handler('mutate', {
    expectedRevision, ops: [{ op: 'set', path: ['embedding'], value: { ...value.embedding, apiKey: '', ...patch } }],
  })
  return { settings, credentials, records, handler, save, value: () => value }
}

describe('embedding credentials through the settings bridge', () => {
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

  it('does not implicitly forward an existing credential to a changed endpoint; explicit removal preserves rollback records', async () => {
    const f = fixture()
    await f.save({ apiKey: key })
    expect(await f.save({ endpoint: 'https://another.example.test/v1' })).toMatchObject({ ok: false })
    expect(f.value().embedding.endpoint).toBe(endpoint)
    expect(await f.save({ endpoint: 'http://localhost:11434', clearApiKey: true })).toMatchObject({ ok: true })
    expect(f.value().embedding).toMatchObject({ endpoint: 'http://localhost:11434', apiKey: '', apiKeyRef: '', apiKeyEnv: '' })
    expect(f.records.size).toBe(1)
    expect(JSON.stringify(f.value())).not.toContain('clearApiKey')
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
})
