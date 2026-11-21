import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const FAKE_EMBEDDING_MODEL = 'nomic-embed-text'

export function fakeEmbedding(text, dimensions = 8) {
  const vector = Array.from({ length: dimensions }, (_, index) => index === 0 ? 0.01 : 0)
  for (const word of new Set(String(text).toLowerCase().split(/\s+/u).filter(word => word !== ''))) {
    vector[createHash('sha256').update(word).digest().readUInt32BE(0) % dimensions] += 1
  }
  return vector
}

export function fakeEmbeddingServer({ model = FAKE_EMBEDDING_MODEL, dimensions = 8, delayMs = 0, missingModel = false, requiredKey, report = () => {} } = {}) {
  let requests = 0
  return createServer(async (request, response) => {
    let input = ''
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
