import * as projectionSDK from 'dsh-mnemon/extension-sdk'
import type { MemoryEvidenceItem, MemoryJsonValue, MemorySourceDefinition } from 'dsh-mnemon/contracts'
import { createHash, randomUUID } from 'node:crypto'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemorySource, createMemoryMutationReceipt as receipt, memoryInputRecord as record, memoryInputStringArray as stringArray, memoryInputText as text, truncateMemoryText as truncate } from 'dsh-mnemon/extension-sdk'
import { resolveGitBranch } from './git-branch.ts'
import { normalizeRuntimeBranches, RuntimeMemoryController } from './controller.ts'
import type { RuntimeMemoryAction, RuntimeMemoryCompactedEntry, RuntimeMemoryEntry, RuntimeMemoryImportance, RuntimeMemoryMutation, RuntimeMemoryTarget } from './contracts.ts'
import { runtimeSourceConfig, type Config } from './config.ts'

const ACTIONS = new Set<RuntimeMemoryAction>(['add', 'replace', 'remove'])
const TARGETS = new Set<RuntimeMemoryTarget>(['memory', 'user'])
const IMPORTANCE = new Set<RuntimeMemoryImportance>(['critical', 'normal', 'low'])

function runtimeMutation(value: MemoryJsonValue, management = false): RuntimeMemoryMutation {
  const input = record(value, 'Runtime Memory mutation')
  const action = text(input.action, 'action', 20) as RuntimeMemoryAction
  const target = text(input.target, 'target', 20) as RuntimeMemoryTarget
  if (!ACTIONS.has(action)) throw new Error(`unsupported Runtime Memory action: ${action}`)
  if (!TARGETS.has(target)) throw new Error(`unsupported Runtime Memory target: ${target}`)
  const importance = text(input.importance, 'importance', 20, false) as RuntimeMemoryImportance | undefined
  if (importance !== undefined && !IMPORTANCE.has(importance)) throw new Error(`unsupported Runtime Memory importance: ${importance}`)
  const content = text(input.content, 'content', 100_000, false)
  const oldText = text(input.oldText ?? input.old_text, 'oldText', 100_000, false)
  return {
    action,
    target,
    ...(content === undefined ? {} : { content }),
    ...(oldText === undefined ? {} : { oldText }),
    ...(importance === undefined ? {} : { importance }),
    ...(management && input.matchBranches !== undefined ? { matchBranches: normalizeRuntimeBranches(input.matchBranches, 'matchBranches') } : {}),
    ...(input.branches === undefined ? {} : { branches: stringArray(input.branches, 'branches', 100) ?? [] }),
  }
}

