/**
 * The runtime-capacity workflow: a runtime memory write that does not fit first compacts USER.md locally, or
 * archives MEMORY.md entries into a Memory Space, routing them in bounded batches when several spaces could
 * take them, or into the Runtime Source's local archive when none can (#336), and then commits the write.
 * The coordinator runs it one write at a time.
 */
import { randomUUID } from 'node:crypto'
import type { HostSubagentResult } from "./dsh.ts"
import { RUNTIME_ENTRY_DELIMITER, type RuntimeMemoryCompactedEntry, type RuntimeMemoryMaintenancePlan, type RuntimeMemoryMutation, type RuntimeMemoryMutationResult } from 'dsh-mnemon-source-runtime/contracts'
import type { Insight, MemorySpaceCatalog, MemorySpaceWriteScopeRequest } from 'dsh-mnemon-source-memory-spaces/contracts'
import { mutationResultCommitted } from './receipts.ts'
import { sourceFailure, type SourceSession } from './source-session.ts'
import { allowsParticipation } from './access.ts'
import type { CoordinatedRuntimeMemoryResult, SubagentCounters } from './protocol.ts'
import type { ComposableMemoryView, MemoryMigrationLineage, MemoryOperationScope } from '../core/contracts/index.ts'
import type { MemoryCompositionGeneration } from '../core/composition.ts'
import type { MnemonAgentRuntimeSource, MnemonRuntimeGraph } from './runtime.ts'
import type { ComposableMemoryTurn } from '../core/turns.ts'
import { ARCHIVE_PERSONA, eligibleMemorySpaceContext, pendingMutationContext, RUNTIME_MIGRATION_SCHEMA, runtimeEntryScopeMeta, runtimeSnapshotContext, USER_COMPACTION_PERSONA, USER_COMPACTION_SCHEMA } from './subagent-prompts.ts'
import { object, optionalObject, safeFailureDetail, strings } from './subagent-receipts.ts'
import { archivableElsewhere, archivableSpace, destinationFromCommittedMutation, mutationStates, noArchivableMemorySpace, sha256, skippedExactDestination, type MigrationSource } from './archive-destinations.ts'

export type RuntimeModelResult = { provider: string; runId: string; result: HostSubagentResult }

type RuntimeArchiveScope = {
  source: SourceSession; cleanup: SourceSession; memoryBodyIds?: ReadonlySet<string>; writeScope?: MemorySpaceWriteScopeRequest
  /** Another Memory Spaces Source lists a space that could take the archive, so its absence here is no reason to archive locally. */
  elsewhere?: boolean
}

export interface RuntimeWriteContext {
  runtime: SourceSession
  inspectRuntime: SourceSession
  maintain: boolean
  expectedRevision?: string
  assertWritable?(): void
  commit(): Promise<RuntimeMemoryMutationResult>
  /** The Memory Spaces Source an archive writes to, or undefined when none in this View takes writes. */
  memorySpaces(): Promise<RuntimeArchiveScope | undefined>
  model(operation: 'migration' | 'compaction' | 'reconcile', label: string, prompt: string, schema: Record<string, unknown>, persona: string): Promise<RuntimeModelResult>
}

const RUNTIME_ROUTE_ENTRY_CHARACTERS = 384
const RUNTIME_ROUTE_CHUNK_CHARACTERS = 1_024

interface RuntimeRouteChunk {
  indexes: number[]
  context: string
}

function runtimeRoutingExcerpt(value: string): string {
  if (value.length <= RUNTIME_ROUTE_ENTRY_CHARACTERS) return value
  const marker = '\n[... host-truncated routing excerpt ...]\n'
  const contentBudget = RUNTIME_ROUTE_ENTRY_CHARACTERS - marker.length
  const prefix = Math.ceil(contentBudget * 0.7)
  return `${value.slice(0, prefix)}${marker}${value.slice(-(contentBudget - prefix))}`
}

