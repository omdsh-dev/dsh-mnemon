import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as forward, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveMemorySpacesConfig } from '../src/config.ts'
import { createRunner } from '../src/runner.ts'
import { mutationResultCompletion } from '../src/service.ts'
import { createRegistry, createService } from './providers.ts'

// Issue #434 on a real Hindsight, such as provider-lab's, through a counting proxy: writes aimed at a
// read-only legacy bank must make no Hindsight mutation, while the DSH bank takes its writes and recall
// reads both. Opt in with MNEMON_WRITE_POLICY_HINDSIGHT=http://127.0.0.1:18889. The banks are created
// (chunks extraction, no LLM) and the legacy one seeded directly, as another tool would write it.
// MNEMON_WRITE_POLICY_MODE=main skips the policy, for a run against main's Source; MNEMON_WRITE_POLICY_OUT
// names a file for the record. docs/pr-assets/issue-434-space-write-policy reports a run.
const hindsight = process.env.MNEMON_WRITE_POLICY_HINDSIGHT?.replace(/\/+$/u, '')
const mode = process.env.MNEMON_WRITE_POLICY_MODE === 'main' ? 'main' : 'branch'
const BANKS = ['wp434-legacy', 'wp434-dsh'] as const

interface Logged { method: string; path: string; status: number }

/** Forwards every request to Hindsight unchanged and logs it. */
function countingProxy(target: URL, log: Logged[]): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', chunk => chunks.push(chunk as Buffer))
    incoming.on('end', () => {
      const upstream = forward({ host: target.hostname, port: target.port, method: incoming.method, path: incoming.url, headers: { ...incoming.headers, host: target.host } }, response => {
        log.push({ method: incoming.method ?? 'GET', path: incoming.url ?? '', status: response.statusCode ?? 0 })
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      })
      upstream.on('error', error => { outgoing.writeHead(502); outgoing.end(String(error)) })
      upstream.end(Buffer.concat(chunks))
    })
  })
  return new Promise(resolve => server.listen(Number(process.env.MNEMON_WRITE_POLICY_PROXY_PORT ?? 0), '127.0.0.1', () => resolve(server)))
}