export function createRuntimeMemorySource(config: Config = {}): MemorySourceDefinition {
 const configured = Object.freeze({ ...config })
 return defineMemorySource({
  manifest: {
    apiVersion: COMPOSABLE_MEMORY_API_VERSION,
    kind: 'source',
    typeId: 'runtime',
    packageName: 'dsh-mnemon-source-runtime',
    role: 'working-context',
    capabilities: ['status', 'project', 'search', 'write'],
    consistency: 'exact-snapshot',
    routes: [{
      id: 'search',
      description: 'Read Runtime entries from this View, including deferred low-priority details and their metadata. Match literal query text, optionally filter target; use an empty query and offset to browse. Other branches and Sources are excluded.',
      capability: 'search',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string' }, target: { type: 'string', enum: ['user', 'memory'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0 },
        },
      },
      maxCalls: 4, maxResults: 50, maxCharacters: 16_000,
    }],
    actions: [{
      id: 'mutate',
      description: 'Add, replace, or remove an entry in Runtime Memory.',
      capability: 'write',
      inputSchema: {
        type: 'object',
        required: ['action', 'target'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'add (requires content), replace (requires oldText and content), or remove (requires oldText).' },
          target: { type: 'string', enum: ['memory', 'user'] },
          content: { type: 'string', description: 'Required for action=add and action=replace. Compact non-empty entry text to store.' },
          oldText: { type: 'string', description: 'Required for action=replace and action=remove. Full content of the existing entry, or a unique substring, excluding the generated metadata line. A unique full-content match takes precedence within the selected target.' },
          importance: { type: 'string', enum: ['critical', 'normal', 'low'] },
          branches: { type: 'array' },
        },
      },
    }],
    management: {
      label: 'Runtime Memory',
      description: 'Exact, bounded working context and user profile projection.',
    },
  },
  create(context) {
    const effective = runtimeSourceConfig({ ...context.configuration, ...configured }, context.sourceInstanceKey)
    const controller = new RuntimeMemoryController(
      { effectiveDataDir: () => effective.dataDir }, undefined,
      { memory: effective.memoryLimitBytes, user: effective.userLimitBytes },
      { effectiveDataDir: () => effective.userDataDir },
    )
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const searchable = effective.deferLowPriority || effective.bm25Recall
    const entryDigest = (entry: RuntimeMemoryEntry) => digest([entry.target, entry.content, entry.importance, entry.branches ?? [], ...(entry.pinned === true ? [true] : [])])
    const projection = (workspaceId?: string) => {
      const branch = resolveGitBranch(workspaceId)
      const current = controller.contextProjection(branch, effective.deferLowPriority, effective.bm25Recall)
      return { ...current, snapshot: {
        version: 1,
        scope: digest([effective.dataDir, effective.userDataDir, branch ?? null, ...(effective.deferLowPriority ? [true] : [])]),
        branchVisibility: current.branchVisibility,
        entries: current.entries.map(entryDigest).sort(),
      } }
    }
    const prepared = new WeakMap<object, ReturnType<typeof projection>>()
    return {
      facts(request) {
        if (request.scenario.startsWith('management.')) return {
          sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'runtime', role: 'working-context', availability: 'ready',
          revision: controller.snapshot().revision, capabilities: ['status', 'project', 'write'], routeIds: [], actionIds: ['mutate'],
        }
        const current = projection(request.scope.workspaceId)
        prepared.set(request.scope, current)
        return {
          sourceInstanceKey: context.sourceInstanceKey,
          sourceTypeId: 'runtime',
          role: 'working-context',
          availability: 'ready',
          revision: current.revision,
          ...(current.minimumCharacters === 0 ? {} : { hints: { minimumProjectionCharacters: current.minimumCharacters } }),
          capabilities: searchable ? ['status', 'project', 'search', 'write'] : ['status', 'project', 'write'],
          routeIds: searchable ? ['search'] : [],
          actionIds: ['mutate'],
        }
      },
      project(request) {
        if (!request.includeProjection && !searchable) return { fragments: [] }
        const current = prepared.get(request.scope) ?? projection(request.scope.workspaceId)
        prepared.delete(request.scope)
        if (current.revision !== request.expectedRevision) throw new Error('Runtime projection revision changed during composition')
        if (request.includeProjection && current.minimumCharacters > request.maxCharacters) throw new Error(`Pinned Runtime entries need ${current.minimumCharacters} projection characters, but the View grants ${request.maxCharacters}. Unpin entries or increase the View budget; pinned entries were not truncated.`)
        return {
          ...(searchable ? { readGrant: {
            id: `${context.sourceInstanceKey}/grant/${current.revision}`,
            sourceInstanceKey: context.sourceInstanceKey, schema: 'dsh-mnemon.runtime/v1',
            revision: current.revision, consistency: 'exact-snapshot' as const,
            value: {
              entries: [...current.entries, ...current.deferredEntries],
              ...(request.includeProjection && current.bm25 !== undefined ? { bm25: {
                scope: digest([current.snapshot.scope, current.branchVisibility, 'bm25']),
                text: truncate(current.bm25.text, request.maxCharacters),
                entries: current.entries.filter(entry => entry.target === 'user' || entry.pinned === true).map(entryDigest).sort(),
                complete: current.bm25.text.length <= request.maxCharacters,
              } } : {}),
            } as unknown as MemoryJsonValue,
          } } : {}),
          fragments: request.includeProjection ? [{
            id: `${context.sourceInstanceKey}/projection`,
            sourceInstanceKey: context.sourceInstanceKey,
            mode: request.mode,
            text: truncate(current.text, request.maxCharacters),
            revision: current.revision,
            provenance: { sourceTypeId: 'runtime', ...(current.text.length <= request.maxCharacters ? { snapshot: current.snapshot } : {}) },
          }] : [],
          presentation: {
            visibleItems: current.entries.length,
            totalItems: current.totalEntries,
            items: current.entries.slice(0, 24).map((entry, index) => ({
              id: `${entry.target}:${entry.created_at}:${index}`,
              title: truncate(entry.content, 160),
            })),
          },
        }
      },
      query(request) {
        if (!searchable || request.grant.schema !== 'dsh-mnemon.runtime/v1') throw new Error('Runtime search requires a scoped ReadGrant')
        request.signal?.throwIfAborted()
        const input = record(request.input, 'Runtime search')
        const query = (text(input.query, 'query', 2_000, false) ?? '').trim().toLowerCase()
        const target = text(input.target, 'target', 20, false)
        const grant = record(request.grant.value, 'Runtime ReadGrant')
        const entries = grant.entries as unknown as RuntimeMemoryEntry[]
        const matches = entries.filter(entry => (target === undefined || entry.target === target) && entry.content.toLowerCase().includes(query))
        const offset = typeof input.offset === 'number' ? Math.max(0, Math.floor(input.offset)) : 0
        const limit = Math.min(request.route.maxResults ?? 50, typeof input.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(input.limit))) : 10)
        let remaining = request.route.maxCharacters ?? 16_000
        let shortened = false
        const items: MemoryEvidenceItem[] = []
        for (const entry of matches.slice(offset, offset + limit)) {
          if (remaining <= 0) break
          const content = truncate(entry.content, remaining)
          remaining -= content.length
          shortened ||= content !== entry.content
          const { content: _content, ...metadata } = entry
          items.push({ id: digest([entry.target, entry.content, entry.branches ?? []]), text: content,
            revision: request.grant.revision, provenance: metadata as unknown as MemoryJsonValue })
        }
        const nextOffset = offset + items.length
        return {
          id: `evidence:${randomUUID()}`, viewId: request.view.id, routeId: request.route.id, sourceInstanceKey: context.sourceInstanceKey,
          observedAt: new Date().toISOString(), items, truncated: shortened || nextOffset < matches.length,
          metadata: { total: matches.length, offset, ...(nextOffset < matches.length ? { nextOffset } : {}) },
        }
      },
      async manage(request) {
        const input = request.input === null ? {} : record(request.input, 'Runtime Memory management')
        if (request.mode === 'read') {
          if (request.operation === 'snapshot') {
            const snapshot = controller.snapshot()
            return { revision: snapshot.revision, value: snapshot as unknown as MemoryJsonValue }
          }
          if (request.operation === 'maintenance-plan') {
            if (typeof projectionSDK.reserveMemoryProjection !== 'function' && controller.snapshot().entries.some(entry => entry.pinned === true)) {
              throw new Error('Pinned Runtime maintenance requires a newer dsh-mnemon Host; update the Host before retrying.')
            }
            const planned = await controller.planMaintenanceCommitted(runtimeMutation(request.input, true), { preserveImportance: input.preserveImportance === true })
            return { revision: planned.revision, value: planned.plan as unknown as MemoryJsonValue }
          }
          throw new Error('unsupported Runtime management read operation: ' + request.operation)
        }
        if (!request.confirmed) throw new Error('Runtime management mutation requires explicit confirmation')
        if (request.operation === 'mutate') {
          const committed = await controller.mutateCommitted(runtimeMutation(request.input, true), { preserveImportance: input.preserveImportance === true })
          return { revision: committed.revision, value: committed.result as unknown as MemoryJsonValue }
        }
        if (request.operation === 'pin') {
          if (input.pinned === true && typeof projectionSDK.reserveMemoryProjection !== 'function') throw new Error('Pinned Runtime requires a newer dsh-mnemon Host; update the Host and official Strategies together.')
          const target = text(input.target, 'target', 20)! as RuntimeMemoryTarget
          if (!TARGETS.has(target) || typeof input.pinned !== 'boolean') throw new Error('Pin requires a valid target and boolean pinned state')
          const matchBranches = input.matchBranches === undefined ? undefined : normalizeRuntimeBranches(input.matchBranches, 'matchBranches')
          const snapshot = await controller.setPinned(target, text(input.content, 'content', 100_000)!, input.pinned, matchBranches)
          return { revision: snapshot.revision, value: snapshot as unknown as MemoryJsonValue }
        }
        if (request.operation === 'compact-and-mutate') {
          if (!Array.isArray(input.compacted)) throw new Error('compacted must be an array')
          const compacted = input.compacted.map(value => {
            const entry = record(value, 'compacted entry')
            const importance = text(entry.importance, 'importance', 20)! as RuntimeMemoryImportance
            if (!IMPORTANCE.has(importance)) throw new Error('invalid compacted importance')
            if (entry.pinned !== undefined && typeof entry.pinned !== 'boolean') throw new Error('invalid compacted pin state')
            return {
              content: text(entry.content, 'content', 100_000)!, importance,
              ...(entry.pinned === undefined ? {} : { pinned: entry.pinned as boolean }),
              ...(entry.branches === undefined ? {} : { branches: stringArray(entry.branches, 'branches', 100) ?? [] }),
            } satisfies RuntimeMemoryCompactedEntry
          })
          if (input.archive !== undefined && input.archive !== 'local') throw new Error('archive must be "local" when given')
          const committed = await controller.compactAndMutateCommitted(
            text(input.revision, 'revision', 300)!, runtimeMutation(input.mutation!, true), compacted,
            typeof input.maxBytes === 'number' ? input.maxBytes : undefined,
            { ...(input.archive === 'local' ? { archive: 'local' as const } : {}), preserveImportance: input.preserveImportance === true },
          )
          return { revision: committed.revision, value: committed.result as unknown as MemoryJsonValue }
        }
        throw new Error('unsupported Runtime management mutation operation: ' + request.operation)
      },
      async mutate(request) {
        const committed = await controller.mutateCommitted(runtimeMutation(request.input), { preserveImportance: true })
        return receipt(request.view.id, request.offer.id, context.sourceInstanceKey, committed.revision, committed.result as unknown as MemoryJsonValue, 'committed')
      },
    }
  },
 })
}

export const RUNTIME_MEMORY_SOURCE = createRuntimeMemorySource()
