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
  /** Digest of the exact managed file read; deletion also fences external edits. */
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

// The files below are this Source's own. A Host that copies them, as a Mnemon Pack or a sync
// does, or counts them for a storage inventory, reads their names and rules from here instead
// of keeping a copy that drifts when the Source changes.

/** The Documents Source's directory under a storage root; each document sits in `<status>/<filename>` below it. */
export const DOCUMENTS_DIRECTORY = 'documents'
/** The metadata of every document, the source of truth for which files belong to the Source. */
export const DOCUMENTS_INDEX_FILE = 'index.json'
/** Created exclusively while the index or a document is read or written; whoever copies them takes it too. */
export const DOCUMENTS_LOCK_FILE = '.index.lock'
/** A lock file older than this was left by a process that stopped, and may be taken over. */
export const DOCUMENTS_LOCK_STALE_MS = 30_000
/** The file name a document may have: one path segment, so it never leaves its status directory. */
export const DOCUMENT_FILENAME_PATTERN = /^[a-zA-Z0-9._-]+\.md$/u

export interface DocumentIndex {
  version: typeof DOCUMENTS_VERSION
  documents: DocumentRecord[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read an index as a copy of it carries it, such as a Mnemon Pack or a sync branch: every record
 * complete, each id unique and each file name safe, or the whole index is refused. A record's path
 * is where its status puts it, whatever the copy says. Unknown fields are dropped, and so are
 * list items that are not strings. Reading the index does not judge a record's content hash: a
 * store that needs repair still has to be copied as one.
 */
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

/** What a stored index.json holds, counted without judging each record. */
export interface DocumentIndexSummary {
  /** Whether the index has a record list at all. Without one, every count is 0. */
  valid: boolean
  /** Every record that is an object, whatever its status. */
  documents: number
  active: number
  archived: number
}

/**
 * Count the records of a parsed index.json for a read-only inventory. It never throws: an index
 * without a record list is not `valid`, and a malformed record is counted or skipped, never refused.
 */
export function summarizeDocumentIndex(value: unknown): DocumentIndexSummary {
  const documents = isObject(value) && Array.isArray(value.documents) ? value.documents.filter(isObject) : []
  return {
    valid: isObject(value) && Array.isArray(value.documents),
    documents: documents.length,
    active: documents.filter(document => document.status === 'active').length,
    archived: documents.filter(document => document.status === 'archived').length,
  }
}
