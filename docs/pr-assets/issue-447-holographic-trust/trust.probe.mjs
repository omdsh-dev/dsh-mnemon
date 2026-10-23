// Writes three memories through the real Memory Spaces Source into a local Holographic space,
// then reads the store and searches it at two minimum trusts. Run from the repository after
// `pnpm build && pnpm -r build`: node docs/pr-assets/issue-447-holographic-trust/trust.probe.mjs <out.json>
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as spacesPlugin from 'dsh-mnemon-source-memory-spaces'
import * as strategyPlugin from 'dsh-mnemon-strategy-default-three-tier'

const dataDir = mkdtempSync(join(tmpdir(), 'issue-447-'))
const workspace = mkdtempSync(join(tmpdir(), 'issue-447-workspace-'))
const dataPath = join(dataDir, 'holographic', 'store.json')
const runner = new MemoryCompositionRunner()
try {
  await runner.mount(strategyPlugin, { instanceId: 'probe-strategy' })
  await runner.mount(spacesPlugin, { instanceId: 'memory-spaces', config: {
    dataDir, timeoutMs: 20_000, providers: [{ use: 'dsh-mnemon-provider-holographic', instanceId: 'holographic' }],
  } })
  const spaces = await runner.managementClient('source:memory-spaces', { storage: 'global', workspaceId: realpathSync(workspace) })
  const space = (await spaces.mutate('body-create', { name: 'Facts', description: 'Issue 447 probe', active: true, providerId: 'holographic',
    connection: { dataPath, defaultTrust: 0.5, minTrust: 0.3 } }, { confirmed: true })).value
  const writes = [
    ['Release notes are drafted on Monday', 1],
    ['Release approvals need a completed canary', 5],
    ['Release branches are cut from main', undefined],
  ]
  for (const [content, importance] of writes) {
    await spaces.mutate('remember', { content, ...(importance === undefined ? {} : { importance }), memoryBodyId: space.id }, { confirmed: true })
  }
  const stored = JSON.parse(readFileSync(dataPath, 'utf8')).facts.map(fact => ({ content: fact.content, trustScore: fact.trustScore, importance: fact.importance ?? null }))
  const search = async () => (await spaces.read('search', { query: 'release', memoryBodyIds: [space.id], limit: 10 })).value.results
    .map(row => ({ content: row.content, score: row.score, importance: row.importance ?? null }))
  const atDefault = await search()
  await spaces.mutate('body-update', { memoryBodyId: space.id, connection: { dataPath, defaultTrust: 0.5, minTrust: 0.5 } }, { confirmed: true })
  const atHalf = await search()
  const out = { stored, search: { 'minTrust 0.3': atDefault, 'minTrust 0.5': atHalf } }
  writeFileSync(process.argv[2], JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 1))
} finally {
  await runner.dispose?.()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
