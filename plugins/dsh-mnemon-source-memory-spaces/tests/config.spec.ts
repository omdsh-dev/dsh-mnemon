import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMemorySpacesConfig, resolveMemorySpacesConfig as resolveConfig } from '../src/config.ts'
import { MEMORY_PLACEMENT_CAPABILITIES, type MemorySpacesStatus } from '../src/contracts.ts'
import { embeddingApiKey } from '../src/embedding-credentials.ts'
import type { ProcessRunner } from '../src/providers/process.ts'
import { createRunner } from '../src/runner.ts'
import { modelStatus } from '../src/view-model.ts'

describe('Memory Spaces configuration rules', () => {
  it('validates configurable recall quality policy thresholds and expansion', () => {
    expect(resolveConfig({
      recallQuality: { policy: 'team-v2', lowScoreThreshold: 0.2, highScoreThreshold: 0.7, candidateMultiplier: 2, maxMediumResults: 5, maxRankedResults: 3, maxUnknownResults: 1 },
    }).recallQuality).toEqual({ policy: 'team-v2', lowScoreThreshold: 0.2, highScoreThreshold: 0.7, candidateMultiplier: 2, maxMediumResults: 5, maxRankedResults: 3, maxUnknownResults: 1 })
    expect(() => resolveConfig({ recallQuality: { lowScoreThreshold: 0.7, highScoreThreshold: 0.6 } })).toThrow('less than')
    expect(() => resolveConfig({ recallQuality: { candidateMultiplier: 1.5 } })).toThrow('integer')
    expect(() => resolveConfig({ recallQuality: { policy: '../unsafe' } })).toThrow('policy id')
    expect(() => resolveConfig({ recallQuality: { maxMediumResults: 51 } })).toThrow('max medium')
    expect(() => resolveConfig({ recallQuality: { maxUnknownResults: -1 } })).toThrow('max unknown')
    expect(resolveConfig({}).recallQuality.maxRankedResults).toBe(4)
    for (const maxRankedResults of [-1, 0.5, 51, Number.NaN]) {
      expect(() => resolveConfig({ recallQuality: { maxRankedResults } })).toThrow('max ranked')
    }
  })

  it('takes a store hint only as a space id', () => {
    for (const store of ['default', 'A-1_b', '9lives']) expect(resolveConfig({ store }).store).toBe(store)
    for (const store of ['../other', '-lead', '_lead', 'a.b', 'a/b', 'ä', 'a b']) {
      expect(() => resolveConfig({ store }), store).toThrow('Memory Spaces store has an invalid identifier')
    }
  })

  it('normalizes and validates DSH-managed Mnemon embedding settings', () => {
    expect(resolveConfig({
      embedding: { enabled: true, endpoint: ' https://ollama.example.test/prefix/// ', model: ' qwen3-embedding:0.6b ', apiKey: '  sk-secret  ' },
    }).embedding).toEqual({
      enabled: true,
      endpoint: 'https://ollama.example.test/prefix',
      model: 'qwen3-embedding:0.6b',
      apiKey: 'sk-secret',
      protocol: 'auto',
    })
    expect(resolveConfig({}).embedding).toMatchObject({ enabled: false, endpoint: 'http://localhost:11434', model: 'nomic-embed-text', apiKey: '', protocol: 'auto' })
    expect(() => resolveConfig({ embedding: { enabled: true, endpoint: 'ftp://ollama.example.test' } })).toThrow('HTTP or HTTPS')
    expect(() => resolveConfig({ embedding: { enabled: true, endpoint: 'http://user:secret@localhost:11434' } })).toThrow('without credentials')
    expect(() => resolveConfig({ embedding: { enabled: true, endpoint: 'http://localhost:11434?tenant=one' } })).toThrow('without credentials')
    expect(() => resolveConfig({ embedding: { enabled: true, endpoint: 'http://localhost:11434?' } })).toThrow('without credentials')
    expect(() => resolveConfig({ embedding: { enabled: true, endpoint: 'http://localhost:11434#' } })).toThrow('without credentials')
    expect(() => resolveConfig({ embedding: { enabled: true, model: 'bad\nmodel' } })).toThrow('control characters')
    expect(() => resolveConfig({ embedding: { enabled: true, apiKey: 'bad\nkey' } })).toThrow('without control characters')
    expect(() => resolveConfig({ embedding: { enabled: true, apiKey: 'k'.repeat(2049) } })).toThrow('0..2048')
    expect(() => resolveConfig({ embedding: { enabled: true, protocol: 'grpc' as never } })).toThrow('unsupported embedding protocol')
  })

  it('resolves a bounded automatic persistence strategy without changing its provider connections', () => {
    expect(resolveConfig({
      persistenceStrategy: {
        mode: 'automatic',
        prompt: 'Prefer shared project memory.',
        rules: {
          allowedProviderIds: ['mnemon-native', 'openviking', 'openviking'],
          dataBoundary: 'allow-remote',
          requiredCapabilities: ['graph'],
          preference: 'shared-first',
        },
        providerConnections: { openviking: { targetUri: 'viking://resources/team' } },
      },
    }).persistenceStrategy).toEqual({
      mode: 'automatic',
      providerId: 'mnemon-native',
      providerDefaulted: true,
      prompt: 'Prefer shared project memory.',
      rules: {
        allowedProviderIds: ['mnemon-native', 'openviking'],
        dataBoundary: 'allow-remote',
        requiredCapabilities: ['graph'],
        preference: 'shared-first',
      },
      providerConnections: { openviking: { targetUri: 'viking://resources/team' } },
    })
  })

  it('takes exactly the placement capabilities its contracts list', () => {
    // The Starter's settings schema offers the same list.
    expect(MEMORY_PLACEMENT_CAPABILITIES).toEqual(['graph', 'entities', 'related', 'exact-write', 'link', 'forget'])
    expect(resolveConfig({ persistenceStrategy: { mode: 'automatic', rules: { requiredCapabilities: [...MEMORY_PLACEMENT_CAPABILITIES] } } })
      .persistenceStrategy.rules.requiredCapabilities).toEqual([...MEMORY_PLACEMENT_CAPABILITIES])
    for (const capability of ['telepathy', 'search', 'Graph']) {
      expect(() => resolveConfig({ persistenceStrategy: { rules: { requiredCapabilities: [capability as never] } } }), capability)
        .toThrow(`dsh-mnemon: unsupported persistence capability: ${capability}`)
    }
  })

  it('marks only an unchosen persistence provider as the default', () => {
    expect(resolveConfig({}).persistenceStrategy).toMatchObject({ mode: 'manual', providerId: 'mnemon-native', providerDefaulted: true })
    expect(resolveConfig({ persistenceStrategy: { providerId: 'mnemon-native' } }).persistenceStrategy).not.toHaveProperty('providerDefaulted')
  })
})

