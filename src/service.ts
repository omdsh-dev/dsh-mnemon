import { MemorySpacesService } from '../plugins/dsh-mnemon-source-memory-spaces/src/service.ts'
import type { MnemonRunner } from './runner.ts'
import type { ResolvedConfig } from './config.ts'
import type { MemoryBodyRegistry } from './memory-bodies.ts'
import type { AuthorityCommitRecorder } from './memory-receipts.ts'
import { recallQualityPolicies, type RecallQualityPolicyRegistry } from './recall-quality/index.ts'
import { memoryProviderAdapterFactories, type MemoryProviderAdapterRegistry } from './providers/registry.ts'
import { BUILTIN_MEMORY_PROVIDER_CATALOG, type MemoryProviderCatalog } from './providers/catalog.ts'
export * from '../plugins/dsh-mnemon-source-memory-spaces/src/service.ts'
export { parseMemoryGraph } from '../plugins/dsh-mnemon-provider-mnemon-native/src/driver.ts'
export type { StatusView } from './shared/contracts.ts'

/** Legacy aggregate constructor; all domain behavior belongs to the Source. */
export class MnemonService extends MemorySpacesService {
  declare readonly config: ResolvedConfig
  constructor(runner: MnemonRunner, config: ResolvedConfig, memoryBodies?: MemoryBodyRegistry,
    recallQuality: RecallQualityPolicyRegistry = recallQualityPolicies,
    providers: MemoryProviderAdapterRegistry = memoryProviderAdapterFactories,
    recordCommit?: AuthorityCommitRecorder, catalog: MemoryProviderCatalog = BUILTIN_MEMORY_PROVIDER_CATALOG) {
    super(runner, config, memoryBodies, recallQuality, providers, recordCommit, catalog)
  }
}
