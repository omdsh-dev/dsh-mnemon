// Replays the exact write bodies the RetainDB Provider sends, for every Memory Spaces category at importance
// 1, 3 and 5, against RetainDB Server's own request schemas. The bodies come from the real Memory Spaces Source
// and the built Provider, written to a loopback recorder: once answering POST /v1/memory, and once refusing it
// with 404 so that the Provider falls back to the legacy POST /v1/memories.
//
// The schemas copy the fields the Provider sends from RetainDB/RetainDB@2ad2cc4d (Apache-2.0):
//   POST /v1/memory    packages/server/src/api/memory.ts:63-80 (memory types) and :921-941
//   POST /v1/memories  packages/server/src/api/routes.ts:2581-2595
// The Server validates them with @hono/zod-validator 0.4.3, which answers a failed parse with HTTP 400, on zod 3;
// `zod/v3` from this repository's zod 4 is that API. For an accepted body, `path` is how the Server then writes it:
// /v1/memory stores it before answering unless `write_mode` or `async` asks to queue (memory.ts:1027-1033); the
// legacy endpoint queues it and answers 202 unless `async` is false (routes.ts:2606).
//
// Run from the repository after `pnpm build && pnpm -r build`:
//   node docs/pr-assets/retaindb-importance-scale/server-schema.probe.mjs <out.json>
import { createServer } from 'node:http'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v3'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as spacesPlugin from 'dsh-mnemon-source-memory-spaces'
import { CATEGORIES } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import * as strategyPlugin from 'dsh-mnemon-strategy-default-three-tier'

const MEMORY_TYPE_VALUES = [
  'factual', 'episodic', 'semantic', 'procedural', 'preference', 'event', 'relationship', 'opinion',
  'goal', 'instruction', 'decision', 'constraint', 'solution', 'project_state', 'correction', 'workflow',
]
const currentSchema = z.object({
  project: z.string().optional(),
  content: z.string().min(1).max(10000),
  memory_type: z.enum(MEMORY_TYPE_VALUES).optional(),
  user_id: z.string().optional(),
  session_id: z.string().optional(),
  importance: z.number().min(0).max(1).optional().default(0.5),
  async: z.boolean().optional(),
  write_mode: z.enum(['async', 'sync']).optional(),
})
const legacySchema = z.object({
  project: z.string().optional(),
  content: z.string().min(1).max(10000),
  memory_type: z.enum(['factual', 'episodic', 'semantic', 'procedural']).optional().default('factual'),
  user_id: z.string().optional(),
  session_id: z.string().optional(),
  importance: z.number().min(0).max(1).optional().default(0.5),
  async: z.boolean().optional().default(true),
})
const writePath = {
  current: data => (data.write_mode ?? (data.async === false ? 'sync' : data.async === true ? 'async' : 'sync')) === 'sync' ? 'stored' : 'queued',
  legacy: data => data.async !== false ? 'queued' : 'stored',
}
const verdict = (schema, body) => {
  const result = schema.safeParse(body)
  return result.success ? 'accepted' : `400: ${[...new Set(result.error.issues.map(issue => issue.path.join('.')))].join(', ')}`
}
const pathFor = (endpoint, schema, body) => {
  const result = schema.safeParse(body)
  return result.success ? writePath[endpoint](result.data) : 'refused'
}

let mode = 'current'
const requests = []
const server = createServer((request, response) => {
  let raw = ''
  request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'POST') requests.push({ mode, path, body: JSON.parse(raw) })
    const reply = (status, payload) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (request.method === 'GET' && path === '/v1/projects') return reply(200, { projects: [{ id: 'project-1', name: 'Launch', slug: 'launch' }] })
    if (request.method === 'GET' && (path === '/v1/memories' || path.startsWith('/v1/memory/profile/'))) return reply(200, { memories: [] })
    if (request.method === 'POST' && path === '/v1/memory') return mode === 'legacy' ? reply(404, { message: 'missing' }) : reply(200, { id: `ret-${requests.length}` })
    if (request.method === 'POST' && path === '/v1/memories') return reply(200, { id: `ret-${requests.length}` })
    return reply(404, { message: 'not served by this recorder' })
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

const dataDir = mkdtempSync(join(tmpdir(), 'retaindb-schema-'))
const workspace = mkdtempSync(join(tmpdir(), 'retaindb-schema-workspace-'))
const runner = new MemoryCompositionRunner()
try {
  await runner.mount(strategyPlugin, { instanceId: 'probe-strategy' })
  await runner.mount(spacesPlugin, { instanceId: 'memory-spaces', config: {
    dataDir, timeoutMs: 20_000, providers: [{ use: 'dsh-mnemon-provider-retaindb', instanceId: 'retaindb' }],
  } })
  const spaces = await runner.managementClient('source:memory-spaces', { storage: 'global', workspaceId: realpathSync(workspace) })
  await spaces.mutate('provider-service-update', {
    providerId: 'retaindb', enabled: true, settings: { endpoint: `http://127.0.0.1:${server.address().port}`, apiKey: 'probe-key' },
  }, { confirmed: true })
  const space = (await spaces.read('bodies', {})).value.items.find(item => item.provider.id === 'retaindb')
  if (space === undefined) throw new Error('RetainDB discovery did not mount a space')
  const writes = CATEGORIES.flatMap(category => [1, 3, 5].map(importance => ({ category, importance })))
  const sent = {}
  for (const pass of ['current', 'legacy']) {
    mode = pass
    const first = requests.length
    for (const { category, importance } of writes) {
      await spaces.mutate('remember', { content: `Canary before production (${pass}, ${category}, ${importance})`, category, importance, memoryBodyId: space.id }, { confirmed: true })
    }
    sent[pass] = requests.slice(first).filter(request => request.path === (pass === 'current' ? '/v1/memory' : '/v1/memories')).map(request => request.body)
    if (sent[pass].length !== writes.length) throw new Error(`expected ${writes.length} ${pass} writes, saw ${sent[pass].length}`)
  }
  const rowFor = (endpoint, schema, body) => ({ memory_type: body.memory_type, importance: body.importance, verdict: verdict(schema, body), path: pathFor(endpoint, schema, body) })
  const rows = writes.map(({ category, importance }, index) => ({
    category, importance,
    current: rowFor('current', currentSchema, sent.current[index]),
    legacy: rowFor('legacy', legacySchema, sent.legacy[index]),
  }))
  const count = endpoint => ({
    accepted: rows.filter(row => row[endpoint].verdict === 'accepted').length,
    refused: rows.filter(row => row[endpoint].verdict !== 'accepted').length,
    storedBeforeAnswer: rows.filter(row => row[endpoint].path === 'stored').length,
    queued: rows.filter(row => row[endpoint].path === 'queued').length,
  })
  const out = {
    rows,
    counts: { '/v1/memory': count('current'), '/v1/memories': count('legacy') },
    serverDefaultImportance: currentSchema.parse({ content: 'x' }).importance,
    sampleBodies: { '/v1/memory': sent.current[0], '/v1/memories': sent.legacy[0] },
  }
  writeFileSync(process.argv[2], `${JSON.stringify(out, null, 2)}\n`)
  const cell = row => `${String(row.memory_type).padEnd(10)} ${String(row.importance).padEnd(4)} ${row.verdict.padEnd(28)} ${row.path.padEnd(7)}`
  for (const row of rows) console.log(`${row.category.padEnd(10)} ${row.importance}  /v1/memory ${cell(row.current)}  /v1/memories ${cell(row.legacy)}`)
  console.log(JSON.stringify(out.counts))
} finally {
  await runner.dispose?.()
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
