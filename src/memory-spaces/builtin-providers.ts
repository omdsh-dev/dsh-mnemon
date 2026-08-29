import { MEMORY_PROVIDER_CATALOG } from '../providers/catalog.ts'
import {
  BUILTIN_MEMORY_PROVIDER_ADAPTER_FACTORIES,
  type MemoryProviderAdapterFactory,
} from '../providers/registry.ts'
import {
  MEMORY_SPACE_PROVIDER_API_VERSION,
  defineMemorySpaceProvider,
  defineMemorySpaceProviderDefinition,
  type MemorySpaceProviderEntry,
  type MemorySpaceProviderModule,
} from './provider-sdk.ts'

const BUNDLED_IMPLEMENTATION_VERSION = '0.3.5'

function moduleFor(factory: MemoryProviderAdapterFactory): MemorySpaceProviderModule<undefined> {
  const descriptor = MEMORY_PROVIDER_CATALOG.find(candidate => candidate.id === factory.id)
  if (descriptor === undefined) throw new Error(`built-in Memory Space Provider ${factory.id} has no descriptor`)
  const definition = defineMemorySpaceProviderDefinition({
    manifest: {
      apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION,
      kind: 'provider',
      typeId: descriptor.id,
      packageName: `dsh-mnemon-provider-${descriptor.id}`,
      version: BUNDLED_IMPLEMENTATION_VERSION,
      label: descriptor.label,
      ...(descriptor.icon === undefined ? {} : { icon: descriptor.icon }),
      summary: descriptor.summary,
      ...(descriptor.summaryI18nKey === undefined ? {} : { summaryI18nKey: descriptor.summaryI18nKey }),
      origin: descriptor.origin,
      locality: descriptor.kind,
      workspaceBinding: descriptor.workspaceBinding,
      capabilities: descriptor.capabilities,
      fields: descriptor.fields,
      secrets: descriptor.fields.filter(field => field.input === 'secret').map(field => field.key),
      scoreSemantics: factory.scoreSemantics,
    },
    create: context => factory.create(context),
  })
  return defineMemorySpaceProvider({
    id: descriptor.id,
    apply(ctx, host) {
      host.install(ctx, definition)
    },
  })
}

/** Every bundled Provider is expressed as the same complete child module. */
export const BUILTIN_MEMORY_SPACE_PROVIDER_MODULES: readonly MemorySpaceProviderModule<undefined>[] =
  Object.freeze(BUILTIN_MEMORY_PROVIDER_ADAPTER_FACTORIES.map(moduleFor))

export const BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES: readonly MemorySpaceProviderEntry<undefined>[] =
  Object.freeze(BUILTIN_MEMORY_SPACE_PROVIDER_MODULES.map(module => Object.freeze({
    instanceId: module.id,
    module,
    config: undefined,
  })))
