import { useEffect, useMemo, useRef, useState } from 'react'
import type { JsonValue, MemorySourceManagementCatalog, MemorySourceManagementInstance } from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'
import type { MnemonSourceManagementClient } from './dsh-context.ts'
import { message } from './page-kit.tsx'
import type { MemorySourcePageEntry } from './source-pages.tsx'

function bindSourceManagementClient(client: MnemonClient, instance: MemorySourceManagementInstance, taskClient: MnemonClient, assertCurrent: () => void): MnemonSourceManagementClient {
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
        return (task ? taskClient : client).assistSource(instance.sourceInstanceKey, operation, input, options.expectedRevision, options.confirmed)
      },
    } }),
    read: async (operation, input = null) => { assertCurrent(); return client.readSourceManagement(instance.sourceInstanceKey, operation, input) },
    mutate: async (operation, input, options) => { assertCurrent(); return client.mutateSourceManagement(
      instance.sourceInstanceKey,
      operation,
      input,
      options.expectedRevision ?? instance.revision,
      options.confirmed,
    ) },
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
 */
export function useSourceCatalog(client: MnemonClient, taskClient: MnemonClient, revision: number, viewContextKey: string, sourcePageEntries: readonly MemorySourcePageEntry[], active = true): {
  sourceCatalogState: { contextKey: string; value: MemorySourceManagementCatalog | null; error: string | null }
  sourceCatalog: MemorySourceManagementCatalog | null
  sourceInstances: MemorySourceManagementInstance[]
  sourceManagementClients: Map<string, MnemonSourceManagementClient>
  visibleSourcePages: MemorySourcePageEntry[]
  managedSourceTypes: [string, MemorySourceManagementInstance[]][]
} {
  const [sourceCatalogState, setSourceCatalogState] = useState<{ contextKey: string; value: MemorySourceManagementCatalog | null; error: string | null }>(() => ({ contextKey: viewContextKey, value: null, error: null }))

  const current = useRef<{ client: MnemonClient; viewContextKey: string; active: boolean }>()
  current.current = { client, viewContextKey, active }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    if (!active) return
    let pending = true
    void client.sourceManagementCatalog().then(value => {
      if (pending) setSourceCatalogState({ contextKey: viewContextKey, value, error: null })
    }).catch(reason => {
      if (pending) setSourceCatalogState({ contextKey: viewContextKey, value: null, error: message(reason) })
    })
    return () => { pending = false }
  }, [active, client, revision, viewContextKey])

  const sourceCatalog = sourceCatalogState.contextKey === viewContextKey ? sourceCatalogState.value : null
  const sourceInstances = sourceCatalog?.sources ?? []
  const sourceManagementClients = useMemo(() => new Map(sourceInstances
    .map(source => [source.sourceInstanceKey, bindSourceManagementClient(client, source, taskClient, () => {
      if (!mounted.current || current.current?.client !== client || current.current.viewContextKey !== viewContextKey) throw new Error('Source page is unmounted or its view context changed')
    })])), [client, sourceInstances, taskClient, viewContextKey])
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
