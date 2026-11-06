import { randomUUID } from 'node:crypto'
import type { HostSession, HostSessionEvent, HostUserMessage } from './dsh.ts'
import { createPluginMessage, MNEMON_PLUGIN_SOURCE } from './plugin-message.ts'
import { readMemorySnapshotState, retainsSnapshotEntries, type MemorySnapshotState } from './memory-snapshot-state.ts'

// Initial engineering defaults, not measured provider cache optima. The current
// snapshot is always complete, even when it alone exceeds the history budget.
const MAX_SNAPSHOTS = 4
const MAX_SNAPSHOT_BYTES = 64 * 1024

// Match the complete Runtime envelope emitted before snapshot-specific sources,
// including the revision/size headings shipped in 0.5.34. Partial quoted output
// and ordinary recall messages are not eligible for replacement.
const LEGACY_RUNTIME_SNAPSHOT = /^MNEMON RUNTIME MEMORY SNAPSHOT\n[^\n]+(?:\n[^\n]+)*\n\n(?:USER\.md \(user profile\)|Contents of USER\.md \(user profile; entries: \d+; UTF-8 bytes: \d+\/\d+\))\n<runtime-memory-file name="USER.md">\n[\s\S]*?\n<\/runtime-memory-file>\n\n(?:MEMORY\.md \(working reference\)|Contents of MEMORY\.md \(working reference; entries: \d+; UTF-8 bytes: \d+\/\d+\))\n<runtime-memory-file name="MEMORY.md">\n[\s\S]*?\n<\/runtime-memory-file>(?:$|\n\n)/u

/** Read only this producer's full snapshots; ordinary recalls retain their history. */
function snapshotText(event: HostSessionEvent | undefined): string | undefined {
  if (event?.type !== 'user/message' || event.data.role !== 'user') return undefined
  const source = event.data.source as { kind?: unknown; form?: unknown } | undefined
  if (source?.kind !== MNEMON_PLUGIN_SOURCE) return undefined
  const content = event.data.content
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block = content[0] as { type?: unknown; text?: unknown } | undefined
  if (block?.type !== 'text' || typeof block.text !== 'string') return undefined
  if (source.form === 'memory-snapshot') return block.text
  // Before snapshot-specific attribution, the built-in Runtime projection used
  // recall. Require its complete envelope, not merely the producer or a quote.
  if (source.form !== 'recall' || !LEGACY_RUNTIME_SNAPSHOT.test(block.text)) return undefined
  return block.text
}

/**
 * Prepare a snapshot and its retirements without writing before step/start.
 * Commit retirements inside agent/request, before the Host builds its request.
 * Empty developer nodes are a public Session representation that derives no model
 * message. They contain no instructions, Source text, or tool changes. Each
 * replacement shadows one owned node and cites it; the append-only audit keeps
 * the original full message, without touching interleaved conversation.
 */
export function prepareMemorySnapshot(session: HostSession, text: string | undefined, state?: MemorySnapshotState): {
  message: HostUserMessage | undefined
  retire(turn: number, step: number): void
} {
  const current = text?.trim() === '' ? undefined : text
  const snapshots = session.surface.nodes.flatMap(seq => {
    const event = session.eventAt(seq)
    const text = snapshotText(event)
    const source = event?.data.source as { form?: unknown; snapshot?: unknown } | undefined
    return text === undefined ? [] : [{ seq, text, state: source?.form === 'memory-snapshot' ? readMemorySnapshotState(source.snapshot) : undefined }]
  })
  const latest = snapshots.at(-1)
  const compatible = state !== undefined && snapshots.every(snapshot => snapshot.state?.boundary === state.boundary
    && retainsSnapshotEntries(snapshot.state.entries, state.entries))
  const unchanged = current !== undefined && latest?.text === current
  const count = snapshots.length + (unchanged ? 0 : 1)
  const bytes = snapshots.reduce((total, snapshot) => total + Buffer.byteLength(snapshot.text, 'utf8'), 0)
    + (unchanged || current === undefined ? 0 : Buffer.byteLength(current, 'utf8'))
  const withinBudget = count <= MAX_SNAPSHOTS && (count <= 1 || bytes <= MAX_SNAPSHOT_BYTES)
  const retained = current === undefined ? [] : compatible && withinBudget ? snapshots
    // Callers without a View keep the conservative single-snapshot behavior.
    : state === undefined && unchanged ? [latest!] : []
  const stale = snapshots.filter(snapshot => !retained.includes(snapshot))
  const message = current === undefined || (unchanged && retained.includes(latest!)) ? undefined : createPluginMessage(current, 'memory-snapshot', state)
  return {
    message,
    retire(turn, step) {
      const visible = new Set(session.surface.nodes)
      for (const { seq } of stale) {
        if (!visible.has(seq)) continue
        if (session.append === undefined) throw new Error('DSH Session append is required to retire superseded memory snapshots')
        session.append('developer/message', {
          turn, step,
          message: {
            id: randomUUID(), role: 'developer', content: [],
            source: { kind: MNEMON_PLUGIN_SOURCE, form: 'memory-snapshot-retired' },
          },
        }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
      }
    },
  }
}
