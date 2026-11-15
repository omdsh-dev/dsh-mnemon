import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemorySpaceAuthority } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { createMemorySpaceProviderFixture, mountMemorySpaceProvider } from 'dsh-mnemon-source-memory-spaces/testing'
import module, { definition, HolographicProvider, descriptor } from '../src/index.ts'
import { topScored } from '../src/top-scored.ts'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('standalone holographic data plane', () => {
  it('preserves exact Jaccard scores for unequal token sets and Unicode', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-holographic-score-'))
    temporaryDirectories.push(dataDir)
    const { authority, body } = createMemorySpaceProviderFixture(descriptor, { defaultTrust: 1, minTrust: 0 }, { dataDir })
    const provider = new HolographicProvider(authority)
    await provider.remember(body, { content: 'alpha gamma delta' })
    await provider.remember(body, { content: '存储 查询' })
    expect((await provider.search(body, { query: 'alpha beta' })).results.map(row => row.score)).toEqual([1 / 4])
    expect((await provider.search(body, { query: 'alpha beta gamma delta epsilon' })).results.map(row => row.score)).toEqual([3 / 5])
    expect((await provider.search(body, { query: '存储 beta' })).results.map(row => row.score)).toEqual([3 / 7])
    expect((await provider.search(body, { query: 'unknown terms' })).results).toEqual([])
    expect((await provider.search(body, { query: '' })).results.map(row => row.score)).toEqual([0.9, 0.9])
  })

  it('stores Holographic facts locally with trust, entities, graph projection, related recall, and hard forget', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-holographic-'))
    temporaryDirectories.push(dataDir)
    const dataPath = join(dataDir, 'facts', 'memory.json')

    const { authority: registry, body } = createMemorySpaceProviderFixture(descriptor, { dataPath, defaultTrust: 0.7, minTrust: 0.3 }, { dataDir, instanceId: 'work-account' })
    const provider = new HolographicProvider(registry)

    const first = await provider.remember(body, {
      content: 'TypeScript service uses SQLite for durable state.',
      category: 'decision',
      tags: ['architecture'],
      entities: ['TypeScript', 'SQLite'],
    }) as { id: string }
    const second = await provider.remember(body, {
      content: 'SQLite backups run daily before deployment.',
      category: 'fact',
      entities: ['SQLite'],
    }) as { id: string }

    await expect(provider.remember(body, { content: 'TypeScript service uses SQLite for durable state.' })).resolves.toMatchObject({ action: 'skipped', id: first.id })
    await expect(provider.search(body, { query: 'TypeScript storage', limit: 5 })).resolves.toEqual({
      results: [expect.objectContaining({ id: first.id, category: 'decision', entities: ['TypeScript', 'SQLite'] })],
    })
    await expect(provider.related(body, first.id, 2)).resolves.toEqual([expect.objectContaining({ id: second.id })])
    await expect(provider.graph(body)).resolves.toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({ id: 'entity:SQLite', kind: 'entity' })]),
      edges: expect.arrayContaining([expect.objectContaining({ sourceId: first.id, targetId: 'entity:SQLite', type: 'entity' })]),
    })
    await expect(provider.status(body)).resolves.toMatchObject({ healthy: true, stats: { totalInsights: 2, edgeCount: 3, dbSizeBytes: statSync(dataPath).size } })
    expect(statSync(dataPath).mode & 0o777).toBe(0o600)
    await expect(provider.forget(body, first.id)).resolves.toMatchObject({ action: 'deleted' })
    await expect(provider.list(body, {})).resolves.toHaveLength(1)
  })

  it('matches short entities on whole-token boundaries without substring false positives', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-holographic-entities-'))
    temporaryDirectories.push(dataDir)
    const { authority, body } = createMemorySpaceProviderFixture(descriptor, { defaultTrust: 1, minTrust: 0 }, { dataDir })
    const provider = new HolographicProvider(authority)
    await provider.remember(body, { content: 'Go service powers the UI and AI workflow.', entities: ['Go', 'UI', 'AI'] })

    expect((await provider.search(body, { query: 'going to build an idea' })).results).toEqual([])
    const matched = await provider.search(body, { query: 'deploy Go with UI and AI' })
    expect(matched.results).toHaveLength(1)
    expect(matched.results[0]?.score).toBe(0.8)
  })
})

