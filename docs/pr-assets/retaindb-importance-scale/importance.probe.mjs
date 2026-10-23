// Writes three memories through the real Memory Spaces Source into a RetainDB space and records the
// importance in each write RetainDB would receive. The endpoint is a loopback recorder, not a RetainDB
// server. Run from the repository after `pnpm build && pnpm -r build`:
//   node docs/pr-assets/retaindb-importance-scale/importance.probe.mjs <out.json>
import { createServer } from 'node:http'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as spacesPlugin from 'dsh-mnemon-source-memory-spaces'
import * as strategyPlugin from 'dsh-mnemon-strategy-default-three-tier'

const requests = []
const server = createServer((request, response) => {
  let raw = ''
  request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    requests.push({ method: request.method, path, ...(raw === '' ? {} : { body: JSON.parse(raw) }) })
    const reply = (status, payload) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (request.method === 'GET' && path === '/v1/projects') return reply(200, { projects: [{ id: 'project-1', name: 'Launch', slug: 'launch' }] })
    if (request.method === 'POST' && path === '/v1/memory') return reply(200, { id: `ret-${requests.length}` })
    if (request.method === 'GET' && (path === '/v1/memories' || path.startsWith('/v1/memory/profile/'))) return reply(200, { memories: [] })
    return reply(404, { message: 'not served by this recorder' })
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

const dataDir = mkdtempSync(join(tmpdir(), 'retaindb-importance-'))
const workspace = mkdtempSync(join(tmpdir(), 'retaindb-importance-workspace-'))
const runner = new MemoryCompositionRunner()
try {
  await runner.mount(strategyPlugin, { instanceId: 'probe-strategy' })
  await runner.mount(spacesPlugin, { instanceId: 'memory-spaces', config: {
    dataDir, timeoutMs: 20_000, providers: [{ use: 'dsh-mnemon-provider-retaindb', instanceId: 'retaindb' }],
  } })
  const spaces = await runner.managementClient('source:memory-spaces', { storage: 'global', workspaceId: realpathSync(workspace) })
  await spaces.mutate('provider-service-update', {
    providerId: 'retaindb', enabled: true,
    settings: { endpoint: `http://127.0.0.1:${server.address().port}`, apiKey: 'probe-key' },
  }, { confirmed: true })
  const space = (await spaces.read('bodies', {})).value.items.find(item => item.provider.id === 'retaindb')
  if (space === undefined) throw new Error('RetainDB discovery did not mount a space')
  const writes = [
    ['Release notes are drafted on Monday', 1],
    ['Release approvals need a completed canary', 5],
    ['Release branches are cut from main', undefined],
  ]
  for (const [content, importance] of writes) {
    await spaces.mutate('remember', { content, ...(importance === undefined ? {} : { importance }), memoryBodyId: space.id }, { confirmed: true })
  }
  const sent = requests.filter(request => request.method === 'POST' && request.path === '/v1/memory').map(request => request.body)
  const out = {
    writes: writes.map(([content, importance]) => ({ content, importance: importance ?? null })),
    requests: requests.map(request => `${request.method} ${request.path}`),
    sent,
  }
  writeFileSync(process.argv[2], `${JSON.stringify(out, null, 2)}\n`)
  console.log(JSON.stringify(out, null, 1))
} finally {
  await runner.dispose?.()
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
