import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import { digest, type AssetReference } from 'dsh-mnemon/source-sdk'

export interface NotificationChannel {
  id: string
  label: string
  target: string
  endpoint: string
  bearerEnv?: string
}
export interface NotificationConfig {
  dataDir?: string
  attachmentRoots?: string[]
  attachmentUrlOrigins?: string[]
  channels?: NotificationChannel[]
  captureActivity?: boolean
  captureTurns?: boolean
}
export interface DeliveryPlan {
  id: string
  title: string
  content: string
  mode: 'notification' | 'message'
  channels: Array<{ id: string; label: string; target: string; endpoint: string }>
  assets: AssetReference[]
  workspace: string | null
  session: string | null
  configurationStamp: string
}
export interface ChannelPayload {
  format: 'mnemon-notification/v1'
  deliveryId: string
  target: string
  mode: DeliveryPlan['mode']
  title: string
  content: string
  sessionId: string | null
  attachments: Array<AssetReference & { base64: string }>
}
/** Source-owned transport seam. Implementations return acceptance, not downstream human receipt. */
export type ChannelSender = (channel: Readonly<NotificationChannel>, payload: Readonly<ChannelPayload>, signal: AbortSignal) => Promise<string>

/** Bound the owning Source's wait even when a third-party transport ignores cancellation. */
export async function deliverWithin(sender: ChannelSender, channel: NotificationChannel, payload: ChannelPayload, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let abort = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([sender(channel, payload, signal), cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

export function validateConfig(config: NotificationConfig) {
  const ids = new Set<string>()
  if ((config.channels?.length ?? 0) > 16) throw new Error('At most 16 notification channels')
  for (const channel of config.channels ?? []) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(channel.id) || ids.has(channel.id) || !channel.label?.trim() || channel.label.length > 100 || !channel.target?.trim() || channel.target.length > 500) throw new Error('Invalid or duplicate notification channel')
    const url = new URL(channel.endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Channel endpoints require HTTP(S), with credentials in the configured environment variable')
    if (channel.bearerEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(channel.bearerEnv)) throw new Error('Invalid channel credential environment variable')
    ids.add(channel.id)
  }
}
export function configurationStamp(config: NotificationConfig): string {
  return digest((config.channels ?? []).map(channel => ({ ...channel, credential: channel.bearerEnv ? process.env[channel.bearerEnv] ?? null : null })))
}
export function planFor(id: string, title: string, content: string, mode: unknown, selected: unknown, assets: AssetReference[], scope: MemoryOperationScope, config: NotificationConfig): DeliveryPlan {
  if (!['notification', 'message'].includes(String(mode))) throw new Error('Choose notification or direct message')
  const ids = selected === 'all' ? (config.channels ?? []).map(channel => channel.id) : selected
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Select one or more configured channels')
  const channels = ids.map(id => {
    const channel = config.channels?.find(channel => channel.id === id)
    if (!channel) throw new Error('Channel is not configured: ' + String(id))
    return { id: channel.id, label: channel.label, target: channel.target, endpoint: channel.endpoint }
  })
  return { id, title, content, mode: mode as DeliveryPlan['mode'], channels, assets, workspace: scope.workspaceId ?? null, session: scope.sessionId ?? null, configurationStamp: configurationStamp(config) }
}
export const sendWebhook: ChannelSender = async (channel, payload, signal) => {
  const token = channel.bearerEnv ? process.env[channel.bearerEnv] : undefined
  if (channel.bearerEnv && !token) throw new Error('The channel credential is unavailable')
  const response = await fetch(channel.endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', 'idempotency-key': payload.deliveryId + ':' + channel.id, ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(payload),
  })
  await response.body?.cancel()
  if (!response.ok) throw new Error('Channel returned HTTP ' + response.status)
  return 'Accepted: HTTP ' + response.status
}
