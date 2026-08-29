import { randomUUID } from 'node:crypto'
import type { MemoryJsonValue, MemoryReadGrant } from '../../packages/contracts/src/index.ts'
import { COMPOSABLE_MEMORY_API_VERSION } from '../../packages/contracts/src/index.ts'
import { defineMemorySource } from '../../packages/kernel/src/index.ts'
import type { DocumentManager } from '../documents.ts'
import type { DocumentMutation } from '../shared/contracts.ts'
import { BUILTIN_MEMORY_BINDINGS } from './bindings.ts'
import { receipt, record, stringArray, text, truncate } from './shared.ts'

function workspace(scope: { workspaceId?: string }): string | undefined {
  const value = scope.workspaceId?.trim()
  return value === undefined || value === '' ? undefined : value
}

function grantIds(grant: MemoryReadGrant): string[] {
  const value = record(grant.value, 'Documents ReadGrant')
  return stringArray(value.documentIds, 'documentIds', 10_000) ?? []
}

export const DOCUMENTS_MEMORY_SOURCE = defineMemorySource({
  manifest: {
    apiVersion: COMPOSABLE_MEMORY_API_VERSION,
    kind: 'source',
    typeId: 'documents',
    packageName: 'dsh-mnemon-source-documents',
    role: 'narrative',
    capabilities: ['status', 'project', 'search', 'read', 'write'],
    consistency: 'namespace-pinned-live-read',
    routes: [{
      id: 'search',
      description: 'Search only the project Documents pinned into this View.',
      capability: 'search',
      inputSchema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      },
      maxCalls: 4,
      maxResults: 20,
      maxCharacters: 16_000,
    }],
    actions: [{
      id: 'manage',
      description: 'Create a project Document or update a Document pinned into this View.',
      capability: 'write',
      inputSchema: {
        type: 'object',
        required: ['action'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['create', 'update'] },
          id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, content: { type: 'string' },
          sourcePaths: { type: 'array' }, sessionIds: { type: 'array' },
        },
      },
    }],
    management: {
      label: 'Project Documents',
      description: 'Workspace-scoped narrative memory with namespace-pinned reads.',
    },
  },
  create(context) {
    const documents = context.binding<DocumentManager>(BUILTIN_MEMORY_BINDINGS.documents)
    if (documents === undefined) throw new Error('Documents Source requires its Host manager binding')
    const snapshot = (workspaceId: string | undefined) => workspaceId === undefined ? undefined : documents.forWorkspace(workspaceId).snapshot()
    return {
      facts(request) {
        const root = workspace(request.scope)
        if (root === undefined) return {
          sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'documents', role: 'narrative', availability: 'unavailable',
          revision: 'unavailable:no-workspace', capabilities: ['status'], routeIds: [], actionIds: [], hints: { reason: 'no-workspace' },
        }
        try {
          const current = snapshot(root)!
          const active = current.documents.filter(document => document.status === 'active' && document.healthy)
          return {
            sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'documents', role: 'narrative', availability: 'ready',
            revision: current.revision, capabilities: ['status', 'project', 'search', 'read', 'write'], routeIds: ['search'], actionIds: ['manage'],
            hints: { activeCount: active.length },
          }
        } catch (error) {
          return {
            sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'documents', role: 'narrative', availability: 'unavailable',
            revision: 'unavailable:documents', capabilities: ['status'], routeIds: [], actionIds: [],
            hints: { reason: error instanceof Error ? error.message : String(error) },
          }
        }
      },
      project(request) {
        const root = workspace(request.scope)
        if (root === undefined) return { fragments: [] }
        const current = snapshot(root)!
        const active = current.documents.filter(document => document.status === 'active' && document.healthy).sort((a, b) => a.id.localeCompare(b.id))
        const readGrant: MemoryReadGrant = {
          id: `${context.sourceInstanceKey}/grant/${current.revision}`,
          sourceInstanceKey: context.sourceInstanceKey,
          schema: 'dsh-mnemon.documents/v1',
          value: { workspaceRoot: root, documentIds: active.map(document => document.id) },
          revision: current.revision,
          consistency: 'namespace-pinned-live-read',
        }
        return {
          fragments: request.includeProjection ? [{
            id: `${context.sourceInstanceKey}/projection`, sourceInstanceKey: context.sourceInstanceKey, mode: request.mode,
            text: truncate(`${active.length} active project Document${active.length === 1 ? '' : 's'} available through the documents/search route.`, request.maxCharacters),
            revision: current.revision,
          }] : [],
          readGrant,
        }
      },
      async query(request) {
        const root = workspace(request.view.scope)
        if (root === undefined) throw new Error('Documents Route requires a workspace-scoped View')
        const input = record(request.input, 'Documents search')
        const query = text(input.query, 'query', 2_000)!
        const limitValue = input.limit
        const limit = typeof limitValue === 'number' && Number.isInteger(limitValue) ? Math.max(1, Math.min(20, limitValue)) : 10
        const result = await documents.forWorkspace(root).search(query, { limit, allowedIds: grantIds(request.grant) })
        return {
          id: `evidence:${randomUUID()}`, viewId: request.view.id, routeId: request.route.id, sourceInstanceKey: context.sourceInstanceKey,
          observedAt: new Date().toISOString(), truncated: result.total >= limit,
          items: result.results.map(document => ({
            id: document.id,
            text: `${document.title}\n${document.description === '' ? '' : `${document.description}\n`}${document.excerpt}`,
            score: document.score,
            revision: String(document.revision),
            provenance: { documentId: document.id, workspaceRoot: root, relativePath: document.relativePath },
          })),
        }
      },
      async mutate(request) {
        const root = workspace(request.view.scope)
        if (root === undefined) throw new Error('Documents Action requires a workspace-scoped View')
        const input = record(request.input, 'Documents mutation')
        const action = text(input.action, 'action', 20)!
        let mutation: DocumentMutation
        if (action === 'create') {
          mutation = {
            action,
            title: text(input.title, 'title', 160)!,
            content: text(input.content, 'content', 1_000_000)!,
            ...(text(input.description, 'description', 600, false) === undefined ? {} : { description: text(input.description, 'description', 600, false)! }),
            ...(input.sourcePaths === undefined ? {} : { sourcePaths: stringArray(input.sourcePaths, 'sourcePaths') ?? [] }),
            ...(input.sessionIds === undefined ? {} : { sessionIds: stringArray(input.sessionIds, 'sessionIds', 20) ?? [] }),
          }
        } else if (action === 'update') {
          const id = text(input.id, 'id', 300)!
          const grant = request.view.readGrants.find(candidate => candidate.sourceInstanceKey === context.sourceInstanceKey)
          if (grant === undefined || !grantIds(grant).includes(id)) throw new Error('Documents update target is outside this View ReadGrant')
          mutation = {
            action,
            id,
            ...(text(input.title, 'title', 160, false) === undefined ? {} : { title: text(input.title, 'title', 160, false)! }),
            ...(text(input.description, 'description', 600, false) === undefined ? {} : { description: text(input.description, 'description', 600, false)! }),
            ...(text(input.content, 'content', 1_000_000, false) === undefined ? {} : { content: text(input.content, 'content', 1_000_000, false)! }),
            ...(input.sourcePaths === undefined ? {} : { sourcePaths: stringArray(input.sourcePaths, 'sourcePaths') ?? [] }),
            ...(input.sessionIds === undefined ? {} : { sessionIds: stringArray(input.sessionIds, 'sessionIds', 20) ?? [] }),
          }
        } else {
          throw new Error(`unsupported Documents action: ${action}`)
        }
        const result = await documents.forWorkspace(root).mutate(mutation)
        return receipt(request.view.id, request.offer.id, context.sourceInstanceKey, result.snapshot.revision, {
          action: result.action, documentId: result.document.id, documentRevision: result.document.revision,
        } as MemoryJsonValue)
      },
    }
  },
})
