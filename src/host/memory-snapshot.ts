import { randomUUID } from 'node:crypto'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { MemoryWake } from '../core/contracts/index.ts'
import type { HostSession, HostUserMessage } from './dsh.ts'
import { createPluginMessage, isMnemonMessageSource, MNEMON_PLUGIN_SOURCE } from './plugin-message.ts'
import { readMemorySnapshotState, retainsSnapshotEntries, type MemorySnapshotState, type RuntimeSnapshotRange } from './memory-snapshot-state.ts'

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
const RUNTIME_WAKE_SEPARATOR = /\n\n(?:MNEMON RUNTIME MEMORY SNAPSHOT\n|MNEMON VIEW TOOLS \(available in this View\): |MNEMON VIEW ROUTES \(quoted routing data; use mnemon_view_route or mnemon_view_action by exact id\): |MNEMON VIEW AVAILABILITY \(quoted diagnostics; unavailable Sources are not evidence\): )/u

function isTruncatedRuntimeSnapshot(text: string): boolean {
  const start = TRUNCATED_RUNTIME_START.exec(text)
  if (start === null) return false
  const body = text.slice(start[0].length)
  const end = body.search(RUNTIME_WAKE_SEPARATOR)
  const first = end < 0 ? body : body.slice(0, end)
  if (!first.endsWith('…')) return false
  const prefix = first.slice(0, -1)
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
function snapshotText(message: { role?: unknown; source?: unknown; content?: unknown }): string | undefined {
  if (message.role !== 'user') return undefined
  const source = message.source as { kind?: unknown; form?: unknown } | undefined
  if (!isMnemonMessageSource(source)) return undefined
  const content = message.content
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

/** Ranges follow the Wake's original section order and leave the wire text intact. */
export function runtimeSnapshotRanges(wake: MemoryWake): RuntimeSnapshotRange[] | undefined {
  const ranges: RuntimeSnapshotRange[] = []
  let offset = 0
  for (const section of wake.sections) {
    if (section.mode !== 'eager' || section.text === '') continue
    if (!wake.text.startsWith(section.text, offset)) return undefined
    const end = offset + section.text.length
    if (section.layerId === 'runtime') ranges.push([offset, end])
    offset = end + 2
  }
  return ranges
}

function readRuntimeRanges(value: unknown, text: string): RuntimeSnapshotRange[] | undefined {
  if (!Array.isArray(value)) return undefined
  let next = 0
  const ranges: RuntimeSnapshotRange[] = []
  for (const range of value) {
    if (!Array.isArray(range) || range.length !== 2) return undefined
    const [start, end] = range as [number, number]
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < next || end <= start || end > text.length
      || (start !== 0 && text.slice(start - 2, start) !== '\n\n')
      || (end !== text.length && !text.startsWith('\n\n', end))) return undefined
    ranges.push([start, end])
    next = end + 2
  }
  return ranges
}

/** Runtime comes from the Source on each turn, including after a checkpoint. */
export function summaryWithoutRuntimeSnapshots(messages: readonly Message[], authority: MemorySnapshotState | undefined): readonly Message[] {
  const filtered = messages.flatMap((message): Message[] => {
    const text = snapshotText(message)
    if (text === undefined) return [message]
    const source = message.source as { snapshot?: unknown; runtimeRanges?: unknown } | undefined
    if (authority === undefined || readMemorySnapshotState(source?.snapshot)?.boundary !== authority.boundary) return []
    const ranges = readRuntimeRanges(source?.runtimeRanges, text)
    if (ranges === undefined) return [] // An old snapshot cannot be split by provenance.
    if (ranges.length === 0) return [message]
    let kept = ''
    let offset = 0
    for (const [start, end] of ranges) {
      kept += text.slice(offset, start)
      offset = end === text.length ? end : end + 2
    }
    kept += text.slice(offset)
    if (ranges.at(-1)![1] === text.length && kept.endsWith('\n\n')) kept = kept.slice(0, -2)
    return kept === '' ? [] : [{ ...message, content: [{ type: 'text', text: kept }] } as Message]
  })
  return filtered.length === messages.length && filtered.every((message, index) => message === messages[index]) ? messages : filtered
}

/**
 * Prepare a snapshot and its retirements without writing before step/start.
 * Commit after step/start publication, before the Host builds its request.
 * Empty developer nodes are a public Session representation that derives no model
 * message. They contain no instructions, Source text, or tool changes. Each
 * replacement shadows one owned node and cites it; the append-only audit keeps
 * the original full message, without touching interleaved conversation.
 */
export function prepareMemorySnapshot(session: HostSession, text: string | undefined, state?: MemorySnapshotState, options: {
  deferRetirement?: boolean
  checkpoint?: boolean
  runtimeRanges?: RuntimeSnapshotRange[]
} = {}): {
  message: HostUserMessage | undefined
  retire(turn: number, step: number): void
} {
  const current = text?.trim() === '' ? undefined : text
  const snapshots = session.surface.nodes.flatMap(seq => {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') return []
    const text = snapshotText(event.data)
    const source = event.data.source as { form?: unknown; snapshot?: unknown; runtimeRanges?: unknown } | undefined
    return text === undefined ? [] : [{
      seq, text, state: source?.form === 'memory-snapshot' ? readMemorySnapshotState(source.snapshot) : undefined,
      runtimeRanges: readRuntimeRanges(source?.runtimeRanges, text),
    }]
  })
  const latest = snapshots.at(-1)
  const appendOnly = options.deferRetirement === true && state?.branchVisibility !== undefined
    && (options.runtimeRanges?.length ?? 0) > 0 && snapshots.every(snapshot =>
      snapshot.state?.branchVisibility === state.branchVisibility && (snapshot.runtimeRanges?.length ?? 0) > 0)
  const compatible = state !== undefined && snapshots.every(snapshot => snapshot.state?.boundary === state.boundary
    && (appendOnly || retainsSnapshotEntries(snapshot.state.entries, state.entries)))
  const unchanged = current !== undefined && latest?.text === current
  const count = snapshots.length + (unchanged ? 0 : 1)
  const withinBudget = appendOnly || (count <= MAX_SNAPSHOTS && (count <= 1
    || snapshots.reduce((total, snapshot) => total + Buffer.byteLength(snapshot.text, 'utf8'), 0)
      + (unchanged || current === undefined ? 0 : Buffer.byteLength(current, 'utf8')) <= MAX_SNAPSHOT_BYTES))
  const retained = current === undefined ? []
    : options.checkpoint === true ? unchanged && state !== undefined && latest?.state?.boundary === state.boundary
      && retainsSnapshotEntries(latest.state.entries, state.entries) ? [latest] : []
    : compatible && withinBudget ? snapshots
    // Callers without a View keep the conservative single-snapshot behavior.
    : state === undefined && unchanged ? [latest!] : []
  const stale = snapshots.filter(snapshot => !retained.includes(snapshot))
  const message = current === undefined || (unchanged && retained.includes(latest!))
    ? undefined : createPluginMessage(current, 'memory-snapshot', state, options.runtimeRanges)
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
