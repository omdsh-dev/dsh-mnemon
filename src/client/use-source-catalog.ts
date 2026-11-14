import { useEffect, useMemo, useRef, useState } from 'react'
import type { JsonValue, MemorySourceManagementCatalog, MemorySourceManagementInstance, MemorySourceManagementResult } from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'
import type { MnemonSourceManagementClient } from './dsh-context.ts'
import { message } from './page-kit.tsx'
import type { MemorySourcePageEntry } from './source-pages.tsx'

interface CoalescedReadEntry {
  promise: Promise<MemorySourceManagementResult>
  waiters: number
}

function bindSourceManagementClient(client: MnemonClient, instance: MemorySourceManagementInstance, taskClient: MnemonClient, assertCurrent: () => void, readEpoch: () => number, changed: () => void): MnemonSourceManagementClient {
  const pending = new Map<string, CoalescedReadEntry>()
  const independent = async (run: () => Promise<MemorySourceManagementResult>): Promise<MemorySourceManagementResult> => {
    assertCurrent()
    pending.clear()
    try { return await run() } finally { pending.clear() }
  }
  const write = async (run: () => Promise<MemorySourceManagementResult>): Promise<MemorySourceManagementResult> => {
    const result = await independent(run)
    changed()
    return result
  }
  return {
    sourceInstanceKey: instance.sourceInstanceKey,
    revision: instance.revision,
    ...(instance.assistance === undefined || instance.assistance.length === 0 ? {} : { assistance: {
      operations: instance.assistance,
      execute: async (operation: string, input: JsonValue, options: { expectedRevision: string; confirmed: boolean }) => {
        assertCurrent()
        // These clean task-Agent workflows follow the inspected Sidebar root;
        // normal Source edits keep their existing session-aware write path.
        const task = ['agent-search', 'supervise', 'body-create', 'body-metadata-maintain'].includes(operation)
        return write(() => (task ? taskClient : client).assistSource(instance.sourceInstanceKey, operation, input, options.expectedRevision, options.confirmed))
      },
    } }),
    read: async (operation, input = null, options) => {
      assertCurrent()
      if (options?.coalesce !== true) return independent(() => client.readSourceManagement(instance.sourceInstanceKey, operation, input))
      const key = JSON.stringify([readEpoch(), operation, input])
      let entry = pending.get(key)
      if (entry === undefined) {
        const created: CoalescedReadEntry = {
          promise: client.readSourceManagement(instance.sourceInstanceKey, operation, input).finally(() => {
            if (pending.get(key) === created) pending.delete(key)
          }),
          waiters: 0,
        }
        entry = created
        pending.set(key, entry)
      }
      entry.waiters += 1
      const result = await entry.promise
      // Clone only when concurrent callers share one in-flight response object.
      return entry.waiters > 1 ? structuredClone(result) : result
    },
    mutate: (operation, input, options) => write(() => client.mutateSourceManagement(
      instance.sourceInstanceKey,
      operation,
      input,
      options.expectedRevision ?? instance.revision,
      options.confirmed,
    )),
    // The catalog a page offers as a per-run choice is the task Agent's own
    // directory, asked through the task-scoped client so a session's route is
    // reported from the conversation that will actually run the work.
    models: async () => { assertCurrent(); return taskClient.taskAgentModels(true) },
  }
}

/**
 * The Source instances that run in one view context, read again whenever `revision` moves: a management client
 * bound to each, the registered pages whose Source runs, and the Source types the descriptor-driven management
 * page shows, those without a page of their own or with configuration fields.
 *
 * `scopeContextKey` omits `sessionId` so switching conversations within the same storage scope and workspace
 * retains the catalog in place without unmounting active Source pages while `viewContextKey` still fences stale
 * session-bound writes.
 */
