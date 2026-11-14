import { randomUUID } from 'node:crypto'
import { resolveEmbedding } from 'dsh-mnemon-source-memory-spaces'
import {
  EMBEDDING_CREDENTIAL_PREFIX,
  type MnemonEmbeddingConfig,
  type MnemonEmbeddingCredential,
  type MnemonEmbeddingSettingsView,
} from 'dsh-mnemon-source-memory-spaces/contracts'
import type { HostCredentialsService, HostSettingsService } from '../dsh.ts'
import { githubGrantFromRecord, MNEMON_SYNC_GITHUB_CREDENTIAL_KEY, type MnemonGitHubCredentialPort } from '../github-auth.ts'
import { MNEMON_SETTINGS_NAMESPACE, type SettingsOperation } from '../protocol.ts'

export type EmbeddingCredentialStore = () => HostCredentialsService | undefined

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Preserve other Host redaction while never returning a legacy inline key. */
export function publicEmbeddingSettings(value: unknown, original: unknown, metadata = false): unknown {
  const config = object(value)
  if (!metadata && config.embedding === undefined) return value
  const embedding = object(config.embedding)
  const raw = object(object(original).embedding)
  const apiKeyStorage: MnemonEmbeddingSettingsView['apiKeyStorage'] = raw.apiKeyEnv ? 'environment' : raw.apiKeyRef ? 'credentials' : raw.apiKey ? 'legacy' : 'none'
  return {
    ...config,
    embedding: {
      ...embedding,
      ...('apiKey' in embedding ? { apiKey: '' } : {}),
      ...(metadata ? { apiKeyStorage, apiKeyConfigured: apiKeyStorage !== 'none' } : {}),
    },
  }
}

