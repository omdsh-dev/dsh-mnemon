import { describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { OpenVikingProvider, descriptor } from '../src/index.ts'
import { OFFICIAL_PLUGIN_PACKAGE, officialPluginIntegration, readOfficialPlugin } from '../src/official-plugin.ts'

const ROOT = 'viking://user/alice/memories'

/** The official plugin's runtime as it reports itself: its key is a trap that fails the test when read. */
function vendorRuntime(config: Record<string, unknown>) {
  const reads: string[] = []
  const guarded = new Proxy(config, {
    get(target, key) {
      if (key === 'apiKey') throw new Error('the official plugin key was read')
      reads.push(String(key))
      return Reflect.get(target, key)
    },
    set() { throw new Error('the official plugin config was changed') },
  })
  return { reads, runtime: Object.freeze({ config: guarded, capture: () => { throw new Error('the official plugin was called') } }) }
}

const DEFAULTS = {
  clientVersion: '0.5.29', baseUrl: 'http://127.0.0.1:1933', account: 'lab', user: 'alice', apiKey: 'synthetic-only-key',
  autoRecall: true, autoCapture: true, skipSubagentSessions: false, peerId: 'dsh',
}

function provider(officialPlugin?: () => ReturnType<typeof readOfficialPlugin>) {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: 'ok', result: { healthy: true } }), { status: 200 }))
  const { authority, body } = createMemorySpaceProviderFixture(descriptor, {
    endpoint: 'http://127.0.0.1:1933/', targetUri: ROOT, account: 'lab', user: '', actorPeerId: 'dsh',
  }, { dataDir: '/unused', instanceId: 'lab' })
  return { body, fetchMock, provider: new OpenVikingProvider(authority, { fetch: fetchMock, requestTimeoutMs: 1_000, ...(officialPlugin === undefined ? {} : { officialPlugin }) }) }
}

describe('OpenViking official DSH plugin, read only', () => {
  it('reads the named settings of its running service and nothing else: not its key, no call, no write', () => {
    const { reads, runtime } = vendorRuntime(DEFAULTS)
    expect(readOfficialPlugin(() => runtime)).toEqual({
      version: '0.5.29', endpoint: 'http://127.0.0.1:1933', account: 'lab', user: 'alice', autoRecall: true, autoCapture: true, skipSubagentSessions: false,
    })
    expect(new Set(reads)).toEqual(new Set(['clientVersion', 'baseUrl', 'account', 'user', 'autoRecall', 'autoCapture', 'skipSubagentSessions']))
  })

  it('finds nothing where the plugin does not run, or its service has no settings', () => {
    expect(readOfficialPlugin(() => undefined)).toBeUndefined()
    expect(readOfficialPlugin(() => ({}))).toBeUndefined()
    expect(readOfficialPlugin(() => { throw new Error('no service') })).toBeUndefined()
  })

  it('says whether the plugin serves the space, and claims nothing it cannot tell', () => {
    const snapshot = readOfficialPlugin(() => vendorRuntime(DEFAULTS).runtime)!
    expect(officialPluginIntegration(snapshot, { endpoint: 'http://127.0.0.1:1933/', account: 'lab', user: 'alice' }).sameNamespace).toBe(true)
    expect(officialPluginIntegration(snapshot, { endpoint: 'http://127.0.0.1:1933', account: 'lab', user: 'bob' }).sameNamespace).toBe(false)
    expect(officialPluginIntegration(snapshot, { endpoint: 'http://127.0.0.1:1934', account: 'lab', user: 'alice' }).sameNamespace).toBe(false)
    expect(officialPluginIntegration(snapshot, { endpoint: 'http://127.0.0.1:1933', account: '', user: 'alice' }).sameNamespace).toBeUndefined()
    expect(officialPluginIntegration({ ...snapshot, skipSubagentSessions: true }, { endpoint: 'http://127.0.0.1:1933', account: 'lab', user: 'alice' }).notes).toBeUndefined()
    expect(officialPluginIntegration(snapshot, { endpoint: 'http://127.0.0.1:1933', account: 'lab', user: 'alice' })).toMatchObject({
      packageName: OFFICIAL_PLUGIN_PACKAGE, version: '0.5.29', state: 'active',
      automation: { autoRecall: true, autoCapture: true, skipSubagentSessions: false },
      notes: [{ id: 'captures-task-agents', tone: 'caution' }],
    })
  })

  it('names the plugin on the space status, the user taken from the memory URI', async () => {
    const f = provider(() => readOfficialPlugin(() => vendorRuntime(DEFAULTS).runtime))
    const status = await f.provider.status(f.body)
    expect(status).toMatchObject({ healthy: true, integration: { packageName: OFFICIAL_PLUGIN_PACKAGE, sameNamespace: true, user: 'alice' } })
    expect(JSON.stringify(status)).not.toContain('synthetic-only-key')
  })

  it('leaves the status exactly as before where the plugin is not installed', async () => {
    const without = provider()
    expect(await without.provider.status(without.body)).toEqual({ healthy: true })
    const absent = provider(() => undefined)
    expect(await absent.provider.status(absent.body)).toEqual({ healthy: true })
  })
})
