/**
 * Where a MEMORY.md archive or a Document's index can go, and the lineage that names where an archived
 * entry went: the Memory Spaces that can take one, and the destination a Provider's receipt proves.
 */
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

/**
 * A space that can take a MEMORY.md archive or a Document's index: active, writable, its
 * Provider enabled and ready, with exact writes and safe forget. A Mnemon Native
 * space stays listed, and active, while its CLI is missing; it takes no writes then.
 * A read-only space is recalled but takes no archive (#434).
 */
export function archivableSpace(directory: MemorySpaceCatalog, body: MemorySpaceCatalog['items'][number]): boolean {
  return body.active && body.writePolicy !== 'read-only' && body.providerEnabled !== false && body.provider.capabilities.remember === true
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

/**
 * The memory a skipped write names as already holding exactly this text, when
 * its receipt carries that memory's id and stored text. Anything less proves
 * nothing, and the caller verifies by search instead.
 */
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

/** Whether a Memory Spaces Source other than the one in use lists a space that could take the archive. */
export async function archivableElsewhere(graph: MnemonRuntimeGraph, scope: MemoryOperationScope, generation: MemoryCompositionGeneration, sourceInstanceKey: string, signal?: AbortSignal): Promise<boolean> {
  if (!generation.sourceInstances().some(source => source.sourceTypeId === 'memory-spaces' && source.sourceInstanceKey !== sourceInstanceKey)) return false
  return !await noArchivableMemorySpace(graph, scope, generation, signal, sourceInstanceKey)
}

/**
 * True only when no installed Memory Spaces Source lists a space that could take
 * an archive (#336). A directory that cannot be read counts as one that could:
 * the caller then refuses as before, and nothing leaves working memory.
 */
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
