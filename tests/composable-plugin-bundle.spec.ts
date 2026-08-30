import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as spaces from 'dsh-mnemon-source-memory-spaces'
import * as runtime from 'dsh-mnemon-source-runtime'
import * as documents from 'dsh-mnemon-source-documents'
import * as strategy from 'dsh-mnemon-strategy-default-three-tier'
import native from 'dsh-mnemon-provider-mnemon-native'
import type { Context } from '@deepseek-ai/cordis'
import { compositionFixture } from './fixtures/composition.ts'
const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose() })

describe('explicit default Starter', () => {
  it('mounts Sources and Strategy as real Cordis Entries and keeps old leases after unload', async () => {
    const value = await compositionFixture()
    fixtures.push(value)
    const { extensions, graph, releases } = value
    expect(extensions.contributionSnapshot()).toMatchObject({
      revision: 4,
      sources: [
        { instanceKey: 'source:mnemon-source-runtime' },
        { instanceKey: 'source:mnemon-source-documents' },
        { instanceKey: 'source:mnemon-source-memory-spaces', effectiveDigest: expect.stringMatching(/^providers:/u) },
      ],
      strategies: [{ instanceKey: 'strategy:mnemon-strategy-default-three-tier' }],
    })
    const lease = graph.memoryComposition.acquire()
    await releases[0]!()
    expect(graph.memoryComposition.inspect().evaluation.state).toBe('rejected')
    expect(graph.memoryComposition.inspect().drainingGenerationIds).toContain(lease.id)
    lease.release()
    expect(graph.memoryComposition.inspect().drainingGenerationIds).toEqual([])
  })
  it('declares five stable Entries and installed package specifiers without source forwarders', () => {
    expect([runtime.name, documents.name, spaces.name, strategy.name]).toEqual([
      'dsh-mnemon-source-runtime', 'dsh-mnemon-source-documents', 'dsh-mnemon-source-memory-spaces', 'dsh-mnemon-strategy-default-three-tier',
    ])
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    for (const name of [runtime.name, documents.name, spaces.name, strategy.name]) expect(patch).toContain(name)
    expect(patch).not.toContain('dsh-mnemon/source-')
    expect(patch).not.toContain('bundledContributions')
  })
  it('allows a Source to mount only its explicitly selected private children', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      const applyProvider = vi.fn(native.apply)
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        const result = await spaces.installMemorySpaces(ctx, [{ instanceId: 'work-native', module: { ...native, apply: applyProvider }, config: undefined }])
        expect(result).toBeUndefined()
      } }, { instanceId: 'memory-spaces/custom:team' })
      expect(applyProvider).toHaveBeenCalledOnce()
      expect(runner.context.get('mnemonProvider', false)).toBeUndefined()
      expect(runner.inspect().evaluation.sourceInstanceKeys).toEqual(['source:memory-spaces/custom:team'])
      await expect(spaces.apply({} as Context, { providers: ['not-installed'] })).rejects.toThrow('DSH Loader')
      await expect(runner.mount(spaces, { instanceId: 'duplicate', config: {
        providers: ['dsh-mnemon-provider-mnemon-native', 'dsh-mnemon-provider-mnemon-native'],
      } })).rejects.toThrow('duplicate Memory Space Provider child')
    } finally { await runner.dispose() }
  })
})
