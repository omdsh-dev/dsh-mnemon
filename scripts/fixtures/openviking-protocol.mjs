// Deterministic protocol fixture for issue 233, not a live OpenViking backend.
// It models a cosmetic extraction update that never stores the submitted text, and the
// request validation of OpenViking 0.4.16: the content API refuses any field it does not
// declare (issue 353), and tags are set by their own endpoint.
import { realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const WRITE_FIELDS = ['uri', 'content', 'mode', 'wait', 'timeout', 'telemetry', 'processing_mode']
export const TAG_FIELDS = ['uri', 'tags', 'mode', 'recursive', 'telemetry']

/** OpenViking 0.4.16's answer to a body with undeclared fields, or undefined when it has none. */
export function extraForbidden(body, fields) {
  const extra = Object.keys(body).filter(name => !fields.includes(name))
  if (extra.length === 0) return undefined
  return { code: 'INVALID_ARGUMENT', message: `Invalid request parameters: body.${extra[0]}: Extra inputs are not permitted`,
    details: { validation_errors: extra.map(name => ({ loc: ['body', name], message: 'Extra inputs are not permitted', type: 'extra_forbidden' })) } }
}

export function openVikingProtocolFixture() {
  const files = new Map()
  const requests = []
  const state = { vectorStatus: 'complete', failDelete: false }
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw || '{}')
    const url = new URL(request.url, 'http://fixture.local')
    const account = request.headers['x-openviking-account'] || 'default'
    const user = request.headers['x-openviking-user'] || 'default'
    const method = request.method
    requests.push({ method, path: url.pathname, account, user, body })
    const key = uri => `${account}:${uri}`
    const root = `viking://user/${user}/memories`
    const canonical = uri => String(uri || '').replace(/^viking:\/\/user\/memories(?=\/|$)/u, root)
    let result
    let status = 200
    let error
    if (url.pathname === '/health') result = { healthy: true }
    else if (url.pathname === '/__fixture') result = { fixture: 'deterministic-openviking-protocol', files: [...files.values()], requests }
    else if (url.pathname === '/api/v1/system/status') result = { initialized: true, user }
    else if (url.pathname === '/api/v1/admin/accounts') result = [{ account_id: 'default' }]
    else if (url.pathname.endsWith('/users')) result = [{ user_id: 'default', display_name: 'Issue 233 protocol fixture' }, { user_id: 'other', display_name: 'Other synthetic namespace' }]
    else if (url.pathname === '/api/v1/sessions') result = { session_id: body.session_id }
    else if (url.pathname.endsWith('/messages')) result = { message_id: 'fixture-message' }
    else if (url.pathname.endsWith('/commit')) result = { task_id: 'fixture-extraction', status: 'accepted' }
    else if (url.pathname === '/api/v1/tasks/fixture-extraction') result = { status: 'completed', result: { memories_extracted: { memory_update: 1 } } }
    else if (url.pathname === '/api/v1/content/write') {
      const uri = canonical(body.uri)
      error = extraForbidden(body, WRITE_FIELDS)
      if (error !== undefined) status = 400
      else if (body.mode === 'create' && files.has(key(uri))) status = 409
      else {
        files.set(key(uri), { uri, account, content: body.content })
        result = { uri, root_uri: uri.slice(0, uri.lastIndexOf('/')), context_type: 'memory', mode: body.mode,
          written_bytes: Buffer.byteLength(body.content), content_updated: true, semantic_status: 'skipped',
          vector_status: state.vectorStatus, queue_status: { Embedding: { error_count: state.vectorStatus === 'failed' ? 1 : 0, errors: [] } } }
      }
    } else if (url.pathname === '/api/v1/content/set_tags') {
      const file = files.get(key(canonical(body.uri)))
      error = extraForbidden(body, TAG_FIELDS)
      if (error !== undefined) status = 400
      // Only replacing is modelled: Mnemon sends nothing else.
      else if (!Array.isArray(body.tags) || body.mode !== 'replace') status = 400
      else if (file === undefined) status = 404
      else {
        file.tags = [...body.tags]
        result = { uri: file.uri, tags_updated: true }
      }
    } else if (url.pathname === '/api/v1/content/read') {
      result = files.get(key(canonical(url.searchParams.get('uri'))))?.content
      if (result === undefined) status = 404
    } else if (url.pathname === '/api/v1/fs/ls') {
      const requestedRoot = canonical(url.searchParams.get('uri'))
      result = [...files.values()].filter(file => file.account === account && file.uri.startsWith(requestedRoot + '/'))
        .map(file => ({ uri: file.uri, isDir: false, abstract: 'Synthetic summary; the Provider must read the full body.' }))
    } else if (url.pathname === '/api/v1/search/find') {
      const requestedRoot = canonical(body.target_uri)
      result = { memories: [...files.values()].filter(file => file.account === account && file.uri.startsWith(requestedRoot + '/') && file.content.includes(body.query))
        .map(file => ({ uri: file.uri, abstract: 'Synthetic summary', score: 0.99 })) }
    } else if (url.pathname === '/api/v1/search/grep') {
      // As every OpenViking since 0.4.16 answers: each line under the URI that the pattern matches,
      // files in name order, until node_limit lines.
      const requestedRoot = canonical(body.uri)
      const pattern = new RegExp(String(body.pattern), body.case_insensitive === true ? 'iu' : 'u')
      const under = [...files.values()].filter(file => file.account === account && file.uri.startsWith(requestedRoot + '/'))
        .sort((left, right) => left.uri < right.uri ? -1 : 1)
      const matches = under.flatMap(file => file.content.split('\n').flatMap((line, index) => pattern.test(line) ? [{ line: index + 1, uri: file.uri, content: line }] : []))
        .slice(0, body.node_limit ?? 256)
      result = { matches, count: matches.length, match_count: matches.length, files_scanned: under.length }
    } else if (url.pathname === '/api/v1/fs' && method === 'DELETE') {
      const uri = canonical(url.searchParams.get('uri'))
      if (state.failDelete) status = 503
      else result = { uri, estimated_deleted_count: Number(files.delete(key(uri))) }
    } else status = 404
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(status === 200 ? { status: 'ok', result } : { status: 'error', error: error ?? { message: `Synthetic OpenViking HTTP ${status}` } }))
  })
  return { server, files, requests, state }
}

// Node runs a script it reaches through a link, such as /tmp on macOS, from its real path.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const fixture = openVikingProtocolFixture()
  fixture.server.listen(Number(process.env.MNEMON_OPENVIKING_FIXTURE_PORT || 19335), '127.0.0.1', () => {
    console.log(`Deterministic OpenViking protocol fixture: http://127.0.0.1:${fixture.server.address().port}`)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => fixture.server.close())
}
