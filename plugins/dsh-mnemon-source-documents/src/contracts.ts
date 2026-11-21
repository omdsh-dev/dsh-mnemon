export type DocumentStatus = 'active' | 'archived'

export interface DocumentRecord {
  id: string
  title: string
  description: string
  status: DocumentStatus
  filename: string
  relativePath: string
  sourcePaths: string[]
  sessionIds: string[]
  createdAt: string
  updatedAt: string
  lastAccessedAt: string
  revision: number
  contentHash: string
  sizeBytes: number
  archivedAt?: string
  archiveSummary?: string
  memoryBodyIds: string[]
}

export interface DocumentView extends DocumentRecord {
  content: string
  fileRevision?: string
}

export interface DocumentSnapshot {
  workspaceRoot: string
  directory: string
  indexPath: string
  generatedAt: string
  revision: string
  limitBytes: number
  activeBytes: number
  activeCount: number
  archivedCount: number
  total: number
  documents: Array<DocumentRecord & { healthy: boolean; excerpt: string }>
}

export interface DocumentSearchResult {
  query: string
  includeArchived: boolean
  total: number
  generatedAt: string
  results: Array<DocumentView & { score: number; excerpt: string }>
}

export type DocumentMutation =
  | { action: 'create'; title: string; description?: string; content: string; sourcePaths?: string[]; sessionIds?: string[] }
  | { action: 'update'; id: string; title?: string; description?: string; content?: string; sourcePaths?: string[]; sessionIds?: string[] }
  | { action: 'delete'; id: string; fileRevision?: string }

export interface DocumentMutationResult {
  success: true
  action: 'created' | 'updated' | 'archived' | 'deleted'
  document: DocumentView
  snapshot: DocumentSnapshot
  maintenance?: { runId: string; provider: string; summary: string; memoryBodyIds: string[]; archivedDocumentIds: string[] }
}

export interface DocumentCapacityPlan {
  projected: number
  limit: number
  fits: boolean
  candidates: DocumentRecord[]
}

export const DOCUMENTS_VERSION = 1
export const DOCUMENTS_ACTIVE_LIMIT_BYTES = 10 * 1024 * 1024

export const DOCUMENTS_DIRECTORY = 'documents'
export const DOCUMENTS_INDEX_FILE = 'index.json'
export const DOCUMENTS_LOCK_FILE = '.index.lock'
export const DOCUMENTS_LOCK_STALE_MS = 30_000
export const DOCUMENT_FILENAME_PATTERN = /^[a-zA-Z0-9._-]+\.md$/u

export interface DocumentIndex {
  version: typeof DOCUMENTS_VERSION
  documents: DocumentRecord[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseDocumentIndex(value: unknown): DocumentIndex {
  const index = isObject(value) ? value : undefined
  if (index?.version !== DOCUMENTS_VERSION || !Array.isArray(index.documents)) throw new Error('Documents index.json is invalid')
  const ids = new Set<string>()
  const documents = index.documents.map((raw): DocumentRecord => {
    const item = isObject(raw) ? raw : undefined
    if (typeof item?.id !== 'string' || item.id.trim() === '' || ids.has(item.id)) throw new Error('Documents index contains an invalid or duplicate id')
    if (typeof item.title !== 'string' || typeof item.description !== 'string' || (item.status !== 'active' && item.status !== 'archived')) throw new Error('Documents index contains an invalid record')
    if (typeof item.filename !== 'string' || !DOCUMENT_FILENAME_PATTERN.test(item.filename)) throw new Error('Documents index contains an unsafe filename')
    if (typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || typeof item.lastAccessedAt !== 'string' || !Number.isSafeInteger(item.revision) || typeof item.contentHash !== 'string' || !Number.isSafeInteger(item.sizeBytes)) throw new Error('Documents index contains invalid metadata')
    if (!Array.isArray(item.sourcePaths) || !Array.isArray(item.sessionIds) || !Array.isArray(item.memoryBodyIds)) throw new Error('Documents index contains invalid lists')
    ids.add(item.id)
    return {
      id: item.id, title: item.title, description: item.description, status: item.status, filename: item.filename,
      relativePath: `${DOCUMENTS_DIRECTORY}/${item.status}/${item.filename}`,
      sourcePaths: item.sourcePaths.filter((entry): entry is string => typeof entry === 'string'),
      sessionIds: item.sessionIds.filter((entry): entry is string => typeof entry === 'string'),
      createdAt: item.createdAt, updatedAt: item.updatedAt, lastAccessedAt: item.lastAccessedAt,
      revision: Number(item.revision), contentHash: item.contentHash, sizeBytes: Number(item.sizeBytes),
      ...(typeof item.archivedAt === 'string' ? { archivedAt: item.archivedAt } : {}),
      ...(typeof item.archiveSummary === 'string' ? { archiveSummary: item.archiveSummary } : {}),
      memoryBodyIds: item.memoryBodyIds.filter((entry): entry is string => typeof entry === 'string'),
    }
  })
  return { version: DOCUMENTS_VERSION, documents }
}

export interface DocumentIndexSummary {
  valid: boolean
  documents: number
  active: number
  archived: number
}

export function summarizeDocumentIndex(value: unknown): DocumentIndexSummary {
  const documents = isObject(value) && Array.isArray(value.documents) ? value.documents.filter(isObject) : []
  return {
    valid: isObject(value) && Array.isArray(value.documents),
    documents: documents.length,
    active: documents.filter(document => document.status === 'active').length,
    archived: documents.filter(document => document.status === 'archived').length,
  }
}
