import type { MemorySpaceIntegration } from 'dsh-mnemon-source-memory-spaces/provider-sdk'

/** OpenViking's own DeepSeek Harness plugin, and the service its runtime provides in the profile. */
export const OFFICIAL_PLUGIN_PACKAGE = '@openviking/dsh-memory-plugin'
export const OFFICIAL_PLUGIN_SERVICE = 'openvikingMemory'

/** What the official plugin says about itself that the page may show: no key, no token. */
export interface OfficialPluginSnapshot {
  version?: string
  endpoint?: string
  account?: string
  user?: string
  autoRecall?: boolean
  autoCapture?: boolean
  skipSubagentSessions?: boolean
}

/**
 * Read the official plugin's effective settings from its running service, one named field at a
 * time, through the read-only view the Memory Spaces Source lends. Mnemon never writes to it,
 * never calls it and never reads its key: its tools, recall and capture stay as OpenViking
 * designed them.
 */
export function readOfficialPlugin(lookup: () => unknown): OfficialPluginSnapshot | undefined {
  let config: unknown
  try { config = (lookup() as { config?: unknown } | undefined)?.config } catch { return undefined }
  if (typeof config !== 'object' || config === null) return undefined
  const field = (key: string): unknown => { try { return (config as Record<string, unknown>)[key] } catch { return undefined } }
  const snapshot: OfficialPluginSnapshot = {}
  for (const [key, from] of [['version', 'clientVersion'], ['endpoint', 'baseUrl'], ['account', 'account'], ['user', 'user']] as const) {
    const value = field(from)
    if (typeof value === 'string' && value.trim() !== '') snapshot[key] = value.trim()
  }
  for (const key of ['autoRecall', 'autoCapture', 'skipSubagentSessions'] as const) {
    const value = field(key)
    if (typeof value === 'boolean') snapshot[key] = value
  }
  return snapshot
}

function origin(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '') return undefined
  try {
    const parsed = new URL(url.trim())
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/u, '')}`.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * The official plugin as one space shows it. It shares the space's namespace when it talks to the
 * same server as the same account and user; when either side leaves one of them to the server,
 * that cannot be told and nothing is claimed.
 */
export function officialPluginIntegration(snapshot: OfficialPluginSnapshot, space: { endpoint: string; account: string; user: string }): MemorySpaceIntegration {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [origin(snapshot.endpoint), origin(space.endpoint)],
    [snapshot.account, space.account.trim() || undefined],
    [snapshot.user, space.user.trim() || undefined],
  ]
  const sameNamespace = pairs.some(([plugin, own]) => plugin !== undefined && own !== undefined && plugin !== own)
    ? false
    : pairs.every(([plugin, own]) => plugin !== undefined && own !== undefined) ? true : undefined
  return {
    packageName: OFFICIAL_PLUGIN_PACKAGE,
    label: 'OpenViking',
    ...(snapshot.version === undefined ? {} : { version: snapshot.version }),
    automation: {
      ...(snapshot.autoRecall === undefined ? {} : { autoRecall: snapshot.autoRecall }),
      ...(snapshot.autoCapture === undefined ? {} : { autoCapture: snapshot.autoCapture }),
      ...(snapshot.skipSubagentSessions === undefined ? {} : { skipSubagentSessions: snapshot.skipSubagentSessions }),
    },
    ...(snapshot.endpoint === undefined ? {} : { endpoint: snapshot.endpoint }),
    ...(snapshot.account === undefined ? {} : { account: snapshot.account }),
    ...(snapshot.user === undefined ? {} : { user: snapshot.user }),
    ...(sameNamespace === undefined ? {} : { sameNamespace }),
    state: 'active',
    ...(snapshot.skipSubagentSessions === false ? { notes: [{
      id: 'captures-task-agents', tone: 'caution',
      text: 'It also captures the sessions of task Agents, dsh-mnemon\'s included, unless skipSubagentSessions is set.',
      textI18nKey: 'providerViews.openviking.capturesTaskAgents',
    }] } : {}),
  }
}
