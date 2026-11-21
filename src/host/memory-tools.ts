export type MemoryToolPage = 'status' | `${string}/${string}`

export interface MemoryToolEntry {
  readonly sourceTypeId?: string
  readonly operation?: string
  readonly kind: 'read' | 'inspect' | 'write'
  readonly page?: MemoryToolPage
  readonly label: `turnTail.tool.${string}`
}

export const MEMORY_TOOLS = {
  mnemon_view_route: { kind: 'read', label: 'turnTail.tool.viewRoute' },
  mnemon_view_action: { kind: 'write', label: 'turnTail.tool.viewAction' },
  mnemon_memory_bodies: { sourceTypeId: 'memory-spaces', operation: 'inspect', kind: 'inspect', page: 'memory-spaces/spaces', label: 'turnTail.tool.spaces' },
  mnemon_recall: { sourceTypeId: 'memory-spaces', operation: 'recall', kind: 'read', page: 'memory-spaces/explore', label: 'turnTail.tool.recall' },
  mnemon_related: { sourceTypeId: 'memory-spaces', operation: 'related', kind: 'read', page: 'memory-spaces/explore', label: 'turnTail.tool.related' },
  mnemon_status: { sourceTypeId: 'memory-spaces', operation: 'inspect', kind: 'inspect', page: 'status', label: 'turnTail.tool.status' },
  mnemon_document_search: { sourceTypeId: 'documents', operation: 'search', kind: 'read', page: 'documents/library', label: 'turnTail.tool.documentSearch' },
  mnemon_document_create: { sourceTypeId: 'documents', operation: 'create', kind: 'write', page: 'documents/library', label: 'turnTail.tool.documentCreate' },
  mnemon_document_manage: { sourceTypeId: 'documents', operation: 'manage', kind: 'write', page: 'documents/library', label: 'turnTail.tool.documentManage' },
  mnemon_runtime_memory: { sourceTypeId: 'runtime', operation: 'mutate', kind: 'write', page: 'runtime/entries', label: 'turnTail.tool.runtime' },
  mnemon_remember: { sourceTypeId: 'memory-spaces', operation: 'remember', kind: 'write', page: 'memory-spaces/spaces', label: 'turnTail.tool.remember' },
  mnemon_link: { sourceTypeId: 'memory-spaces', operation: 'link', kind: 'write', page: 'memory-spaces/spaces', label: 'turnTail.tool.link' },
  mnemon_forget: { sourceTypeId: 'memory-spaces', operation: 'forget', kind: 'write', page: 'memory-spaces/spaces', label: 'turnTail.tool.forget' },
  mnemon_memory_body_create: { sourceTypeId: 'memory-spaces', operation: 'manage-spaces', kind: 'write', page: 'memory-spaces/spaces', label: 'turnTail.tool.spaceCreate' },
  mnemon_memory_body_update: { sourceTypeId: 'memory-spaces', operation: 'manage-spaces', kind: 'write', page: 'memory-spaces/spaces', label: 'turnTail.tool.spaceUpdate' },
  mnemon_memory_body_merge: { sourceTypeId: 'memory-spaces', operation: 'manage-spaces', kind: 'write', page: 'memory-spaces/spaces', label: 'turnTail.tool.spaceMerge' },
} as const satisfies Readonly<Record<string, MemoryToolEntry>>

export type MemoryToolName = keyof typeof MEMORY_TOOLS
export type MemoryToolLabel = (typeof MEMORY_TOOLS)[MemoryToolName]['label']

export function memoryTool(name: string): (MemoryToolEntry & { readonly label: MemoryToolLabel }) | undefined {
  return Object.hasOwn(MEMORY_TOOLS, name) ? MEMORY_TOOLS[name as MemoryToolName] : undefined
}

export function memoryTools(): Array<[MemoryToolName, MemoryToolEntry]> {
  return Object.entries(MEMORY_TOOLS) as Array<[MemoryToolName, MemoryToolEntry]>
}
