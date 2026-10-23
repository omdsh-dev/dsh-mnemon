import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { MEMORY_PLACEMENT_CAPABILITIES } from 'dsh-mnemon-source-memory-spaces/contracts'
import { Config as RuntimeConfig } from 'dsh-mnemon-source-runtime'
import { RUNTIME_MEMORY_LIMIT_MAX_BYTES, RUNTIME_MEMORY_LIMITS } from 'dsh-mnemon-source-runtime/contracts'
import { Config, resolveConfig } from "../src/host/config.ts"

afterEach(() => vi.unstubAllEnvs())

describe('Mnemon config and resolution', () => {
  it.each([{ maxPerSession: -1 }, { maxPerSession: 201 }, { minIntervalMs: 0 }, { maxContextChars: 1 }, { maxTokens: 0 }, { provider: 'unisolated' }, { agentTeams: 'unrestricted' }, { runtimeMemory: 'documents' }])('rejects invalid idle review policy %j', idleReview => {
    expect(() => resolveConfig({ idleReview } as never)).toThrow()
  })
  it('keeps idle review to Documents only when runtime memory is off', () => {
    expect(resolveConfig({ idleReview: { runtimeMemory: false } }).idleReview).toMatchObject({ enabled: true, runtimeMemory: false, provider: 'spawn' })
  })
  it('materializes conservative defaults', () => {
    expect(resolveConfig({})).toMatchObject({
      storageScope: 'global',
      runtimeUserScope: 'storage',
      timeoutMs: 10_000,
      defaultRecallLimit: 10,
      runtimeMemory: {
        memoryLimitBytes: 10_240,
        userLimitBytes: 4_096,
        maintenanceMaxTokens: 8_192,
      },
      embedding: {
        enabled: false,
        endpoint: 'http://localhost:11434',
        model: 'nomic-embed-text',
      },
      memoryTopology: {
        id: 'default-three-tier',
        strategyId: 'default-three-tier',
        layers: {
          runtime: { enabled: true, participation: { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' }, adapterIds: [] },
          documents: { enabled: true, participation: { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' }, adapterIds: [] },
          'memory-spaces': { enabled: true, participation: { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' }, adapterIds: [] },
        },
      },
      recallQuality: {
        policy: 'strict-v1',
        lowScoreThreshold: 0.25,
        highScoreThreshold: 0.6,
        candidateMultiplier: 3,
        maxMediumResults: 4,
        maxUnknownResults: 2,
        maxRankedResults: 2,
      },
      routingGuidance: true,
      lifecycleEnabled: true,
      recallMode: 'guided',
      writebackMode: 'guided',
      idleReviewMs: 30_000,
      idleReview: { enabled: true, runtimeMemory: true, provider: 'spawn', fallback: 'spawn', agentTeams: 'pause', minIntervalMs: 300_000, maxPerSession: 20, maxContextChars: 24_000, maxTokens: 4_096 },
      displayMode: 'sidebar',
      tabEnabled: true,
      writeEnabled: true,
      remoteAccess: 'read-only',
      conversationInteraction: { turnBar: true, saveAction: true },
      persistenceStrategy: {
        mode: 'manual',
        providerId: 'mnemon-native',
        prompt: '',
        rules: {
          allowedProviderIds: ['mnemon-native'],
          dataBoundary: 'allow-remote',
          requiredCapabilities: [],
          preference: 'balanced',
        },
        providerConnections: {},
      },
      taskAgentModel: { mode: 'inherit' },
    })
  })

  it('resolves independently switchable memory layer participation without deleting bindings', () => {
    expect(resolveConfig({
      memoryTopology: {
        layers: {
          documents: {
            enabled: false,
            participation: { recall: 'manual', write: 'off' },
            adapterIds: ['openviking', 'openviking'],
          },
        },
      },
    }).memoryTopology.layers.documents).toEqual({
      enabled: false,
      participation: { recall: 'manual', write: 'off', projection: 'automatic', maintenance: 'automatic' },
      adapterIds: ['openviking'],
    })
    expect(() => resolveConfig({ memoryTopology: { strategyId: '../unsafe' } })).toThrow('memory strategy id')
  })

  it('resolves all eight built-in Layer switch combinations without changing the fixed default policy', () => {
    const ids = ['runtime', 'documents', 'memory-spaces'] as const
    for (let mask = 0; mask < 8; mask += 1) {
      const layers = Object.fromEntries(ids.map((id, index) => [id, { enabled: (mask & (1 << index)) !== 0 }]))
      const resolved = resolveConfig({ memoryTopology: { layers } }).memoryTopology.layers
      for (const id of ids) {
        expect(resolved[id]).toEqual({
          enabled: layers[id]!.enabled,
          participation: { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' },
          adapterIds: [],
        })
      }
    }
  })

  it('resolves bounded Runtime Memory capacity and maintenance budgets', () => {
    expect(resolveConfig({
      runtimeMemory: {
        memoryLimitBytes: 20_480,
        userLimitBytes: 10_240,
        maintenanceMaxTokens: 32_768,
      },
    }).runtimeMemory).toEqual({
      memoryLimitBytes: 20_480,
      userLimitBytes: 10_240,
      maintenanceMaxTokens: 32_768,
    })
    expect(() => resolveConfig({ runtimeMemory: { memoryLimitBytes: 0 } })).toThrow('MEMORY.md limit')
    expect(() => resolveConfig({ runtimeMemory: { userLimitBytes: 1.5 } })).toThrow('USER.md limit')
    expect(() => resolveConfig({ runtimeMemory: { maintenanceMaxTokens: 1_000_001 } })).toThrow('maintenance maxTokens')
  })

  it('defaults and bounds the Runtime limits as the Runtime Source does', () => {
    // The values stored settings are checked against.
    expect([RUNTIME_MEMORY_LIMITS.memory, RUNTIME_MEMORY_LIMITS.user, RUNTIME_MEMORY_LIMIT_MAX_BYTES]).toEqual([10_240, 4_096, 1_048_576])
    expect(resolveConfig({}).runtimeMemory).toMatchObject({ memoryLimitBytes: RUNTIME_MEMORY_LIMITS.memory, userLimitBytes: RUNTIME_MEMORY_LIMITS.user })
    expect(Config({}).runtimeMemory).toMatchObject({ memoryLimitBytes: RUNTIME_MEMORY_LIMITS.memory, userLimitBytes: RUNTIME_MEMORY_LIMITS.user })
    for (const [key, file] of [['memoryLimitBytes', 'MEMORY.md'], ['userLimitBytes', 'USER.md']] as const) {
      expect(resolveConfig({ runtimeMemory: { [key]: RUNTIME_MEMORY_LIMIT_MAX_BYTES } }).runtimeMemory[key]).toBe(RUNTIME_MEMORY_LIMIT_MAX_BYTES)
      expect(RuntimeConfig({ [key]: RUNTIME_MEMORY_LIMIT_MAX_BYTES })[key]).toBe(RUNTIME_MEMORY_LIMIT_MAX_BYTES)
      expect(() => resolveConfig({ runtimeMemory: { [key]: RUNTIME_MEMORY_LIMIT_MAX_BYTES + 1 } }))
        .toThrow(`dsh-mnemon: Runtime ${file} limit must be an integer within 1..${RUNTIME_MEMORY_LIMIT_MAX_BYTES} bytes`)
      expect(() => Config({ runtimeMemory: { [key]: RUNTIME_MEMORY_LIMIT_MAX_BYTES + 1 } })).toThrow(`$.runtimeMemory.${key} expected number <= 1048576 but got 1048577`)
      expect(() => RuntimeConfig({ [key]: RUNTIME_MEMORY_LIMIT_MAX_BYTES + 1 })).toThrow(`$.${key} expected number <= 1048576 but got 1048577`)
    }
  })

  it('takes the placement capabilities Memory Spaces lists, and only those', () => {
    const persistenceStrategy = { mode: 'automatic' as const, rules: { requiredCapabilities: [...MEMORY_PLACEMENT_CAPABILITIES] } }
    expect(Config({ persistenceStrategy }).persistenceStrategy?.rules?.requiredCapabilities).toEqual([...MEMORY_PLACEMENT_CAPABILITIES])
    expect(resolveConfig({ persistenceStrategy }).persistenceStrategy.rules.requiredCapabilities).toEqual([...MEMORY_PLACEMENT_CAPABILITIES])
    expect(() => Config({ persistenceStrategy: { rules: { requiredCapabilities: ['telepathy' as never] } } }))
      .toThrow('$.persistenceStrategy.rules.requiredCapabilities[0] expected "graph" | "entities" | "related" | "exact-write" | "link" | "forget" but got "telepathy"')
  })

  it('writes only the code defaults into the Starter patch', () => {
    // The mnemon Entry of the bundle patch, its disabled expression kept as data.
    const rows = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
    }) as Array<{ insert: Array<{ config: Array<{ id: string; config?: Record<string, unknown> }> }> }>
    const patched = rows[0]!.insert[0]!.config.find(row => row.id === 'mnemon')!.config!
    expect(Object.keys(patched).sort()).toEqual(['defaultRecallLimit', 'embedding', 'idleReviewMs', 'lifecycleEnabled', 'recallMode', 'recallQuality',
      'remoteAccess', 'routingGuidance', 'tabEnabled', 'timeoutMs', 'writeEnabled', 'writebackMode'])
    // The defaults DSH's form shows, and the ones the Host applies, which take embedding and recall quality from Memory Spaces.
    expect(Config({})).toMatchObject(patched)
    expect(resolveConfig({})).toMatchObject(patched)
  })

  it('inherits the DSH new-session model by default and validates fixed task routes', () => {
    expect(resolveConfig({}).taskAgentModel).toEqual({ mode: 'inherit' })
    expect(resolveConfig({
      taskAgentModel: { mode: 'fixed', provider: ' deepseek ', model: ' deepseek-chat ' },
    }).taskAgentModel).toEqual({ mode: 'fixed', provider: 'deepseek', model: 'deepseek-chat' })
    expect(() => resolveConfig({ taskAgentModel: { mode: 'fixed', provider: 'deepseek' } }))
      .toThrow('provider and model')
  })

  it('lets an inherited task route follow its conversation only once that is switched on', () => {
    expect(resolveConfig({ taskAgentModel: { mode: 'inherit', followConversation: true } }).taskAgentModel).toEqual({ mode: 'inherit', followConversation: true })
    expect(resolveConfig({ taskAgentModel: { followConversation: false } }).taskAgentModel).toEqual({ mode: 'inherit' })
    // A fixed route names its own model, so the switch has nothing to follow there.
    expect(resolveConfig({
      taskAgentModel: { mode: 'fixed', provider: 'deepseek', model: 'deepseek-chat', followConversation: true },
    }).taskAgentModel).toEqual({ mode: 'fixed', provider: 'deepseek', model: 'deepseek-chat' })
    expect(() => resolveConfig({ taskAgentModel: { mode: 'inherit', followConversation: 'yes' as unknown as boolean } }))
      .toThrow('taskAgentModel.followConversation must be a boolean')
  })

  it('migrates the settings schema empty candidate list to the conservative manual default', () => {
    expect(resolveConfig({ persistenceStrategy: { mode: 'manual', rules: { allowedProviderIds: [] } } }).persistenceStrategy.rules.allowedProviderIds)
      .toEqual(['mnemon-native'])
    expect(() => resolveConfig({ persistenceStrategy: { mode: 'automatic', rules: { allowedProviderIds: [] } } }))
      .toThrow('at least one allowed provider')
  })

  it('keeps explicit conversation-surface opt-outs', () => {
    expect(resolveConfig({ conversationInteraction: { turnBar: false, saveAction: false } }).conversationInteraction)
      .toMatchObject({ turnBar: false, saveAction: false })
  })

  it('still accepts a stored toolviews preference and leaves it out of the resolved config', () => {
    for (const toolviews of [true, false]) {
      const stored = Config({ conversationInteraction: { toolviews, turnBar: false } })
      expect(stored.conversationInteraction).toEqual({ toolviews, turnBar: false, saveAction: true })
      expect(resolveConfig(stored).conversationInteraction).toEqual({ turnBar: false, saveAction: true })
    }
    expect(Config({}).conversationInteraction).toEqual({ toolviews: false, turnBar: true, saveAction: true })
    expect(resolveConfig({}).conversationInteraction).toEqual({ turnBar: true, saveAction: true })
  })

  it('keeps toolviews declared in the schema DSH builds its form from', () => {
    // Undeclared keys pass through the schema, so only this keeps the generated form as it was.
    expect(Object.keys(Config.dict?.conversationInteraction?.dict ?? {})).toEqual(['toolviews', 'turnBar', 'saveAction'])
  })

  it.each(['builtin', 'sidebar'] as const)('preserves displayMode=%s without changing storage or visibility', displayMode => {
    const legacy = { displayMode, storageScope: 'workspace' as const, tabEnabled: false, writeEnabled: false }
    const parsed = Config(legacy)
    expect(resolveConfig(parsed)).toMatchObject({ displayMode, storageScope: 'workspace', tabEnabled: false, writeEnabled: false })
    expect(resolveConfig({}).displayMode).toBe('sidebar')
    expect(Config({}).displayMode).toBe('sidebar')
    expect(legacy).toEqual({ displayMode, storageScope: 'workspace', tabEnabled: false, writeEnabled: false })
  })

  it('normalizes legacy buildin input to builtin without changing storage, visibility, or caller data', () => {
    const legacy = { displayMode: 'buildin' as const, storageScope: 'workspace' as const, tabEnabled: false }
    expect(resolveConfig(Config(legacy))).toMatchObject({ displayMode: 'builtin', storageScope: 'workspace', tabEnabled: false })
    expect(resolveConfig(legacy).displayMode).toBe('builtin')
    expect(legacy.displayMode).toBe('buildin')
  })

  it.each(['built-in', 'Builtin', 'unknown', '', true])('rejects invalid displayMode=%s', displayMode => {
    expect(() => Config({ displayMode } as never)).toThrow()
    expect(() => resolveConfig({ displayMode } as never)).toThrow('displayMode')
  })

  it('resolves the one storage-scope setting and preserves legacy dataDir as custom', () => {
    expect(resolveConfig({ storageScope: 'workspace' })).toMatchObject({ storageScope: 'workspace' })
    expect(resolveConfig({ dataDir: '/memory/custom' })).toMatchObject({
      storageScope: 'custom', dataDir: '/memory/custom',
    })
    expect(() => resolveConfig({ storageScope: 'custom' })).toThrow('custom dataDir')
    expect(() => resolveConfig({ storageScope: 'custom', dataDir: 'relative/memory' })).toThrow('absolute')
  })

  it('keeps USER.md on the selected root by default and accepts an explicit global profile', () => {
    expect(resolveConfig({ storageScope: 'workspace' })).toMatchObject({ storageScope: 'workspace', runtimeUserScope: 'storage' })
    expect(resolveConfig({ storageScope: 'workspace', runtimeUserScope: 'global' })).toMatchObject({ storageScope: 'workspace', runtimeUserScope: 'global' })
    expect(() => resolveConfig({ runtimeUserScope: 'workspace' as never })).toThrow('USER.md scope')
  })

  it('migrates the selected root from the former named-Pack settings', () => {
    expect(resolveConfig({
      storageScope: 'custom',
      customPackId: 'research',
      customPacks: [
        { id: 'project', name: 'Project', dataDir: '/memory/project' },
        { id: 'research', name: 'Research', dataDir: '~/memory/research' },
      ],
    })).toMatchObject({
      storageScope: 'custom',
      dataDir: '~/memory/research',
    })
  })

  it('rejects duplicate, missing, and unsafe custom Pack definitions', () => {
    expect(() => resolveConfig({ customPacks: [{ id: 'same', name: 'One', dataDir: '/one' }, { id: 'same', name: 'Two', dataDir: '/two' }] })).toThrow('duplicate')
    expect(() => resolveConfig({ storageScope: 'custom', customPackId: 'missing', customPacks: [{ id: 'other', name: 'Other', dataDir: '/other' }] })).toThrow('unknown custom Pack')
    expect(() => resolveConfig({ customPacks: [{ id: '../bad', name: 'Bad', dataDir: '/bad' }] })).toThrow('id')
  })

  it('rejects unsafe store names', () => {
    expect(() => resolveConfig({ store: '../other' })).toThrow('store')
    // A store names a Native space's directory, so it takes exactly a space id.
    for (const store of ['default', 'A-1_b', '9lives']) expect(resolveConfig({ store }).store).toBe(store)
    for (const store of ['-lead', '_lead', 'a.b', 'a/b', 'ä', 'a b']) {
      expect(() => resolveConfig({ store }), store).toThrow('dsh-mnemon: store must match [a-zA-Z0-9][a-zA-Z0-9_-]*')
    }
  })

})

describe('centralized workspace configuration', () => {
  it('accepts default, home-relative and custom central roots with either USER.md scope', () => {
    for (const runtimeUserScope of ['storage', 'global'] as const) {
      for (const dataDir of [undefined, '', '~/central-memory', '/central-memory']) {
        const input = { storageScope: 'workspaces' as const, runtimeUserScope, ...(dataDir === undefined ? {} : { dataDir }) }
        expect(resolveConfig(Config(input))).toMatchObject({ storageScope: 'workspaces', runtimeUserScope })
      }
    }
    expect(() => resolveConfig({ storageScope: 'workspaces', dataDir: 'relative' })).toThrow('absolute')
    expect(() => resolveConfig({ storageScope: 'workspaces', dataDir: '/root\0' })).toThrow('null byte')
    expect(() => resolveConfig({ storageScope: 'unknown' as never })).toThrow('storageScope')
  })
})
