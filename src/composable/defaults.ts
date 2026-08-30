import type { InstalledMemorySource, InstalledMemoryStrategy } from '../../packages/contracts/src/index.ts'
import type { MemoryRuntime } from '../../packages/extension-sdk/src/index.ts'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from '../../packages/strategy-default-three-tier/src/index.ts'
import { DOCUMENTS_MEMORY_SOURCE } from '../../plugins/dsh-mnemon-source-documents/src/source.ts'
import { MEMORY_SPACES_SOURCE } from './source-memory-spaces.ts'
import { RUNTIME_MEMORY_SOURCE } from '../../plugins/dsh-mnemon-source-runtime/src/source.ts'

export const BUILTIN_MEMORY_SOURCES = Object.freeze([
  RUNTIME_MEMORY_SOURCE,
  DOCUMENTS_MEMORY_SOURCE,
  MEMORY_SPACES_SOURCE,
])

/** Compatibility assembly for consumers that still mount only `dsh-mnemon`. */
export function installBundledComposableMemory(runtime: MemoryRuntime): () => void {
  const sources: InstalledMemorySource[] = BUILTIN_MEMORY_SOURCES.map(definition => ({
    kind: 'source',
    instanceKey: `source:bundled-${definition.manifest.typeId}`,
    provenance: { packageName: definition.manifest.packageName, entryId: `bundled-${definition.manifest.typeId}` },
    definition,
  }))
  const strategies: InstalledMemoryStrategy[] = [{
    kind: 'strategy',
    instanceKey: 'strategy:bundled-default-three-tier',
    provenance: { packageName: DEFAULT_THREE_TIER_VIEW_STRATEGY.manifest.packageName, entryId: 'bundled-default-three-tier' },
    definition: DEFAULT_THREE_TIER_VIEW_STRATEGY,
  }]
  return runtime.installContributions({ sources, strategies })
}
