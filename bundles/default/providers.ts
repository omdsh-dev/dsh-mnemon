import mnemonNative, { definition as mnemonNativeDefinition } from '../../plugins/dsh-mnemon-provider-mnemon-native/src/index.ts'
import openviking, { definition as openvikingDefinition } from '../../plugins/dsh-mnemon-provider-openviking/src/index.ts'
import honcho, { definition as honchoDefinition } from '../../plugins/dsh-mnemon-provider-honcho/src/index.ts'
import mem0, { definition as mem0Definition } from '../../plugins/dsh-mnemon-provider-mem0/src/index.ts'
import hindsight, { definition as hindsightDefinition } from '../../plugins/dsh-mnemon-provider-hindsight/src/index.ts'
import holographic, { definition as holographicDefinition } from '../../plugins/dsh-mnemon-provider-holographic/src/index.ts'
import retaindb, { definition as retaindbDefinition } from '../../plugins/dsh-mnemon-provider-retaindb/src/index.ts'
import byterover, { definition as byteroverDefinition } from '../../plugins/dsh-mnemon-provider-byterover/src/index.ts'
import supermemory, { definition as supermemoryDefinition } from '../../plugins/dsh-mnemon-provider-supermemory/src/index.ts'
import type { MemorySpaceProviderDefinition, MemorySpaceProviderEntry, MemorySpaceProviderModule } from '../../src/memory-spaces/provider-sdk.ts'

/** Explicit default bundle; the independent Source imports no Provider. */
export const BUILTIN_MEMORY_SPACE_PROVIDER_MODULES: readonly MemorySpaceProviderModule<undefined>[] = Object.freeze([
  mnemonNative, openviking, honcho, mem0, hindsight, holographic, retaindb, byterover, supermemory
])
export const BUILTIN_MEMORY_SPACE_PROVIDER_DEFINITIONS: readonly MemorySpaceProviderDefinition[] = Object.freeze([
  mnemonNativeDefinition, openvikingDefinition, honchoDefinition, mem0Definition, hindsightDefinition, holographicDefinition, retaindbDefinition, byteroverDefinition, supermemoryDefinition
])
export const BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES: readonly MemorySpaceProviderEntry<undefined>[] = Object.freeze(
  BUILTIN_MEMORY_SPACE_PROVIDER_MODULES.map(module => Object.freeze({ instanceId: module.id, module, config: undefined })),
)