describe('Memory Spaces health for model tools', () => {
  function status(overrides: Partial<MemorySpacesStatus> = {}): MemorySpacesStatus {
    return {
      healthy: true,
      cliPath: '/opt/mnemon/bin/mnemon',
      commandFound: true,
      dataDir: '/data',
      store: 'none',
      mnemonDefaultStore: 'default',
      dshActiveStores: [],
      writeEnabled: true,
      timeoutMs: 10_000,
      defaultRecallLimit: 10,
      memoryBodyDirectory: '/data/.dsh-memory-bodies.json',
      memoryBodies: [],
      providerServices: [],
      ...overrides,
    } as unknown as MemorySpacesStatus
  }

  it('says what durable memory needs when no Memory Space exists, without calling memory unhealthy (issue 336)', () => {
    // No Mnemon CLI and no other Provider: a space cannot be created yet.
    const blocked = modelStatus(status({ commandFound: false }))
    expect(blocked).toMatchObject({ healthy: true, memorySpaces: { total: 0 } })
    expect(blocked.notice).toBe('No Memory Space exists, and none can be created until a memory Provider is ready, so durable memory has nowhere to go and a full MEMORY.md archives to a local file. Install the Mnemon CLI for Mnemon Native, or connect another Provider on the dsh-mnemon page under Plugins, then create and activate a Memory Space.')

    // A ready Provider: only the space is missing.
    const native = modelStatus(status({ commandFound: true }))
    expect(native.notice).toBe('No Memory Space exists yet, so durable memory has nowhere to go and a full MEMORY.md archives to a local file. Create and activate a Memory Space to keep durable memory.')
    const remote = modelStatus(status({ commandFound: false, providerServices: [{ providerId: 'mem0', label: 'Mem0', enabled: true, configured: true, status: 'idle', memoryBodyCount: 0, activeMemoryBodyCount: 0 }] as never }))
    expect(remote.notice).toBe(native.notice)
    // A service saved but switched off cannot create a space either.
    const disabled = modelStatus(status({ commandFound: false, providerServices: [{ providerId: 'mem0', label: 'Mem0', enabled: false, configured: true, status: 'disabled', memoryBodyCount: 0, activeMemoryBodyCount: 0 }] as never }))
    expect(disabled.notice).toBe(blocked.notice)
  })

  it('says what the aggregate sums, so per-space counts can be squared with it (#390)', () => {
    const stats = { totalInsights: 108, deletedInsights: 3, edgeCount: 3879, oplogCount: 40, dbSizeBytes: 3_547_136, byCategory: {}, topEntities: [] }
    const value = modelStatus(status({ memoryBodies: [
      { id: 'default', name: 'Default', active: true, providerEnabled: true, healthy: true, stats },
      // A Provider that keeps no statistics, such as Mem0, counts as healthy and adds nothing.
      { id: 'mem0', name: 'Mem0', active: true, providerEnabled: true, healthy: true },
      { id: 'archive', name: 'Archive', active: false, providerEnabled: true, healthy: true, stats },
    ] as never, stats } as never))
    expect(value.memorySpaces).toMatchObject({ active: 2, healthy: 2 })
    expect(value.aggregate).toEqual({
      scope: 'Sums over the active, healthy Memory Spaces whose Provider reports statistics (spaces); the others add nothing. totalInsights counts live memories, and deletedInsights the forgotten ones a Provider keeps, as Mnemon Native does.',
      spaces: 1,
      totalInsights: 108, deletedInsights: 3, edgeCount: 3879, oplogCount: 40, dbSizeBytes: 3_547_136,
    })
  })

  it('adds nothing once a Memory Space exists', () => {
    const value = modelStatus(status({ memoryBodies: [{ id: 'default', name: 'Default', active: true, providerEnabled: true, healthy: true }] as never }))
    expect(value).not.toHaveProperty('notice')
    expect(value).toMatchObject({ healthy: true, memorySpaces: { total: 1, active: 1, healthy: 1 } })
  })
})

