import { randomUUID } from 'node:crypto'
import type { MemoryEvidenceItem, MemoryJsonValue, MemoryOperationScope, MemorySourceDefinition, MemorySourceRouteManifest } from '../../core/contracts/index.ts'
import { memoryInputRecord, memoryInputText, truncateMemoryText } from '../index.ts'
import { digest, json } from './records.ts'

export interface LookupResult { items: MemoryEvidenceItem[]; truncated?: boolean; summary?: string }
export interface LookupOptions {
  routes: MemorySourceRouteManifest[]
  namespace(scope: MemoryOperationScope, signal?: AbortSignal): Promise<MemoryJsonValue>
  run(operation: string, input: { [key: string]: MemoryJsonValue }, namespace: MemoryJsonValue, scope: MemoryOperationScope, signal: AbortSignal): Promise<LookupResult>
}

/** Add Source-owned, namespace-pinned live reads to a record Source. Never grants writes. */
export function withLookupRoutes(base: MemorySourceDefinition, options: LookupOptions): MemorySourceDefinition {
  return {
    manifest: { ...base.manifest, consistency: 'namespace-pinned-live-read', routes: [...options.routes, ...base.manifest.routes ?? []] },
    create(context) {
      const runtime = base.create(context)
      const requests = new Map<string, AbortController>()
      const keyFor = (scope: MemoryOperationScope, id: string) => digest([scope, id])
      async function run(operation: string, raw: MemoryJsonValue, namespace: MemoryJsonValue, scope: MemoryOperationScope, signal?: AbortSignal): Promise<LookupResult> {
        const input = memoryInputRecord(raw, 'lookup')
        const requestId = memoryInputText(input.requestId, 'requestId', 100, false) ?? randomUUID()
        const key = keyFor(scope, requestId)
        if (requests.has(key)) throw new Error('A lookup with this request id is already running')
        if (requests.size >= 8) throw new Error('This Source already has eight active lookups')
        const controller = new AbortController()
        requests.set(key, controller)
        const timer = setTimeout(() => controller.abort(new Error('Lookup timed out after 15 seconds')), 15_000)
        const abort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        try { return await options.run(operation, input, namespace, scope, controller.signal) }
        finally { clearTimeout(timer); requests.delete(key); signal?.removeEventListener('abort', abort) }
      }
      return { ...runtime,
        async facts(request, signal) { const facts = await runtime.facts(request, signal); return { ...facts, routeIds: [...options.routes.map(route => route.id), ...facts.routeIds] } },
        async project(request, signal) {
          const result = await runtime.project(request, signal)
          if (!result.readGrant) throw new Error('Lookup composition needs a Source read grant')
          return { ...result, readGrant: { ...result.readGrant, consistency: 'namespace-pinned-live-read' as const,
            value: { ...memoryInputRecord(result.readGrant.value, 'record grant'), namespace: await options.namespace(request.scope, signal) } } }
        },
        async query(request) {
          if (!options.routes.some(route => route.id === request.route.sourceRouteId)) return runtime.query!(request)
          const namespace = memoryInputRecord(request.grant.value, 'lookup grant').namespace!
          const result = await run(request.route.sourceRouteId, request.input, namespace, request.view.scope, request.signal)
          let remaining = request.route.maxCharacters ?? 12_000
          const items = result.items.slice(0, request.route.maxResults ?? 20).flatMap(item => {
            if (remaining < 1) return []
            const text = truncateMemoryText(item.text, remaining); remaining -= text.length
            return [{ ...item, text, reference: item.reference ?? { id: item.id, ...(item.revision === undefined ? {} : { revision: item.revision }) } }]
          })
          return { id: randomUUID(), viewId: request.view.id, routeId: request.route.id, sourceInstanceKey: context.sourceInstanceKey, observedAt: new Date().toISOString(), items,
            truncated: result.truncated === true || items.length < result.items.length || remaining < 1 }
        },
        async manage(request) {
          if (request.mode !== 'read' || !request.operation.startsWith('lookup-')) return runtime.manage!(request)
          const operation = request.operation.slice(7)
          const input = memoryInputRecord(request.input ?? {}, 'lookup management')
          if (operation === 'cancel') {
            const id = memoryInputText(input.requestId, 'requestId', 100)!
            requests.get(keyFor(request.scope, id))?.abort(new Error('Lookup cancelled'))
            return { revision: request.expectedRevision ?? 'lookup', value: { cancelled: true } }
          }
          if (!options.routes.some(route => route.id === operation)) throw new Error('Unsupported lookup operation')
          const namespace = await options.namespace(request.scope, request.signal)
          const result = await run(operation, input, namespace, request.scope, request.signal)
          return { revision: (await runtime.facts({ scope: request.scope, scenario: 'management', budget: { maxProjectionCharacters: 0, maxActions: 0, maxRoutes: 0, maxEvidenceResults: 0, maxEvidenceCharacters: 0 } }, request.signal)).revision, value: json(result) }
        },
        async dispose() { for (const controller of requests.values()) controller.abort(new Error('Source unloaded')); requests.clear(); await runtime.dispose?.() },
      }
    },
  }
}