/** Write/verify a new record before referencing it; failures keep the old configuration and key intact. */
export async function prepareEmbeddingSettings(
  settings: HostSettingsService,
  namespace: string,
  operations: SettingsOperation[],
  revision: number | undefined,
  store?: EmbeddingCredentialStore,
): Promise<{
  operations: SettingsOperation[]
  revision: number | undefined
  rollback?: () => Promise<void>
  commit?: () => Promise<void>
}> {
  const last = operations.findLastIndex(operation => operation.path.length === 1 && operation.path[0] === 'embedding')
  if (namespace !== MNEMON_SETTINGS_NAMESPACE || last === -1) return { operations, revision }
  const operation = operations[last]!
  // A transaction can set the whole field more than once; only its final value is effective.
  const edits = operations.filter((entry, index) => index === last || entry.path[0] !== 'embedding')
  if (operation.op === 'unset') {
    const view = settings.describe({ redactSecrets: false }).find(candidate => candidate.ns === namespace)
    const previous = view === undefined ? undefined : resolveEmbedding(object(object(view.value).embedding) as MnemonEmbeddingConfig)
    const oldRef = previous?.apiKeyRef
    const commit = oldRef
      ? async () => {
          const credentials = store?.()
          if (credentials !== undefined) await credentials.deleteRecord(oldRef)
        }
      : undefined
    return { operations: edits, revision, ...(commit === undefined ? {} : { commit }) }
  }
  const view = settings.describe({ redactSecrets: false }).find(candidate => candidate.ns === namespace)
  if (view === undefined) throw new Error('Mnemon settings are unavailable')
  if (revision !== undefined && revision !== view.revision) throw new Error('Settings changed; reload before saving the embedding connection')
  const previous = resolveEmbedding(object(object(view.value).embedding) as MnemonEmbeddingConfig)
  const input = object(operation.value)
  if (typeof operation.value !== 'object' || operation.value === null || Array.isArray(operation.value)) throw new Error('Embedding settings must be an object')
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new Error('Embedding API key must be text')
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new Error('clearApiKey must be boolean')
  const { apiKeyStorage: _storage, apiKeyConfigured: _configured, clearApiKey: _clear, ...next } = input
  let resolved = resolveEmbedding(next as MnemonEmbeddingConfig)
  let rollback: (() => Promise<void>) | undefined
  if (input.clearApiKey === true) {
    next.apiKey = ''; next.apiKeyRef = ''; next.apiKeyEnv = ''
  } else if (resolved.apiKeyEnv) {
    if (resolved.apiKey) throw new Error('Choose an embedding API key or an environment variable, not both')
    next.apiKey = ''; next.apiKeyRef = ''
  } else {
    if (resolved.apiKeyRef && resolved.apiKeyRef !== previous.apiKeyRef) throw new Error('Save a key to create an embedding credential reference')
    const sameEndpoint = resolved.endpoint === previous.endpoint
    if (!resolved.apiKey && !sameEndpoint && (previous.apiKeyRef || previous.apiKey)) {
      throw new Error('Changing the embedding endpoint requires a new key, an environment variable, or explicitly removing the saved key')
    }
    const key = resolved.apiKey || (sameEndpoint ? previous.apiKey : '')
    if (key) {
      const credentials = store?.()
      if (credentials === undefined) throw new Error('DSH credentials storage is unavailable; configure apiKeyEnv instead. The existing connection was not changed')
      const reference = EMBEDDING_CREDENTIAL_PREFIX + randomUUID()
      const payload: MnemonEmbeddingCredential = { version: 1, endpoint: resolved.endpoint, apiKey: key }
      rollback = async () => { await credentials.deleteRecord(reference) }
      try {
        await credentials.modifyRecord(reference, async () => ({ kind: 'grant', payload }))
        const record = await credentials.readRecord(reference) as { kind?: string; payload?: MnemonEmbeddingCredential } | undefined
        if (record?.kind !== 'grant' || record.payload?.version !== 1 || record.payload.endpoint !== payload.endpoint || record.payload.apiKey !== key) throw new Error('Credential readback failed')
      } catch {
        await rollback().catch(() => {})
        throw new Error('Could not save and verify the embedding credential; the existing connection was not changed')
      }
      next.apiKey = ''; next.apiKeyRef = reference
    } else if (sameEndpoint && previous.apiKeyRef) {
      next.apiKey = ''; next.apiKeyRef = previous.apiKeyRef
    }
  }
  resolved = resolveEmbedding(next as MnemonEmbeddingConfig)
  // Validate the same normalized configuration the runtime will receive, without returning its key.
  if (resolved.apiKey) throw new Error('Embedding settings must not persist a plaintext key')
  const oldRef = previous.apiKeyRef
  const commit = oldRef && oldRef !== resolved.apiKeyRef
    ? async () => {
        const credentials = store?.()
        if (credentials !== undefined) await credentials.deleteRecord(oldRef)
      }
    : undefined
  const prepared = edits.map(entry => entry === operation ? { ...entry, value: next } as SettingsOperation : entry)
  return {
    operations: prepared,
    revision: revision ?? view.revision,
    ...(rollback === undefined ? {} : { rollback }),
    ...(commit === undefined ? {} : { commit }),
  }
}

/**
 * The one GitHub credentials record this plugin keeps, as DSH's store addresses it:
 * `<scope>/<id>`. Presence of the record is the whole fact, and every write
 * goes through `modifyRecord` so a replacement happens under the store's lock.
 */
export function credentialPort(service: () => HostCredentialsService | undefined): MnemonGitHubCredentialPort {
  return {
    available: () => service() !== undefined,
    describe: async () => {
      const store = service()
      if (store === undefined) return { configured: false, writable: false }
      const info = await store.describeRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY)
      return { configured: info.configured, writable: info.writable }
    },
    read: async () => githubGrantFromRecord(await service()?.readRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY)),
    write: async grant => {
      const store = service()
      if (store === undefined) throw new Error('this DSH Host provides no credentials store, so GitHub sign-in is unavailable')
      await store.modifyRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY, async () => ({ kind: 'grant', payload: grant }))
    },
    clear: async () => {
      const store = service()
      if (store === undefined) return
      // An absent record is already the signed-out state; deleting one twice is not a failure.
      if (await store.readRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY) === undefined) return
      await store.deleteRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY)
    },
  }
}
