import { MemoryRuntime } from './runtime.ts'

export const name = 'dsh-mnemon-core'
export const provide = ['mnemonMemory']
export const inject: string[] = []

interface MemoryCoreContext {
  provide(name: string, service: MemoryRuntime): unknown
  effect(factory: () => () => Promise<void>, label?: string): unknown
}

/** Publish the Source-neutral service. A host adapter owns phase/scope wiring. */
export function provideMemoryRuntime(context: MemoryCoreContext): MemoryRuntime {
  const runtime = new MemoryRuntime()
  context.provide('mnemonMemory', runtime)
  context.effect(() => () => runtime.dispose(), 'dsh-mnemon.core()')
  return runtime
}

/** No built-in Source, Provider, filesystem, settings, tools, or Web dependency. */
export function apply(context: MemoryCoreContext): void {
  provideMemoryRuntime(context)
}

export { MemoryRuntime }
export { ComposableMemoryTurnManager } from "./turns.ts"
