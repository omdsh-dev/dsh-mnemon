import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { FAKE_EMBEDDING_MODEL, fakeEmbedding, fakeEmbeddingServer } from '../scripts/fixtures/fake-embeddings.mjs'

const servers = []
const directories = []
const commands = []
afterEach(async () => {
  for (const command of commands.splice(0)) if (command.exitCode === null && command.signalCode === null) command.kill('SIGKILL')
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function serve(options = {}) {
  const events = []
  const server = fakeEmbeddingServer({ ...options, report: event => events.push(event) })
  servers.push(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = `http://127.0.0.1:${server.address().port}`
  return {
    server, root, events,
    get: path => fetch(root + path),
    post: (path, body, init = {}) => fetch(root + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init }),
  }
}

const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0) / Math.hypot(...a) / Math.hypot(...b)
const request = (number, protocol, model, inputs, delayMs = 0) => ({ event: 'embedding-request', request: number, delayMs, protocol, model, inputs })

describe('fake embedding service', () => {
  it('speaks Ollama at its root: the model listed, and one vector per input', async () => {
    const f = await serve()
    expect(await (await f.get('/api/tags')).json()).toEqual({ models: [{ name: FAKE_EMBEDDING_MODEL, model: FAKE_EMBEDDING_MODEL }] })
    const one = await f.post('/api/embed', { model: FAKE_EMBEDDING_MODEL, input: 'Release candidates run the full verify' })
    expect(one.status).toBe(200)
    expect(await one.json()).toEqual({ model: FAKE_EMBEDDING_MODEL, embeddings: [fakeEmbedding('Release candidates run the full verify')] })
    expect(await (await f.post('/api/embed', { model: 'other-model', input: ['first text', 'second'] })).json())
      .toEqual({ model: 'other-model', embeddings: [fakeEmbedding('first text'), fakeEmbedding('second')] })
    expect(f.events).toEqual([request(1, 'ollama', FAKE_EMBEDDING_MODEL, 1), request(2, 'ollama', 'other-model', 2)])
  })

  it('speaks the OpenAI-compatible protocol under /v1', async () => {
    const f = await serve({ model: 'fixture-embed' })
    expect(await (await f.get('/v1/models')).json()).toEqual({ object: 'list', data: [{ id: 'fixture-embed', object: 'model', owned_by: 'fixture' }] })
    expect(await (await f.post('/v1/embeddings', { model: 'fixture-embed', input: ['first text', 'second'] })).json()).toEqual({
      object: 'list', model: 'fixture-embed',
      data: [{ object: 'embedding', index: 0, embedding: fakeEmbedding('first text') }, { object: 'embedding', index: 1, embedding: fakeEmbedding('second') }],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    })
    expect(f.events).toEqual([request(1, 'openai', 'fixture-embed', 2)])
  })

  it('gives texts that share words closer vectors, any text a direction, and a request its own dimensions', async () => {
    const migrations = fakeEmbedding('database migrations ship with a rollback script')
    expect(cosine(migrations, fakeEmbedding('a rollback script for database migrations')))
      .toBeGreaterThan(cosine(migrations, fakeEmbedding('dependency upgrades land one package family at a time')))
    expect(fakeEmbedding('Same words')).toEqual(fakeEmbedding('same   WORDS words'))
    expect(fakeEmbedding('')).toEqual([0.01, 0, 0, 0, 0, 0, 0, 0])
    const f = await serve()
    const { embeddings } = await (await f.post('/api/embed', { input: 'four dimensions', dimensions: 4 })).json()
    expect(embeddings).toEqual([fakeEmbedding('four dimensions', 4)])
  })

  it('stays up without the model: the listings name none and every embedding request answers 404', async () => {
    const f = await serve({ missingModel: true })
    expect(await (await f.get('/api/tags')).json()).toEqual({ models: [] })
    expect(await (await f.get('/v1/models')).json()).toEqual({ object: 'list', data: [] })
    const ollama = await f.post('/api/embed', { model: FAKE_EMBEDDING_MODEL, input: 'text' })
    expect(ollama.status).toBe(404)
    expect(await ollama.json()).toEqual({ error: `model "${FAKE_EMBEDDING_MODEL}" not found, try pulling it first` })
    const openai = await f.post('/v1/embeddings', { model: 'fixture-embed', input: 'text' })
    expect(openai.status).toBe(404)
    expect(await openai.json()).toMatchObject({ error: { code: 'model_not_found', message: 'The model `fixture-embed` does not exist' } })
    expect(f.events).toHaveLength(2)
  })

  it('holds each embedding answer for the delay, but not the listings', async () => {
    const slow = await serve({ delayMs: 150 })
    const started = Date.now()
    expect((await slow.post('/api/embed', { input: 'text' })).status).toBe(200)
    expect(Date.now() - started).toBeGreaterThanOrEqual(145)
    expect(slow.events).toEqual([request(1, 'ollama', FAKE_EMBEDDING_MODEL, 1, 150)])
    // While an embedding answer is held for a minute, the listing still answers.
    const held = await serve({ delayMs: 60_000 })
    void held.post('/v1/embeddings', { input: 'text' }).catch(() => {})
    await expect.poll(() => held.events.length).toBe(1)
    expect((await held.get('/v1/models')).status).toBe(200)
  })

  it('runs as a command, also through a linked path, and leaves no answer waiting once its client hung up', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-fake-embeddings-'))
    directories.push(directory)
    // Node runs a script it reaches through a link from its real path; the command must start all the same.
    const fixtures = join(directory, 'fixtures')
    symlinkSync(fileURLToPath(new URL('../scripts/fixtures', import.meta.url)), fixtures, 'junction')
    const portFile = join(directory, 'port')
    const command = spawn(process.execPath, [join(fixtures, 'fake-embeddings.mjs'), '--port-file', portFile, '--delay-ms', '60000'], { stdio: ['ignore', 'pipe', 'pipe'] })
    commands.push(command)
    let output = ''
    command.stdout.on('data', chunk => { output += chunk })
    const exited = new Promise(resolve => command.once('exit', (code, signal) => resolve({ code, signal })))
    const port = () => { try { return readFileSync(portFile, 'utf8') } catch { return '' } }
    await expect.poll(port, { timeout: 10_000 }).not.toBe('')
    const abort = new AbortController()
    const pending = fetch(`http://127.0.0.1:${port()}/api/embed`, { method: 'POST', body: JSON.stringify({ input: 'text' }), signal: abort.signal })
      .then(() => 'answered', () => 'aborted')
    await expect.poll(() => output, { timeout: 10_000 }).toContain('Fake embeddings: {"event":"embedding-request","request":1,"delayMs":60000')
    abort.abort()
    expect(await pending).toBe('aborted')
    command.kill('SIGTERM')
    // An answer still held for the hung-up client would keep the process alive for the rest of the minute.
    const late = new Promise(resolve => setTimeout(resolve, 10_000, 'still running 10 s after SIGTERM').unref())
    expect(await Promise.race([exited, late])).toEqual({ code: 0, signal: null })
  }, 30_000)

  it('refuses a route it does not serve and a body that is not a JSON object', async () => {
    const f = await serve()
    expect((await f.get('/api/embed')).status).toBe(404)
    expect((await f.post('/api/embeddings', { prompt: 'legacy Ollama route' })).status).toBe(404)
    expect((await f.post('/api/embed', 'not json')).status).toBe(400)
    expect((await f.post('/v1/embeddings', '["text"]')).status).toBe(400)
    expect(f.events).toEqual([])
  })

  // Opt-in: MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon, as for the other real-CLI tests.
  it.skipIf(!process.env.MNEMON_NATIVE_TEST_CLI)('serves the Mnemon CLI over both protocols, and gives it no vector with the model missing', async () => {
    // Asynchronous, since the service answers from this process; only the Mnemon settings given here apply.
    const run = promisify(execFile)
    const mnemon = async (directory, endpoint, ...args) => (await run(process.env.MNEMON_NATIVE_TEST_CLI, args, {
      env: { PATH: process.env.PATH ?? '', HOME: directory, MNEMON_DATA_DIR: join(directory, 'data'), MNEMON_EMBED_ENDPOINT: endpoint },
    })).stdout
    const cli = async (directory, endpoint, ...args) => JSON.parse(await mnemon(directory, endpoint, ...args))
    const store = async () => {
      const directory = mkdtempSync(join(tmpdir(), 'mnemon-fake-embeddings-'))
      directories.push(directory)
      // Remembered while no embedding service answers, so each memory still needs its vector.
      for (const text of ['Release candidates run the full verify locally', 'Database migrations ship with a rollback script']) {
        await mnemon(directory, 'http://127.0.0.1:9', 'remember', text, '--cat', 'fact')
      }
      return directory
    }
    for (const suffix of ['', '/v1']) {
      const f = await serve()
      const directory = await store()
      const endpoint = f.root + suffix
      expect(await cli(directory, endpoint, 'embed', '--status')).toMatchObject({ protocol: suffix === '' ? 'ollama' : 'openai', embedded: 0, total_insights: 2 })
      const beforeBackfill = f.events.length
      expect(await cli(directory, endpoint, 'embed', '--all')).toMatchObject({ succeeded: 2, failed: 0 })
      // Newer CLI status calls probe model availability; count only the backfill itself.
      expect(f.events.slice(beforeBackfill).filter(event => event.protocol === (suffix === '' ? 'ollama' : 'openai'))).toHaveLength(2)
      expect(await cli(directory, endpoint, 'embed', '--status')).toMatchObject({ embedded: 2, total_insights: 2 })
    }
    const missing = await serve({ missingModel: true })
    const directory = await store()
    expect(await cli(directory, missing.root, 'embed', '--all')).toMatchObject({ succeeded: 0, failed: 2 })
    expect(await cli(directory, missing.root, 'embed', '--status')).toMatchObject({ embedded: 0, total_insights: 2 })
  }, 60_000)
})
