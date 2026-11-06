import { randomUUID } from 'node:crypto'
import type { HostSession, HostSessionEvent, HostUserMessage } from './dsh.ts'
import { createPluginMessage, isMnemonMessageSource, MNEMON_PLUGIN_SOURCE } from './plugin-message.ts'
import { readMemorySnapshotState, retainsSnapshotEntries, type MemorySnapshotState } from './memory-snapshot-state.ts'

// Initial engineering defaults, not measured provider cache optima. The current
// snapshot is always complete, even when it alone exceeds the history budget.
const MAX_SNAPSHOTS = 4
const MAX_SNAPSHOT_BYTES = 64 * 1024

// Match the complete Runtime envelope emitted before snapshot-specific sources,
// including the revision/size headings shipped in 0.5.34. Never borrow a closing
// tag from the next Source fragment to make a partial quote look complete.
const LEGACY_RUNTIME_SNAPSHOT = /^MNEMON RUNTIME MEMORY SNAPSHOT\n[^\n]+(?:\n[^\n]+)*\n\n(?:USER\.md \(user profile\)|Contents of USER\.md \(user profile; entries: \d+; UTF-8 bytes: \d+\/\d+\))\n<runtime-memory-file name="USER.md">\n(?:(?!\n\nMNEMON (?:RUNTIME MEMORY SNAPSHOT|VIEW ))[\s\S])*?\n<\/runtime-memory-file>\n\n(?:MEMORY\.md \(working reference\)|Contents of MEMORY\.md \(working reference; entries: \d+; UTF-8 bytes: \d+\/\d+\))\n<runtime-memory-file name="MEMORY.md">\n(?:(?!\n\nMNEMON (?:RUNTIME MEMORY SNAPSHOT|VIEW ))[\s\S])*?\n<\/runtime-memory-file>(?:$|\n\n)/u

// Official light-context can truncate before a closing tag. Require the exact
// shipped introduction, USER opener, structural progress and SDK ellipsis at a
// Source/Wake boundary; an arbitrary partial quote is not a legacy snapshot.
const TRUNCATED_RUNTIME_START = /^MNEMON RUNTIME MEMORY SNAPSHOT\n(?:Revision: [a-f0-9]{64}(?:\nGit branch: [^\r\n]+)?(?:\nMetadata lines are annotations; created\/updated are ages at projection in whole days \(future\/unknown for future\/invalid timestamps\)\. Current instructions win\. For old_text\/oldText, use entry content only\.)?\n\nContents of USER\.md \(user profile; entries: \d+; UTF-8 bytes: \d+\/\d+\)|Entry annotations default to importance=normal and ages=0d \(whole days at projection; future\/unknown for future\/invalid timestamps\)\. Current instructions win\. For old_text\/oldText, use entry content only\.(?:\nGit branch: [^\r\n]+)?\n\nUSER\.md \(user profile\))\n<runtime-memory-file name="USER.md">\n/u
const TRUNCATED_RUNTIME_END = /…(?=$|\n\n(?:MNEMON RUNTIME MEMORY SNAPSHOT\n|MNEMON VIEW TOOLS \(available in this View\): |MNEMON VIEW ROUTES \(quoted routing data; use mnemon_view_route or mnemon_view_action by exact id\): |MNEMON VIEW AVAILABILITY \(quoted diagnostics; unavailable Sources are not evidence\): ))/u

function isTruncatedRuntimeSnapshot(text: string): boolean {
  const start = TRUNCATED_RUNTIME_START.exec(text)
  if (start === null) return false
  const body = text.slice(start[0].length)
  const end = body.search(TRUNCATED_RUNTIME_END)
  if (end < 0) return false
  const prefix = body.slice(0, end)
  const closing = '\n</runtime-memory-file>'
  const userEnd = prefix.indexOf(closing)
  if (userEnd < 0) return true // The official cut is inside USER.md or its close.
  // A valid SDK cut can also land between files or inside the MEMORY heading.
  // Match a prefix of the shipped heading grammar, then allow its quoted body.
  const legacy = start[0].includes('\nContents of USER.md ')
  const heading: Array<string | RegExp> = legacy
    ? ['\n\nContents of MEMORY.md (working reference; entries: ', /^\d+/u, '; UTF-8 bytes: ', /^\d+/u, '/', /^\d+/u, ')']
    : ['\n\nMEMORY.md (working reference)']
  heading.push('\n<runtime-memory-file name="MEMORY.md">\n')
  let rest = prefix.slice(userEnd + closing.length)
  for (const part of heading) {
    if (rest === '') return true
    if (typeof part === 'string') {
      if (part.startsWith(rest)) return true
      if (!rest.startsWith(part)) return false
      rest = rest.slice(part.length)
    } else {
      const match = part.exec(rest)
      if (match === null) return false
      rest = rest.slice(match[0].length)
    }
  }
  return true
}

/** Read only this producer's snapshot formats; ordinary recalls retain history. */
function snapshotText(event: HostSessionEvent | undefined): string | undefined {
  if (event?.type !== 'user/message' || event.data.role !== 'user') return undefined
  const source = event.data.source as { kind?: unknown; form?: unknown } | undefined
  if (!isMnemonMessageSource(source)) return undefined
  const content = event.data.content
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block = content[0] as { type?: unknown; text?: unknown } | undefined
  if (block?.type !== 'text' || typeof block.text !== 'string') return undefined
  if (source?.form === 'memory-snapshot') return block.text
  // Before snapshot-specific attribution, the built-in Runtime projection used
  // recall. Require its full envelope or canonical SDK truncation, not ownership
  // alone or an arbitrary quote.
  if (source?.form !== 'recall' || !(LEGACY_RUNTIME_SNAPSHOT.test(block.text) || isTruncatedRuntimeSnapshot(block.text))) return undefined
  return block.text
}

/**
 * Prepare a snapshot and its retirements without writing before step/start.
 * Commit after step/start publication, before the Host builds its request.
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
