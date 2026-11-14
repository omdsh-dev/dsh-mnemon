import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { MnemonClient } from '../src/client/api.ts'
import { createComponentHosts } from '../src/client/component-host.ts'
import { MnemonSettingsScope } from '../src/client/settings.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { HostConnectionHandle, HostRpcHandler, HostSettingsService, RpcResult } from '../src/host/dsh.ts'
import type { MnemonLifecycle } from '../src/host/lifecycle.ts'
import type { MemoryPluginManagement } from '../src/host/plugin-management.ts'
import {
  MNEMON_ACTIVATION_CHANNEL, MNEMON_PACK_CHANNEL, MNEMON_READ_CHANNEL, MNEMON_REVIEW_CHANNEL, MNEMON_RPC_ENDPOINTS, MNEMON_SETTINGS_CHANNEL,
  MNEMON_SYNC_CHANNEL, MNEMON_VIEW_CHANNEL, MNEMON_VIEW_WRITE_CHANNEL, MNEMON_WRITE_CHANNEL,
  type ClientConnectionHandle, type ClientSettingsScope, type Config, type MnemonRpcChannel,
} from '../src/host/protocol.ts'
import { registerRpc } from '../src/host/rpc.ts'
import type { LiveMnemonRuntime } from '../src/host/runtime.ts'
import { registerSettingsRpc } from '../src/host/settings.ts'
import type { VersionUpdateManager } from '../src/host/version-updates.ts'
import { registerViewRpc } from '../src/host/view-rpc.ts'
import type { MemoryRuntime } from '../src/core/runtime.ts'

const channels = Object.keys(MNEMON_RPC_ENDPOINTS) as MnemonRpcChannel[]
/** Channel and endpoint pairs, each once, in a stable order. */
const pairs = (entries: Iterable<readonly [string, string]>): string[] => [...new Set([...entries].map(([channel, endpoint]) => channel + ' ' + endpoint))].sort()
const LISTED = pairs(channels.flatMap(channel => MNEMON_RPC_ENDPOINTS[channel].map(endpoint => [channel, endpoint] as const)))

/**
 * What each Host handler answers an endpoint it does not serve. The View handlers check a name
 * against the list first, so one listed there that nothing dispatches gets their second answer.
 */
const VIEW_UNKNOWN = ['View operation is not available on this channel', 'Unknown View operation']
const UNKNOWN: Record<MnemonRpcChannel, (endpoint: string) => readonly string[]> = {
  [MNEMON_READ_CHANNEL]: endpoint => ['unknown read endpoint: ' + endpoint],
  [MNEMON_ACTIVATION_CHANNEL]: endpoint => ['unknown activation endpoint: ' + endpoint],
  [MNEMON_WRITE_CHANNEL]: endpoint => ['unknown write endpoint: ' + endpoint],
  [MNEMON_PACK_CHANNEL]: endpoint => ['unknown Pack endpoint: ' + endpoint],
  [MNEMON_SYNC_CHANNEL]: endpoint => ['unknown sync endpoint: ' + endpoint],
  [MNEMON_REVIEW_CHANNEL]: endpoint => ['unknown review endpoint: ' + endpoint],
  [MNEMON_SETTINGS_CHANNEL]: endpoint => ['unknown settings endpoint: ' + endpoint],
  [MNEMON_VIEW_CHANNEL]: () => VIEW_UNKNOWN,
  [MNEMON_VIEW_WRITE_CHANNEL]: () => VIEW_UNKNOWN,
}

/**
 * Every lowercase word the Host's handler modules spell, as a string or a name: more than the
 * endpoint names they compare, so a name served without being listed is found too.
 */
function handlerWords(): string[] {
  const words = new Set<string>()
  for (const file of ['src/host/rpc.ts', 'src/host/settings.ts', 'src/host/view-rpc.ts']) {
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteralLike(node) || ts.isIdentifier(node)) && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(node.text)) words.add(node.text)
      ts.forEachChild(node, visit)
    }
    visit(ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true))
  }
  return [...words]
}

/**
 * The handlers the Host registers, over just enough of a Host for each to reach its dispatch:
 * stores, Agents, Git and the registry are stand-ins that answer at once.
 */
