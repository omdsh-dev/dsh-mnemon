import { describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { OpenVikingProvider, descriptor } from '../src/index.ts'

const ROOT = 'viking://user/team/memories'

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ status: 'ok', result }), { status: 200 })
}

function notFound(message: string, resource?: string): Response {
  return new Response(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND', message, ...(resource === undefined ? {} : { details: { type: 'file', resource } }) } }), { status: 404 })
}

/** The fields each release's GrepRequest declares (#452). */
const GREP_FIELDS: Record<string, string[]> = {
  '0.4.16': ['uri', 'exclude_uri', 'pattern', 'case_insensitive', 'node_limit', 'level_limit'],
  '0.5.1.1': ['uri', 'exclude_uri', 'pattern', 'case_insensitive', 'node_limit', 'level_limit', 'tags', 'include_tags', 'before_context', 'after_context'],
}

const FILES: Record<string, string> = {
  [`${ROOT}/entities/20261023120000-postgres_fact-11111111-1111-4111-8111-111111111111.md`]:
    'PostgreSQL 18 is installed at D:\\Program Files (x86)\\PostgreSQL\\18; the Windows service is named postgresql-x64-18.',
  [`${ROOT}/entities/20261023120000-fleet-037_fact-22222222-2222-4222-8222-222222222222.md`]:
    'Host fleet-037 runs Docker Engine 29.8.37 with Compose v5.2.2.',
  [`${ROOT}/entities/20261023120000-fleet-036_fact-33333333-3333-4333-8333-333333333333.md`]:
    'Host fleet-036 runs Docker Engine 29.8.36 with Compose v5.1.1.',
  [`${ROOT}/entities/20261023120000-fleet-137_fact-44444444-4444-4444-8444-444444444444.md`]:
    'Host fleet-137 runs Docker Engine 29.8.137 with Compose v5.4.2.\nIt serves the search team.',
  [`${ROOT}/experiences/20261023120000-release_decision-66666666-6666-4666-8666-666666666666.md`]:
    '发布必须先通过灰度验证。',
  [`${ROOT}/.abstract.md`]: 'Directory summary that mentions fleet-037 and 29.8.37.',
  'viking://user/other/memories/entities/foreign_fact-55555555-5555-4555-8555-555555555555.md': 'fleet-037 belongs to someone else.',
}

/** A server that greps the way OpenViking does: one regular expression over every line under the URI. */
function grepServer(version: '0.4.16' | '0.5.1.1', options: { missingRoute?: boolean; emptyRoot?: boolean } = {}) {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url))
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: path.pathname, ...(body === undefined ? {} : { body }) })
    if (path.pathname === '/api/v1/content/read') return ok(FILES[path.searchParams.get('uri')!])
    if (path.pathname === '/api/v1/search/find') {
      return ok({ memories: [{ uri: `${ROOT}/entities/20261023120000-fleet-036_fact-33333333-3333-4333-8333-333333333333.md`, abstract: 'Host fleet-036', score: 0.86 }] })
    }
    if (path.pathname === '/api/v1/search/grep') {
      if (options.missingRoute) return notFound('Not Found')
      if (options.emptyRoot) return notFound(`File not found: ${String(body!.uri)}`, String(body!.uri))
      const extra = Object.keys(body!).filter(name => !GREP_FIELDS[version]!.includes(name))
      if (extra.length > 0) return new Response(JSON.stringify({ status: 'error', error: { message: `body.${extra[0]}: Extra inputs are not permitted` } }), { status: 400 })
      const pattern = new RegExp(String(body!.pattern), body!.case_insensitive === true ? 'iu' : 'u')
      const matches = Object.entries(FILES).filter(([uri]) => uri.startsWith(`${String(body!.uri)}/`)).flatMap(([uri, text]) => (
        text.split('\n').flatMap((line, index) => pattern.test(line) ? [{ line: index + 1, uri, content: line }] : [])
      ))
      return ok({ matches, count: matches.length, match_count: matches.length, files_scanned: Object.keys(FILES).length })
    }
    throw new Error('unexpected request ' + path.pathname)
  })
  const { authority, body } = createMemorySpaceProviderFixture(descriptor, {
    endpoint: 'https://memory.example', targetUri: ROOT, user: 'team', account: 'work', apiKey: 'synthetic-only-key',
  }, { dataDir: '/unused', instanceId: 'work-account' })
  return { calls, fetchMock, body, provider: new OpenVikingProvider(authority, { fetch: fetchMock, requestTimeoutMs: 1_000 }) }
}

