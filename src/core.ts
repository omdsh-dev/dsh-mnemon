import { MemoryRuntime, type MemoryBoot } from '../packages/extension-sdk/src/index.ts'

export const name = 'dsh-mnemon-core'
export const provide = ['mnemonMemory']
export const inject: string[] = []

interface MemoryCoreContext {
  provide?(name: string, service: MemoryRuntime): unknown
  effect(factory: () => () => Promise<void>, label?: string): unknown
}

/** Publish the Source-neutral service. A host adapter owns phase/scope wiring. */
export function provideMemoryRuntime(context: MemoryCoreContext, legacyBoot?: MemoryBoot): MemoryRuntime {
  const runtime = new MemoryRuntime(legacyBoot)
  context.provide?.('mnemonMemory', runtime)
  context.effect(() => () => runtime.dispose(), 'dsh-mnemon.core()')
  return runtime
}

/** No built-in Source, Provider, filesystem, settings, tools, or Web dependency. */
export function apply(context: MemoryCoreContext): void {
  provideMemoryRuntime(context)
}

export { MemoryRuntime }
export { ComposableMemoryTurnManager } from './composable/turns.ts'