describe.skipIf(hindsight === undefined)('a read-only Hindsight bank takes no write (#434)', () => {
  it(`records the ${mode} behavior`, async () => {
    const lab = `${hindsight}/v1/default/banks`
    const json = async (path: string, init?: RequestInit) => await (await fetch(`${lab}${path}`, { ...init, headers: { 'content-type': 'application/json' } })).json() as Record<string, unknown>
    for (const bank of BANKS) {
      await json(`/${bank}`, { method: 'PUT', body: JSON.stringify({ name: bank, mission: 'dsh-mnemon #434 write-policy check' }) })
      await json(`/${bank}/import`, { method: 'POST', body: JSON.stringify({ version: '1', bank: { retain_extraction_mode: 'chunks', enable_observations: false } }) })
    }
    const held = async (bank: string) => (await json(`/${bank}/memories/list?limit=100`)).total as number
    if (await held('wp434-legacy') === 0) {
      await json('/wp434-legacy/memories', { method: 'POST', body: JSON.stringify({ async: false, items: [
        { content: 'Legacy decision (wp434): the Orion service deploys only after a green canary build.', context: 'legacy-tool' },
        { content: 'Legacy fact (wp434): the Orion billing bank predates DSH and is still written by the legacy tool.', context: 'legacy-tool' },
      ] }) })
    }
    const log: Logged[] = []
    const proxy = await countingProxy(new URL(hindsight!), log)
    const dataDir = mkdtempSync(join(tmpdir(), `wp434-${mode}-`))
    try {
      const config = resolveMemorySpacesConfig({ dataDir, cliPath: '/nonexistent/mnemon', timeoutMs: 60_000 })
      const runner = createRunner(config)
      const service = createService(runner, config, createRegistry(runner, true))
      const before = { legacy: await held('wp434-legacy'), dsh: await held('wp434-dsh') }
      const address = proxy.address() as { port: number }
      await service.updateProviderService('hindsight', { endpoint: `http://127.0.0.1:${address.port}` })
      const spaces = service.memorySpaces.list().filter(space => space.provider.id === 'hindsight')
      for (const space of spaces) if (!BANKS.includes(String(space.provider.settings.bankId) as never)) service.updateSpace(space.id, { active: false })
      const legacy = spaces.find(space => space.provider.settings.bankId === 'wp434-legacy')!
      const dsh = spaces.find(space => space.provider.settings.bankId === 'wp434-dsh')!
      if (mode === 'branch') (service as unknown as { setWritePolicy(id: string, policy: string): unknown }).setWritePolicy(legacy.id, 'read-only')
      const legacyMemory = ((await json('/wp434-legacy/memories/list?limit=10')).items as Array<{ id: string }>)[0]!
      const steps: Array<Record<string, unknown>> = []
      // Every call that changes a bank; recall is a POST that only reads.
      const mutations = (from: number) => Object.fromEntries(BANKS.map(bank => [bank, log.slice(from)
        .filter(row => row.path.startsWith(`/v1/default/banks/${bank}/`) && row.method !== 'GET' && !row.path.endsWith('/memories/recall'))
        .map(row => `${row.method} ${row.path.replace(`/v1/default/banks/${bank}`, '')} ${row.status}`)]))
      const step = async (name: string, run: () => Promise<unknown>) => {
        const from = log.length
        const outcome = await run().then(value => ({ outcome: 'written', completion: Array.isArray(value) ? value.map(item => mutationResultCompletion(item as never)) : mutationResultCompletion(value as never) }),
          (error: unknown) => ({ outcome: 'refused', error: error instanceof Error ? error.message : String(error) }))
        steps.push({ step: name, ...outcome, hindsightMutations: mutations(from) })
      }
      await step('remember naming the legacy space', () => service.remember({ content: `wp434 ${mode}: a new memory aimed at the legacy bank.`, memoryBodyId: legacy.id }))
      await step('rememberMany naming the legacy space', () => service.rememberMany([{ content: `wp434 ${mode}: a batch memory aimed at the legacy bank.`, memoryBodyId: legacy.id }]))
      await step('forget a legacy memory', () => service.forget(legacyMemory.id, undefined, legacy.id))
      service.updateSpace(dsh.id, { active: false })
      await step('capture naming no space, the legacy space the only active one', () => service.remember({ content: `wp434 ${mode}: an automatic capture with no space named.` }))
      service.updateSpace(dsh.id, { active: true })
      await step('remember naming the DSH space', () => service.remember({ content: `wp434 ${mode}: the Orion team moved deploy reviews to Thursdays.`, memoryBodyId: dsh.id }))
      await step('remember naming no space, both active', () => service.remember({ content: `wp434 ${mode}: the Orion on-call rotation is weekly.` }))
      // Hindsight stores a queued write in the background.
      const expected = before.dsh + steps.filter(entry => (entry.hindsightMutations as Record<string, string[]>)['wp434-dsh']!.length > 0).length
      for (let attempt = 0; attempt < 90 && await held('wp434-dsh') < expected; attempt++) await new Promise(resolve => setTimeout(resolve, 1_000))
      const recalled = await service.search({ query: 'Orion', memoryBodyIds: [legacy.id, dsh.id] })
      const record = { mode, at: new Date().toISOString(), before, after: { legacy: await held('wp434-legacy'), dsh: await held('wp434-dsh') }, steps,
        recall: recalled.results.map(item => ({ space: item.memoryBodyId === legacy.id ? 'wp434-legacy' : 'wp434-dsh', content: item.content.slice(0, 90) })) }
      if (process.env.MNEMON_WRITE_POLICY_OUT !== undefined) writeFileSync(process.env.MNEMON_WRITE_POLICY_OUT, JSON.stringify(record, null, 2) + '\n')
      if (mode === 'branch') {
        const legacyWrites = steps.flatMap(entry => (entry.hindsightMutations as Record<string, string[]>)['wp434-legacy']!)
        expect(legacyWrites).toEqual([])
        expect(steps.slice(0, 4).map(entry => entry.outcome)).toEqual(['refused', 'refused', 'refused', 'refused'])
        expect(steps.slice(4).map(entry => [entry.outcome, entry.completion])).toEqual([['written', 'accepted'], ['written', 'accepted']])
        expect(new Set(record.recall.map(item => item.space))).toEqual(new Set(BANKS))
      }
    } finally {
      proxy.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 180_000)
})
