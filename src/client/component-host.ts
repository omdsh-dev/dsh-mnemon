import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { ClientConnectionHandle, ClientSettingsScope, ClientSettingsSnapshot, Config, MNEMON_READ_CHANNEL, MNEMON_WRITE_CHANNEL, MnemonRpcEndpoint } from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import type { MnemonChangeSignal } from './change-signal.ts'
import type { MemoryComponentConfigurationSnapshot, MemoryComponentHost } from './component-ui.tsx'

/** What dsh-mnemon serves a shipped component whose settings it used to draw itself. */
interface Lent {
  /** Configuration keys its settings read. */
  reads: readonly string[]
  /** The ones it owns and may write. */
  owns: readonly string[]
  /** Host operations on the read and write channels, by the names the Host serves them under. */
  read: readonly MnemonRpcEndpoint<typeof MNEMON_READ_CHANNEL>[]
  write: readonly MnemonRpcEndpoint<typeof MNEMON_WRITE_CHANNEL>[]
  /**
   * Reads the settings make on their own, which a later mount may join while the same one is
   * under way at the same configuration revision. A read the user asks for is never joined.
   */
  join: readonly string[]
}

const LENT: Readonly<Record<string, Lent>> = {
  // Memory Spaces' Providers, Space policy, recall parameters and the embedding runtime only Mnemon
  // Native reads. Where memory is stored scopes a Provider, and a read-only Mnemon takes no fill.
  'dsh-mnemon-source-memory-spaces': {
    reads: ['embedding', 'persistenceStrategy', 'defaultRecallLimit', 'recallQuality', 'timeoutMs', 'storageScope', 'writeEnabled'],
    owns: ['embedding', 'persistenceStrategy', 'defaultRecallLimit', 'recallQuality', 'timeoutMs'],
    read: ['status-summary', 'embedding-status', 'provider-services'],
    write: ['embedding-fill', 'provider-service-update'],
    // An embedding test checks the connection as it is now, so it always asks the Host.
    join: ['status-summary', 'provider-services'],
  },
}

export interface ComponentHostServices {
  scope: ClientSettingsScope<Config>
  connection?: ClientConnectionHandle | undefined
  componentChanges?: Pick<MnemonChangeSignal, 'bump'> | undefined
}

/** The host one component's settings get on a page opened for a conversation and workspace, or none. */
export type ComponentHosts = (packageName: string, sessionId?: string, workspaceId?: string) => MemoryComponentHost | undefined

function configurationOf(scope: ClientSettingsScope<Config>, lent: Lent): MemoryComponentHost['configuration'] {
  let source: ClientSettingsSnapshot<Config> | undefined
  let snapshot: MemoryComponentConfigurationSnapshot = { status: 'loading', writable: false }
  return {
    // A snapshot that has not changed reads as the same object, as React's external stores require.
    getSnapshot() {
      const current = scope.getSnapshot()
      if (current === source) return snapshot
      source = current
      const value = current.value as Readonly<Record<string, unknown>> | undefined
      snapshot = {
        status: current.status, writable: current.writable,
        ...(current.revision === undefined ? {} : { revision: current.revision }),
        ...(value === undefined ? {} : { value: Object.fromEntries(lent.reads.flatMap(key => Object.hasOwn(value, key) ? [[key, value[key]]] : [])) }),
      }
      return snapshot
    },
    subscribe: listener => scope.subscribe(listener),
    async set(key: string, value: MemoryJsonValue) {
      if (!lent.owns.includes(key)) throw new Error(`dsh-mnemon does not lend this component the setting ${key}`)
      await scope.mutate([{ op: 'set', path: [key], value }])
    },
  }
}

// The page binds every operation to its own conversation and workspace; a component cannot name others.
const SCOPE_FIELDS = ['sessionId', 'workspaceId']

/**
 * The hosts a page lends shipped components, one per component, conversation
 * and workspace, so a component's effects see the same object on every render
 * and what its settings retain survives their mounting again. The client keeps
 * them while it runs, as it keeps one settings scope: one small object for each
 * conversation and workspace the page was opened for.
 */
export function createComponentHosts(services: ComponentHostServices): ComponentHosts {
  const configurations = new Map<string, MemoryComponentHost['configuration']>()
  const hosts = new Map<string, MemoryComponentHost>()
  return (packageName, sessionId, workspaceId) => {
    const lent = LENT[packageName]
    if (lent === undefined) return undefined
    const key = [packageName, sessionId ?? '', workspaceId ?? ''].join('\u0000')
    let host = hosts.get(key)
    if (host !== undefined) return host
    let configuration = configurations.get(packageName)
    if (configuration === undefined) {
      configuration = configurationOf(services.scope, lent)
      configurations.set(packageName, configuration)
    }
    const { connection, componentChanges } = services
    const client = connection === undefined ? undefined : new MnemonClient(connection, sessionId, workspaceId)
    const call = (mode: 'read' | 'write', names: Lent['read'] | Lent['write'], operation: string, input: MemoryJsonValue | undefined): Promise<unknown> => {
      const endpoint = names.find(name => name === operation)
      if (endpoint === undefined) return Promise.reject(new Error(`dsh-mnemon does not serve this component the ${mode} operation ${operation}`))
      if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) return Promise.reject(new Error(`${operation} takes an object`))
      const named = SCOPE_FIELDS.filter(field => input !== undefined && Object.hasOwn(input, field))
      if (named.length > 0) return Promise.reject(new Error(`${operation} runs in the page's conversation and workspace; it takes no ${named.join(' or ')}`))
      return client!.componentOperation(mode, endpoint, input ?? {})
    }
    // A read the settings start while the same one is under way joins it, as when the
    // component's own settings replace dsh-mnemon's while those still load. Only one started
    // at the configuration's current revision: an older one answers for a configuration that
    // has since changed, such as another storage scope.
    const reading = new Map<string, Promise<unknown>>()
    const read = (operation: string, input: MemoryJsonValue | undefined): Promise<unknown> => {
      if (!lent.join.includes(operation)) return call('read', lent.read, operation, input)
      const key = [operation, services.scope.getSnapshot().revision ?? '', JSON.stringify(input ?? {})].join('\u0000')
      let pending = reading.get(key)
      if (pending === undefined) {
        pending = call('read', lent.read, operation, input).finally(() => { reading.delete(key) })
        reading.set(key, pending)
      }
      return pending
    }
    host = {
      configuration,
      ...(client === undefined ? {} : { operations: {
        read,
        write: (operation, input) => call('write', lent.write, operation, input),
      } }),
      changed: () => { componentChanges?.bump() },
      retained: new Map(),
    }
    hosts.set(key, host)
    return host
  }
}