function hostHandlers(): Map<string, HostRpcHandler> {
  const answer = vi.fn(async () => ({}))
  const source = { read: answer, mutate: answer, identity: vi.fn(async () => ({ sourceInstanceKey: 'source:mnemon-source-runtime' })) }
  const generation = {
    managementCatalog: vi.fn(async () => ({ generationId: 'g1', sources: [] })),
    managementRevision: vi.fn(async () => 'r1'),
    executeManagement: vi.fn(async () => ({ revision: 'r1', value: {} })),
    sourceInstances: () => [],
    strategy: { definition: { manifest: { typeId: 'default-three-tier' } } },
  }
  const config = resolveConfig({})
  const graph = {
    config, directory: '/fixture/data', source: () => source,
    memoryComposition: { current: () => generation, acquire: () => ({ generation, release: () => {} }), inspect: () => ({ evaluation: { state: 'ready' } }) },
    storage: { catalog: () => ({}) },
    packs: { target: () => ({}), exportPack: answer, inspectPack: () => ({}), importPack: answer },
    sync: { status: answer, configure: answer, push: answer, preview: answer, backups: answer, diff: answer, pull: answer },
  }
  const route = { graph, participation: { excluded: false }, selectedRoot: '/fixture/data', effectiveRoot: '/fixture/data', aligned: true, liveSession: false }
  const runtime = {
    config, route: () => route, workspaceParticipations: () => [],
    sync: { github: () => ({ status: answer, start: answer, poll: answer, cancel: answer, signOut: answer, repositories: answer, create: answer }) },
    reviews: { view: () => ({}), addOpinion: () => ({}), decide: () => ({}), reopen: () => ({}), get: () => undefined },
  } as unknown as LiveMnemonRuntime
  const lifecycle = {
    workspaceRoot: () => '/fixture/workspace', snapshot: () => ({ enabled: true, taskAgentAvailable: true }),
    taskAgentModels: answer, answerTask: answer, superviseTask: answer, reconcile: answer,
    manageSource: vi.fn(async () => ({ revision: 'r1', value: {} })),
    turnActivities: () => ({ cursor: 0, activities: [] }), assistantMessage: () => null, memoryView: () => undefined,
  } as unknown as MnemonLifecycle
  const versions = { check: answer, update: answer, restartStatus: () => undefined, runningVersion: '0.0.0' } as unknown as VersionUpdateManager
  const settings = {
    writable: false, mutate: answer,
    describe: () => [{ ns: 'mnemon', value: {}, base: {}, user: {}, revision: 1 }],
  } as unknown as HostSettingsService
  const management = { resolveConfig: (value: unknown) => value, catalog: async () => ({}) } as unknown as MemoryPluginManagement
  const engine = { contributionSnapshot: () => ({ sources: [] }) } as unknown as MemoryRuntime
  const handlers = new Map<string, HostRpcHandler>()
  const connection = { rpc: { handle: (channel: string, handler: HostRpcHandler) => { handlers.set(channel, handler) } } } as unknown as HostConnectionHandle
  registerRpc(connection, runtime, lifecycle, versions)
  registerSettingsRpc(connection, settings)
  registerViewRpc(connection, runtime, engine, management, lifecycle)
  return handlers
}

/** Every channel and endpoint the shipped client sends, from each of its callers. */
async function clientCalls(): Promise<Array<readonly [string, string]>> {
  const calls: Array<readonly [string, string]> = []
  const connection = {
    isLoopback: true,
    rpc: { call: vi.fn(async (channel: string, endpoint: string) => {
      calls.push([channel, endpoint])
      return { ok: true as const, value: endpoint === 'turn-activities' ? { cursor: 1, activities: [] } : {} }
    }) },
  } as unknown as ClientConnectionHandle

  const client = new MnemonClient(connection, 'session-1', 'workspace-1')
  const methods: Record<string, () => Promise<unknown>> = {
    status: () => client.status(),
    statusSummary: () => client.statusSummary(),
    memorySystem: () => client.memorySystem(),
    viewDashboard: () => client.viewDashboard(),
    applyView: () => client.applyView({ expectedRevision: 'r1', strategyTypeId: 'default-three-tier', entries: {} }),
    sourceManagementCatalog: () => client.sourceManagementCatalog(),
    readSourceManagement: () => client.readSourceManagement('source:spaces', 'snapshot'),
    mutateSourceManagement: () => client.mutateSourceManagement('source:spaces', 'mutate', {}, 'r1', true),
    // Activation, a confirmed write and an unconfirmed read each take their own channel.
    assistSource: () => Promise.all([
      client.assistSource('source:spaces', 'activation', {}, 'r1', true),
      client.assistSource('source:spaces', 'supervise', {}, 'r1', true),
      client.assistSource('source:spaces', 'agent-search', {}, 'r1', false),
    ]),
    taskAgentModels: () => client.taskAgentModels(),
    versions: () => client.versions(),
    updateVersion: () => client.updateVersion('mnemon'),
    turnActivity: () => client.turnActivity(1),
    assistantMessageText: () => client.assistantMessageText('message-1'),
    skillActivity: () => client.skillActivity(),
    supervise: () => client.supervise('A durable fact'),
    packTarget: () => client.packTarget(),
    exportPack: () => client.exportPack(),
    inspectPack: () => client.inspectPack('eA=='),
    importPack: () => client.importPack('eA=='),
    reviewLedger: () => client.reviewLedger(),
    reconcile: () => client.reconcile(),
    reviewOpinion: () => client.reviewOpinion('entry-1', 'Keep it'),
    decideReview: () => client.decideReview('entry-1', 'accepted'),
    reopenReview: () => client.reopenReview('entry-1'),
    applyReview: () => client.applyReview('entry-1'),
    syncStatus: () => client.syncStatus(),
    configureSync: () => client.configureSync({}),
    pushSync: () => client.pushSync(),
    previewSync: () => client.previewSync(),
    syncBackups: () => client.syncBackups(),
    syncDiff: () => client.syncDiff(),
    pullSync: () => client.pullSync(),
    githubStatus: () => client.githubStatus(),
    githubStart: () => client.githubStart(),
    githubPoll: () => client.githubPoll(),
    githubCancel: () => client.githubCancel(),
    githubSignOut: () => client.githubSignOut(),
    githubRepositories: () => client.githubRepositories(),
    githubCreateRepository: () => client.githubCreateRepository('memory', true),
  }
  // Every method that calls the Host, so one added later has to be added here too. The
  // component operations run through the hosts a page lends components, below.
  const own = Object.getOwnPropertyNames(MnemonClient.prototype).filter(name => !['constructor', 'call', 'scoped', 'componentOperation'].includes(name))
  expect(Object.keys(methods).sort()).toEqual(own.sort())
  for (const run of Object.values(methods)) await run()

  // A component's settings name the Host operations they want; the page serves only those it lends.
  const scope: ClientSettingsScope<Config> = { getSnapshot: () => ({ status: 'ready', writable: true, mode: 'host' }), subscribe: () => () => {}, mutate: async () => {} }
  const hosts = createComponentHosts({ scope, connection })
  const probes = [...new Set(Object.values(MNEMON_RPC_ENDPOINTS).flat())]
  for (const packageName of ['dsh-mnemon-source-runtime', 'dsh-mnemon-source-documents', 'dsh-mnemon-source-memory-spaces']) {
    const operations = hosts(packageName, 'session-1', 'workspace-1')?.operations
    for (const operation of probes) {
      await operations?.read(operation, {}).catch(() => undefined)
      await operations?.write(operation, {}).catch(() => undefined)
    }
  }

  const settings = new MnemonSettingsScope(connection)
  await settings.mutate([{ op: 'set', path: ['routingGuidance'], value: true }])
  return calls
}

