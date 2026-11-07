import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { MemorySpaceNativeRunner } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { createMemorySpaceProviderFixture, mountMemorySpaceProvider } from 'dsh-mnemon-source-memory-spaces/testing'
import module, { definition, descriptor, MnemonNativeProvider } from '../src/index.ts'
import { STORE_DUMP_MAX_OUTPUT_BYTES } from '../src/driver.ts'

describe('independent Native Provider', () => {
  it('mounts through the public module fixture and honors an aliased child identity', async () => {
    const mounted = await mountMemorySpaceProvider(module, { instanceId: 'local', config: undefined })
    const { authority } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused', instanceId: 'local' })
    try {
      expect(mounted.descriptor).toMatchObject({ id: 'local', typeId: 'mnemon-native' })
      expect(mounted.createAdapter({ memoryBodies: authority, config: { timeoutMs: 100 }, nativeRunner: {
        runJson: vi.fn(), runText: vi.fn(),
      } }).id).toBe('local')
    } finally { await mounted.dispose() }
    expect(mounted.registered).toBe(false)
  })

  it('requires a command capability and creates its own adapter', () => {
    const { authority } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    expect(() => definition.create({ memoryBodies: authority, config: { timeoutMs: 100 }, providerInstanceId: 'native', manifest: definition.manifest })).toThrow('nativeRunner')
  })

  it('decodes both CLI response generations and keeps every command scoped', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused', memoryBodyId: 'work' })
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>()
      .mockResolvedValueOnce([{ insight: { id: 'old', content: 'Nested recall', entities: ['A'] }, score: 0.9 }])
      .mockResolvedValueOnce({ results: [{ id: 'new', content: 'Flat recall', score: 0.8 }] })
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    await expect(provider.search(body, { query: 'recall' })).resolves.toMatchObject({ results: [{ id: 'old', entities: ['A'], score: 0.9 }] })
    await expect(provider.metadataSample(body, 6)).resolves.toMatchObject([{ id: 'new', score: 0.8 }])
    expect(runJson.mock.calls.map(call => call[1]?.store)).toEqual(['work', 'work'])
    expect(runJson.mock.calls[1]?.[0]).toEqual(['--readonly', 'recall', '', '--basic', '--limit', '6'])
  })

  it('reads one memory by exact id from a read-only snapshot', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused', memoryBodyId: 'work' })
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>()
      .mockResolvedValueOnce({ id: 'fact-1', content: 'Keep exact content', category: 'fact', importance: 3, tags: [], entities: ['DSH'], created_at: '2026-10-08T00:00:00Z' })
      // A missing or forgotten id: `mnemon show` exits 1 with SQL's "no rows".
      .mockRejectedValueOnce(new Error('mnemon --readonly show gone exited 1: Error: sql: no rows in result set'))
      .mockRejectedValueOnce(new Error('mnemon --readonly show slow did not respond within 10000ms'))
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    await expect(provider.get(body, 'fact-1')).resolves.toMatchObject({ id: 'fact-1', content: 'Keep exact content', entities: ['DSH'] })
    await expect(provider.get(body, 'gone')).resolves.toBeUndefined()
    await expect(provider.get(body, 'slow')).rejects.toThrow('did not respond')
    expect(runJson.mock.calls.map(call => [call[0], call[1]?.store])).toEqual([
      [['--readonly', 'show', 'fact-1'], 'work'],
      [['--readonly', 'show', 'gone'], 'work'],
      [['--readonly', 'show', 'slow'], 'work'],
    ])
  })

  it('retrieves beyond the hybrid cutoff and ranks by bounded semantic relevance before limiting', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused', memoryBodyId: 'work' })
    const rows = Array.from({ length: 40 }, (_, index) => ({
      insight: { id: `fact-${index}`, content: `Synthetic fact ${index}`, entities: ['Fixture'] },
      score: (40 - index) / 50, signals: { similarity: index === 35 ? 0.95 : 0.1 },
    }))
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async args => ({
      results: rows.slice(0, Number(args[args.indexOf('--limit') + 1])), meta: { hint: 'Synthetic retrieval hint.' },
    }))
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    const signal = new AbortController().signal
    const result = await provider.search(body, { query: 'semantic question', limit: 10, category: 'fact', source: 'user', intent: 'GENERAL', inspect: true }, signal)
    expect(result.results).toHaveLength(10)
    expect(result.results[0]).toMatchObject({ id: 'fact-35', score: 0.95, entities: ['Fixture'] })
    expect(result.results.slice(1).map(row => row.id)).toEqual(rows.slice(0, 9).map(row => row.insight.id))
    expect(result.hint).toBe('Synthetic retrieval hint.')
    expect(runJson).toHaveBeenCalledWith([
      '--readonly', 'recall', 'semantic question', '--limit', '40', '--verbose', '--cat', 'fact', '--source', 'user', '--intent', 'GENERAL',
    ], { store: 'work', signal })
  })

  it.each([1, 10, 30, 50])('bounds semantic candidate overfetch for requested limit %s', async limit => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async () => [])
    await new MnemonNativeProvider({ runJson, runText: vi.fn() }).search(body, { query: 'fact', limit })
    expect(runJson.mock.calls[0]![0]).toEqual(['recall', 'fact', '--limit', String(Math.min(50, Math.max(20, limit * 4))), '--verbose'])
  })

  it.each([undefined, 0, -0.2, 'not-a-number'])('keeps hybrid ordering and scores when no positive similarity exists (%s)', async similarity => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    const rows = [{ id: 'first', content: 'First', score: 0.8, confidence: 'high' }, { id: 'second', content: 'Second', score: 0.3 }]
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async () => ({ results: rows.map(row => ({ ...row,
      ...(similarity === undefined ? {} : { signals: { similarity } }),
    })) }))
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    expect((await provider.search(body, { query: 'fallback', limit: 1 })).results).toEqual([rows[0]])
    expect(runJson).toHaveBeenCalledTimes(1)
  })

  it('does not mix unknown hybrid scores into semantic relevance or resurrect superseded facts', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async () => ({ results: [
      { id: 'unknown', content: 'No embedding signal', score: 0.99, confidence: 'high' },
      { id: 'old', content: 'Superseded rule', score: 0.12, superseded: true, signals: { similarity: 0.99 } },
      { id: 'old-unembedded', content: 'Superseded without a vector', score: 0.11, superseded: true },
      { id: 'current', content: 'Current rule', score: 0.3, confidence: 'low', signals: { similarity: 0.8 } },
      { id: 'negative', content: 'Unrelated', score: 0.6, signals: { similarity: -0.1 } },
      { id: 'clamped', content: 'Floating point overshoot', score: 0.4, signals: { similarity: 1.00000001 } },
    ] }))
    const result = await new MnemonNativeProvider({ runJson, runText: vi.fn() }).search(body, { query: 'query' })
    expect(result.results.map(row => [row.id, row.score, row.confidence])).toEqual([
      ['clamped', 1, undefined], ['current', 0.8, undefined], ['old', 0.12, undefined], ['old-unembedded', 0.11, undefined], ['negative', 0, undefined], ['unknown', undefined, undefined],
    ])
  })

  it.each(['keyword', 'basic'] as const)('keeps the %s command, original order, and original scores', async mode => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async () => [
      { id: 'first', content: 'Literal first', score: 0.9, signals: { similarity: 0.1 } },
      { id: 'second', content: 'Literal second', score: 0.2, signals: { similarity: 0.99 } },
    ])
    const result = await new MnemonNativeProvider({ runJson, runText: vi.fn() }).search(body, { query: 'literal', mode, limit: 2 })
    expect(result.results.map(row => [row.id, row.score])).toEqual([['first', 0.9], ['second', 0.2]])
    expect(runJson.mock.calls[0]![0]).toEqual(mode === 'keyword' ? ['search', 'literal', '--limit', '2'] : ['recall', 'literal', '--limit', '2', '--basic'])
  })

  it('retries legacy CLIs only when they reject the verbose flag before executing recall', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>()
      .mockRejectedValueOnce(new Error('mnemon --readonly recall legacy --limit 40 --verbose exited 1: Error: unknown flag: --verbose'))
      .mockResolvedValueOnce({ results: [{ insight: { id: 'old', content: 'Legacy full response' }, score: 0.3, signals: { similarity: 0.8 } }] })
    const result = await new MnemonNativeProvider({ runJson, runText: vi.fn() }).search(body, { query: 'legacy', inspect: true })
    expect(result.results[0]).toMatchObject({ id: 'old', score: 0.8 })
    expect(runJson.mock.calls.map(([args]) => args)).toEqual([
      ['--readonly', 'recall', 'legacy', '--limit', '40', '--verbose'], ['--readonly', 'recall', 'legacy', '--limit', '40'],
    ])
  })

  it.each(['timeout', 'database unavailable', 'unknown flag: --intent'])('does not retry a recall that fails with %s', async message => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>().mockRejectedValue(new Error(message))
    await expect(new MnemonNativeProvider({ runJson, runText: vi.fn() }).search(body, { query: 'query' })).rejects.toThrow(message)
    expect(runJson).toHaveBeenCalledTimes(1)
  })

  it('does not mistake query text in a failure message for an unsupported flag', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async args => { throw new Error(`mnemon ${args.join(' ')} exited 1: database unavailable`) })
    await expect(new MnemonNativeProvider({ runJson, runText: vi.fn() }).search(body, { query: 'Error: unknown flag: --verbose' })).rejects.toThrow('database unavailable')
    expect(runJson).toHaveBeenCalledTimes(1)
  })

  it('does not retry an unsupported flag after cancellation', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    const controller = new AbortController()
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async () => {
      controller.abort()
      throw new Error('Error: unknown flag: --verbose')
    })
    await expect(new MnemonNativeProvider({ runJson, runText: vi.fn() }).search(body, { query: 'query' }, controller.signal)).rejects.toThrow('unknown flag')
    expect(runJson).toHaveBeenCalledTimes(1)
  })

  it('reads a snapshot for an inspection and records a use otherwise', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused', memoryBodyId: 'work' })
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async () => ({ results: [] }))
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    await provider.search(body, { query: 'release gate' })
    await provider.search(body, { query: 'release gate', inspect: true })
    await provider.search(body, { query: 'release gate', mode: 'keyword', inspect: true })
    await provider.search(body, { query: 'release gate', mode: 'keyword' })
    expect(runJson.mock.calls.map(call => call[0].slice(0, 2))).toEqual([
      ['recall', 'release gate'],
      ['--readonly', 'recall'],
      ['--readonly', 'search'],
      ['search', 'release gate'],
    ])
  })

  it('validates batch receipts and removes its private draft after failure', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    let draftPath = ''
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async args => {
      if (args[0] === '--readonly') return []
      draftPath = args[1]!
      expect(args[2]).toBe('--no-diff')
      expect(JSON.parse(readFileSync(draftPath, 'utf8')).insights[0].content).toBe('Keep exact content')
      return { imported: 0, updated: 0, skipped: 0, errors: 1, results: [] }
    })
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    await expect(provider.rememberMany(body, [{ content: 'Keep exact content' }])).rejects.toThrow('invalid or partial result')
    expect(existsSync(draftPath)).toBe(false)
  })

  it('archives similar facts exactly while reusing identical persisted and in-batch content', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused', memoryBodyId: 'work' })
    const old = 'Backend order retry limit is 3; preserve this independent decision.'
    const next = 'Backend order retry limit is 4; preserve this independent decision.'
    const another = 'Frontend order retry limit is 3; preserve this independent decision.'
    let persisted = [{ id: 'old', content: old }]
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async (args, options) => {
      expect(options?.store).toBe('work')
      if (args[0] === '--readonly') return persisted
      expect(args).toEqual(['import', expect.any(String), '--no-diff'])
      const draft = JSON.parse(readFileSync(args[1]!, 'utf8')) as { insights: Array<{ content: string }> }
      expect(draft.insights.map(entry => entry.content)).toEqual([next, another])
      const results = draft.insights.map((entry, index) => ({ index, id: 'new-' + index, action: 'added', content: entry.content }))
      persisted = [...persisted, ...results]
      return { imported: 2, updated: 0, skipped: 0, errors: 0, results: results.toReversed() }
    })
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    const requests = [old, next, another, next].map(content => ({ content }))
    await expect(provider.rememberMany(body, requests)).resolves.toMatchObject([
      { action: 'skipped', id: 'old', content: old }, { action: 'added', id: 'new-0', content: next },
      { action: 'added', id: 'new-1', content: another }, { action: 'skipped', id: 'new-0', content: next },
    ])
    await expect(provider.rememberMany(body, requests)).resolves.toMatchObject(requests.map(({ content }) => ({ action: 'skipped', content })))
    expect(runJson.mock.calls.filter(([args]) => args[0] === 'import')).toHaveLength(1)
    expect(persisted.find(entry => entry.id === 'old')?.content).toBe(old)
  })

  it('imports an entry again when the same import prunes the copy it reused (issue 339)', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused', memoryBodyId: 'work' })
    const kept = 'Release gates close at 18:00; the archive reuses this exact copy.'
    const added = 'Canary deploys run for one hour before the full rollout.'
    const drafts: string[][] = []
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async args => {
      if (args[0] === '--readonly') return [{ id: 'old-copy', content: kept }]
      const draft = JSON.parse(readFileSync(args[1]!, 'utf8')) as { insights: Array<{ content: string }> }
      drafts.push(draft.insights.map(entry => entry.content))
      const results = draft.insights.map((entry, index) => ({ index, id: 'new-' + drafts.length + '-' + index, action: 'added', content: entry.content }))
      // At its capacity Mnemon prunes its weakest memories after the first import, the reused copy among them.
      return { imported: results.length, updated: 0, skipped: 0, errors: 0, results, auto_pruned_ids: drafts.length === 1 ? ['old-copy', 'unrelated'] : [] }
    })
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    await expect(provider.rememberMany(body, [{ content: kept }, { content: added }, { content: kept }])).resolves.toMatchObject([
      { action: 'added', id: 'new-2-0', content: kept },
      { action: 'added', id: 'new-1-0', content: added },
      { action: 'skipped', id: 'new-2-0', content: kept },
    ])
    expect(drafts).toEqual([[added], [kept]])
  })

  it('does not import when the readonly exact-content snapshot fails', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused', memoryBodyId: 'work' })
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>().mockRejectedValue(new Error('snapshot unavailable'))
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    await expect(provider.rememberMany(body, [{ content: 'Preserve the existing store' }])).rejects.toThrow('snapshot unavailable')
    expect(runJson).toHaveBeenCalledOnce()
    expect(runJson.mock.calls[0]?.[0][0]).toBe('--readonly')
  })

  it.each(['updated', 'skipped'])('rejects a %s receipt for a forced exact import', async action => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    const content = 'A distinct fact must be inserted exactly'
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ imported: 0, updated: action === 'updated' ? 1 : 0, skipped: action === 'skipped' ? 1 : 0,
        errors: 0, results: [{ index: 0, id: 'other', action, content }] })
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    await expect(provider.rememberMany(body, [{ content }])).rejects.toThrow('invalid or partial result')
  })

  it('raises the output cap for whole-Store reads only', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused', memoryBodyId: 'work' })
    const html = 'var nodes = new vis.DataSet([{id:"a",label:"a: [fact] One",title:"One",color:"#3498db",font:{color:"white"}}]);\nvar edges = new vis.DataSet([]);'
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async args => {
      if (args[0] === 'import') {
        const draft = JSON.parse(readFileSync(args[1]!, 'utf8')) as { insights: Array<{ content: string }> }
        return { imported: 1, updated: 0, skipped: 0, errors: 0, results: [{ index: 0, id: 'b', action: 'added', content: draft.insights[0]!.content }] }
      }
      if (args[0] === 'status') return { total_insights: 1 }
      return [{ id: 'a', content: 'One' }]
    })
    const runText = vi.fn<MemorySpaceNativeRunner['runText']>(async () => html)
    const provider = new MnemonNativeProvider({ runJson, runText })
    await provider.list(body, {})
    await provider.graph(body)
    await provider.rememberMany(body, [{ content: 'Two' }])
    await provider.search(body, { query: 'one' })
    await provider.status(body)
    const cap = (args: readonly string[], options?: { maxOutputBytes?: number }) => [args.find(arg => !arg.startsWith('-')), options?.maxOutputBytes]
    expect(runText.mock.calls.map(([args, options]) => cap(args, options))).toEqual([['viz', STORE_DUMP_MAX_OUTPUT_BYTES]])
    expect(runJson.mock.calls.map(([args, options]) => cap(args, options))).toEqual([
      ['recall', STORE_DUMP_MAX_OUTPUT_BYTES], ['recall', STORE_DUMP_MAX_OUTPUT_BYTES], ['recall', STORE_DUMP_MAX_OUTPUT_BYTES],
      ['import', undefined], ['recall', undefined], ['status', undefined],
    ])
    expect(STORE_DUMP_MAX_OUTPUT_BYTES).toBeGreaterThanOrEqual(64 * 1024 * 1024)
  })
})