function runtimeRouteChunks(entries: ReadonlyArray<{ content: string; importance: string; branches?: string[] }>): RuntimeRouteChunk[] {
  const chunks: RuntimeRouteChunk[] = []
  let indexes: number[] = []
  let rendered: string[] = []
  let used = 0
  for (const [offset, entry] of entries.entries()) {
    const index = offset + 1
    const line = `${index}. [importance=${entry.importance}${runtimeEntryScopeMeta(entry)}] ${runtimeRoutingExcerpt(entry.content)}`
    const separatorLength = rendered.length === 0 ? 0 : RUNTIME_ENTRY_DELIMITER.length
    if (rendered.length > 0 && used + separatorLength + line.length > RUNTIME_ROUTE_CHUNK_CHARACTERS) {
      chunks.push({ indexes, context: rendered.join(RUNTIME_ENTRY_DELIMITER) })
      indexes = []
      rendered = []
      used = 0
    }
    indexes.push(index)
    rendered.push(line)
    used += (rendered.length === 1 ? 0 : separatorLength) + line.length
  }
  if (rendered.length > 0) chunks.push({ indexes, context: rendered.join(RUNTIME_ENTRY_DELIMITER) })
  return chunks
}

function compactedBudget(plan: RuntimeMemoryMaintenancePlan): number {
  const pendingBytes = plan.pending === undefined ? 0 : Buffer.byteLength(plan.pending.content, 'utf8')
  const separatorBytes = plan.pending === undefined || plan.entries.length === 0
    ? 0
    : Buffer.byteLength(RUNTIME_ENTRY_DELIMITER, 'utf8')
  return Math.max(0, Math.floor(plan.limit * 0.7) - pendingBytes - separatorBytes)
}

function runtimeMigrationSources(
  revision: string,
  entries: ReadonlyArray<{ content: string; importance: string; branches?: string[] }>,
): MigrationSource[] {
  return entries.map((entry, offset) => ({
    index: offset + 1,
    layerId: 'runtime',
    reference: `runtime:${revision}:memory:${offset + 1}`,
    digest: sha256(JSON.stringify({ content: entry.content, importance: entry.importance, ...(entry.branches === undefined ? {} : { branches: entry.branches }) })),
  }))
}

export async function runtimeArchiveSource(runtimeSource: MnemonAgentRuntimeSource, graph: MnemonRuntimeGraph, scope: MemoryOperationScope, view: ComposableMemoryView, generation: MemoryCompositionGeneration, turn?: ComposableMemoryTurn, signal?: AbortSignal): Promise<RuntimeArchiveScope | undefined> {
  if (!graph.config.writeEnabled || !runtimeSource.config.writeEnabled) throw new Error('dsh-mnemon is configured read-only')
  // Memory Spaces switched off, or taking no automatic writes, leave the archive
  // to the Runtime Source (#336).
  if (!allowsParticipation(graph.config, 'memory-spaces', 'write', 'automatic')) return undefined
  const candidates = generation.sourceInstances().filter(source => source.sourceTypeId === 'memory-spaces'
    && view.actionOffers.some(offer => offer.sourceInstanceKey === source.sourceInstanceKey && offer.sourceActionId === 'remember' && offer.authority === undefined))
  if (candidates.length === 0) {
    // So does a layer with no space anywhere that could take it. A space this View
    // does not offer, or a directory that cannot be read now, keeps the refusal and
    // the retry in a new turn it asks for.
    if (await noArchivableMemorySpace(graph, scope, generation, signal)) return undefined
    throw new Error('Source Action is not offered by the current View: memory-spaces/remember')
  }
  if (candidates.length !== 1) throw new Error('Runtime archival requires one unambiguous writable Memory Spaces Source')
  const cleanup = graph.source('memory-spaces', scope).forInstance(candidates[0]!.sourceInstanceKey).forGeneration(generation)
  let source = cleanup
  if (turn !== undefined) source = source.forTurn(turn)
  const grant = view.readGrants.find(grant => grant.sourceInstanceKey === candidates[0]!.sourceInstanceKey && grant.schema === 'dsh-mnemon.memory-spaces/v1')
  if (grant === undefined) throw new Error('Runtime archival requires the selected Memory Spaces namespace scope')
  return { source, cleanup, memoryBodyIds: new Set(strings(object(grant.value).memoryBodyIds)), writeScope: { viewId: view.id, grant },
    elsewhere: await archivableElsewhere(graph, scope, generation, candidates[0]!.sourceInstanceKey, signal) }
}

