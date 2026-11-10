import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMemorySpacesConfig } from '../src/config.ts'
import { embeddingApiKey } from '../src/embedding-credentials.ts'
import { createRunner } from '../src/runner.ts'
import type { ProcessRunner } from '../src/providers/process.ts'

const apiKeyRef = 'dsh-mnemon/embedding-12345678-1234-1234-1234-123456789abc'
const endpoint = 'https://embedding.example.test/v1'
const config = (auth: object, enabled = true) => resolveMemorySpacesConfig({ dataDir: process.cwd(), embedding: { enabled, endpoint, model: 'fixture', ...auth } })
afterEach(() => vi.unstubAllEnvs())

describe('lazy embedding credential resolution', () => {
  it('reads the current grant for every CLI launch and places the key only in its environment', async () => {
    let apiKey = 'fixture-one'
    const read = vi.fn(async () => ({ kind: 'grant', payload: { version: 1, endpoint, apiKey } }))
    const process = vi.fn<ProcessRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }))
    const settings = config({ apiKeyRef })
    const runner = createRunner(settings, process, read)
    await runner.runJson(['embed', '--status'])
    apiKey = 'fixture-two'
    await runner.runJson(['embed', '--status'])
    expect(read.mock.calls).toHaveLength(2)
    expect(process.mock.calls[0]![2]?.env?.MNEMON_EMBED_API_KEY).toBe('fixture-one')
    expect(process.mock.calls[1]![2]?.env?.MNEMON_EMBED_API_KEY).toBe('fixture-two')
    expect(JSON.stringify(process.mock.calls.map(call => call.slice(0, 2)))).not.toContain('fixture-')
    expect(JSON.stringify(settings)).not.toContain('fixture-one')
    expect(JSON.stringify(settings)).not.toContain('fixture-two')
  })

  it('resolves apiKeyEnv at call time with priority and fails explicitly when it is missing', async () => {
    const settings = config({ apiKeyEnv: 'MNEMON_TEST_EMBEDDING_KEY', apiKey: 'legacy-fallback' })
    vi.stubEnv('MNEMON_TEST_EMBEDDING_KEY', 'fixture-env')
    expect(await embeddingApiKey(settings.embedding)).toBe('fixture-env')
    vi.stubEnv('MNEMON_TEST_EMBEDDING_KEY', '')
    const process = vi.fn<ProcessRunner>()
    await expect(createRunner(settings, process).runJson(['embed', '--status'])).rejects.toThrow('environment variable is unset or empty')
    expect(process).not.toHaveBeenCalled()
  })

  it('refuses missing, malformed, unreadable or mismatched grants without an empty-key request or leaking errors', async () => {
    const settings = config({ apiKeyRef })
    for (const record of [undefined, { kind: 'api-key', apiKey: 'fixture' }, { kind: 'grant', payload: { version: 1, endpoint: 'https://other.test', apiKey: 'fixture' } }]) {
      const process = vi.fn<ProcessRunner>()
      await expect(createRunner(settings, process, async () => record).runJson(['embed', '--status'])).rejects.toThrow(/credential/i)
      expect(process).not.toHaveBeenCalled()
    }
    await expect(embeddingApiKey(settings.embedding, async () => { throw new Error('secret provider diagnostic') })).rejects.toThrow('Cannot read the saved embedding credential')
    await expect(embeddingApiKey(settings.embedding)).rejects.toThrow('storage is unavailable')
  })

  it('redacts reflected keys from CLI failures before they can reach the UI', async () => {
    const process = vi.fn<ProcessRunner>(async () => ({ stdout: '', stderr: 'server rejected fixture-sensitive-key', exitCode: 1 }))
    await expect(createRunner(config({ apiKey: 'fixture-sensitive-key' }), process).runJson(['embed', '--status'])).rejects.toThrow('server rejected [redacted]')
  })

  it('preserves legacy inline authentication and unmanaged CLI environments without looking up a saved reference', async () => {
    expect(await embeddingApiKey(config({ apiKey: 'legacy-fixture' }).embedding)).toBe('legacy-fixture')
    const process = vi.fn<ProcessRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }))
    const read = vi.fn()
    await createRunner(config({ apiKeyRef }, false), process, read).runJson(['embed', '--status'])
    expect(read).not.toHaveBeenCalled()
    expect(process.mock.calls[0]![2]?.env).toBeUndefined()
  })
})
