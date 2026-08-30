import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMemorySpacesConfig } from "../src/config.ts"
import { createRegistry } from './providers.ts'
import type { ProcessRunner } from '../src/providers/process.ts'
import { createRunner } from '../src/runner.ts'
import type { MemorySpacesService } from '../src/service.ts'
import type { MnemonRunner } from '../src/runner.ts'
import { parseMemoryGraph } from 'dsh-mnemon-provider-mnemon-native'
import { createService } from './providers.ts'
import { RecallQualityPolicyRegistry, STRICT_RECALL_QUALITY_POLICY, type RecallQualityPolicy } from '../src/recall-quality/index.ts'

const VIZ_HTML = `<script>
var nodes = new vis.DataSet([{id:"m2",label:"m2: [fact] Four graph memory",title:"Four graph memory",color:"#3498db",font:{color:"white"}},
{id:"m1",label:"m1: [decision] Use SQLite",title:"Use SQLite for local-first storage.",color:"#e74c3c",font:{color:"white"}}]);
var edges = new vis.DataSet([{from:"m1",to:"m2",label:"backbone",color:{color:"#aaaaaa"},arrows:"to",font:{color:"#aaaaaa",size:10}}]);
</script>`

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function populatedDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-service-'))
  temporaryDirectories.push(dataDir)
  mkdirSync(join(dataDir, 'data', 'work'), { recursive: true })
  writeFileSync(join(dataDir, 'data', 'work', 'mnemon.db'), 'fixture database')
  writeFileSync(join(dataDir, 'active'), 'work\n')
  return dataDir
}

function fixture(writeEnabled = true): { service: MemorySpacesService; process: ReturnType<typeof vi.fn<ProcessRunner>>; dataDir: string } {
  const process = vi.fn<ProcessRunner>(async (_command, args) => {
    if (args.includes('--version')) return { stdout: 'mnemon version 0.1.2\n', stderr: '', exitCode: 0 }
    if (args.includes('status')) return {
      stdout: JSON.stringify({
        total_insights: 3,
        deleted_insights: 1,
        by_category: { decision: 2, fact: 1 },
        edge_count: 4,
        top_entities: [{ entity: 'SQLite', count: 2 }],
        oplog_count: 8,
        db_path: '/tmp/mnemon/data/work/mnemon.db',
        db_size_bytes: 4096,
      }),
      stderr: '',
      exitCode: 0,
    }
    if (args.includes('recall')) return {
      stdout: JSON.stringify({ results: args.includes('--readonly')
        ? [
            { id: 'm1', content: 'Use SQLite for local-first storage.', category: 'decision', entities: ['SQLite'], tags: ['storage'] },
            { id: 'm2', content: 'Four graph memory', category: 'fact', entities: ['Mnemon'] },
          ]
        : [{ id: 'm1', content: 'SQLite is selected.', category: 'decision', score: 0.91, confidence: 'high' }] }),
      stderr: '',
      exitCode: 0,
    }
    if (args.includes('viz')) return { stdout: VIZ_HTML, stderr: '', exitCode: 0 }
    if (args.includes('remember')) return { stdout: JSON.stringify({ id: 'm2', action: 'added' }), stderr: '', exitCode: 0 }
    if (args.includes('related')) return { stdout: JSON.stringify([{ id: 'm3', content: 'Single-file deployment', depth: 1 }]), stderr: '', exitCode: 0 }
    return { stdout: '{}', stderr: '', exitCode: 0 }
  })
  const dataDir = populatedDataDir()
  const config = resolveMemorySpacesConfig({
    cliPath: '/fake/mnemon',
    dataDir,
    store: 'work',
    timeoutMs: 4321,
    defaultRecallLimit: 7,
    writeEnabled,
  })
  const runner = createRunner(config, process)
  return { service: createService(runner, config, createRegistry(runner, true)), process, dataDir }
}