describe('lazy embedding credential resolution', () => {
  const apiKeyRef = 'dsh-mnemon/embedding-12345678-1234-1234-1234-123456789abc'
  const endpoint = 'https://embedding.example.test/v1'
  const config = (auth: object, enabled = true) => resolveMemorySpacesConfig({ dataDir: process.cwd(), embedding: { enabled, endpoint, model: 'fixture', ...auth } })
  afterEach(() => vi.unstubAllEnvs())

  it('reads the current grant for every CLI launch and places the key only in its environment', async () => {
    let apiKey = 'fixture-one'
    const read = vi.fn(async () => ({ kind: 'grant', payload: { version: 1, endpoint, apiKey } }))
    const processRunner = vi.fn<ProcessRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }))
    const settings = config({ apiKeyRef })
    const runner = createRunner(settings, processRunner, read)
    await runner.runJson(['embed', '--status'])
    apiKey = 'fixture-two'
    await runner.runJson(['embed', '--status'])
    expect(read.mock.calls).toHaveLength(2)
    expect(processRunner.mock.calls[0]![2]?.env?.MNEMON_EMBED_API_KEY).toBe('fixture-one')
    expect(processRunner.mock.calls[1]![2]?.env?.MNEMON_EMBED_API_KEY).toBe('fixture-two')
    expect(JSON.stringify(processRunner.mock.calls.map(call => call.slice(0, 2)))).not.toContain('fixture-')
    expect(JSON.stringify(settings)).not.toContain('fixture-one')
    expect(JSON.stringify(settings)).not.toContain('fixture-two')
  })

  it('resolves apiKeyEnv at call time with priority and fails explicitly when it is missing', async () => {
    const settings = config({ apiKeyEnv: 'MNEMON_TEST_EMBEDDING_KEY', apiKey: 'legacy-fallback' })
    vi.stubEnv('MNEMON_TEST_EMBEDDING_KEY', 'fixture-env')
    expect(await embeddingApiKey(settings.embedding)).toBe('fixture-env')
    vi.stubEnv('MNEMON_TEST_EMBEDDING_KEY', '')
    const processRunner = vi.fn<ProcessRunner>()
    await expect(createRunner(settings, processRunner).runJson(['embed', '--status'])).rejects.toThrow('environment variable is unset or empty')
    expect(processRunner).not.toHaveBeenCalled()
  })

  it('refuses missing, malformed, unreadable or mismatched grants without an empty-key request or leaking errors', async () => {
    const settings = config({ apiKeyRef })
    for (const record of [undefined, { kind: 'api-key', apiKey: 'fixture' }, { kind: 'grant', payload: { version: 1, endpoint: 'https://other.test', apiKey: 'fixture' } }]) {
      const processRunner = vi.fn<ProcessRunner>()
      await expect(createRunner(settings, processRunner, async () => record).runJson(['embed', '--status'])).rejects.toThrow(/credential/i)
      expect(processRunner).not.toHaveBeenCalled()
    }
    await expect(embeddingApiKey(settings.embedding, async () => { throw new Error('secret provider diagnostic') })).rejects.toThrow('Cannot read the saved embedding credential')
    await expect(embeddingApiKey(settings.embedding)).rejects.toThrow('storage is unavailable')
  })

  it('redacts reflected keys from CLI failures before they can reach the UI', async () => {
    const processRunner = vi.fn<ProcessRunner>(async () => ({ stdout: '', stderr: 'server rejected fixture-sensitive-key', exitCode: 1 }))
    await expect(createRunner(config({ apiKey: 'fixture-sensitive-key' }), processRunner).runJson(['embed', '--status'])).rejects.toThrow('server rejected [redacted]')
  })

  it('preserves legacy inline authentication and unmanaged CLI environments without looking up a saved reference', async () => {
    expect(await embeddingApiKey(config({ apiKey: 'legacy-fixture' }).embedding)).toBe('legacy-fixture')
    const processRunner = vi.fn<ProcessRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }))
    const read = vi.fn()
    await createRunner(config({ apiKeyRef }, false), processRunner, read).runJson(['embed', '--status'])
    expect(read).not.toHaveBeenCalled()
    expect(processRunner.mock.calls[0]![2]?.env).toBeUndefined()
  })
})
