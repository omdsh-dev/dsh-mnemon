import { MemoryBodyRegistry as SourceRegistry } from '../plugins/dsh-mnemon-source-memory-spaces/src/memory-bodies.ts'
import type { MnemonRunner } from './runner.ts'
import { BUILTIN_MEMORY_PROVIDER_CATALOG, type MemoryProviderCatalog } from './providers/catalog.ts'
export * from '../plugins/dsh-mnemon-source-memory-spaces/src/memory-bodies.ts'

/** Pre-composable constructor retains the default Provider catalog. */
export class MemoryBodyRegistry extends SourceRegistry {
  constructor(runner: MnemonRunner, persistent = true, now: () => Date = () => new Date(), catalog: MemoryProviderCatalog = BUILTIN_MEMORY_PROVIDER_CATALOG) {
    super(runner, persistent, now, catalog)
  }
}
