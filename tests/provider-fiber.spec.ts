import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MemoryProviderAdapterRegistry } from '../src/providers/registry.ts'
import { BUILTIN_MEMORY_SPACE_PROVIDER_FACTORIES, createMemorySpaceProviderPlugin } from '../src/plugins/memory-space-providers.ts'

describe('Memory Spaces private Provider Fibers', () => {
  it('registers a Provider through a child Fiber closure and removes it with that Fiber', async () => {
    const ctx = new Context()
    const privateHost = new MemoryProviderAdapterRegistry()
    const factory = BUILTIN_MEMORY_SPACE_PROVIDER_FACTORIES.find(candidate => candidate.id === 'openviking')!
    const fiber = ctx.plugin(createMemorySpaceProviderPlugin(factory, privateHost))
    await fiber.await()

    expect(privateHost.ids()).toEqual(['openviking'])
    expect(ctx.get('mnemonProvider', false)).toBeUndefined()

    await fiber.dispose()
    expect(privateHost.ids()).toEqual([])
  })

  it('gives each Memory Spaces parent an isolated Provider host', async () => {
    const ctx = new Context()
    const first = new MemoryProviderAdapterRegistry()
    const second = new MemoryProviderAdapterRegistry()
    const factory = BUILTIN_MEMORY_SPACE_PROVIDER_FACTORIES.find(candidate => candidate.id === 'honcho')!
    const fiber = ctx.plugin(createMemorySpaceProviderPlugin(factory, first))
    await fiber.await()

    expect(first.ids()).toEqual(['honcho'])
    expect(second.ids()).toEqual([])
    await fiber.dispose()
  })
})