describe('independent holographic Provider', () => {
  it('installs complete immutable metadata in one parent-owned child', async () => {
    const mounted = await mountMemorySpaceProvider(module, { instanceId: 'work', config: undefined })
    try {
      expect(mounted.descriptor).toMatchObject({ id: 'work', typeId: 'holographic', label: descriptor.label })
      expect(Object.isFrozen(mounted.manifest)).toBe(true)
      const authority: MemorySpaceAuthority = { runner: { effectiveDataDir: () => '/unused' }, list: () => [], providerConnection: () => ({}) }
      expect(mounted.createAdapter({ memoryBodies: authority, config: { timeoutMs: 200 } }).id).toBe('work')
      expect(mounted.registered).toBe(true)
      expect(definition.manifest.secrets).toEqual(descriptor.fields.filter(field => field.input === 'secret').map(field => field.key).sort())
    } finally { await mounted.dispose() }
    expect(mounted.registered).toBe(false)
  })

  it('constructs its own driver from a structural authority, without the main repository', () => {
    const authority: MemorySpaceAuthority = { runner: { effectiveDataDir: () => '/unused' }, list: () => [], providerConnection: () => ({}) }
    const adapter = definition.create({ memoryBodies: authority, config: { timeoutMs: 200 }, providerInstanceId: 'holographic', manifest: definition.manifest })
    expect(adapter).toBeInstanceOf(HolographicProvider)
    expect(adapter.id).toBe('holographic')
  })
})

describe('Holographic importance and trust', () => {
  function fixture() {
    const dataDir = mkdtempSync(join(tmpdir(), 'holographic-importance-'))
    temporaryDirectories.push(dataDir)
    const dataPath = join(dataDir, 'facts.json')
    const { authority, body } = createMemorySpaceProviderFixture(descriptor, { dataPath, defaultTrust: 0.7, minTrust: 0.5 }, { dataDir })
    return { body, dataPath, provider: new HolographicProvider(authority), facts: () => JSON.parse(readFileSync(dataPath, 'utf8')).facts }
  }

  it('normalizes explicit importance, keeps the configured default, and applies minTrust to every read', async () => {
    const f = fixture()
    const low = await f.provider.remember(f.body, { content: 'Release checklist low', importance: 1, entities: ['Release'] }) as { id: string }
    const high = await f.provider.remember(f.body, { content: 'Release checklist high', importance: 5, entities: ['Release'] }) as { id: string }
    await f.provider.remember(f.body, { content: 'Release checklist default', entities: ['Release'] })
    expect(f.facts().map((row: { trustScore: number }) => row.trustScore)).toEqual([0.2, 1, 0.7])
    expect((await f.provider.search(f.body, { query: 'Release' })).results.map(row => row.id)).not.toContain(low.id)
    expect((await f.provider.list(f.body, {})).map(row => row.id)).not.toContain(low.id)
    expect((await f.provider.related(f.body, high.id, 1)).map(row => row.id)).not.toContain(low.id)
    expect(f.facts()).toHaveLength(3)
    expect((await f.provider.list(f.body, {})).find(row => row.id === high.id)?.importance).toBe(5)
  })

  it('keeps legacy trust values and original facts intact when adding a new fact', async () => {
    const f = fixture()
    await f.provider.remember(f.body, { content: 'Legacy fact', importance: 5 })
    const legacy = f.facts()
    delete legacy[0].importance
    writeFileSync(f.dataPath, JSON.stringify({ version: 1, facts: legacy }))
    await f.provider.remember(f.body, { content: 'New fact', importance: 3 })
    expect(f.facts()[0]).toEqual(legacy[0])
    expect(f.facts()[1]).toMatchObject({ importance: 3, trustScore: 0.6 })
  })

  it.each([0, 6, 1.5, NaN, Infinity])('refuses invalid importance %s without writing a fact', async importance => {
    const f = fixture()
    await expect(f.provider.remember(f.body, { content: 'Invalid fact', importance })).rejects.toThrow('importance')
    expect((await f.provider.list(f.body, {}))).toEqual([])
  })
})

describe('bounded score selection', () => {
  it('matches stable full sorting across sizes, ties, directions and limits', () => {
    for (const n of [0, 1, 10, 64, 65, 100, 1000]) {
      for (const scores of [
        Array.from({ length: n }, (_, i) => i),
        Array.from({ length: n }, (_, i) => n - i),
        Array.from({ length: n }, (_, i) => (i * 37) % 11),
        Array.from({ length: n }, () => 0.5),
      ]) {
        const values = scores.map((score, id) => ({ score, id }))
        for (const limit of [0, 1, 2, 10, 20, 50, 99, 1001, 3.5, NaN, Infinity]) {
          expect(topScored([...values], limit)).toEqual([...values].sort((a, b) => b.score - a.score).slice(0, limit))
        }
      }
    }
  })

  it('retains the legacy sort result for non-finite scores', () => {
    for (const score of [NaN, Infinity, -Infinity]) for (const position of [0, 37, 99]) {
      const values = Array.from({ length: 100 }, (_, i) => ({ id: i, score: i === position ? score : i % 7 }))
      expect(topScored([...values], 10)).toEqual([...values].sort((a, b) => b.score - a.score).slice(0, 10))
    }
  })

  it('bounds ranking work when the requested result count is small', () => {
    let reads = 0
    const n = 10_000
    const values = Array.from({ length: n }, (_, i) => ({ id: i, get score() { reads += 1; return i } }))
    expect(topScored(values, 10).map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => n - i - 1))
    expect(reads).toBeLessThan(n * 20)
  })
})