describe('MemorySpacesService', () => {
  it('filters low normalized scores before returning recall content and reports structured quality stats', async () => {
    const process = vi.fn<ProcessRunner>(async () => ({
      stdout: JSON.stringify({ results: [
        { id: 'zero', content: 'Irrelevant', score: 0 },
        { id: 'low', content: 'Weak clue', score: 0.2 },
        { id: 'medium', content: 'Useful evidence', score: 0.25 },
        { id: 'high', content: 'Strong evidence', score: 0.6 },
      ] }),
      stderr: '',
      exitCode: 0,
    }))
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    const result = await service.search({ query: 'evidence', limit: 2 })
    expect(result).toMatchObject({
      results: [
        { id: 'high', normalizedScore: 0.6, relevanceTier: 'high' },
        { id: 'medium', normalizedScore: 0.25, relevanceTier: 'medium' },
      ],
      sources: [{
        status: 'ready', itemCount: 2,
        quality: {
          policyId: 'strict-v1', fetched: 4, retained: 2, selected: 2,
          droppedLowScore: 1, droppedNonPositiveScore: 1, droppedInvalidScore: 0,
        },
      }],
    })
    expect(JSON.stringify(result)).not.toContain('Weak clue')
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining(['--limit', '6']), expect.anything())
  })

  it('resolves an injected recall quality policy without changing the service pipeline', async () => {
    const process = vi.fn<ProcessRunner>(async () => ({
      stdout: JSON.stringify({ results: [{ id: 'candidate', content: 'Policy-controlled evidence', score: 0.9 }] }),
      stderr: '', exitCode: 0,
    }))
    const policy: RecallQualityPolicy = {
      ...STRICT_RECALL_QUALITY_POLICY,
      id: 'drop-all-v1',
      evaluate: () => ({ action: 'drop', tier: 'unknown', reason: 'unscored' }),
      select: () => [],
    }
    const registry = new RecallQualityPolicyRegistry()
    registry.register(policy)
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work', recallQuality: { policy: policy.id } })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true), registry)

    await expect(service.search({ query: 'evidence', limit: 2 })).resolves.toMatchObject({
      results: [],
      sources: [{ status: 'empty', itemCount: 0, quality: { policyId: 'drop-all-v1', fetched: 1, retained: 0 } }],
    })
  })

  it('does not fill the Agent result limit with medium or unknown evidence', async () => {
    const rows = [
      { id: 'high', content: 'High evidence', score: 0.8 },
      ...Array.from({ length: 6 }, (_, index) => ({ id: `medium-${index + 1}`, content: `Medium evidence ${index + 1}`, score: 0.5 - index * 0.01 })),
      ...Array.from({ length: 3 }, (_, index) => ({ id: `unknown-${index + 1}`, content: `Unknown evidence ${index + 1}` })),
    ]
    const process = vi.fn<ProcessRunner>(async () => ({ stdout: JSON.stringify({ results: rows }), stderr: '', exitCode: 0 }))
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    const result = await service.search({ query: 'bounded evidence', limit: 10 })
    expect(result.results.map(item => item.id)).toEqual([
      'high', 'medium-1', 'medium-2', 'medium-3', 'medium-4', 'unknown-1', 'unknown-2',
    ])
    expect(result.sources[0]?.quality).toMatchObject({ retained: 10, selected: 7 })
    expect(JSON.stringify(result.results)).not.toContain('Medium evidence 5')
    expect(JSON.stringify(result.results)).not.toContain('Unknown evidence 3')
  })

  it('keeps Agent-created Memory Spaces on the fixed Provider in manual persistence mode', async () => {
    const config = resolveMemorySpacesConfig({ dataDir: populatedDataDir(), persistenceStrategy: { mode: 'manual', providerId: 'mnemon-native' } })
    const service = createService(createRunner(config, vi.fn<ProcessRunner>()), config)
    const createBody = vi.fn(async request => ({ id: 'space-1', ...request }))
    Object.assign(service, { config, createBody })

    await service.createBodyForPersistence({ name: 'Release', description: 'Durable release knowledge.' }, {
      providerId: 'openviking', reason: 'Model preference must be ignored.', confidence: 'high',
    })

    expect(createBody).toHaveBeenCalledWith({
      name: 'Release', description: 'Durable release knowledge.', providerId: 'mnemon-native',
    }, undefined)
  })

  it('host-validates an Agent Provider choice against automatic persistence rules', async () => {
    const config = resolveMemorySpacesConfig({
      dataDir: populatedDataDir(),
      persistenceStrategy: {
        mode: 'automatic',
        prompt: 'Prefer shared memory.',
        rules: { allowedProviderIds: ['mnemon-native', 'openviking'], preference: 'shared-first' },
        providerConnections: { openviking: { targetUri: 'viking://resources/team' } },
      },
    })
    const service = createService(createRunner(config, vi.fn<ProcessRunner>()), config)
    const prepared = {
      prompt: 'Prefer shared memory.',
      candidates: [
        { id: 'mnemon-native' as const, label: 'mnemon', kind: 'local' as const, configured: true, summary: 'Local.', capabilities: { search: true, browse: true, graph: true, entities: true, related: true, remember: true, link: true, forget: true, writeMode: 'exact' as const, deletionMode: 'soft' as const } },
        { id: 'openviking' as const, label: 'OpenViking', kind: 'remote' as const, configured: true, summary: 'Shared.', capabilities: { search: true, browse: true, graph: false, entities: false, related: false, remember: true, link: false, forget: false, writeMode: 'async-extracting' as const, deletionMode: 'hard' as const } },
      ],
      appliedRules: ['allowed:mnemon-native,openviking', 'preference:shared-first'],
      selectorBrief: 'eligible providers',
    }
    const prepareBodyPlacement = vi.fn(() => prepared)
    const createBody = vi.fn(async (request, _signal, placement) => ({ id: 'space-1', ...request, placement }))
    Object.assign(service, { config, prepareBodyPlacement, createBody })

    await service.createBodyForPersistence({ name: 'Team', description: 'Shared team knowledge.' }, {
      providerId: 'openviking', reason: 'This scope must be shared.', confidence: 'high',
    }, undefined, { runId: 'task-1', provider: 'supervised-writeback' })

    expect(prepareBodyPlacement).toHaveBeenCalledWith(expect.objectContaining({
      placement: expect.objectContaining({ prompt: 'Prefer shared memory.' }),
      providerConnections: { openviking: { targetUri: 'viking://resources/team' } },
    }))
    expect(createBody).toHaveBeenCalledWith(expect.any(Object), undefined, expect.objectContaining({
      providerId: 'openviking', decidedBy: 'llm', runId: 'task-1',
    }))
  })

  it('projects status and reports the effective configuration', async () => {
    const { service, process, dataDir } = fixture()
    const summary = service.statusSummary()
    expect(summary).toMatchObject({ healthy: true, store: 'work', memoryBodies: [expect.objectContaining({ id: 'work', statusLoading: true })] })
    expect(process).not.toHaveBeenCalled()
    const status = await service.status()
    expect(status).toMatchObject({
      healthy: true,
      version: '0.1.2',
      store: 'work',
      mnemonDefaultStore: 'work',
      dshActiveStores: ['work'],
      dataDir,
      timeoutMs: 4321,
      stats: { totalInsights: 3, edgeCount: 4, byCategory: { decision: 2 } },
    })
    expect(status.memoryBodies).toEqual([expect.objectContaining({ id: 'work', active: true, mnemonDefault: true })])
    expect(process).toHaveBeenCalledWith('/fake/mnemon', ['--data-dir', dataDir, '--store', 'work', 'status'], expect.anything())
    expect(process).toHaveBeenCalledWith('/fake/mnemon', ['--version'], expect.anything())
  })

  it('reports the effective Mnemon embedding connection and coverage with strict response validation', async () => {
    const process = vi.fn<ProcessRunner>()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          total_insights: 8,
          embedded: 6,
          coverage: '75%',
          embedding_available: true,
          protocol: 'openai',
          model: 'qwen3-embedding:0.6b',
        }),
        stderr: '', exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          total_insights: 8,
          embedded: 6,
          coverage: '75%',
          ollama_available: true,
          model: 'qwen3-embedding:0.6b',
        }),
        stderr: '', exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          total_insights: 8,
          embedded: 6,
          coverage: '75%',
          ollama_available: true,
          model: 'x'.repeat(201),
        }),
        stderr: '', exitCode: 0,
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ ollama_available: true, embedded: 9, total_insights: 8 }), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          total_insights: 8,
          embedded: 6,
          coverage: '101%',
          ollama_available: true,
          model: 'qwen3-embedding:0.6b',
        }),
        stderr: '', exitCode: 0,
      })
    const dataDir = populatedDataDir()
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir, store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    // Mnemon ≥ 0.3.x reports `embedding_available` plus the resolved protocol.
    const expected = {
      available: true,
      model: 'qwen3-embedding:0.6b',
      protocol: 'openai',
      totalInsights: 8,
      embedded: 6,
      coverage: '75%',
    }
    // Legacy output carries no protocol, so the field stays absent.
    const legacyExpected = {
      available: true,
      model: 'qwen3-embedding:0.6b',
      totalInsights: 8,
      embedded: 6,
      coverage: '75%',
    }
    await expect(service.embeddingStatus()).resolves.toEqual(expected)
    expect(process).toHaveBeenNthCalledWith(1, '/fake/mnemon', [
      '--data-dir', dataDir, '--store', 'work', 'embed', '--status',
    ], expect.anything())
    await expect(service.embeddingStatus()).resolves.toEqual(legacyExpected)
    await expect(service.embeddingStatus()).rejects.toThrow('invalid response')
    await expect(service.embeddingStatus()).rejects.toThrow('invalid response')
    await expect(service.embeddingStatus()).rejects.toThrow('invalid response')
  })

  it('coalesces simultaneous Memory Space health snapshots', async () => {
    const { service, process } = fixture()

    const [first, second] = await Promise.all([service.bodies(), service.bodies()])

    expect(first).toEqual(second)
    expect(process.mock.calls.filter(([, args]) => args.includes('status'))).toHaveLength(1)
  })

  it('allows every Memory Space to be inactive for DSH without changing the Mnemon default Store', async () => {
    const { service } = fixture()
    service.updateBody('work', { active: false })

    const status = await service.status()

    expect(status).toMatchObject({ store: 'none', mnemonDefaultStore: 'work', dshActiveStores: [] })
    expect(status.memoryBodies).toEqual([expect.objectContaining({ id: 'work', active: false, mnemonDefault: true })])
  })

  it('reports enabled provider health and removes its local Memory Space projections when disabled', async () => {
    const { service } = fixture()
    const provider = {
      id: 'openviking' as const,
      status: vi.fn(async () => ({ healthy: true })),
      search: vi.fn(async () => ({ results: [] })),
      graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: 'now' })),
      list: vi.fn(async () => []),
      remember: vi.fn(async () => ({ action: 'stored' })),
    }
    ;(service as unknown as { providers: Map<string, typeof provider> }).providers.set('openviking', provider)
    const body = await service.createBody({
      name: 'Team memory', description: 'Shared provider memory.', active: true, providerId: 'openviking',
      connection: { endpoint: 'http://127.0.0.1:1933', targetUri: 'viking://user/team/memories' },
    })

    await expect(service.status()).resolves.toMatchObject({
      providerServices: expect.arrayContaining([expect.objectContaining({
        providerId: 'openviking', enabled: true, configured: true, status: 'healthy', memoryBodyCount: 1, activeMemoryBodyCount: 1,
      })]),
    })

    service.memoryBodies.updateProviderService('openviking', {}, [], false)
    await expect(service.status()).resolves.toMatchObject({
      providerServices: expect.arrayContaining([expect.objectContaining({
        providerId: 'openviking', enabled: false, configured: true, status: 'disabled', memoryBodyCount: 0, activeMemoryBodyCount: 0,
      })]),
    })
    expect(service.memoryBodies.list()).toEqual([expect.objectContaining({ provider: expect.objectContaining({
      id: 'mnemon-native', label: 'mnemon', kind: 'local', origin: 'native',
      location: expect.any(String), apiKeyConfigured: false, settings: {}, configuredSecrets: [], capabilities: expect.any(Object),
    }) })])
    await expect(service.search({ query: 'anything', memoryBodyIds: [body.id] })).rejects.toThrow('unknown memory body')
  })

  it('discovers provider-owned Memory Spaces before enabling the service', async () => {
    const { service } = fixture()
    const provider = {
      id: 'hindsight' as const,
      discover: vi.fn()
        .mockResolvedValueOnce([
          { externalId: 'bank-1', name: 'Product bank', description: 'Mapped from Hindsight.', connection: { bankId: 'bank-1', budget: 'mid' } },
          { externalId: 'bank-2', name: 'Engineering bank', description: 'A second provider-owned namespace.', connection: { bankId: 'bank-2', budget: 'low' } },
        ]),
      status: vi.fn(async () => ({ healthy: true })),
      search: vi.fn(async () => ({ results: [] })),
      graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: 'now' })),
      list: vi.fn(async () => []),
      remember: vi.fn(async () => ({ action: 'stored' })),
    }
    ;(service as unknown as { providers: Map<string, typeof provider> }).providers.set('hindsight', provider)

    await expect(service.updateProviderService('hindsight', { endpoint: 'http://127.0.0.1:18889', apiKey: 'secret' })).resolves.toMatchObject({ enabled: true, configured: true })
    expect(provider.discover).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'http://127.0.0.1:18889', apiKey: 'secret' }), undefined)
    expect(service.memoryBodies.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Product bank', description: 'Mapped from Hindsight.', active: true, provider: expect.objectContaining({ id: 'hindsight' }) }),
    ]))
    const body = service.memoryBodies.list().find(item => item.provider.id === 'hindsight')!
    service.updateBodyMetadata([{ memoryBodyId: body.id, title: '产品长期洞察', description: 'AI 维护的产品范围、用户反馈与关键取舍。' }])
    await expect(service.reconnectBody(body.id)).resolves.toMatchObject({
      id: body.id,
      name: '产品长期洞察',
      description: 'AI 维护的产品范围、用户反馈与关键取舍。',
      provider: expect.objectContaining({ settings: expect.objectContaining({ bankId: 'bank-1', budget: 'mid' }) }),
      healthy: true,
    })
    expect(provider.discover).toHaveBeenCalledOnce()
    expect(provider.status).toHaveBeenCalledOnce()
    expect(provider.status).toHaveBeenCalledWith(expect.objectContaining({ id: body.id, provider: expect.objectContaining({ settings: expect.objectContaining({ bankId: 'bank-1' }) }) }), undefined)
  })

  it('persists third-party Provider services when the optional native CLI is absent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-provider-without-cli-'))
    temporaryDirectories.push(dataDir)
    const config = resolveMemorySpacesConfig({ dataDir, cliPath: '/missing/mnemon' })
    const runner: MnemonRunner = {
      command: '/missing/mnemon',
      commandFound: false,
      config,
      runJson: vi.fn(async () => ({})),
      runText: vi.fn(async () => ''),
      runTextBatch: vi.fn(async () => []),
      withExclusive: vi.fn(async operation => operation()),
      effectiveDataDir: () => dataDir,
      persistedStore: () => 'default',
      effectiveStore: () => 'default',
    }

    const first = createService(runner, config)
    await expect(first.updateProviderService('holographic', {})).resolves.toMatchObject({
      providerId: 'holographic', enabled: true, configured: true,
    })
    expect(existsSync(join(dataDir, 'state', 'memory-providers.json'))).toBe(true)

    const reloaded = createService(runner, config)
    expect(reloaded.memoryBodies.providerServices().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'holographic', enabled: true, configured: true }),
    ]))
    expect(reloaded.memoryBodies.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: expect.objectContaining({ id: 'holographic' }) }),
    ]))
  })

  it('refreshes one Memory Space health status in read-only mode', async () => {
    const { service } = fixture(false)

    await expect(service.reconnectBody('work')).resolves.toMatchObject({ id: 'work', healthy: true })
  })

  it('keeps the previous provider projection untouched when reconnect discovery fails', async () => {
    const { service } = fixture()
    const provider = {
      id: 'hindsight' as const,
      discover: vi.fn()
        .mockResolvedValueOnce([{ externalId: 'bank-1', name: 'Product bank', description: 'Mapped from Hindsight.', connection: { bankId: 'bank-1', budget: 'mid' } }])
        .mockRejectedValueOnce(new Error('connection refused')),
      status: vi.fn(async () => ({ healthy: true })),
      search: vi.fn(async () => ({ results: [] })),
      graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: 'now' })),
      list: vi.fn(async () => []),
      remember: vi.fn(async () => ({ action: 'stored' })),
    }
    ;(service as unknown as { providers: Map<string, typeof provider> }).providers.set('hindsight', provider)

    await service.updateProviderService('hindsight', { endpoint: 'http://127.0.0.1:18889', apiKey: 'old-secret' })
    const before = service.memoryBodies.list()
    await expect(service.updateProviderService('hindsight', { endpoint: 'http://127.0.0.1:19999', apiKey: 'new-secret' })).rejects.toThrow('connection refused')

    expect(service.memoryBodies.list()).toEqual(before)
    expect(service.memoryBodies.providerConnection(before.find(body => body.provider.id === 'hindsight')!.id)).toMatchObject({
      endpoint: 'http://127.0.0.1:18889',
      apiKey: 'old-secret',
    })
  })

  it('uses graph recall by default and normalizes compact results', async () => {
    const { service, process, dataDir } = fixture()
    const result = await service.search({ query: ' database choice ' })
    expect(result.results).toEqual([expect.objectContaining({ id: 'm1', score: 0.91, confidence: 'high', memoryCapabilities: expect.objectContaining({ related: true, forget: true }) })])
    expect(result.sources).toEqual([expect.objectContaining({ memoryBodyId: 'work', mode: 'search', status: 'ready', itemCount: 1 })])
    expect(process).toHaveBeenCalledWith(
      '/fake/mnemon',
      ['--data-dir', dataDir, '--store', 'work', 'recall', 'database choice', '--limit', '21'],
      expect.anything(),
    )
  })

  it('recovers structured exact evidence after an explicit smart search misses it', async () => {
    const process = vi.fn<ProcessRunner>(async (_command, args) => {
      if (args.includes('search')) return {
        stdout: JSON.stringify([
          { id: 'target', content: '2026-06-02 的演练发现直接从 12% 升到 100% 会掩盖租户倾斜，因此增加 35% 与 65% 两个阶段。', score: 1 },
          { id: 'partial', content: 'Project Lantern 当前 canary 是 12%。', score: 0.8 },
        ]),
        stderr: '', exitCode: 0,
      }
      return {
        stdout: JSON.stringify({ results: [{ id: 'incident', content: 'ORCHID-47 是一次生产事故。', score: 0.9 }] }),
        stderr: '', exitCode: 0,
      }
    })
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    const result = await service.search({
      query: '哪次演练或事故导致灰度增加 35% 和 65% 阶段？直接从 12% 升到 100% 暴露了什么故障？',
      limit: 3,
    })

    expect(result.results.map(insight => insight.id)).toEqual(['target', 'incident'])
    expect(JSON.stringify(result.results)).not.toContain('当前 canary')
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining([
      'search', '35% 65% 12% 100%', '--limit', '3',
    ]), expect.anything())
  })

  it('recovers a lexically precise Native result when graph search loses the user wording', async () => {
    const query = '普通用户是否应该选择或理解 View id？过去的明确纠正是什么？'
    const process = vi.fn<ProcessRunner>(async (_command, args) => {
      if (args.includes('search')) return {
        stdout: JSON.stringify([
          { id: 'target', content: '用户曾明确纠正：View 是内部 generation snapshot，不应要求普通用户选择或理解 View id。', score: 0.52 },
          { id: 'zoom', content: '收敛版移除了模型可见 View id 和 Zoom。', score: 0.3 },
        ]),
        stderr: '', exitCode: 0,
      }
      return {
        stdout: JSON.stringify({ results: [{ id: 'generic', content: '架构说明默认使用中文，UI 变更需要用户明确授权。', score: 0.4 }] }),
        stderr: '', exitCode: 0,
      }
    })
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    const result = await service.search({ query, limit: 3 })
    expect(result.results.map(insight => insight.id)).toEqual(['target', 'generic'])
    expect(JSON.stringify(result.results)).not.toContain('收敛版移除')
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining(['search', query]), expect.anything())
  })

  it('prioritizes selected query-covering evidence before the smaller model envelope', async () => {
    const process = vi.fn<ProcessRunner>(async () => ({
      stdout: JSON.stringify({ results: [
        { id: 'generic', content: '架构说明默认使用中文，UI 变更需要用户明确授权。', score: 0.35 },
        { id: 'target', content: '用户曾明确纠正：View 是内部 generation snapshot，不应要求普通用户选择或理解 View id。', score: 0.317 },
      ] }),
      stderr: '', exitCode: 0,
    }))
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    const result = await service.search({ query: 'View id 普通用户体验 纠正 暴露', limit: 3 })
    expect(result.results.map(insight => insight.id)).toEqual(['target', 'generic'])
    expect(process).toHaveBeenCalledOnce()
  })

  it('does not run exact-anchor recovery when smart search already found covering evidence', async () => {
    const process = vi.fn<ProcessRunner>(async () => ({
      stdout: JSON.stringify({ results: [{
        id: 'target',
        content: '2026-06-02 的演练发现直接从 12% 升到 100% 会掩盖租户倾斜，因此增加 35% 与 65% 两个阶段。',
        score: 0.7,
      }] }),
      stderr: '', exitCode: 0,
    }))
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    await expect(service.search({ query: '35% 和 65% 两档来自哪次从 12% 到 100% 的演练？' })).resolves.toMatchObject({
      results: [{ id: 'target' }],
    })
    expect(process).toHaveBeenCalledTimes(1)
    expect(process.mock.calls[0]![1]).toContain('recall')
  })

  it('keeps keyword searches single-pass even when the query contains exact anchors', async () => {
    const process = vi.fn<ProcessRunner>(async () => ({ stdout: '[]', stderr: '', exitCode: 0 }))
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    await service.search({ query: 'ORCHID-31 17', mode: 'keyword' })
    expect(process).toHaveBeenCalledTimes(1)
    expect(process.mock.calls[0]![1]).toEqual(expect.arrayContaining(['search', 'ORCHID-31 17']))
  })

  it('does not duplicate remote Provider calls during local exact-anchor recovery', async () => {
    const { service } = fixture()
    const provider = {
      id: 'openviking' as const,
      status: vi.fn(async () => ({ healthy: true })),
      search: vi.fn(async () => ({ results: [{ id: 'remote-incident', content: 'ORCHID-47 是一次生产事故。' }] })),
      graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: 'now' })),
      list: vi.fn(async () => []),
      remember: vi.fn(async () => ({ action: 'stored' })),
    }
    ;(service as unknown as { providers: Map<string, typeof provider> }).providers.set('openviking', provider)
    await service.createBody({
      name: 'Team memory', description: 'Shared provider memory.', active: true, providerId: 'openviking',
      connection: { endpoint: 'http://127.0.0.1:1933', targetUri: 'viking://user/team/memories' },
    })
    provider.search.mockClear()

    await service.search({ query: '哪次事故涉及 35% 和 65%，并且从 12% 直接升到 100%？' })
    expect(provider.search).toHaveBeenCalledTimes(1)
  })

  it('retains the original smart result if optional exact-anchor recovery is unavailable', async () => {
    const process = vi.fn<ProcessRunner>(async (_command, args) => {
      if (args.includes('search')) throw new Error('keyword index unavailable')
      return {
        stdout: JSON.stringify({ results: [{ id: 'incident', content: 'ORCHID-47 是一次生产事故。', score: 0.9 }] }),
        stderr: '', exitCode: 0,
      }
    })
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    await expect(service.search({ query: '35% 65% 12% 100% 的事故' })).resolves.toMatchObject({
      results: [{ id: 'incident' }],
    })
    expect(process).toHaveBeenCalledTimes(2)
  })

  it('parses the official Mnemon visualization into a safe graph snapshot', async () => {
    const { service, process } = fixture()
    const graph = await service.graph()
    expect(graph.nodes).toEqual([
      expect.objectContaining({ id: 'm2', category: 'fact', content: 'Four graph memory', entities: ['Mnemon'] }),
      expect.objectContaining({ id: 'm1', category: 'decision', entities: ['SQLite'], tags: ['storage'] }),
    ])
    expect(graph.edges).toEqual([expect.objectContaining({ sourceId: 'work:m1', targetId: 'work:m2', type: 'temporal', label: 'backbone' })])
    expect(graph.sources).toEqual([expect.objectContaining({ memoryBodyId: 'work', mode: 'graph', status: 'ready', itemCount: 2, edgeCount: 1 })])
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining(['viz', '--format', 'html']), expect.anything())
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining(['--readonly', 'recall', '', '--basic']), expect.anything())
  })

  it('lists active memories with readonly metadata and filters locally', async () => {
    const { service, process } = fixture()
    await expect(service.list({ query: 'sqlite', category: 'decision' })).resolves.toMatchObject({
      total: 1,
      items: [{ id: 'm1', content: 'Use SQLite for local-first storage.', category: 'decision', color: '#e74c3c' }],
      sources: [{ memoryBodyId: 'work', mode: 'enumerable', status: 'ready', itemCount: 1 }],
    })
    expect(process.mock.calls.filter(([, args]) => args.includes('recall')).every(([, args]) => args.includes('--readonly'))).toBe(true)
  })

  it('samples Native metadata through one bounded readonly basic recall', async () => {
    const { service, process } = fixture()

    await expect(service.metadataSample('work')).resolves.toMatchObject({
      memoryBodyId: 'work',
      providerId: 'mnemon-native',
      method: 'native-basic',
      evidence: [{ content: 'Use SQLite for local-first storage.' }, { content: 'Four graph memory' }],
    })
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining([
      '--readonly', 'recall', '', '--basic', '--limit', '6',
    ]), expect.anything())
  })

  it('uses a single native search request when Provider browse would fan out', async () => {
    const { service } = fixture()
    const provider = {
      id: 'openviking' as const,
      status: vi.fn(async () => ({ healthy: true })),
      search: vi.fn(async () => ({ results: [{ id: 'memory-1', content: 'Team release gates and rollback decisions.', category: 'decision', entities: ['Release'] }] })),
      graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: 'now' })),
      list: vi.fn(async () => []),
      remember: vi.fn(async () => ({ action: 'stored' })),
    }
    ;(service as unknown as { providers: Map<string, typeof provider> }).providers.set('openviking', provider)
    const body = await service.createBody({
      name: 'Team memory', description: 'Shared provider memory.', active: true, providerId: 'openviking',
      connection: { endpoint: 'http://127.0.0.1:1933', targetUri: 'viking://user/team/memories' },
    })

    await expect(service.metadataSample(body.id)).resolves.toMatchObject({
      providerId: 'openviking', method: 'search', evidence: [{ content: 'Team release gates and rollback decisions.' }],
    })
    expect(provider.search).toHaveBeenCalledWith(body, {
      query: 'Shared provider memory.',
      mode: 'basic',
      limit: 6,
    }, undefined)
    expect(provider.list).not.toHaveBeenCalled()
  })

  it('exposes top entities and recalls one entity on demand', async () => {
    const { service, process } = fixture()
    await expect(service.entities()).resolves.toMatchObject({
      items: [{ entity: 'SQLite', count: 2 }],
      insights: [],
      sources: [{ memoryBodyId: 'work', mode: 'entities', status: 'ready', itemCount: 1 }],
    })
    await expect(service.entities('SQLite', 5)).resolves.toMatchObject({ selected: 'SQLite', insights: [{ id: 'm1' }] })
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining(['--intent', 'ENTITY', '--limit', '15']), expect.anything())
  })

  it('rejects malformed visualization output', () => {
    expect(() => parseMemoryGraph('<html />')).toThrow('unexpected HTML')
  })

  it('normalizes the nested recall rows returned by Mnemon 0.1.2', async () => {
    const process = vi.fn<ProcessRunner>(async () => ({
      stdout: JSON.stringify({
        results: [{
          insight: { id: 'legacy-1', content: 'Nested payload', category: 'fact', importance: 4, tags: ['legacy'] },
          score: 0.72,
          intent: 'GENERAL',
          via: 'hybrid',
        }],
      }),
      stderr: '',
      exitCode: 0,
    }))
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))
    await expect(service.search({ query: 'nested' })).resolves.toMatchObject({
      results: [{ id: 'legacy-1', content: 'Nested payload', category: 'fact', importance: 4, score: 0.72, matchedVia: 'hybrid' }],
    })
  })

  it('validates and forwards durable write metadata without a shell', async () => {
    const { service, process } = fixture()
    await service.remember({ content: 'Use SQLite for local-first storage.', category: 'decision', importance: 5, tags: ['storage', 'local'] })
    expect(process).toHaveBeenCalledWith(
      '/fake/mnemon',
      expect.arrayContaining(['remember', 'Use SQLite for local-first storage.', '--cat', 'decision', '--imp', '5', '--tags', 'storage,local']),
      expect.anything(),
    )
  })

  it('bulk-imports exact Native memories once and validates per-entry receipts', async () => {
    let draftPath = ''
    let draftMode = 0
    let draft: Record<string, unknown> | undefined
    const process = vi.fn<ProcessRunner>(async (_command, args) => {
      const importIndex = args.indexOf('import')
      if (importIndex < 0) return { stdout: '{}', stderr: '', exitCode: 0 }
      draftPath = args[importIndex + 1]!
      draftMode = statSync(draftPath).mode & 0o777
      draft = JSON.parse(readFileSync(draftPath, 'utf8')) as Record<string, unknown>
      return {
        stdout: JSON.stringify({
          imported: 1,
          updated: 1,
          skipped: 0,
          errors: 0,
          results: [
            { index: 1, id: 'release-2', content: '发布前执行金丝雀检查。', action: 'updated' },
            { index: 0, id: 'project-1', content: '项目使用 pnpm。', action: 'added' },
          ],
        }),
        stderr: '',
        exitCode: 0,
      }
    })
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    await expect(service.rememberMany([
      { content: '项目使用 pnpm。', category: 'context', importance: 3, source: 'agent', memoryBodyId: 'work' },
      { content: '发布前执行金丝雀检查。', category: 'context', importance: 5, source: 'agent', memoryBodyId: 'work' },
    ])).resolves.toEqual([
      expect.objectContaining({ id: 'project-1', action: 'added', memoryBodyId: 'work' }),
      expect.objectContaining({ id: 'release-2', action: 'updated', memoryBodyId: 'work' }),
    ])
    expect(process.mock.calls.filter(([, args]) => args.includes('import'))).toHaveLength(1)
    expect(process.mock.calls.some(([, args]) => args.includes('remember'))).toBe(false)
    expect(draftMode).toBe(0o600)
    expect(draft).toEqual({
      schema_version: '1',
      source: 'dsh-mnemon-runtime-archive',
      insights: [
        { content: '项目使用 pnpm。', category: 'context', importance: 3, source: 'agent' },
        { content: '发布前执行金丝雀检查。', category: 'context', importance: 5, source: 'agent' },
      ],
    })
    expect(existsSync(draftPath)).toBe(false)
  })

  it('rejects a partial Native archive import and removes its temporary draft', async () => {
    let draftPath = ''
    const process = vi.fn<ProcessRunner>(async (_command, args) => {
      const importIndex = args.indexOf('import')
      draftPath = args[importIndex + 1]!
      return {
        stdout: JSON.stringify({
          imported: 1,
          updated: 0,
          skipped: 0,
          errors: 1,
          results: [{ index: 0, id: 'partial-1', content: 'First.', action: 'added' }],
        }),
        stderr: '',
        exitCode: 0,
      }
    })
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', dataDir: populatedDataDir(), store: 'work' })
    const runner = createRunner(config, process)
    const service = createService(runner, config, createRegistry(runner, true))

    await expect(service.rememberMany([
      { content: 'First.', memoryBodyId: 'work' },
      { content: 'Second.', memoryBodyId: 'work' },
    ])).rejects.toThrow('invalid or partial result')
    expect(existsSync(draftPath)).toBe(false)
  })

  it('accepts the full Runtime entry boundary for lossless Host archival', async () => {
    const { service, process } = fixture()
    const content = 'x'.repeat(8 * 1024)

    await expect(service.remember({ content })).resolves.toMatchObject({ action: 'added' })
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining(['remember', content]), expect.anything())
    process.mockClear()
    await expect(service.rememberMany([{ content, memoryBodyId: 'work' }])).resolves.toEqual([
      expect.objectContaining({ action: 'added', memoryBodyId: 'work' }),
    ])
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining(['remember', content]), expect.anything())
    expect(process.mock.calls.some(([, args]) => args.includes('import'))).toBe(false)
    await expect(service.remember({ content: `${content}x` })).rejects.toThrow('max 8192 characters')
  })

  it('advances the Memory Space checkpoint only after committed Provider mutations', async () => {
    const { service, process } = fixture(true)
    const before = service.memoryRevision()

    await service.remember({ content: 'Receipt-backed provider mutation.' })
    const committed = service.memoryRevision()
    expect(committed).not.toBe(before)

    process.mockImplementation(async (_command, args) => args.includes('remember')
      ? { stdout: JSON.stringify({ action: 'skipped' }), stderr: '', exitCode: 0 }
      : { stdout: '{}', stderr: '', exitCode: 0 })
    const beforeSkipped = service.memoryRevision()
    await service.remember({ content: 'Duplicate provider mutation.' })
    expect(service.memoryRevision()).toBe(beforeSkipped)

    process.mockImplementation(async (_command, args) => args.includes('remember')
      ? { stdout: JSON.stringify({ action: 'queued', status: 'pending', taskId: 'task-slow' }), stderr: '', exitCode: 0 }
      : { stdout: '{}', stderr: '', exitCode: 0 })
    const beforeQueued = service.memoryRevision()
    await service.remember({ content: 'Provider has only accepted this mutation.' })
    expect(service.memoryRevision()).toBe(beforeQueued)
  })

  it('refuses mutations in read-only plugin mode', async () => {
    const config = resolveMemorySpacesConfig({ cliPath: '/fake/mnemon', writeEnabled: false })
    const process = vi.fn<ProcessRunner>()
    const service = createService(createRunner(config, process), config)
    await expect(service.remember({ content: 'secret' })).rejects.toThrow('read-only')
    expect(process).not.toHaveBeenCalled()
  })

  it('traverses related nodes with a bounded depth', async () => {
    const { service } = fixture()
    await expect(service.related('m1', 2)).resolves.toEqual([
      expect.objectContaining({ id: 'm3', depth: 1 }),
    ])
    await expect(service.related('m1', 9)).rejects.toThrow('1..5')
  })

  it('aggregates reads across active memory bodies and activates a write target', async () => {
    const { service, process } = fixture()
    const research = await service.createBody({ name: '研究决策', description: '研究假设、证据与技术取舍；评估研究方向时召回。', active: true })

    const result = await service.search({ query: 'database choice' })
    expect(result.results).toHaveLength(2)
    expect(result.results.map(item => item.memoryBodyId)).toEqual(['work', research.id])
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining(['--store', research.id, 'recall']), expect.anything())

    service.updateBody(research.id, { active: false })
    await service.remember({ memoryBodyId: research.id, content: 'Durable cross-body write.' })
    expect(service.memoryBodies.get(research.id).active).toBe(true)

    await expect(service.deleteBody(research.id)).resolves.toMatchObject({ id: research.id })
    expect(service.memoryBodies.list().some(body => body.id === research.id)).toBe(false)
    expect(process).toHaveBeenCalledWith('/fake/mnemon', expect.arrayContaining(['--store', research.id, 'store', 'remove', research.id]), expect.anything())
  })

  it('fuses heterogeneous provider ranks without comparing raw scores and isolates provider failures', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      status: 'success',
      result: { memories: [{ uri: 'viking://user/team/memories/preferences/concise.md', overview: 'Prefer concise answers.', score: 99 }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { service } = fixture()
    await service.createBody({
      name: '团队 OpenViking', description: '团队共享的远程长期记忆。', active: true, providerId: 'openviking',
      openViking: { endpoint: 'https://memory.example.com', targetUri: 'viking://user/team/memories' },
    })

    const result = await service.search({ query: 'answer style' })

    expect(result.results).toHaveLength(2)
    expect(result.results.map(item => item.memoryProviderId)).toEqual(['mnemon-native', 'openviking'])
    expect(result.results.map(item => item.score)).toEqual([0.91, 99])
    expect(result.results[0]!.federatedScore).toBe(result.results[1]!.federatedScore)
    expect(result.sources).toEqual([
      expect.objectContaining({ memoryBodyId: 'work', mode: 'search', status: 'ready' }),
      expect.objectContaining({ providerId: 'openviking', mode: 'search', status: 'ready' }),
    ])

    fetchMock.mockRejectedValueOnce(new Error('remote offline'))
    await expect(service.search({ query: 'fallback' })).resolves.toMatchObject({
      results: [expect.objectContaining({ memoryProviderId: 'mnemon-native' })],
      hint: expect.stringContaining('团队 OpenViking: unavailable: remote offline'),
      sources: expect.arrayContaining([expect.objectContaining({ providerId: 'openviking', status: 'unavailable' })]),
    })
  })

  it('reports query-only providers without pretending they expose an enumerable content list', async () => {
    const { service } = fixture()
    const provider = {
      id: 'byterover' as const,
      status: vi.fn(async () => ({ healthy: true })),
      search: vi.fn(async () => ({ results: [{ id: 'brv:architecture', content: 'Architecture decisions are curated before compression.', category: 'context' }] })),
      graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: 'now' })),
      list: vi.fn(async () => []),
      remember: vi.fn(async () => ({ action: 'stored' })),
    }
    ;(service as unknown as { providers: Map<string, typeof provider> }).providers.set('byterover', provider)
    const body = await service.createBody({
      name: 'ByteRover Knowledge', description: 'Query-oriented coding context.', active: true, providerId: 'byterover',
      connection: { cliPath: 'brv', workingDirectory: '/tmp/dsh-mnemon-bytrover' },
    })

    await expect(service.list({ memoryBodyIds: [body.id] })).resolves.toMatchObject({
      items: [],
      sources: [{ mode: 'query-only', status: 'query-required', itemCount: 0 }],
    })
    await expect(service.list({ query: 'architecture', memoryBodyIds: [body.id] })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: 'brv:architecture', memoryProviderId: 'byterover' })],
      sources: [{ mode: 'query-only', status: 'ready', itemCount: 1 }],
    })
    expect(provider.list).not.toHaveBeenCalled()
    expect(provider.search).toHaveBeenCalledWith(body, expect.objectContaining({ query: 'architecture' }), undefined)

    provider.search.mockClear()
    await expect(service.metadataSample(body.id)).resolves.toMatchObject({ providerId: 'byterover', method: 'search' })
    expect(provider.search).toHaveBeenCalledWith(body, {
      query: 'Query-oriented coding context.',
      mode: 'basic',
      limit: 6,
    }, undefined)
  })

  it('rejects explicit reads from an inactive memory body', async () => {
    const { service } = fixture()
    const archive = await service.createBody({ name: '交付历史', description: '稳定的交付决策与回滚经验；规划发布时召回。' })
    await expect(service.search({ query: 'anything', memoryBodyIds: [archive.id] })).rejects.toThrow('not active')
  })
})
