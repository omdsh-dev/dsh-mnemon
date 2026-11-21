import { createHash } from 'node:crypto'
import type { MemorySpaceCatalog } from 'dsh-mnemon-source-memory-spaces/contracts'
import { mutationResultCommitted } from './receipts.ts'
import type { MemoryMigrationLineage, MemoryOperationScope } from '../core/contracts/index.ts'
import type { MemoryCompositionGeneration } from '../core/composition.ts'
import type { MnemonRuntimeGraph } from './runtime.ts'
import { addString, optionalObject } from './subagent-receipts.ts'

export interface MigrationSource {
  index: number
  layerId: string
  reference: string
  digest: string
}

export function archivableSpace(directory: MemorySpaceCatalog, body: MemorySpaceCatalog['items'][number]): boolean {
  return body.active && body.providerEnabled !== false && body.provider.capabilities.remember === true
    && body.provider.capabilities.writeMode === 'exact' && body.provider.capabilities.forget === true
    && directory.providers?.find(provider => provider.id === body.provider.id)?.serviceConfigured !== false
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function destinationProviderIds(value: Record<string, unknown> | undefined): string[] {
  const ids = new Set<string>()
  for (const key of ['id', 'eventId', 'operationId', 'taskId', 'resourceId', 'documentId'] as const) addString(ids, value?.[key])
  return [...ids]
}

export function destinationFromCommittedMutation(
  result: unknown,
  memoryBodyId: string,
  content: string,
): MemoryMigrationLineage['destination'] | undefined {
  if (!mutationResultCommitted(result)) return undefined
  const value = optionalObject(result)
  if (typeof value?.memoryBodyId === 'string' && value.memoryBodyId !== memoryBodyId) {
    throw new Error('runtime archive receipt names a different Memory Space')
  }
  const digest = sha256(content)
  const stableId = destinationProviderIds(value)[0]
  return {
    layerId: 'memory-spaces',
    reference: `memory-space:${encodeURIComponent(memoryBodyId)}/${stableId === undefined ? `sha256:${digest}` : `item:${encodeURIComponent(stableId)}`}`,
    digest,
  }
}

export function skippedExactDestination(
  result: unknown,
  memoryBodyId: string,
  content: string,
): MemoryMigrationLineage['destination'] | undefined {
  const value = optionalObject(result)
  const id = typeof value?.id === 'string' ? value.id.trim() : ''
  if (id === '' || value?.content !== content) return undefined
  if (value.memoryBodyId !== undefined && value.memoryBodyId !== memoryBodyId) return undefined
  return {
    layerId: 'memory-spaces',
    reference: `memory-space:${encodeURIComponent(memoryBodyId)}/item:${encodeURIComponent(id)}`,
    digest: sha256(content),
  }
}

export function mutationStates(result: unknown): string[] {
  const value = optionalObject(result)
  return [value?.action, value?.status]
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim().toLocaleLowerCase())
}

export async function archivableElsewhere(graph: MnemonRuntimeGraph, scope: MemoryOperationScope, generation: MemoryCompositionGeneration, sourceInstanceKey: string, signal?: AbortSignal): Promise<boolean> {
  if (!generation.sourceInstances().some(source => source.sourceTypeId === 'memory-spaces' && source.sourceInstanceKey !== sourceInstanceKey)) return false
  return !await noArchivableMemorySpace(graph, scope, generation, signal, sourceInstanceKey)
}

export async function noArchivableMemorySpace(graph: MnemonRuntimeGraph, scope: MemoryOperationScope, generation: MemoryCompositionGeneration, signal?: AbortSignal, except?: string): Promise<boolean> {
  for (const instance of generation.sourceInstances().filter(source => source.sourceTypeId === 'memory-spaces' && source.sourceInstanceKey !== except)) {
    try {
      const directory = await graph.source('memory-spaces', scope).forInstance(instance.sourceInstanceKey).forGeneration(generation).read<MemorySpaceCatalog>('body-directory', null, signal)
      if (directory.items.some(body => archivableSpace(directory, body))) return false
    } catch {
      signal?.throwIfAborted()
      return false
    }
  }
  return true
}
