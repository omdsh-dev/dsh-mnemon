import type {
  MemoryProviderCapabilities,
  MemoryProviderConfigField,
  MemoryProviderConnection,
  MemoryProviderDescriptor,
  MemoryProviderId,
  MemoryProviderIcon,
} from '../shared/contracts.ts'

import { descriptor as openvikingDescriptor } from '../../plugins/dsh-mnemon-provider-openviking/src/descriptor.ts'
import { descriptor as honchoDescriptor } from '../../plugins/dsh-mnemon-provider-honcho/src/descriptor.ts'
import { descriptor as mem0Descriptor } from '../../plugins/dsh-mnemon-provider-mem0/src/descriptor.ts'
import { descriptor as hindsightDescriptor } from '../../plugins/dsh-mnemon-provider-hindsight/src/descriptor.ts'
import { descriptor as holographicDescriptor } from '../../plugins/dsh-mnemon-provider-holographic/src/descriptor.ts'
import { descriptor as retaindbDescriptor } from '../../plugins/dsh-mnemon-provider-retaindb/src/descriptor.ts'
import { descriptor as byteroverDescriptor } from '../../plugins/dsh-mnemon-provider-byterover/src/descriptor.ts'
import { descriptor as supermemoryDescriptor } from '../../plugins/dsh-mnemon-provider-supermemory/src/descriptor.ts'

import { descriptor as nativeDescriptor } from '../../plugins/dsh-mnemon-provider-mnemon-native/src/descriptor.ts'

export const MEMORY_PROVIDER_IDS = ["mnemon-native","openviking","honcho","mem0","hindsight","holographic","retaindb","byterover","supermemory"] as const
export const MEMORY_PROVIDER_ID_SET = new Set<MemoryProviderId>(MEMORY_PROVIDER_IDS)
export const MEMORY_PROVIDER_CATALOG: readonly MemoryProviderDescriptor[] = [
  nativeDescriptor, openvikingDescriptor, honchoDescriptor, mem0Descriptor, hindsightDescriptor, holographicDescriptor, retaindbDescriptor, byteroverDescriptor, supermemoryDescriptor
]

import * as catalogTools from '../../plugins/dsh-mnemon-source-memory-spaces/src/providers/catalog.ts'
import { MemoryProviderCatalog } from '../../plugins/dsh-mnemon-source-memory-spaces/src/providers/catalog.ts'
export { MemoryProviderCatalog }

export function memoryProviderDescriptor(id: MemoryProviderId, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): MemoryProviderDescriptor {
  return catalogTools.memoryProviderDescriptor(id, catalog)
}

export function isMemoryProviderId(value: unknown): value is MemoryProviderId {
  return typeof value === 'string' && MEMORY_PROVIDER_ID_SET.has(value as MemoryProviderId)
}

export function providerServiceFields(providerId: MemoryProviderId, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): MemoryProviderConfigField[] {
  return catalogTools.providerServiceFields(providerId, catalog)
}

export function providerMemoryFields(providerId: MemoryProviderId, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): MemoryProviderConfigField[] {
  return catalogTools.providerMemoryFields(providerId, catalog)
}

export function splitProviderConnection(providerId: MemoryProviderId, connection: MemoryProviderConnection | undefined, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): {
  service: MemoryProviderConnection
  memory: MemoryProviderConnection
} {
  return catalogTools.splitProviderConnection(providerId, connection, catalog)
}

export function normalizeProviderServiceConnection(providerId: MemoryProviderId, input: MemoryProviderConnection | undefined, previous: MemoryProviderConnection = {}, clearSecrets: readonly string[] = [], catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): MemoryProviderConnection {
  return catalogTools.normalizeProviderServiceConnection(providerId, input, previous, clearSecrets, catalog)
}

export function normalizeProviderMemoryConnection(providerId: MemoryProviderId, input: MemoryProviderConnection | undefined, previous: MemoryProviderConnection = {}, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): MemoryProviderConnection {
  return catalogTools.normalizeProviderMemoryConnection(providerId, input, previous, catalog)
}

export function normalizeProviderConnection(
  providerId: MemoryProviderId,
  input: MemoryProviderConnection | undefined,
  previous: MemoryProviderConnection = {},
  clearSecrets: readonly string[] = [],
  catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG,
): MemoryProviderConnection {
  return catalogTools.normalizeProviderConnection(providerId, input, previous, clearSecrets, catalog)
}

export function publicScopedProviderConnection(providerId: MemoryProviderId, scope: MemoryProviderConfigField['scope'], connection: MemoryProviderConnection, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): {
  settings: MemoryProviderConnection
  configuredSecrets: string[]
} {
  return catalogTools.publicScopedProviderConnection(providerId, scope, connection, catalog)
}

export function publicProviderConnection(providerId: MemoryProviderId, connection: MemoryProviderConnection, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): {
  settings: MemoryProviderConnection
  configuredSecrets: string[]
} {
  return catalogTools.publicProviderConnection(providerId, connection, catalog)
}

export const BUILTIN_MEMORY_PROVIDER_CATALOG = new MemoryProviderCatalog(MEMORY_PROVIDER_CATALOG)