/**
 * Endpoints the Host serves that the shipped client no longer calls. The workbench's pages moved to
 * Source management and Host assistance in September 2026, and the turn bar to the bulk
 * `turn-activities` read in August; the Host kept the direct endpoints, which the Interfaces
 * reference still lists and scripts such as verify-sync-git.mjs use.
 */
const SERVED_FOR_OTHER_CALLERS = pairs([
  ...['runtime-memory', 'documents', 'document', 'document-search', 'graph', 'bodies', 'body-directory', 'body-reconnect',
    'list', 'entities', 'search', 'agent-search', 'related', 'turn-activity'].map(endpoint => [MNEMON_READ_CHANNEL, endpoint] as const),
  [MNEMON_ACTIVATION_CHANNEL, 'body'],
  ...['runtime-memory', 'document', 'remember', 'link', 'forget', 'body-create', 'body-update', 'body-delete', 'body-merge',
    'body-metadata-maintain'].map(endpoint => [MNEMON_WRITE_CHANNEL, endpoint] as const),
  [MNEMON_VIEW_CHANNEL, 'preview'], [MNEMON_VIEW_CHANNEL, 'inspect-plugin'], [MNEMON_VIEW_WRITE_CHANNEL, 'install-plugin'],
])

describe('RPC endpoint names', () => {
  it('has the Host serve exactly the listed endpoints on each channel it registers', async () => {
    const handlers = hostHandlers()
    expect([...handlers.keys()].sort()).toEqual([...channels].sort())
    // Every name any channel lists, and every word the handlers spell, against every channel.
    const probes = [...new Set([...Object.values(MNEMON_RPC_ENDPOINTS).flat(), ...handlerWords(), 'unlisted-endpoint'])]
    expect(probes.length).toBeGreaterThan(200)
    const refused: Array<[string, string]> = []
    for (const channel of channels) {
      for (const endpoint of probes) {
        const response = await handlers.get(channel)!(endpoint, {}, new AbortController().signal) as RpcResult<unknown>
        if (!response.ok && UNKNOWN[channel](endpoint).includes(response.error.message)) refused.push([channel, endpoint])
      }
    }
    const unknown = new Set(pairs(refused))
    const served = pairs(channels.flatMap(channel => probes.map(endpoint => [channel, endpoint] as const))).filter(pair => !unknown.has(pair))
    expect(served).toEqual(LISTED)
  })

  it('has the client call only endpoints the Host serves, and the Host serve only those and the ones kept for other callers', async () => {
    const called = pairs(await clientCalls())
    expect(called.filter(pair => !LISTED.includes(pair))).toEqual([])
    expect(LISTED.filter(pair => !called.includes(pair))).toEqual(SERVED_FOR_OTHER_CALLERS)
  })
})
