import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { ClientConnectionHandle, ClientSettingsScope, ClientSettingsSnapshot, Config, MNEMON_READ_CHANNEL, MNEMON_WRITE_CHANNEL, MnemonRpcEndpoint } from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import type { MnemonChangeSignal } from './change-signal.ts'
import type { MemoryComponentConfigurationSnapshot, MemoryComponentHost } from './component-ui.tsx'

interface Lent {
  reads: readonly string[]
  owns: readonly string[]
  read: readonly MnemonRpcEndpoint<typeof MNEMON_READ_CHANNEL>[]
  write: readonly MnemonRpcEndpoint<typeof MNEMON_WRITE_CHANNEL>[]
  join: readonly string[]
}

const LENT: Readonly<Record<string, Lent>> = {
  'dsh-mnemon-source-memory-spaces': {
    reads: ['embedding', 'persistenceStrategy', 'defaultRecallLimit', 'recallQuality', 'timeoutMs', 'storageScope', 'writeEnabled'],
    owns: ['embedding', 'persistenceStrategy', 'defaultRecallLimit', 'recallQuality', 'timeoutMs'],
    read: ['status-summary', 'embedding-status', 'provider-services'],
    write: ['embedding-fill', 'provider-service-update'],
    join: ['status-summary', 'provider-services'],
  },
}

export interface ComponentHostServices {
  scope: ClientSettingsScope<Config>
  connection?: ClientConnectionHandle | undefined
  componentChanges?: Pick<MnemonChangeSignal, 'bump'> | undefined
}

export type ComponentHosts = (packageName: string, sessionId?: string, workspaceId?: string) => MemoryComponentHost | undefined

function configurationOf(scope: ClientSettingsScope<Config>, lent: Lent): MemoryComponentHost['configuration'] {
  let source: ClientSettingsSnapshot<Config> | undefined
  let snapshot: MemoryComponentConfigurationSnapshot = { status: 'loading', writable: false }
  return {
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

const SCOPE_FIELDS = ['sessionId', 'workspaceId']

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
