import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { MemorySpaceNativeRunner } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { definition, descriptor, MnemonNativeProvider } from '../src/index.ts'

describe('independent Native Provider', () => {
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

  it('validates batch receipts and removes its private draft after failure', async () => {
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    let draftPath = ''
    const runJson = vi.fn<MemorySpaceNativeRunner['runJson']>(async args => {
      draftPath = args[1]!
      expect(JSON.parse(readFileSync(draftPath, 'utf8')).insights[0].content).toBe('Keep exact content')
      return { imported: 0, updated: 0, skipped: 0, errors: 1, results: [] }
    })
    const provider = new MnemonNativeProvider({ runJson, runText: vi.fn() })
    await expect(provider.rememberMany(body, [{ content: 'Keep exact content' }])).rejects.toThrow('invalid or partial result')
    expect(existsSync(draftPath)).toBe(false)
  })
})
