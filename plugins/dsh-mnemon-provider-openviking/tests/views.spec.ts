import { describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { OpenVikingProvider, descriptor } from '../src/index.ts'

const ROOT = 'viking://user/alice/memories'
const SESSIONS = 'viking://user/alice/sessions'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ status: 'ok', result }), { status: 200 })
}

function notFound(resource: string): Response {
  return new Response(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND', message: `Directory not found: ${resource}`, details: { type: 'directory', resource } } }), { status: 404 })
}

const DIFF = {
  archive_uri: `${SESSIONS}/dsh-session-1/history/archive_001`,
  extracted_at: '2026-10-23T12:39:13Z',
  operations: {
    adds: [{ uri: `${ROOT}/preferences/language.md`, memory_type: 'preferences', after: 'Prefers answers in Chinese.' }],
    updates: [{ uri: `${ROOT}/entities/docker.md`, memory_type: 'entities', before: 'Docker 29.8.0', after: 'Docker 29.8.1' }],
    deletes: [],
  },
  skipped_operations: [{ uri: `${ROOT}/entities/noise.md` }],
}

/** A server laid out the way OpenViking keeps a user's data, answering only what a view may ask. */
function server() {
  const asked: string[] = []
  const listings: Record<string, unknown[]> = {
    'viking://user/alice': [{ uri: ROOT, isDir: true, size: 0, modTime: '2026-10-23T12:00:00Z', abstract: '# viking://user/alice/memories [Directory abstract is not ready]' }],
    'viking://resources': [{ uri: 'viking://resources/status', isDir: true, modTime: '2026-10-23T12:10:00Z', abstract: 'A screenshot of the status page.' }],
    'viking://resources/status': [{ uri: 'viking://resources/status/status.jpg', isDir: false, size: PNG.byteLength, modTime: '2026-10-23T12:10:00Z' }, { uri: 'viking://resources/status/notes.md', isDir: false, size: 12 }],
    [SESSIONS]: [
      { uri: `${SESSIONS}/dsh-session-1`, isDir: true, modTime: '2026-10-23T12:40:00Z' },
      { uri: `${SESSIONS}/dsh-session-2`, isDir: true, modTime: '2026-10-23T12:00:00Z' },
    ],
    [`${SESSIONS}/dsh-session-1/history`]: [{ uri: `${SESSIONS}/dsh-session-1/history/archive_001`, isDir: true }],
    [`${SESSIONS}/dsh-session-2/history`]: [{ uri: `${SESSIONS}/dsh-session-2/history/archive_001`, isDir: true }],
  }
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.method ?? 'GET').toBe('GET')
    const path = new URL(String(url))
    const uri = path.searchParams.get('uri') ?? ''
    asked.push(`${path.pathname} ${uri}`)
    if (path.pathname === '/api/v1/fs/ls') return listings[uri] === undefined ? notFound(uri) : ok(listings[uri])
    if (path.pathname === '/api/v1/fs/stat') return ok({ uri, isDir: listings[uri] !== undefined, size: uri.endsWith('.jpg') ? PNG.byteLength : 12 })
    if (path.pathname === '/api/v1/content/download') return new Response(PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    if (path.pathname === '/api/v1/content/read') {
      if (uri === `${SESSIONS}/dsh-session-1/history/archive_001/memory_diff.json`) return ok(JSON.stringify(DIFF))
      if (uri === 'viking://resources/status/notes.md') return ok('Status notes')
      return notFound(uri)
    }
    throw new Error('unexpected request ' + path.pathname)
  })
  const { authority, body } = createMemorySpaceProviderFixture(descriptor, {
    endpoint: 'http://127.0.0.1:1933', targetUri: ROOT, account: 'lab', user: 'alice', actorPeerId: 'dsh',
  }, { dataDir: '/unused', instanceId: 'lab' })
  return { asked, body, provider: new OpenVikingProvider(authority, { fetch: fetchMock, requestTimeoutMs: 1_000 }) }
}

describe('OpenViking views of a space', () => {
  it('declares the hierarchy, Resources and server changes', () => {
    expect(descriptor.views?.map(view => [view.id, view.kind])).toEqual([['hierarchy', 'files'], ['resources', 'files'], ['changes', 'changes']])
  })

  it('starts the hierarchy at the space user, the resources and the agent directory, and lists a directory with its abstract', async () => {
    const f = server()
    expect(await f.provider.view(f.body, { view: 'hierarchy' })).toEqual({ kind: 'entries', uri: 'viking://', entries: [
      { uri: 'viking://user/alice', name: 'user/alice', directory: true },
      { uri: 'viking://resources', name: 'resources', directory: true },
      { uri: 'viking://agent', name: 'agent', directory: true },
    ] })
    // A directory the server has not summarized yet shows no abstract; a root that holds nothing yet is empty.
    expect(await f.provider.view(f.body, { view: 'hierarchy', uri: 'viking://user/alice' })).toEqual({ kind: 'entries', uri: 'viking://user/alice', entries: [
      { uri: ROOT, name: 'memories', directory: true, modifiedAt: '2026-10-23T12:00:00Z' },
    ] })
    expect(await f.provider.view(f.body, { view: 'hierarchy', uri: 'viking://agent' })).toEqual({ kind: 'entries', uri: 'viking://agent', entries: [] })
  })

  it('never leaves what the view shows', async () => {
    const f = server()
    for (const uri of ['viking://user/bob', 'viking://user/alice/../bob', 'viking://user/alice%2F..', 'viking://resources/../user/bob', 'https://example.com/']) {
      await expect(f.provider.view(f.body, { view: 'hierarchy', uri })).rejects.toThrow(/outside what the view shows/u)
    }
    await expect(f.provider.view(f.body, { view: 'resources', uri: 'viking://user/alice' })).rejects.toThrow(/outside what the view shows/u)
    await expect(f.provider.view(f.body, { view: 'unknown' })).rejects.toThrow(/no view/u)
    expect(f.asked).toEqual([])
  })

  it('lists the resources with their abstracts and previews an image and a text file', async () => {
    const f = server()
    expect(await f.provider.view(f.body, { view: 'resources' })).toEqual({ kind: 'entries', uri: 'viking://resources', entries: [
      { uri: 'viking://resources/status', name: 'status', directory: true, modifiedAt: '2026-10-23T12:10:00Z', summary: 'A screenshot of the status page.' },
    ] })
    expect(await f.provider.view(f.body, { view: 'resources', uri: 'viking://resources/status/status.jpg' })).toEqual({
      kind: 'file', uri: 'viking://resources/status/status.jpg', name: 'status.jpg', size: PNG.byteLength, mediaType: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${Buffer.from(PNG).toString('base64')}`,
    })
    expect(await f.provider.view(f.body, { view: 'resources', uri: 'viking://resources/status/notes.md' })).toMatchObject({ kind: 'file', text: 'Status notes', mediaType: 'text/plain' })
  })

  it('lists what OpenViking extraction changed, newest first, from the diffs beside committed sessions', async () => {
    const f = server()
    expect(await f.provider.view(f.body, { view: 'changes' })).toEqual({ kind: 'changes', changes: [{
      id: `${SESSIONS}/dsh-session-1/history/archive_001`, at: '2026-10-23T12:39:13Z', origin: 'dsh-session-1', skipped: 1,
      operations: [
        { action: 'add', uri: `${ROOT}/preferences/language.md`, kind: 'preferences', after: 'Prefers answers in Chinese.' },
        { action: 'update', uri: `${ROOT}/entities/docker.md`, kind: 'entities', before: 'Docker 29.8.0', after: 'Docker 29.8.1' },
      ],
    }] })
  })
})