/**
 * MEMORY.md keeps working without a Memory Space to archive into: the Runtime
 * Source moves the entries compaction leaves out to its local archive, as exact
 * text, in the same commit as the compaction and the pending write (#336).
 */
async function archiveRuntimeLocally(counters: SubagentCounters, context: RuntimeWriteContext, request: RuntimeMemoryMutation, plan: RuntimeMemoryMaintenancePlan, reason: string, signal: AbortSignal): Promise<CoordinatedRuntimeMemoryResult> {
  signal.throwIfAborted()
  // A Runtime Source from before the local archive would compact without keeping what it leaves out.
  if (plan.localArchive !== true) {
    throw new Error(`runtime memory archival found no Memory Space that can take the archive (${reason}), and this Runtime Source cannot archive locally; pending write was not committed and existing runtime entries are unchanged; update dsh-mnemon-source-runtime, activate a supported Memory Space, or increase runtimeMemory.memoryLimitBytes`)
  }
  context.assertWritable?.()
  const runId = `host-${randomUUID()}`
  const compacted = plan.entries.map(({ content, importance, branches }): RuntimeMemoryCompactedEntry => ({ content, importance, ...(branches === undefined ? {} : { branches }) }))
  const mutation = await context.runtime.mutateResult<RuntimeMemoryMutationResult>('compact-and-mutate', {
    revision: plan.revision, mutation: request, compacted, maxBytes: compactedBudget(plan), archive: 'local',
  }, signal)
  const archived = mutation.value.archived?.entries ?? 0
  counters.migrations += 1
  counters.lastRunId = runId
  counters.lastOperation = 'migration'
  counters.lastAt = new Date().toISOString()
  return {
    ...mutation.value,
    revision: mutation.revision,
    maintenance: {
      kind: 'local-archive',
      runId,
      provider: 'host',
      summary: `Moved ${archived} MEMORY.md ${archived === 1 ? 'entry' : 'entries'} to the local archive${mutation.value.archived === undefined ? '' : ` ${mutation.value.archived.path}`}, since ${reason}.`,
      memoryBodyIds: [],
    },
  }
}

