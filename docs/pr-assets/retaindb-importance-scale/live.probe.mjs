// Writes four memories through the real Memory Spaces Source into a project of a running RetainDB Local
// (provider-lab/, service `retaindb`), then reads back what RetainDB Local stored and the order it recalls
// them in. Run from the repository after `pnpm build && pnpm -r build`:
//   node docs/pr-assets/retaindb-importance-scale/live.probe.mjs http://127.0.0.1:18990 <new project> <out.json>
// Give each run a project that does not exist yet: RetainDB Local returns or merges a repeated memory
// instead of storing it again, so a second run into the same project would read back the first run's values.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as spacesPlugin from 'dsh-mnemon-source-memory-spaces'
import * as strategyPlugin from 'dsh-mnemon-strategy-default-three-tier'

const [endpoint, project, outPath] = process.argv.slice(2)
if (!endpoint || !project || !outPath) throw new Error('usage: live.probe.mjs <endpoint> <new project> <out.json>')
const userId = 'rv462'
const query = 'release step check before tagging the version'
// Same length and wording, so RetainDB Local gives each the same type and quality; only the importance differs.
const writes = [
  ['Release step one: check the changelog before tagging the version', 1],
  ['Release step two: check the licenses before tagging the version', 3],
  ['Release step three: check the canary before tagging the version', 5],
  ['Release step four: check the translations before tagging the version', undefined],
]

async function retaindb(path, init = {}) {
  const response = await fetch(`${endpoint}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } })
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${response.status}`)
  return await response.json()
}

const before = await retaindb('/v1/projects')
if (before.projects.some(item => item.slug === project || item.name === project)) throw new Error(`RetainDB Local already has project ${project}; use a new one`)

const dataDir = mkdtempSync(join(tmpdir(), 'retaindb-live-'))
const workspace = mkdtempSync(join(tmpdir(), 'retaindb-live-workspace-'))
const runner = new MemoryCompositionRunner()
try {
  await runner.mount(strategyPlugin, { instanceId: 'probe-strategy' })
  await runner.mount(spacesPlugin, { instanceId: 'memory-spaces', config: {
    dataDir, timeoutMs: 20_000, providers: [{ use: 'dsh-mnemon-provider-retaindb', instanceId: 'retaindb' }],
  } })
  const spaces = await runner.managementClient('source:memory-spaces', { storage: 'global', workspaceId: realpathSync(workspace) })
  // As scripts/seed-provider-lab.mjs does: service settings first, then a space for one project and user.
  await spaces.mutate('provider-service-update', { providerId: 'retaindb', enabled: true, settings: { endpoint, apiKey: 'local-lab' } }, { confirmed: true })
  const space = (await spaces.mutate('body-create', {
    name: `Importance probe ${project}`, description: 'RetainDB importance scale probe', active: true,
    providerId: 'retaindb', connection: { project, userId },
  }, { confirmed: true })).value
  const ids = []
  for (const [content, importance] of writes) {
    const receipt = (await spaces.mutate('remember', { content, ...(importance === undefined ? {} : { importance }), memoryBodyId: space.id }, { confirmed: true })).value
    ids.push(receipt.id)
  }
  const label = id => {
    const index = ids.indexOf(id)
    return index < 0 ? id : writes[index][1] === undefined ? 'none' : String(writes[index][1])
  }

  // What RetainDB Local stored, read from its own listing.
  const listed = (await retaindb(`/v1/memories?${new URLSearchParams({ project, user_id: userId, limit: '10' })}`)).memories
  const stored = writes.map(([content, importance], index) => {
    const memory = listed.find(item => item.id === ids[index])
    return {
      content, importanceWritten: importance ?? null, id: ids[index], type: memory?.memory_type ?? null,
      importance: memory?.importance ?? null, confidence: memory?.confidence ?? null,
      strength: memory?.metadata?.strength ?? null, quality: memory?.metadata?.quality ?? null,
    }
  })

  // RetainDB Local's own recall, with the request the Provider sends for this space.
  const direct = await retaindb('/v1/memory/search', { method: 'POST', body: JSON.stringify({
    project, query, user_id: userId, session_id: `dsh-${space.id}`, top_k: 10, include_pending: true,
  }) })
  const recall = direct.results.map(row => ({ importanceWritten: label(row.id), score: row.score, importance: row.memory.importance, scores: row.scores }))

  // The same recall through the Memory Spaces Source.
  const throughSource = (await spaces.read('search', { query, memoryBodyIds: [space.id], limit: 10 })).value.results
    .map(row => ({ importanceWritten: label(row.id), score: row.score }))

  const out = { endpoint, project, userId, query, spaceId: space.id, stored, recall, throughSource }
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  console.log(JSON.stringify(out, null, 1))
} finally {
  await runner.dispose?.()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
