import type { MemoryProviderChange, MemoryProviderViewEntry, MemoryProviderViewRequest, MemoryProviderViewResult } from 'dsh-mnemon-source-memory-spaces/provider-sdk'

/** What a view reads from the space's server: JSON results, and a file's bytes up to a size. */
export interface OpenVikingViewIo {
  get(path: string, signal?: AbortSignal): Promise<unknown>
  bytes(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>
  /** The user whose memory root the space names. */
  user: string
}

const RESOURCES = 'viking://resources'
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const TEXT_TYPES = new Set(['md', 'markdown', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'py', 'ts', 'tsx', 'js', 'mjs', 'go', 'rs', 'java', 'sh', 'toml', 'ini'])
/** The largest image the page previews, and how many sessions and diffs the change list reads. */
const IMAGE_BYTES = 2_500_000
const SESSIONS = 20
const DIFFS = 30

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A plain viking:// location: no traversal, encoding, query or control characters. */
function plainUri(uri: string): boolean {
  if (!uri.startsWith('viking://') || /[%?#\\\u0000-\u001f\u007f]/u.test(uri)) return false
  return uri.slice('viking://'.length).split('/').every((part, index, parts) => part !== '.' && part !== '..' && (part !== '' || index === parts.length - 1))
}

function within(uri: string, root: string): boolean {
  return uri === root || uri.startsWith(`${root}/`)
}

function nameOf(uri: string): string {
  return uri.replace(/\/+$/u, '').split('/').pop() || uri
}

function extension(uri: string): string {
  const name = nameOf(uri)
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
}

/** OpenViking's answer for a location that does not exist yet: a 404 naming it. */
function missing(error: unknown): boolean {
  const failure = object(error)
  return failure?.status === 404 && failure.resource !== undefined
}

/** One location's contents, or none while it does not exist yet, as in a new account. */
async function list(io: OpenVikingViewIo, uri: string, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
  try {
    const result = await io.get(`/api/v1/fs/ls?${new URLSearchParams({ uri, output: 'agent', abs_limit: '240' })}`, signal)
    return (Array.isArray(result) ? result : []).flatMap((value): Array<Record<string, unknown>> => { const item = object(value); return item === undefined ? [] : [item] })
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
}

function entry(item: Record<string, unknown>): MemoryProviderViewEntry | undefined {
  const uri = string(item.uri)
  if (uri === undefined || !plainUri(uri)) return undefined
  const size = typeof item.size === 'number' && Number.isFinite(item.size) && item.isDir !== true ? item.size : undefined
  const modifiedAt = string(item.modTime)
  const abstract = string(item.abstract)?.trim()
  // A directory the server has not summarized yet says so in place of an abstract.
  const summary = abstract === undefined || abstract === '' || abstract.includes('abstract is not ready') ? undefined : abstract
  return {
    uri, name: string(item.name) ?? nameOf(uri), directory: item.isDir === true,
    ...(size === undefined ? {} : { size }), ...(modifiedAt === undefined ? {} : { modifiedAt }), ...(summary === undefined ? {} : { summary }),
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** One file: an image as a data URL, text as text, anything else by its name and size alone. */
async function file(io: OpenVikingViewIo, uri: string, signal?: AbortSignal): Promise<MemoryProviderViewResult> {
  const stat = object(await io.get(`/api/v1/fs/stat?${new URLSearchParams({ uri })}`, signal)) ?? {}
  if (stat.isDir === true) return { kind: 'entries', uri, entries: (await list(io, uri, signal)).flatMap(item => entry(item) ?? []) }
  const size = typeof stat.size === 'number' && Number.isFinite(stat.size) ? stat.size : undefined
  const kind = extension(uri)
  const name = nameOf(uri)
  const image = IMAGE_TYPES[kind]
  if (image !== undefined) {
    if (size !== undefined && size > IMAGE_BYTES) return { kind: 'file', uri, name, size, mediaType: image, truncated: true }
    const bytes = await io.bytes(`/api/v1/content/download?${new URLSearchParams({ uri })}`, IMAGE_BYTES, signal)
    return { kind: 'file', uri, name, size: size ?? bytes.byteLength, mediaType: image, dataUrl: `data:${image};base64,${base64(bytes)}` }
  }
  if (kind !== '' && !TEXT_TYPES.has(kind)) return { kind: 'file', uri, name, ...(size === undefined ? {} : { size }) }
  const text = await io.get(`/api/v1/content/read?${new URLSearchParams({ uri })}`, signal)
  return { kind: 'file', uri, name, ...(size === undefined ? {} : { size }), mediaType: 'text/plain', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }
}

type Operation = MemoryProviderChange['operations'][number]

function operations(value: unknown, action: Operation['action']): Operation[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const operation = object(item)
    const uri = string(operation?.uri)
    if (operation === undefined || uri === undefined) return []
    const kind = string(operation.memory_type)
    const before = string(operation.before) ?? (action === 'delete' ? string(operation.content) : undefined)
    const after = string(operation.after) ?? (action === 'add' ? string(operation.content) : undefined)
    return [{ action, uri, ...(kind === undefined ? {} : { kind }), ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }]
  })
}

/**
 * What OpenViking's own memory extraction changed, read from the `memory_diff.json` the server
 * keeps beside each committed session archive: the newest sessions first, a bounded number of each.
 */
async function changes(io: OpenVikingViewIo, signal?: AbortSignal): Promise<MemoryProviderViewResult> {
  const root = `viking://user/${io.user}/sessions`
  const sessions = (await list(io, root, signal)).filter(item => item.isDir === true && plainUri(string(item.uri) ?? ''))
    .sort((left, right) => String(right.modTime ?? '').localeCompare(String(left.modTime ?? '')))
  const histories = await Promise.all(sessions.slice(0, SESSIONS).map(async session => {
    const uri = string(session.uri)!
    const archives = (await list(io, `${uri}/history`, signal)).flatMap(item => item.isDir === true && plainUri(string(item.uri) ?? '') ? [string(item.uri)!] : [])
    return archives.sort().reverse().map(archive => ({ session: nameOf(uri), archive }))
  }))
  const candidates = histories.flat().slice(0, DIFFS)
  const read = await Promise.all(candidates.map(async ({ session, archive }): Promise<MemoryProviderChange | undefined> => {
    let diff: Record<string, unknown> | undefined
    try {
      const text = await io.get(`/api/v1/content/read?${new URLSearchParams({ uri: `${archive}/memory_diff.json` })}`, signal)
      diff = object(typeof text === 'string' ? JSON.parse(text) : text)
    } catch (error) {
      // An archive whose extraction has not run, or found nothing to change, keeps no diff.
      if (missing(error) || error instanceof SyntaxError) return undefined
      throw error
    }
    const found = object(diff?.operations)
    if (found === undefined) return undefined
    const all = [...operations(found.adds, 'add'), ...operations(found.updates, 'update'), ...operations(found.deletes, 'delete')]
    const skipped = Array.isArray(diff?.skipped_operations) ? diff.skipped_operations.length : 0
    if (all.length === 0 && skipped === 0) return undefined
    const at = string(diff?.extracted_at)
    return { id: archive, ...(at === undefined ? {} : { at }), origin: session, operations: all, ...(skipped === 0 ? {} : { skipped }) }
  }))
  const found = read.flatMap(change => change ?? []).sort((left, right) => (right.at ?? '').localeCompare(left.at ?? ''))
  return { kind: 'changes', changes: found, ...(sessions.length > SESSIONS || histories.flat().length > DIFFS ? { truncated: true } : {}) }
}

/**
 * One view of the space's OpenViking data. The hierarchy starts at the space's own user and the
 * account's resources and agent directories, and never leaves them; Resources starts at the
 * resources directory. Everything is read through the space's own connection, and nothing is written.
 */
export async function openVikingView(io: OpenVikingViewIo, request: MemoryProviderViewRequest, signal?: AbortSignal): Promise<MemoryProviderViewResult> {
  if (request.view === 'changes') return changes(io, signal)
  const roots = request.view === 'hierarchy' ? [`viking://user/${io.user}`, RESOURCES, 'viking://agent'] : request.view === 'resources' ? [RESOURCES] : undefined
  if (roots === undefined) throw new Error(`OpenViking has no view ${JSON.stringify(request.view)}`)
  const uri = request.uri?.trim().replace(/\/+$/u, '')
  if (uri === undefined || uri === '') {
    if (roots.length === 1) return { kind: 'entries', uri: roots[0]!, entries: (await list(io, roots[0]!, signal)).flatMap(item => entry(item) ?? []) }
    return { kind: 'entries', uri: 'viking://', entries: roots.map(root => ({ uri: root, name: root.slice('viking://'.length), directory: true })) }
  }
  if (!plainUri(uri) || !roots.some(root => within(uri, root))) throw new Error('This location is outside what the view shows')
  // A root is a directory, even before anything is stored under it.
  if (roots.includes(uri)) return { kind: 'entries', uri, entries: (await list(io, uri, signal)).flatMap(item => entry(item) ?? []) }
  return file(io, uri, signal)
}
