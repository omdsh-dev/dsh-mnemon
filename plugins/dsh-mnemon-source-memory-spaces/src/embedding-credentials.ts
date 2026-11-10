import { EMBEDDING_CREDENTIAL_REFERENCE, type MnemonEmbeddingCredential, type ResolvedMnemonEmbeddingConfig } from './contracts.ts'

export type EmbeddingCredentialReader = (reference: string) => Promise<unknown>

/** The Host never exports this value to the browser or serializes it into configuration. */
export async function embeddingApiKey(config: ResolvedMnemonEmbeddingConfig, read?: EmbeddingCredentialReader, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (config.apiKeyEnv) {
    const key = environment[config.apiKeyEnv]?.trim()
    if (!key) throw new Error('Embedding API key environment variable is unset or empty: ' + config.apiKeyEnv)
    return checkedKey(key)
  }
  if (!config.apiKeyRef) return config.apiKey
  if (!EMBEDDING_CREDENTIAL_REFERENCE.test(config.apiKeyRef)) throw new Error('Invalid embedding credential reference')
  if (read === undefined) throw new Error('Embedding credential storage is unavailable; use apiKeyEnv or enable the DSH credentials service')
  let record: unknown
  try { record = await read(config.apiKeyRef) } catch { throw new Error('Cannot read the saved embedding credential; check the DSH credentials service') }
  const grant = record as { kind?: unknown; payload?: Partial<MnemonEmbeddingCredential> } | undefined
  if (grant?.kind !== 'grant' || grant.payload?.version !== 1 || typeof grant.payload.apiKey !== 'string') throw new Error('Saved embedding credential is missing or invalid; save a new key')
  if (grant.payload.endpoint !== config.endpoint) throw new Error('Saved embedding credential belongs to another endpoint; save a new key for this endpoint')
  return checkedKey(grant.payload.apiKey)
}

function checkedKey(key: string): string {
  if (!key || key.length > 2048 || /[\u0000-\u001f\u007f]/u.test(key)) throw new Error('Embedding API key must contain 1..2048 characters without control characters')
  return key
}