describe('OpenViking keyword search through search/grep (#452)', () => {
  it.each(['0.4.16', '0.5.1.1'] as const)('finds an exact identifier on OpenViking %s, with the full memory and no made-up score', async version => {
    const f = grepServer(version)
    const result = await f.provider.search(f.body, { query: 'postgresql-x64-18', mode: 'keyword', limit: 10 })
    expect(result.results).toEqual([{
      id: `${ROOT}/entities/20261023120000-postgres_fact-11111111-1111-4111-8111-111111111111.md`,
      externalUri: `${ROOT}/entities/20261023120000-postgres_fact-11111111-1111-4111-8111-111111111111.md`,
      content: FILES[`${ROOT}/entities/20261023120000-postgres_fact-11111111-1111-4111-8111-111111111111.md`],
      category: 'fact',
      source: 'external',
    }])
    const grep = f.calls.find(call => call.path === '/api/v1/search/grep')!
    // Only fields every release from 0.4.16 to 0.5.2 declares, scoped to the space's memory root.
    expect(grep.body).toEqual({ uri: ROOT, pattern: 'postgresql-x64-18', case_insensitive: true, node_limit: 256 })
    expect(f.calls.some(call => call.path === '/api/v1/search/find')).toBe(false)
  })

  it('matches a version as literal text, not as a pattern', async () => {
    const f = grepServer('0.5.1.1')
    const result = await f.provider.search(f.body, { query: '29.8.37', mode: 'keyword', limit: 10 })
    // Unescaped, "29.8.37" would also match 29x8y37; escaped, only the exact version is found.
    expect(result.results.map(item => item.content)).toEqual(['Host fleet-037 runs Docker Engine 29.8.37 with Compose v5.2.2.'])
    expect(f.calls.find(call => call.path === '/api/v1/search/grep')!.body!.pattern).toBe('29\\.8\\.37')
  })

  it.each([['29.8.13', '29.8.137'], ['fleet-13', 'fleet-137']])('takes %s as a whole word, so it does not match %s', async query => {
    const f = grepServer('0.5.1.1')
    await expect(f.provider.search(f.body, { query, mode: 'keyword', limit: 10 })).resolves.toEqual({ results: [] })
  })

  it('finds a term inside text written without spaces', async () => {
    const f = grepServer('0.5.1.1')
    const result = await f.provider.search(f.body, { query: '灰度', mode: 'keyword', limit: 10 })
    expect(result.results.map(item => [item.content, item.category])).toEqual([['发布必须先通过灰度验证。', 'decision']])
  })

  it('keeps a quoted path whole, backslashes and parentheses included', async () => {
    const f = grepServer('0.4.16')
    const result = await f.provider.search(f.body, { query: '"D:\\Program Files (x86)\\PostgreSQL\\18"', mode: 'keyword', limit: 10 })
    expect(result.results.map(item => item.id)).toEqual([`${ROOT}/entities/20261023120000-postgres_fact-11111111-1111-4111-8111-111111111111.md`])
  })

  it('puts the memory holding more of the terms first, and keeps grep order otherwise', async () => {
    const f = grepServer('0.5.1.1')
    const result = await f.provider.search(f.body, { query: 'fleet-137 29.8.37 search', mode: 'keyword', limit: 10 })
    expect(result.results.map(item => item.id.split('/').pop()!.split('_')[0])).toEqual([
      '20261023120000-fleet-137', // fleet-137 and search
      '20261023120000-fleet-037', // 29.8.37
    ])
    expect(result.results.every(item => item.score === undefined)).toBe(true)
  })

  it('stays inside the memory root and leaves out OpenViking system files', async () => {
    const f = grepServer('0.5.1.1')
    const result = await f.provider.search(f.body, { query: 'fleet-037', mode: 'keyword', limit: 10 })
    expect(result.results.map(item => item.id)).toEqual([`${ROOT}/entities/20261023120000-fleet-037_fact-22222222-2222-4222-8222-222222222222.md`])
  })

  it('honours the limit', async () => {
    const f = grepServer('0.5.1.1')
    const result = await f.provider.search(f.body, { query: 'Docker', mode: 'keyword', limit: 2 })
    expect(result.results).toHaveLength(2)
  })

  it('answers an empty space with no results', async () => {
    const f = grepServer('0.5.1.1', { emptyRoot: true })
    await expect(f.provider.search(f.body, { query: 'postgresql-x64-18', mode: 'keyword', limit: 10 })).resolves.toEqual({ results: [] })
  })

  it('answers semantically, and says so, where the server has no search/grep', async () => {
    const f = grepServer('0.4.16', { missingRoute: true })
    const result = await f.provider.search(f.body, { query: 'fleet-036', mode: 'keyword', limit: 10 })
    expect(result.results.map(item => item.content)).toEqual(['Host fleet-036 runs Docker Engine 29.8.36 with Compose v5.1.1.'])
    expect(result.hint).toMatch(/no exact-text search \(search\/grep\), so these keyword results are semantic/u)
  })

  it('leaves smart, basic and unspecified searches on the semantic route', async () => {
    for (const mode of ['smart', 'basic', undefined] as const) {
      const f = grepServer('0.5.1.1')
      await f.provider.search(f.body, { query: 'fleet-036', limit: 10, ...(mode === undefined ? {} : { mode }) })
      expect(f.calls.map(call => call.path)).toEqual(['/api/v1/search/find', '/api/v1/content/read'])
    }
  })

  it('asks nothing for a query without terms', async () => {
    const f = grepServer('0.5.1.1')
    await expect(f.provider.search(f.body, { query: '   ', mode: 'keyword', limit: 10 })).resolves.toEqual({ results: [] })
    expect(f.fetchMock).not.toHaveBeenCalled()
  })
})