export function useSourceCatalog(
  client: MnemonClient,
  taskClient: MnemonClient,
  revision: number,
  viewContextKey: string,
  sourcePageEntries: readonly MemorySourcePageEntry[],
  active = true,
  onSourceChanged?: (sourceTypeId: string) => void,
  scopeContextKey: string = viewContextKey,
): {
  sourceCatalogState: { contextKey: string; value: MemorySourceManagementCatalog | null; error: string | null }
  sourceCatalog: MemorySourceManagementCatalog | null
  sourceInstances: MemorySourceManagementInstance[]
  sourceManagementClients: Map<string, MnemonSourceManagementClient>
  visibleSourcePages: MemorySourcePageEntry[]
  managedSourceTypes: [string, MemorySourceManagementInstance[]][]
} {
  const [sourceCatalogState, setSourceCatalogState] = useState<{ contextKey: string; value: MemorySourceManagementCatalog | null; error: string | null }>(() => ({ contextKey: scopeContextKey, value: null, error: null }))

  const current = useRef<{ client: MnemonClient; viewContextKey: string; active: boolean; revision: number; epoch: number }>()
  const previousRead = current.current
  const changed = previousRead?.client !== client || previousRead.viewContextKey !== viewContextKey || previousRead.active !== active || previousRead.revision !== revision
  current.current = { client, viewContextKey, active, revision, epoch: (previousRead?.epoch ?? 0) + Number(changed) }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    if (!active) return
    let pending = true
    void client.sourceManagementCatalog().then(value => {
      if (pending) setSourceCatalogState({ contextKey: scopeContextKey, value, error: null })
    }).catch(reason => {
      if (pending) setSourceCatalogState({ contextKey: scopeContextKey, value: null, error: message(reason) })
    })
    return () => { pending = false }
  }, [active, client, revision, scopeContextKey, viewContextKey])

  const sourceCatalog = sourceCatalogState.contextKey === scopeContextKey ? sourceCatalogState.value : null
  const sourceInstances = sourceCatalog?.sources ?? []
  const bindings = useRef<{ client: MnemonClient; taskClient: MnemonClient; context: string; generation?: string; values: Map<string, { signature: string; management: MnemonSourceManagementClient }> }>()
  const sourceManagementClients = useMemo(() => {
    const previous = bindings.current
    const reusable = previous?.client === client && previous.taskClient === taskClient && previous.context === viewContextKey && previous.generation === sourceCatalog?.generationId
    const values = new Map<string, { signature: string; management: MnemonSourceManagementClient }>()
    for (const source of sourceInstances) {
      // Re-reading an unchanged catalog must not restart every Source page. Include
      // the whole descriptor so revisions, authority hints and extension changes count.
      const signature = JSON.stringify(source)
      const prior = reusable ? previous.values.get(source.sourceInstanceKey) : undefined
      values.set(source.sourceInstanceKey, prior?.signature === signature ? prior : { signature, management: bindSourceManagementClient(client, source, taskClient, () => {
        if (!mounted.current || current.current?.client !== client || current.current.viewContextKey !== viewContextKey) throw new Error('Source page is unmounted or its view context changed')
      }, () => current.current!.epoch, () => onSourceChanged?.(source.sourceTypeId)) })
    }
    bindings.current = { client, taskClient, context: viewContextKey, ...(sourceCatalog === null ? {} : { generation: sourceCatalog.generationId }), values }
    return new Map([...values].map(([key, value]) => [key, value.management]))
  }, [client, onSourceChanged, sourceCatalog, sourceInstances, taskClient, viewContextKey])
  const visibleSourcePages = useMemo(() => {
    const visibleTypes = new Set(sourceInstances.map(source => source.sourceTypeId))
    return sourcePageEntries.filter(entry => visibleTypes.has(entry.sourceTypeId))
  }, [sourceInstances, sourcePageEntries])
  const managedSourceTypes = useMemo(() => {
    const byType = new Map<string, MemorySourceManagementInstance[]>()
    for (const source of sourceInstances) {
      if (sourcePageEntries.some(entry => entry.sourceTypeId === source.sourceTypeId) && (source.management.fields?.length ?? 0) === 0) continue
      const current = byType.get(source.sourceTypeId)
      if (current === undefined) byType.set(source.sourceTypeId, [source])
      else current.push(source)
    }
    return [...byType.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [sourceInstances, sourcePageEntries])
  return { sourceCatalogState, sourceCatalog, sourceInstances, sourceManagementClients, visibleSourcePages, managedSourceTypes }
}
