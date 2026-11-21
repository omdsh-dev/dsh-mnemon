import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isRecord } from './is-record.ts'

export const retiredMemorySnapshot: ConversationNodeDefinition<null> = {
  kind: 'dsh-mnemon/retired-memory-snapshot',
  target: 'chat',
  match(event) {
    if (event.type !== 'developer/message') return null
    const message: unknown = event.data.message
    if (!isRecord(message) || message.role !== 'developer' || typeof message.id !== 'string'
      || !Array.isArray(message.content) || message.content.length !== 0) return null
    const source = message.source
    if (!isRecord(source) || source.form !== 'memory-snapshot-retired') return null
    const owned = source.kind === 'dsh-mnemon' || source.kind === 'plugin:dsh-mnemon'
      || (source.kind === 'plugin' && source.plugin === 'dsh-mnemon')
    if (!owned) return null
    return { id: message.id, role: 'start', exclusive: true }
  },
  start: () => null,
  update: () => null,
  buildViewNode: () => null,
}
