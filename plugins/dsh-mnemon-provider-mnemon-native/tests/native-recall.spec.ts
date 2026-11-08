import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { JsonValue, MemorySpaceNativeRunner } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { descriptor, MnemonNativeProvider } from '../src/index.ts'

const cli = process.env.MNEMON_NATIVE_TEST_CLI
const execute = promisify(execFile)

it.skipIf(!cli)('uses real CLI similarity without exposing private stores or changing inspection data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mnemon-semantic-recall-'))
  const query = 'How is the next deployment prepared?'
  const fact = 'The zephyr rollout uses a cobalt staging cluster.'
  let available = true
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'fixture-semantic' }] })); return }
    if (request.url !== '/api/embed') { response.writeHead(404); response.end('{}'); return }
    if (!available) { response.writeHead(503); response.end('{"error":"Synthetic embedding outage"}'); return }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const payload = JSON.parse(raw) as { input: string | string[] }
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input]
    response.end(JSON.stringify({ embeddings: inputs.map(text => text === fact || text === query ? [1, 0] : [0, 1]) }))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fixture address')
    const env = { ...process.env, MNEMON_DATA_DIR: directory, MNEMON_EMBED_ENDPOINT: `http://127.0.0.1:${address.port}`,
      MNEMON_EMBED_MODEL: 'fixture-semantic', MNEMON_EMBED_PROTOCOL: 'ollama', MNEMON_EMBED_API_KEY: '', MNEMON_EMBED_DIMENSIONS: '' }
    const runText: MemorySpaceNativeRunner['runText'] = async (args, options) => (await execute(cli!, [
      '--data-dir', directory, '--store', options?.store ?? 'work', ...args,
    ], { env, timeout: 10_000, signal: options?.signal, maxBuffer: 2 * 1024 * 1024 })).stdout
    const runJson: MemorySpaceNativeRunner['runJson'] = async (args, options) => JSON.parse(await runText(args, options)) as JsonValue
    const { body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: directory, memoryBodyId: 'work' })
    const provider = new MnemonNativeProvider({ runJson, runText })
    const remembered = await runJson(['remember', fact, '--no-diff', '--cat', 'fact']) as { id: string }
    for (let index = 0; index < 20; index++) {
      await runJson(['remember', `${query} Synthetic lexical distraction ${index}.`, '--no-diff', '--cat', 'fact'])
    }
    const database = join(directory, 'data', 'work', 'mnemon.db')
    const before = await readFile(database)
    const native = await runJson(['--readonly', 'recall', query, '--limit', '50', '--verbose']) as {
      results: Array<{ insight: { id: string }; score: number; signals: { similarity: number } }>
    }
    const original = native.results.find(row => row.insight.id === remembered.id)
    expect(original).toBeDefined()
    expect(original!.signals.similarity).toBeCloseTo(1)
    expect(original!.score).toBeLessThan(0.6)
    const result = await provider.search(body, { query, limit: 10, inspect: true })
    expect(result.results[0]).toMatchObject({ id: remembered.id, content: fact, score: 1 })
    expect(result.results).toHaveLength(10)
    expect(await readFile(database)).toEqual(before)

    available = false
    const fallback = await provider.search(body, { query, limit: 10, inspect: true })
    expect(fallback.results).toHaveLength(10)
    expect(fallback.results.some(row => (row.score ?? 0) > 0)).toBe(true)
    expect(await readFile(database)).toEqual(before)
    console.log(`Synthetic CLI recall: ${native.results.length} candidates, hybrid score ${original!.score.toFixed(3)} -> similarity 1.000; outage fallback kept ${fallback.results.length}; inspection database unchanged.`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
