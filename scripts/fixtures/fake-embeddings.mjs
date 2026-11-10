// A stand-in embedding service on loopback, not a model: it speaks Ollama's API at its root and
// the OpenAI-compatible API under /v1, the two protocols the Mnemon CLI uses, and answers each
// text with a deterministic vector. `--archive-copies` uses it as its slow service; run it with
// `node` for Mnemon CLI probes or as the endpoint in the Mnemon Native embedding settings:
//   node scripts/fixtures/fake-embeddings.mjs [--port <n>] [--port-file <file>] [--delay-ms <ms>] [--missing-model] [--model <name>]
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** Mnemon's default embedding model, which the service lists unless told otherwise. */
export const FAKE_EMBEDDING_MODEL = 'nomic-embed-text'

/**
 * One dimension per hashed word, so texts that share words point the same way. The first
 * dimension starts above zero, so even an empty text has a direction.
 */
export function fakeEmbedding(text, dimensions = 8) {
  const vector = Array.from({ length: dimensions }, (_, index) => index === 0 ? 0.01 : 0)
  for (const word of new Set(String(text).toLowerCase().split(/\s+/u).filter(word => word !== ''))) {
    vector[createHash('sha256').update(word).digest().readUInt32BE(0) % dimensions] += 1
  }
  return vector
}

/**
 * An embedding service, not yet listening:
 * - Ollama: `GET /api/tags` lists the model and `POST /api/embed` answers one vector per input;
 * - OpenAI-compatible: `GET <prefix>/models` lists it and `POST <prefix>/embeddings` answers the
 *   same vectors, for an endpoint such as `http://127.0.0.1:<port>/v1`.
 *
 * `delayMs` holds every embedding answer, but not the listings, as a slow or loaded service does;
 * a client that gives up first, such as a Mnemon CLI call stopped at its timeout, gets nothing. With
 * `missingModel` the service is up without the model: the listings name none and every embedding
 * request answers 404, as Ollama does for a model it has not pulled. A request may ask for its own
 * `dimensions`. `report` receives each embedding request as it arrives.
 */
export function fakeEmbeddingServer({ model = FAKE_EMBEDDING_MODEL, dimensions = 8, delayMs = 0, missingModel = false, requiredKey, report = () => {} } = {}) {
  let requests = 0
  return createServer(async (request, response) => {
    let input = ''
    // A client that hangs up mid-request rejects the read; the handler must not reject with it.
    try { for await (const chunk of request) input += chunk } catch { return }
    const answer = (status, body) => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/u, '')
    const ollama = path.startsWith('/api/')
    if (requiredKey !== undefined) {
      const authorized = request.headers.authorization === 'Bearer ' + requiredKey
      report({ event: 'authorization', authorized })
      if (!authorized) return answer(401, { error: 'fixture authorization missing or invalid' })
    }
    if (request.method === 'GET' && path === '/api/tags') return answer(200, { models: missingModel ? [] : [{ name: model, model }] })
    if (request.method === 'GET' && !ollama && path.endsWith('/models')) {
      return answer(200, { object: 'list', data: missingModel ? [] : [{ id: model, object: 'model', owned_by: 'fixture' }] })
    }
    if (request.method !== 'POST' || (path !== '/api/embed' && (ollama || !path.endsWith('/embeddings')))) {
      return answer(404, { error: `no fake embedding route for ${request.method} ${path}` })
    }
    let body
    try { body = JSON.parse(input === '' ? '{}' : input) } catch { body = undefined }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return answer(400, { error: 'the request body is not a JSON object' })
    const asked = typeof body.model === 'string' && body.model !== '' ? body.model : model
    const texts = body.input === undefined ? [] : (Array.isArray(body.input) ? body.input : [body.input]).map(String)
    requests += 1
    report({ event: 'embedding-request', request: requests, delayMs, protocol: ollama ? 'ollama' : 'openai', model: asked, inputs: texts.length })
    if (delayMs > 0) {
      // A request whose client hangs up stops waiting, so closing the service never waits out a delay.
      const hungUp = new AbortController()
      response.once('close', () => hungUp.abort())
      try { await sleep(delayMs, undefined, { signal: hungUp.signal }) } catch { return }
    }
    if (missingModel) {
      return answer(404, ollama
        ? { error: `model "${asked}" not found, try pulling it first` }
        : { error: { message: `The model \`${asked}\` does not exist`, type: 'invalid_request_error', param: 'model', code: 'model_not_found' } })
    }
    const size = Number.isInteger(body.dimensions) && body.dimensions > 0 ? body.dimensions : dimensions
    const vectors = texts.map(text => fakeEmbedding(text, size))
    answer(200, ollama ? { model: asked, embeddings: vectors } : {
      object: 'list', model: asked,
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      usage: { prompt_tokens: texts.length, total_tokens: texts.length },
    })
  })
}

// Node runs a script it reaches through a link, such as /tmp on macOS, from its real path.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '0' },
    'port-file': { type: 'string' },
    'delay-ms': { type: 'string', default: '0' },
    'missing-model': { type: 'boolean', default: false },
    model: { type: 'string', default: FAKE_EMBEDDING_MODEL },
  } })
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0 through 65535')
  const delayMs = Number(values['delay-ms'])
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('--delay-ms must be a number of milliseconds')
  const server = fakeEmbeddingServer({ model: values.model, delayMs, missingModel: values['missing-model'],
    report: event => console.log('Fake embeddings: ' + JSON.stringify(event)) })
  server.listen(port, '127.0.0.1', async () => {
    const bound = server.address().port
    if (values['port-file'] !== undefined) await writeFile(values['port-file'], String(bound))
    console.log(`Fake embeddings: Ollama at http://127.0.0.1:${bound}, OpenAI-compatible at http://127.0.0.1:${bound}/v1, model ${values.model}`
      + (values['missing-model'] ? ' (missing)' : '') + (delayMs > 0 ? `, each answer after ${delayMs} ms` : ''))
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close() })
}
