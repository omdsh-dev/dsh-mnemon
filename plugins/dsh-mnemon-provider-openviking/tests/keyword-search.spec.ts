import { describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { OpenVikingProvider, descriptor } from '../src/index.ts'

const ROOT = 'viking://user/team/memories'
const HASH = 'cff1dd03149f8966cd3916c906c7f8789c65e4c3f0b2857db721daf061d93d0f'

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
  [`${ROOT}/entities/20261023120000-kappa_fact-77777777-7777-4777-8777-777777777777.md`]:
    'Host kappa defaults to Python3.12; its archive digest is sha256:' + HASH + '.',
  [`${ROOT}/entities/20261023120000-clock_fact-88888888-8888-4888-8888-888888888888.md`]: 'Это который час?',
  [`${ROOT}/experiences/20261023120000-release_decision-66666666-6666-4666-8666-666666666666.md`]:
    '发布必须先通过灰度验证。',
  [`${ROOT}/experiences/20261023120000-cache_insight-99999999-9999-4999-8999-999999999999.md`]: '先调用API接口，再写缓存。',
  [`${ROOT}/preferences/20261023120000-pets_preference-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.md`]: '我家的猫叫咪咪，狗叫旺财。',
  [`${ROOT}/.abstract.md`]: 'Directory summary that mentions fleet-037 and 29.8.37.',
  'viking://user/other/memories/entities/foreign_fact-55555555-5555-4555-8555-555555555555.md': 'fleet-037 belongs to someone else.',
}

const short = (uri: string) => uri.split('/').pop()!.split('_')[0]!

/**
 * A server that greps the way OpenViking does: one regular expression over the lines of every file under
 * the URI, files in name order, stopping after `node_limit` matching lines.
 */
function grepServer(version: '0.4.16' | '0.5.1.1', options: {
  files?: Record<string, string>
  missingRoute?: boolean
  emptyRoot?: boolean
  failure?: number
  unreadable?: string[]
} = {}) {
  const files = { ...FILES, ...options.files }
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url))
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: path.pathname, ...(body === undefined ? {} : { body }) })
    if (path.pathname === '/api/v1/content/read') {
      const uri = path.searchParams.get('uri')!
      return options.unreadable?.includes(uri) ? notFound(`File not found: ${uri}`, uri) : ok(files[uri])
    }
    if (path.pathname === '/api/v1/search/find') {
      return ok({ memories: [{ uri: `${ROOT}/entities/20261023120000-fleet-036_fact-33333333-3333-4333-8333-333333333333.md`, abstract: 'Host fleet-036', score: 0.86 }] })
    }
    if (path.pathname === '/api/v1/search/grep') {
      if (options.missingRoute) return notFound('Not Found')
      if (options.failure !== undefined) {
        return new Response(JSON.stringify(options.failure === 405 ? { detail: 'Method Not Allowed' } : { status: 'error', error: { code: 'INTERNAL', message: 'grep failed' } }), { status: options.failure })
      }
      if (options.emptyRoot) return notFound(`File not found: ${String(body!.uri)}`, String(body!.uri))
      const extra = Object.keys(body!).filter(name => !GREP_FIELDS[version]!.includes(name))
      if (extra.length > 0) return new Response(JSON.stringify({ status: 'error', error: { message: `body.${extra[0]}: Extra inputs are not permitted` } }), { status: 400 })
      const pattern = new RegExp(String(body!.pattern), body!.case_insensitive === true ? 'iu' : 'u')
      const matches = Object.entries(files).filter(([uri]) => uri.startsWith(`${String(body!.uri)}/`))
        .sort(([left], [right]) => left < right ? -1 : 1)
        .flatMap(([uri, text]) => text.split('\n').flatMap((line, index) => pattern.test(line) ? [{ line: index + 1, uri, content: line }] : []))
        .slice(0, Number(body!.node_limit))
      return ok({ matches, count: matches.length, match_count: matches.length, files_scanned: Object.keys(files).length })
    }
    throw new Error('unexpected request ' + path.pathname)
  })
  const { authority, body } = createMemorySpaceProviderFixture(descriptor, {
    endpoint: 'https://memory.example', targetUri: ROOT, user: 'team', account: 'work', apiKey: 'synthetic-only-key',
  }, { dataDir: '/unused', instanceId: 'work-account' })
  const patterns = () => calls.filter(call => call.path === '/api/v1/search/grep').map(call => call.body!.pattern)
  return { calls, fetchMock, body, patterns, provider: new OpenVikingProvider(authority, { fetch: fetchMock, requestTimeoutMs: 1_000 }) }
}

