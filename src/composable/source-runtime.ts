import type { MemoryJsonValue } from '../../packages/contracts/src/index.ts'
import { COMPOSABLE_MEMORY_API_VERSION } from '../../packages/contracts/src/index.ts'
import { defineMemorySource } from '../../packages/kernel/src/index.ts'
import { resolveGitBranch } from '../git-branch.ts'
import type { RuntimeMemoryController } from '../runtime-memory.ts'
import type { RuntimeMemoryAction, RuntimeMemoryImportance, RuntimeMemoryTarget } from '../shared/contracts.ts'
import { BUILTIN_MEMORY_BINDINGS } from './bindings.ts'
import { receipt, record, stringArray, text, truncate } from './shared.ts'

const ACTIONS = new Set<RuntimeMemoryAction>(['add', 'replace', 'remove'])
const TARGETS = new Set<RuntimeMemoryTarget>(['memory', 'user'])
const IMPORTANCE = new Set<RuntimeMemoryImportance>(['critical', 'normal', 'low'])

export const RUNTIME_MEMORY_SOURCE = defineMemorySource({
  manifest: {
    apiVersion: COMPOSABLE_MEMORY_API_VERSION,
    kind: 'source',
    typeId: 'runtime',
    packageName: 'dsh-mnemon-source-runtime',
    role: 'working-context',
    capabilities: ['status', 'project', 'write'],
    consistency: 'exact-snapshot',
    actions: [{
      id: 'mutate',
      description: 'Add, replace, or remove an entry in Runtime Memory.',
      capability: 'write',
      inputSchema: {
        type: 'object',
        required: ['action', 'target'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['add', 'replace', 'remove'] },
          target: { type: 'string', enum: ['memory', 'user'] },
          content: { type: 'string' },
          oldText: { type: 'string' },
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
    const controller = context.binding<RuntimeMemoryController>(BUILTIN_MEMORY_BINDINGS.runtime)
    if (controller === undefined) throw new Error('Runtime Memory Source requires its Host runtime binding')
    const projection = (workspaceId?: string) => controller.contextProjection(resolveGitBranch(workspaceId))
    const prepared = new Map<string, ReturnType<typeof projection>>()
    const scopeKey = (workspaceId?: string) => workspaceId?.trim() ?? ''
    return {
      facts(request) {
        const current = projection(request.scope.workspaceId)
        prepared.set(scopeKey(request.scope.workspaceId), current)
        return {
          sourceInstanceKey: context.sourceInstanceKey,
          sourceTypeId: 'runtime',
          role: 'working-context',
          availability: 'ready',
          revision: current.revision,
          capabilities: ['status', 'project', 'write'],
          routeIds: [],
          actionIds: ['mutate'],
        }
      },
      project(request) {
        if (!request.includeProjection) return { fragments: [] }
        const key = scopeKey(request.scope.workspaceId)
        const current = prepared.get(key) ?? projection(request.scope.workspaceId)
        prepared.delete(key)
        return {
          fragments: [{
            id: `${context.sourceInstanceKey}/projection`,
            sourceInstanceKey: context.sourceInstanceKey,
            mode: request.mode,
            text: truncate(current.text, request.maxCharacters),
            revision: current.revision,
            provenance: { sourceTypeId: 'runtime' },
          }],
        }
      },
      async mutate(request) {
        const input = record(request.input, 'Runtime Memory mutation')
        const action = text(input.action, 'action', 20) as RuntimeMemoryAction
        const target = text(input.target, 'target', 20) as RuntimeMemoryTarget
        if (!ACTIONS.has(action)) throw new Error(`unsupported Runtime Memory action: ${action}`)
        if (!TARGETS.has(target)) throw new Error(`unsupported Runtime Memory target: ${target}`)
        const importance = text(input.importance, 'importance', 20, false) as RuntimeMemoryImportance | undefined
        if (importance !== undefined && !IMPORTANCE.has(importance)) throw new Error(`unsupported Runtime Memory importance: ${importance}`)
        const result = await controller.mutate({
          action,
          target,
          ...(text(input.content, 'content', 100_000, false) === undefined ? {} : { content: text(input.content, 'content', 100_000, false)! }),
          ...(text(input.oldText, 'oldText', 100_000, false) === undefined ? {} : { oldText: text(input.oldText, 'oldText', 100_000, false)! }),
          ...(importance === undefined ? {} : { importance }),
          ...(input.branches === undefined ? {} : { branches: stringArray(input.branches, 'branches', 100) ?? [] }),
        })
        const revision = controller.snapshot().revision
        return receipt(request.view.id, request.offer.id, context.sourceInstanceKey, revision, result as unknown as MemoryJsonValue)
      },
    }
  },
})
