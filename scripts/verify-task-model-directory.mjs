import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { resolveConfig } from '../src/host/config.ts'

if (!process.argv[2]) throw new Error('Usage: node --experimental-transform-types scripts/verify-task-model-directory.mjs DSH_PACKAGE_JSON [OUTPUT_JSON]')
const host = createRequire(realpathSync(process.argv[2]))
const { Context } = await import(host.resolve('@deepseek-ai/cordis'))
const { default: LlmRuntime } = await import(host.resolve('@deepseek-ai/dsh-llm'))
const ApiKey = await import(host.resolve('@deepseek-ai/dsh-llm-deepseek-api-key'))
const ctx = new Context()
const originalFetch = globalThis.fetch
const calls = []
globalThis.fetch = async input => {
  const url = String(input instanceof Request ? input.url : input)
  assert.equal(url, 'https://api.deepseek.com/models', 'Only the synthetic model directory may be requested')
  calls.push({ url, at: performance.now() })
  await new Promise(resolve => setTimeout(resolve, 3600))
  return new Response(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', api_capabilities: { anthropic_messages: {} } }] }), { headers: { 'content-type': 'application/json' } })
}
process.env.DSH_COMPAT_AUDIT_KEY = 'synthetic-no-network-key'
try {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ApiKey, { apiKeyEnv: 'DSH_COMPAT_AUDIT_KEY' })
  const llm = ctx.get('llm')
  assert(llm.listProviders().some(provider => provider.id === 'deepseek-official'))
  const lifecycle = new MnemonLifecycle({
    agents: { get: () => undefined },
    get: name => name === 'llm' ? llm : undefined,
  }, {}, resolveConfig({}))
  const started = performance.now()
  const first = await lifecycle.taskAgentModels()
  const firstMs = Math.round(performance.now() - started)
  const hostModels = await llm.listModels('deepseek-official')
  const hostFinishedMs = Math.round(performance.now() - started)
  const retry = await lifecycle.taskAgentModels()
  const result = { dsh: host('@deepseek-ai/dsh/package.json').version, simulatedNetworkMs: 3600, firstMs, first,
    hostFinishedMs, hostModels: hostModels.map(model => model.id), retry, networkRequests: calls.length, realNetworkRequests: 0 }
  assert.equal(first.failures.length, 0, 'the first directory load must not time out before DSH finishes')
  assert(first.groups.some(group => group.id === 'deepseek-official' && group.models.length > 0))
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  globalThis.fetch = originalFetch
  delete process.env.DSH_COMPAT_AUDIT_KEY
  await ctx.fiber.dispose()
}
