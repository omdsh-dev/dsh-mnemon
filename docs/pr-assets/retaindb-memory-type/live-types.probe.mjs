// Writes every Memory Spaces category at importance 1, 3 and 5 through the real Memory Spaces Source into a new
// project of a running RetainDB Local (provider-lab/, service `retaindb`), then reads back the type, importance and
// original type RetainDB Local stored for each. RetainDB Local infers a type from the text and falls back to the
// type it was sent; the texts here carry none of the words it looks for, so the fallback shows.
// Run from the repository after `pnpm build && pnpm -r build`:
//   node docs/pr-assets/retaindb-memory-type/live-types.probe.mjs http://127.0.0.1:18990 <new project> <out.json>
// Give each run a project that does not exist yet: RetainDB Local returns or merges a repeated memory.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as spacesPlugin from 'dsh-mnemon-source-memory-spaces'
import { CATEGORIES } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import * as strategyPlugin from 'dsh-mnemon-strategy-default-three-tier'

const [endpoint, project, outPath] = process.argv.slice(2)
if (!endpoint || !project || !outPath) throw new Error('usage: live-types.probe.mjs <endpoint> <new project> <out.json>')
const userId = 'rv462'
const writes = CATEGORIES.flatMap(category => [1, 3, 5].map(importance => ({
  category, importance, content: `The staging cluster keeps replica set ${category.slice(0, 3)}-${importance}`,
})))

async function retaindb(path) {
  const response = await fetch(`${endpoint}${path}`)
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`)
  return await response.json()
}

if ((await retaindb('/v1/projects')).projects.some(item => item.slug === project || item.name === project)) {
  throw new Error(`RetainDB Local already has project ${project}; use a new one`)
}

const dataDir = mkdtempSync(join(tmpdir(), 'retaindb-types-'))
const workspace = mkdtempSync(join(tmpdir(), 'retaindb-types-workspace-'))
const runner = new MemoryCompositionRunner()
try {
  await runner.mount(strategyPlugin, { instanceId: 'probe-strategy' })
  await runner.mount(spacesPlugin, { instanceId: 'memory-spaces', config: {
    dataDir, timeoutMs: 20_000, providers: [{ use: 'dsh-mnemon-provider-retaindb', instanceId: 'retaindb' }],
  } })
  const spaces = await runner.managementClient('source:memory-spaces', { storage: 'global', workspaceId: realpathSync(workspace) })
  await spaces.mutate('provider-service-update', { providerId: 'retaindb', enabled: true, settings: { endpoint, apiKey: 'local-lab' } }, { confirmed: true })
  const space = (await spaces.mutate('body-create', {
    name: `Memory type probe ${project}`, description: 'RetainDB memory type probe', active: true,
    providerId: 'retaindb', connection: { project, userId },
  }, { confirmed: true })).value
  const ids = []
  for (const { category, importance, content } of writes) {
    ids.push((await spaces.mutate('remember', { content, category, importance, memoryBodyId: space.id }, { confirmed: true })).value.id)
  }
  const listed = (await retaindb(`/v1/memories?${new URLSearchParams({ project, user_id: userId, limit: '50' })}`)).memories
  const stored = writes.map(({ category, importance, content }, index) => {
    const memory = listed.find(item => item.id === ids[index])
    return {
      category, importance, content, id: ids[index],
      type: memory?.memory_type ?? null, importanceStored: memory?.importance ?? null,
      originalType: memory?.metadata?.original_type ?? null, quality: memory?.metadata?.quality ?? null,
    }
  })
  const out = { endpoint, project, userId, spaceId: space.id, stored }
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  for (const row of stored) console.log(`${row.category.padEnd(10)} ${row.importance}  sent type ${String(row.originalType).padEnd(10)} stored ${String(row.type).padEnd(10)} importance ${row.importanceStored}`)
} finally {
  await runner.dispose?.()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