/** Six long notes from early October, then the update that matters: more lines say "Atlas" than one grep returns. */
const ATLAS: Record<string, string> = {
  ...Object.fromEntries(Array.from({ length: 6 }, (_, n) => [
    `${ROOT}/entities/2026100${n + 1}090000-atlas-sprint-log-${n + 1}_fact-0000000${n + 1}-0000-4000-8000-000000000000.md`,
    [`Atlas sprint log ${n + 1}`, ...Array.from({ length: 49 }, (_, i) => `Atlas sprint ${n + 1} item ${i + 1}: the build queue drained after the nightly job.`)].join('\n'),
  ])),
  [`${ROOT}/entities/20261020090000-atlas-rollout_fact-00000009-0000-4000-8000-000000000000.md`]:
    'Atlas rollout: fleet-777 was upgraded to Docker Engine 29.9.1 on 2026-10-20.',
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
    expect(f.patterns()).toEqual(['29\\.8\\.37'])
  })

  it.each([
    ['5.2.2', '20261023120000-fleet-037', 'after a letter'],
    ['3.12', '20261023120000-kappa', 'after a letter'],
    ['api', '20261023120000-cache', 'between Chinese characters'],
    ['灰度', '20261023120000-release', 'inside text written without spaces'],
    [HASH.slice(0, 7), '20261023120000-kappa', 'as the start of a hexadecimal ID'],
  ])('finds %s %s', async (query, file) => {
    const f = grepServer('0.5.1.1')
    const result = await f.provider.search(f.body, { query, mode: 'keyword', limit: 10 })
    expect(result.results.map(item => short(item.id))).toEqual([file])
  })

  it.each([
    ['29.8.13', 'inside 29.8.137'],
    ['fleet-13', 'inside fleet-137'],
    ['кот', 'inside который'],
    [HASH.slice(0, 5), 'as a five-character piece of a hash, too short to be taken for an ID'],
    [HASH.slice(3, 15), 'from the middle of a hexadecimal ID'],
  ])('does not find %s %s', async query => {
    const f = grepServer('0.5.1.1')
    await expect(f.provider.search(f.body, { query, mode: 'keyword', limit: 10 })).resolves.toEqual({ results: [] })
  })

  it('keeps a quoted path whole, backslashes and parentheses included, in straight or curly quotes', async () => {
    for (const query of ['"D:\\Program Files (x86)\\PostgreSQL\\18"', '\u201cD:\\Program Files (x86)\\PostgreSQL\\18\u201d']) {
      const f = grepServer('0.4.16')
      const result = await f.provider.search(f.body, { query, mode: 'keyword', limit: 10 })
      expect(result.results.map(item => short(item.id))).toEqual(['20261023120000-postgres'])
      expect(f.patterns()).toEqual(['D:\\\\Program Files \\(x86\\)\\\\PostgreSQL\\\\18'])
    }
  })

  it('matches a quoted phrase within one line', async () => {
    const f = grepServer('0.5.1.1')
    // fleet-137's note breaks the line between these words.
    await expect(f.provider.search(f.body, { query: '"v5.4.2. It serves"', mode: 'keyword', limit: 10 })).resolves.toEqual({ results: [] })
  })

  it('asks one grep for all the terms while it holds every match, and puts the memory holding more of them first', async () => {
    const f = grepServer('0.5.1.1')
    const result = await f.provider.search(f.body, { query: 'fleet-137 29.8.37 search', mode: 'keyword', limit: 10 })
    expect(f.patterns()).toEqual(['fleet-137|29\\.8\\.37|search'])
    expect(result.results.map(item => short(item.id))).toEqual([
      '20261023120000-fleet-137', // fleet-137 and search, on different lines
      '20261023120000-fleet-037', // 29.8.37
    ])
    expect(result.results.every(item => item.score === undefined)).toBe(true)
  })

  it('gives each term its own grep when one for all of them fills up, so a rare term finds its memory', async () => {
    const f = grepServer('0.5.1.1', { files: ATLAS })
    const result = await f.provider.search(f.body, { query: 'Atlas fleet-777', mode: 'keyword', limit: 10 })
    // Both greps that hold "Atlas" stop at 256 lines, in the sixth sprint log; "fleet-777" alone finds the rollout.
    expect(f.patterns()).toEqual(['Atlas|fleet-777', 'Atlas', 'fleet-777'])
    expect(result.results.map(item => short(item.id))).toEqual([
      '20261020090000-atlas-rollout',
      '20261006090000-atlas-sprint-log-6',
      '20261005090000-atlas-sprint-log-5',
      '20261004090000-atlas-sprint-log-4',
      '20261003090000-atlas-sprint-log-3',
      '20261002090000-atlas-sprint-log-2',
      '20261001090000-atlas-sprint-log-1',
    ])
    expect(result.hint).toBe('"Atlas" matched 256 lines, where OpenViking\'s exact-text search stops, so other memories holding it may be missing; a rarer term finds them.')
  })

  it('says so when a common term alone reaches the grep limit', async () => {
    const f = grepServer('0.5.1.1', { files: ATLAS })
    const result = await f.provider.search(f.body, { query: 'Atlas', mode: 'keyword', limit: 10 })
    // The server never reaches the rollout; what it returned comes newest first.
    expect(result.results.map(item => short(item.id))).toEqual([6, 5, 4, 3, 2, 1].map(n => `2026100${n}090000-atlas-sprint-log-${n}`))
    expect(result.hint).toMatch(/^"Atlas" matched 256 lines, where OpenViking's exact-text search stops/u)
  })

  it('ranks a rare term above a common one, however old its memory', async () => {
    const f = grepServer('0.5.1.1', {
      files: {
        [`${ROOT}/events/20261001080000-fleet-777_context-00000010-0000-4000-8000-000000000000.md`]: 'fleet-777 joined rack R4 on 2026-10-01.',
        ...Object.fromEntries([1, 2, 3].map(n => [
          `${ROOT}/events/2026101${n}080000-standup-${n}_context-0000001${n}-0000-4000-8000-000000000000.md`, `Standup ${n}: the release train left on time.`,
        ])),
      },
    })
    const result = await f.provider.search(f.body, { query: 'the fleet-777', mode: 'keyword', limit: 10 })
    // The oldest memory here, and the only one holding the rare term.
    expect(result.results.map(item => short(item.id))).toEqual([
      '20261001080000-fleet-777',
      '20261023120000-fleet-137', '20261023120000-postgres', '20261013080000-standup-3', '20261012080000-standup-2', '20261011080000-standup-1',
    ])
  })

  it('puts the latest of memories holding the same terms first, then files without a time in grep order', async () => {
    const f = grepServer('0.5.1.1', {
      files: {
        [`${ROOT}/entities/20261001080000-fleet-777_fact-00000020-0000-4000-8000-000000000000.md`]: 'fleet-777 runs Docker Engine 29.8.1.',
        [`${ROOT}/entities/20261015080000-fleet-777_fact-00000021-0000-4000-8000-000000000000.md`]: 'fleet-777 now runs Docker Engine 29.9.1.',
        [`${ROOT}/entities/fleet-notes.md`]: 'fleet-777 sits in rack R4.',
        [`${ROOT}/entities/aa-fleet-notes.md`]: 'fleet-777 has two power supplies.',
      },
    })
    const result = await f.provider.search(f.body, { query: 'fleet-777', mode: 'keyword', limit: 10 })
    expect(result.results.map(item => short(item.id))).toEqual([
      '20261015080000-fleet-777', '20261001080000-fleet-777', 'aa-fleet-notes.md', 'fleet-notes.md',
    ])
  })

  it('looks up the words of a question without the punctuation that ends it', async () => {
    const f = grepServer('0.5.1.1')
    const result = await f.provider.search(f.body, { query: 'Which Docker version runs on fleet-137?', mode: 'keyword', limit: 10 })
    expect(f.patterns()).toEqual(['Which|Docker|version|runs|on|fleet-137'])
    expect(short(result.results[0]!.id)).toBe('20261023120000-fleet-137')
  })

  it('leaves out one-character words of a spaced script beside other terms, but keeps Chinese characters', async () => {
    const pets = grepServer('0.5.1.1')
    const result = await pets.provider.search(pets.body, { query: '猫 狗', mode: 'keyword', limit: 10 })
    expect(pets.patterns()).toEqual(['猫|狗'])
    expect(result.results.map(item => short(item.id))).toEqual(['20261023120000-pets'])
    const fleet = grepServer('0.5.1.1')
    await fleet.provider.search(fleet.body, { query: 'a fleet-137 5', mode: 'keyword', limit: 10 })
    expect(fleet.patterns()).toEqual(['fleet-137'])
    const letters = grepServer('0.5.1.1')
    await letters.provider.search(letters.body, { query: 'x y', mode: 'keyword', limit: 10 })
    expect(letters.patterns()).toEqual(['x|y'])
  })

  it('looks up at most eight terms, and says so', async () => {
    const f = grepServer('0.5.1.1')
    const result = await f.provider.search(f.body, { query: 'one two three four five six seven eight nine fleet-137', mode: 'keyword', limit: 10 })
    expect(f.patterns()).toEqual(['one|two|three|four|five|six|seven|eight'])
    expect(result.results).toEqual([])
    expect(result.hint).toBe('Only the first 8 terms were looked up.')
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

  it('leaves out a matched file the server cannot read, and says so', async () => {
    const unread = `${ROOT}/entities/20261023120000-fleet-036_fact-33333333-3333-4333-8333-333333333333.md`
    const f = grepServer('0.5.1.1', { unreadable: [unread] })
    const result = await f.provider.search(f.body, { query: 'Docker', mode: 'keyword', limit: 10 })
    expect(result.results.map(item => item.id)).not.toContain(unread)
    expect(result.results).toHaveLength(2)
    expect(result.hint).toBe("1 OpenViking result could not be read and was left out; the server's index can list a file it no longer holds.")
  })

  it('answers an empty space with no results', async () => {
    const f = grepServer('0.5.1.1', { emptyRoot: true })
    await expect(f.provider.search(f.body, { query: 'postgresql-x64-18 fleet-037', mode: 'keyword', limit: 10 })).resolves.toEqual({ results: [] })
  })

  it.each([
    ['without the route', { missingRoute: true }],
    ['that refuses the method', { failure: 405 }],
  ])('answers semantically, and says so, on a server %s', async (_, options) => {
    const f = grepServer('0.4.16', options)
    const result = await f.provider.search(f.body, { query: 'fleet-036', mode: 'keyword', limit: 10 })
    expect(result.results.map(item => item.content)).toEqual(['Host fleet-036 runs Docker Engine 29.8.36 with Compose v5.1.1.'])
    expect(result.hint).toMatch(/no exact-text search \(search\/grep\), so these keyword results are semantic/u)
  })

  it.each([500, 403])('reports a grep that fails with HTTP %i instead of answering another way', async failure => {
    const f = grepServer('0.5.1.1', { failure })
    await expect(f.provider.search(f.body, { query: 'fleet-036', mode: 'keyword', limit: 10 })).rejects.toThrow('grep failed')
    expect(f.calls.some(call => call.path === '/api/v1/search/find')).toBe(false)
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
    for (const query of ['   ', '? .']) {
      await expect(f.provider.search(f.body, { query, mode: 'keyword', limit: 10 })).resolves.toEqual({ results: [] })
    }
    expect(f.fetchMock).not.toHaveBeenCalled()
  })
})
