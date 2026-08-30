import { randomUUID } from 'node:crypto'
import type { MemoryJsonValue, MemoryReadGrant, MemorySourceDefinition, MemorySourceRuntimeContext } from 'dsh-mnemon/contracts'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemorySource, createMemoryMutationReceipt as receipt, memoryInputRecord as record, memoryInputStringArray as stringArray, memoryInputText as text, truncateMemoryText as truncate } from 'dsh-mnemon/extension-sdk'
import { DocumentManager } from './controller.ts'
import type { DocumentMutation } from './contracts.ts'
import { documentsSourceConfig, type Config } from './config.ts'

function workspace(scope: { workspaceId?: string }): string | undefined {
  const value = scope.workspaceId?.trim()
  return value === undefined || value === '' ? undefined : value
}

function grantIds(grant: MemoryReadGrant): string[] {
  const value = record(grant.value, 'Documents ReadGrant')
  return stringArray(value.documentIds, 'documentIds', 10_000) ?? []
}

function documentMutation(value: MemoryJsonValue, allowedIds?: readonly string[]): DocumentMutation {
  const input = record(value, 'Documents mutation')
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
    if (allowedIds !== undefined && !allowedIds.includes(id)) throw new Error('Documents update target is outside this View ReadGrant')
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
  return mutation
}

export function createDocumentsMemorySource(config: Config = {}, managerFactory?: (context: MemorySourceRuntimeContext) => DocumentManager): MemorySourceDefinition {
 const configured = Object.freeze({ ...config })
 return defineMemorySource({
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
    const effective = documentsSourceConfig({ ...context.configuration, ...configured }, context.sourceInstanceKey)
    const documents = managerFactory?.(context) ?? new DocumentManager(effective.limitBytes, undefined, () => effective.dataDir)
    const snapshot = (workspaceId: string | undefined) => workspaceId === undefined ? undefined : documents.forWorkspace(workspaceId).snapshot()
    const prepared = new Map<string, NonNullable<ReturnType<typeof snapshot>>>()
    return {
      facts(request) {
        const root = workspace(request.scope)
        if (root === undefined) return {
          sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'documents', role: 'narrative', availability: 'unavailable',
          revision: 'unavailable:no-workspace', capabilities: ['status'], routeIds: [], actionIds: [], hints: { reason: 'no-workspace' },
        }
        try {
          const current = snapshot(root)!
          prepared.set(root, current)
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
        const current = prepared.get(root) ?? snapshot(root)!
        prepared.delete(root)
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
            provenance: { sourceTypeId: 'documents' },
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
      async manage(request) {
        const root = workspace(request.scope)
        if (root === undefined) throw new Error('Documents management requires a workspace')
        const controller = documents.forWorkspace(root)
        const input = request.input === null ? {} : record(request.input, 'Documents management')
        let value: unknown
        if (request.mode === 'read') {
          switch (request.operation) {
            case 'snapshot': value = controller.snapshot(); break
            case 'document': value = controller.get(text(input.id, 'id', 300)!); break
            case 'search': value = await controller.search(text(input.query, 'query', 2_000)!, {
              includeArchived: input.includeArchived === true,
              ...(input.limit === undefined ? {} : { limit: Math.min(100, Math.max(1, Number(input.limit) || 50)) }),
            }); break
            default: throw new Error('unsupported Documents management read operation: ' + request.operation)
          }
        } else {
          if (!request.confirmed) throw new Error('Documents management mutation requires explicit confirmation')
          if (request.operation === 'mutate') value = await controller.mutate(documentMutation(request.input))
          else if (request.operation === 'archive') {
            const document = controller.get(text(input.id, 'id', 300)!)
            // A Source-local archive does not claim a cross-Source distillation.
            value = await controller.archive(document.id, document.revision, { summary: 'Archived locally by the user.', memoryBodyIds: [] })
          } else throw new Error('unsupported Documents management mutation operation: ' + request.operation)
        }
        return { revision: controller.snapshot().revision, value: value as MemoryJsonValue }
      },
      async mutate(request) {
        const root = workspace(request.view.scope)
        if (root === undefined) throw new Error('Documents Action requires a workspace-scoped View')
        const grant = request.view.readGrants.find(candidate => candidate.sourceInstanceKey === context.sourceInstanceKey)
        const mutation = documentMutation(request.input, grant === undefined ? [] : grantIds(grant))
        const result = await documents.forWorkspace(root).mutate(mutation)
        return receipt(request.view.id, request.offer.id, context.sourceInstanceKey, result.snapshot.revision, {
          action: result.action, documentId: result.document.id, documentRevision: result.document.revision,
        } as MemoryJsonValue)
      },
    }
  },
 })
}

export const DOCUMENTS_MEMORY_SOURCE = createDocumentsMemorySource()
