import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { PrivateMemorySpaceProviderHost, type MemorySpaceAuthority } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import module, { definition, ByteRoverProvider, descriptor } from '../src/index.ts'

describe('independent byterover Provider', () => {
  it('installs complete immutable metadata in one parent-owned child', async () => {
    const ctx = new Context()
    const host = new PrivateMemorySpaceProviderHost('external-memory-spaces')
    const fiber = ctx.plugin({ name: 'provider-test', apply(child) { module.apply(child, host.bind('work', module.id, undefined), undefined) } })
    try {
      await fiber.await()
      const snapshot = host.snapshot()
      expect(snapshot.descriptors()).toMatchObject([{ id: 'work', typeId: 'byterover', label: descriptor.label }])
      expect(Object.isFrozen(snapshot.entries[0]!.definition.manifest)).toBe(true)
      expect(definition.manifest.secrets).toEqual(descriptor.fields.filter(field => field.input === 'secret').map(field => field.key).sort())
    } finally { await fiber.dispose() }
    expect(host.snapshot().entries).toHaveLength(0)
  })

  it('constructs its own driver from a structural authority, without the main repository', () => {
    const authority: MemorySpaceAuthority = { runner: { effectiveDataDir: () => '/unused' }, list: () => [], providerConnection: () => ({}) }
    const adapter = definition.create({ memoryBodies: authority, config: { timeoutMs: 200 }, providerInstanceId: 'byterover', manifest: definition.manifest })
    expect(adapter).toBeInstanceOf(ByteRoverProvider)
    expect(adapter.id).toBe('byterover')
  })
})