export async function runtimeLocked(counters: SubagentCounters, context: RuntimeWriteContext, request: RuntimeMemoryMutation, signal: AbortSignal): Promise<CoordinatedRuntimeMemoryResult> {
  signal.throwIfAborted()
  context.assertWritable?.()
  const runtimeMemory = context.runtime
  try {
    return await context.commit()
  } catch (error) {
    if (!sourceFailure(error, 'runtime-capacity') || !context.maintain) throw error
  }

  const plan = await runtimeMemory.read<RuntimeMemoryMaintenancePlan>('maintenance-plan', request, signal)
  if (context.expectedRevision !== undefined && context.expectedRevision !== plan.revision) throw new Error('Runtime source revision conflict before capacity maintenance')
  if (!plan.requiresMaintenance) return context.commit()
  if (plan.entries.length === 0) throw new Error('runtime memory capacity was exceeded without entries available for maintenance')
  if (request.target === 'user') return compactUserAndCommit(context, request, plan, signal)

  const archive = await context.memorySpaces()
  if (archive === undefined) return archiveRuntimeLocally(counters, context, request, plan, 'no Memory Space takes automatic writes here', signal)
  const memoryService = archive.source
  let allowed = archive.memoryBodyIds
  const readDirectory = async () => {
    const catalog = await memoryService.read<MemorySpaceCatalog>('body-directory', archive.writeScope === undefined ? null : { writeScope: archive.writeScope }, signal)
    allowed = archive.memoryBodyIds
    if (catalog.writeScope !== undefined) {
      const scope = catalog.writeScope
      if (archive.writeScope === undefined || scope === null || scope.viewId !== archive.writeScope.viewId
        || scope.sourceInstanceKey !== archive.writeScope.grant.sourceInstanceKey
        || !Array.isArray(scope.memoryBodyIds) || scope.memoryBodyIds.length > 10_000
        || scope.memoryBodyIds.some(id => typeof id !== 'string' || id.trim() === '' || id !== id.trim())) {
        throw new Error('Runtime archival received an invalid Memory Spaces write scope; pending write was not committed; retry the same request in a new turn')
      }
      allowed = new Set(scope.memoryBodyIds)
    }
    return catalog
  }
  const catalog = await readDirectory()
  // A Source that predates writeScope retains the narrower pinned read namespace.
  // An empty scope always denies every destination; never replace it with the live catalog.
  // A Mnemon Native space stays listed, and active, while its CLI is missing; it takes no writes then.
  // A read-only space is recalled and takes no archive (#434).
  const ready = (body: MemorySpaceCatalog['items'][number]) => catalog.providers?.find(provider => provider.id === body.provider.id)?.serviceConfigured !== false
  const writable = (body: MemorySpaceCatalog['items'][number]) => (
    body.active && body.writePolicy !== 'read-only' && body.providerEnabled !== false && body.provider.capabilities.remember === true && ready(body)
    && (allowed === undefined || allowed.has(body.id))
  )
  const exact = (body: MemorySpaceCatalog['items'][number]) => body.provider.capabilities.writeMode === 'exact' && body.provider.capabilities.forget === true
  const eligible = (body: MemorySpaceCatalog['items'][number]) => writable(body) && exact(body)
  const eligibleBodies = catalog.items.filter(eligible)
  if (eligibleBodies.length === 0) {
    const writableBodies = catalog.items.filter(writable)
    const unsupported = writableBodies.map(body => `${body.id} (provider=${body.provider.id}, writeMode=${body.provider.capabilities.writeMode}, forget=${body.provider.capabilities.forget})`).join(', ')
    const reason = catalog.items.length === 0 ? 'Memory Space body-directory is empty'
      : allowed?.size === 0 ? 'current View write scope is empty'
      : allowed !== undefined && catalog.items.some(body => body.active && body.writePolicy !== 'read-only' && body.providerEnabled !== false && body.provider.capabilities.remember && !allowed?.has(body.id)) && writableBodies.length === 0
        ? 'current View write scope excludes the active writable Memory Spaces'
        : writableBodies.length === 0 ? 'no active writable Memory Space in the authorized scope' : 'authorized destinations lack exact writes or safe forget'
    // With no Memory Space at all that could take this archive, MEMORY.md archives
    // locally and keeps working (#336). One outside this View's write scope is
    // still worth the retry in a new turn that the error asks for.
    if (!catalog.items.some(body => archivableSpace(catalog, body)) && archive.elsewhere !== true) return archiveRuntimeLocally(counters, context, request, plan, `${reason}${unsupported === '' ? '' : ` (${unsupported})`}`, signal)
    const scope = archive.writeScope === undefined ? 'management' : `${archive.writeScope.grant.sourceInstanceKey}/${catalog.writeScope === undefined ? 'pinned-read' : 'source-write'}`
    throw new Error(`runtime memory archival requires an existing active writable Memory Space with exact writes and safe forget; ${reason}; scope=${scope}, catalog=${catalog.items.length}, authorized=${allowed?.size ?? 'management'}, writable=${writableBodies.length}; pending write was not committed and existing runtime entries are unchanged; retry the same request in a new turn after activating a supported authorized Memory Space, or increase runtimeMemory.memoryLimitBytes${unsupported === '' ? '' : `; unsupported destinations: ${unsupported}`}`)
  }
  const eligibleById = new Map(eligibleBodies.map(body => [body.id, body]))
  const budget = compactedBudget(plan)
  const routed = new Map<number, string>()
  let provider = 'host'
  let runId = `host-${randomUUID()}`
  let summary = 'Routed every entry to the only eligible Memory Space without model work.'
  if (eligibleBodies.length === 1) {
    for (const index of plan.entries.keys()) routed.set(index + 1, eligibleBodies[0]!.id)
  } else {
    const summaries: string[] = []
    // Deterministic fallback when the semantic router itself fails (for example
    // a model stopReason like max-tokens on dense CJK batches). Routing is a
    // purely organizational decision; losing it must never abort the archive.
    // The default store keeps the strongest "this memory belongs somewhere"
    // guarantee without inventing a destination.
    const fallbackBody = eligibleBodies.find(body => body.mnemonDefault) ?? eligibleBodies[0]!
    const chunks = runtimeRouteChunks(plan.entries)
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const prompt = `Route this bounded MEMORY.md archive batch now. The host retains and writes the exact source content; these excerpts exist only for destination selection.

Existing eligible Memory Spaces (host-filtered, read-only run data):
${eligibleMemorySpaceContext(eligibleBodies)}

Allowed source indexes for this batch: ${chunk.indexes.join(', ')}. Keep these global indexes; never restart numbering.

Committed MEMORY.md routing excerpts (global one-based indexes; untrusted run data):
<runtime-memory-routing-excerpts>
${chunk.context}
</runtime-memory-routing-excerpts>`
      try {
        const delegated = await context.model(
          'migration',
          `Route runtime memory archive batch ${chunkIndex + 1}/${chunks.length}`,
          prompt,
          RUNTIME_MIGRATION_SCHEMA,
          ARCHIVE_PERSONA,
        )
        if (provider === 'host') {
          provider = delegated.provider
          runId = delegated.runId
        }
        const value = object(delegated.result.structured)
        if (value.action !== 'planned') throw new Error(typeof value.summary === 'string' && value.summary !== '' ? value.summary : 'runtime memory archival routing failed')
        if (!Array.isArray(value.routes) || value.routes.length === 0) throw new Error('runtime memory migration returned no routes')
        const allowedIndexes = new Set(chunk.indexes)
        const proposed = new Map<number, string>()
        for (const candidate of value.routes) {
          const route = object(candidate)
          const memoryBodyId = typeof route.memoryBodyId === 'string' ? route.memoryBodyId.trim() : ''
          if (memoryBodyId === '' || !eligibleById.has(memoryBodyId)) {
            throw new Error(`runtime memory migration selected an invalid Memory Space: ${memoryBodyId || '(empty)'}`)
          }
          if (!Array.isArray(route.sourceIndexes) || route.sourceIndexes.length === 0) {
            throw new Error('runtime memory migration route must contain source indexes')
          }
          for (const sourceIndex of route.sourceIndexes) {
            if (!Number.isInteger(sourceIndex) || !allowedIndexes.has(sourceIndex as number) || proposed.has(sourceIndex as number)) {
              throw new Error('runtime memory migration route coverage is invalid')
            }
            proposed.set(sourceIndex as number, memoryBodyId)
          }
        }
        if (chunk.indexes.some(index => !proposed.has(index))) throw new Error('runtime memory migration omitted committed archive sources')
        for (const [index, memoryBodyId] of proposed) routed.set(index, memoryBodyId)
        if (typeof value.summary === 'string' && value.summary.trim() !== '') summaries.push(value.summary.trim())
      } catch (error) {
        signal.throwIfAborted()
        // Routing is advisory, including a returned proposal that fails Host
        // validation. Publish either the complete proposal or the whole chunk's
        // deterministic fallback; never retain a partially validated route.
        for (const index of chunk.indexes) routed.set(index, fallbackBody.id)
        summaries.push(`batch ${chunkIndex + 1} routed to ${fallbackBody.id} deterministically (routing failed: ${safeFailureDetail(error instanceof Error ? error.message : String(error))})`)
      }
    }
    summary = summaries.join(' ')
  }
  if (routed.size !== plan.entries.length) throw new Error('runtime memory migration omitted committed archive sources')
  const compactedEntries = plan.entries.map(({ content, importance, branches }): RuntimeMemoryCompactedEntry => ({ content, importance, ...(branches === undefined ? {} : { branches }) }))

  // Re-check the local source before any Provider side effect. A later race is
  // still caught by compactAndMutate; Provider receipts are verified because
  // an external data plane cannot share the local filesystem lock.
  const current = await runtimeMemory.read<RuntimeMemoryMaintenancePlan>('maintenance-plan', request, signal)
  if (current.revision !== plan.revision) throw new Error('runtime memory changed while archival was running; no archive writes were attempted')
  const destinations = await readDirectory()
  for (const memoryBodyId of new Set(routed.values())) {
    if (!destinations.items.some(body => body.id === memoryBodyId && eligible(body))) {
      throw new Error(`runtime archive Memory Space ${memoryBodyId} is no longer eligible; no archive writes were attempted`)
    }
  }
  signal.throwIfAborted()
  context.assertWritable?.()

  const sources = runtimeMigrationSources(plan.revision, plan.entries)
  const requests = sources.map(source => {
    const entry = plan.entries[source.index - 1]!
    return {
      content: entry.content,
      category: 'context' as const,
      importance: entry.importance === 'critical' ? 5 : entry.importance === 'low' ? 1 : 3,
      source: 'agent' as const,
      memoryBodyId: routed.get(source.index)!,
      ...(entry.branches === undefined || entry.branches.length === 0 ? {} : { tags: entry.branches.map(branch => `branch:${branch}`) }),
    }
  })
  const archiveResults = new Map<number, unknown>()
  const verified = new Map<number, MemoryMigrationLineage['destination']>()
  const created = new Map<string, { id: string; memoryBodyId: string }>()
  let commitAttempted = false
  try {
    // Keep Native exact imports batched per destination, while retaining earlier
    // destinations' receipts if a later Provider call fails.
    for (const memoryBodyId of new Set(routed.values())) {
      signal.throwIfAborted()
      context.assertWritable?.()
      if (archive.writeScope !== undefined && !(await readDirectory()).items.some(body => body.id === memoryBodyId && eligible(body))) {
        throw new Error(`runtime archive Memory Space ${memoryBodyId} is no longer authorized or eligible; pending write was not committed`)
      }
      const batch = sources.filter(source => routed.get(source.index) === memoryBodyId)
      const written = await memoryService.mutate<unknown[]>('remember-many', { requests: batch.map(source => requests[source.index - 1]!) }, signal)
      for (const [offset, result] of written.entries()) {
        const source = batch[offset]
        if (source === undefined) continue
        const receipt = optionalObject(result)
        const states = mutationStates(result)
        const id = typeof receipt?.id === 'string' && receipt.id.trim() !== '' ? receipt.id : undefined
        const isNew = mutationResultCommitted(result) && states.some(state => ['added', 'created', 'stored'].includes(state))
          && !states.some(state => ['updated', 'replaced', 'merged', 'skipped'].includes(state))
        if (isNew && id !== undefined && (receipt?.memoryBodyId === undefined || receipt.memoryBodyId === memoryBodyId)) {
          created.set(JSON.stringify([memoryBodyId, id]), { id, memoryBodyId })
        }
        archiveResults.set(source.index, result)
      }
      if (written.length !== batch.length) throw new Error('runtime archive batch did not return one receipt per source entry')
      for (const source of batch) {
        verified.set(source.index, await archiveRuntimeEntry(memoryService, memoryBodyId, plan.entries[source.index - 1]!, archiveResults.get(source.index), signal))
      }
    }
    const lineage: MemoryMigrationLineage[] = []
    const memoryBodyIds = new Set<string>()
    for (const source of sources) {
      const memoryBodyId = routed.get(source.index)!
      const destination = verified.get(source.index)!
      memoryBodyIds.add(memoryBodyId)
      lineage.push({
        source: { layerId: source.layerId, reference: source.reference, digest: source.digest },
        destination,
      })
    }
    signal.throwIfAborted()
    context.assertWritable?.()
    commitAttempted = true
    const mutation = await runtimeMemory.mutateResult<RuntimeMemoryMutationResult>('compact-and-mutate', { revision: plan.revision, mutation: request, compacted: compactedEntries, maxBytes: budget, lineage }, signal)
    if (provider === 'host') {
      counters.migrations += 1
      counters.lastRunId = runId
      counters.lastOperation = 'migration'
      counters.lastAt = new Date().toISOString()
    }
    return {
      ...mutation.value,
      revision: mutation.revision,
      maintenance: {
        kind: 'mnemon-archive',
        runId,
        provider,
        summary,
        memoryBodyIds: [...memoryBodyIds],
      },
    }
  } catch (error) {
    if (created.size > 0) {
      const cleanupSignal = AbortSignal.timeout(30_000)
      const failures: unknown[] = []
      if (commitAttempted) {
        try {
          const persisted = await context.inspectRuntime.read<RuntimeMemoryMaintenancePlan>('maintenance-plan', request, cleanupSignal)
          if (persisted.revision !== plan.revision) throw new Error('Runtime revision changed; preserve archive entries and inspect the completed operation')
        } catch (inspectionError) {
          throw new AggregateError([error, inspectionError], `runtime archive failed with uncertain local commit; preserve Memory Space entries: ${[...created.values()].map(item => `${item.memoryBodyId}/${item.id}`).join(', ')}`)
        }
      }
      for (const entry of [...created.values()].reverse()) {
        try {
          const removed = await archive.cleanup.mutate('forget', entry, cleanupSignal)
          if (!mutationResultCommitted(removed)) throw new Error('Provider did not confirm archive cleanup')
        } catch (cleanupError) {
          failures.push(new Error(`Memory Space ${entry.memoryBodyId}, archive entry ${entry.id}`, { cause: cleanupError }))
        }
      }
      if (failures.length > 0) throw new AggregateError([error, ...failures], `runtime archive failed and cleanup failed; ${failures.map(failure => (failure as Error).message).join('; ')}`)
    }
    throw error
  }
}

