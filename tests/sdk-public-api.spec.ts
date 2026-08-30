import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as sdk from 'dsh-mnemon/extension-sdk'
import type { MnemonMemoryService, MemorySourceRuntime } from 'dsh-mnemon/extension-sdk'
// @ts-expect-error Engine implementations are not plugin author contracts.
import type { MemoryRuntime } from 'dsh-mnemon/extension-sdk'
// @ts-expect-error Installed records belong to Core, not the public wire protocol.
import type { InstalledMemorySource } from 'dsh-mnemon/contracts'
// @ts-expect-error Registry snapshots are internal installation state.
import type { MemoryContributionSnapshot } from 'dsh-mnemon/contracts'

describe('public plugin SDK boundary', () => {
  it('types the only Context service as its contribution protocol', () => {
    expectTypeOf<Context['mnemonMemory']>().toEqualTypeOf<MnemonMemoryService>()
    expectTypeOf<keyof MnemonMemoryService>().toEqualTypeOf<'installContributions'>()
    expectTypeOf<MemorySourceRuntime['facts']>().toBeFunction()
  })

  it('exports author tools without engine, registry or generation constructors', () => {
    expect(sdk.installMemory).toBeTypeOf('function')
    expect(sdk.defineMemorySource).toBeTypeOf('function')
    expect(sdk.defineMemoryStrategy).toBeTypeOf('function')
    for (const name of ['MemoryRuntime', 'MemoryContributionRegistry', 'MemoryGenerationHost', 'ComposableMemoryTurnManager']) {
      expect(name in sdk).toBe(false)
    }
  })
})