async function compactUserAndCommit(
  context: RuntimeWriteContext,
  request: RuntimeMemoryMutation,
  plan: RuntimeMemoryMaintenancePlan,
  signal: AbortSignal,
): Promise<CoordinatedRuntimeMemoryResult> {
  const runtimeMemory = context.runtime
  const budget = compactedBudget(plan)
  const prompt = `Run local USER.md compaction now.
Pending mutation (uncommitted; do not include in compaction):
${pendingMutationContext(plan)}

${runtimeSnapshotContext('user', plan.entries)}`
  const { provider, runId, result } = await context.model('compaction', 'Consolidate local user profile', prompt, USER_COMPACTION_SCHEMA, USER_COMPACTION_PERSONA)
  const value = object(result.structured)
  if (value.action !== 'compacted') throw new Error(typeof value.summary === 'string' && value.summary !== '' ? value.summary : 'USER.md compaction failed')
  const compactedEntries = Array.isArray(value.compactedEntries) ? value.compactedEntries.map((entry): RuntimeMemoryCompactedEntry & { sourceIndexes: number[] } => {
    const item = object(entry)
    if (typeof item.content !== 'string' || !['critical', 'normal', 'low'].includes(String(item.importance)) || !Array.isArray(item.sourceIndexes)) throw new Error('USER.md compaction returned an invalid entry')
    const sourceIndexes = item.sourceIndexes.filter((index): index is number => typeof index === 'number' && Number.isInteger(index))
    if (sourceIndexes.length !== item.sourceIndexes.length) throw new Error('USER.md compaction returned a non-integer source index')
    return { content: item.content, importance: item.importance as RuntimeMemoryCompactedEntry['importance'], sourceIndexes }
  }) : []
  const seen = new Set<number>()
  const importanceRank = { low: 0, normal: 1, critical: 2 } as const
  for (const entry of compactedEntries) {
    if (entry.sourceIndexes.length === 0) throw new Error('USER.md compaction returned an entry without a source')
    let requiredRank = 0
    for (const index of entry.sourceIndexes) {
      if (index < 1 || index > plan.entries.length || seen.has(index)) throw new Error('USER.md compaction source coverage is invalid')
      seen.add(index)
      requiredRank = Math.max(requiredRank, importanceRank[plan.entries[index - 1]!.importance])
    }
    if (importanceRank[entry.importance] < requiredRank) throw new Error('USER.md compaction lowered source importance')
  }
  if (seen.size !== plan.entries.length) throw new Error('USER.md compaction omitted committed entries')
  const candidates = compactedEntries.map(({ content, importance }) => ({ content, importance }))
  const candidateBytes = Buffer.byteLength(candidates.map(entry => entry.content.trim().replace(/\s+/gu, ' ')).join(RUNTIME_ENTRY_DELIMITER), 'utf8')
  if (candidateBytes > budget) throw new Error(`USER.md compaction did not fit the host budget (${candidateBytes} > ${budget} bytes)`)
  signal.throwIfAborted()
  context.assertWritable?.()
  const mutation = await runtimeMemory.mutateResult<RuntimeMemoryMutationResult>('compact-and-mutate', { revision: plan.revision, mutation: request, compacted: candidates, maxBytes: budget }, signal)
  return {
    ...mutation.value,
    revision: mutation.revision,
    maintenance: {
      kind: 'local-compaction',
      runId,
      provider,
      summary: typeof value.summary === 'string' ? value.summary : '',
      memoryBodyIds: [],
    },
  }
}

async function archiveRuntimeEntry(
  service: SourceSession,
  memoryBodyId: string,
  entry: { content: string; importance: 'critical' | 'normal' | 'low' },
  result: unknown,
  signal: AbortSignal,
): Promise<MemoryMigrationLineage['destination']> {
  const committed = destinationFromCommittedMutation(result, memoryBodyId, entry.content)
  if (committed !== undefined) return committed
  if (!mutationStates(result).includes('skipped')) {
    throw new Error(`runtime archive write did not commit synchronously for Memory Space ${memoryBodyId}`)
  }
  // A write skipped because the space already holds this exact text can name
  // that memory itself, as Mnemon Native does after matching its stored
  // contents byte for byte. A ranked search could miss it (#339).
  const named = skippedExactDestination(result, memoryBodyId, entry.content)
  if (named !== undefined) return named
  const recalled = await service.read<{ results: Insight[]; sources?: Array<{ status?: string; hint?: string }> }>('search', {
    query: entry.content.slice(0, 500),
    limit: 20,
    memoryBodyIds: [memoryBodyId],
  }, signal)
  const exact = recalled.results.find(candidate => candidate.memoryBodyId === memoryBodyId && candidate.content.trim() === entry.content)
  if (exact === undefined) {
    const unavailable = recalled.sources?.find(source => source.status === 'unavailable')
    throw new Error(`runtime archive skipped an entry without exact durable recall evidence in Memory Space ${memoryBodyId}: ${unavailable === undefined
      ? `its search returned ${recalled.results.length} results, none with that exact text`
      : `its search was unavailable (${safeFailureDetail(unavailable.hint ?? 'no detail')})`}`)
  }
  return {
    layerId: 'memory-spaces',
    reference: `memory-space:${encodeURIComponent(memoryBodyId)}/item:${encodeURIComponent(exact.id)}`,
    digest: sha256(exact.content),
  }
}
