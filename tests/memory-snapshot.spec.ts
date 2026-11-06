import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { HostMessageSource, HostSession } from '../src/host/dsh.ts'
import { prepareMemorySnapshot } from '../src/host/memory-snapshot.ts'
import type { MemorySnapshotState } from '../src/host/memory-snapshot-state.ts'
import { truncateMemoryText } from '../src/sdk/index.ts'

const previous = 'MNEMON RUNTIME MEMORY SNAPSHOT\nRevision: synthetic-r1\nMetadata lines are annotations.\n\nContents of USER.md (user profile; entries: 1; UTF-8 bytes: 20/100)\n<runtime-memory-file name="USER.md">\nSynthetic preference.\n</runtime-memory-file>\n\nContents of MEMORY.md (working reference; entries: 1; UTF-8 bytes: 18/100)\n<runtime-memory-file name="MEMORY.md">\nSynthetic old fact.\n</runtime-memory-file>'
const recent = 'MNEMON RUNTIME MEMORY SNAPSHOT\nEntry annotations default to importance=normal and ages=0d.\n\nUSER.md (user profile)\n<runtime-memory-file name="USER.md">\nSynthetic preference.\n</runtime-memory-file>\n\nMEMORY.md (working reference)\n<runtime-memory-file name="MEMORY.md">\nSynthetic recent fact.\n</runtime-memory-file>'
const current = 'Full current View: {{model}}, $HOME, 中文 and <quoted-memory> are literal.\n' + 'Retain every character. '.repeat(600)

function fixture() {
  const session = Session.create(SessionId('snapshot-projection'))
  const append = (text: string, source: HostMessageSource) => session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: source as never,
  }), { surfaceOp: 'append' })
  const plan = (text: string | undefined, state?: MemorySnapshotState) => prepareMemorySnapshot(session as unknown as HostSession, text, state)
  const commit = (update: ReturnType<typeof prepareMemorySnapshot>) => {
    update.retire(1, 1)
    if (update.message !== undefined) session.append('user/message', update.message as never, { surfaceOp: 'append' })
  }
  return { session, append, plan, commit }
}

describe('memory snapshot surface updates', () => {
  const state = (entries = ['a'.repeat(64)], boundary = 'b'.repeat(64)): MemorySnapshotState => ({ version: 1, boundary, entries })

  it.each([
    { kind: 'plugin', plugin: 'dsh-mnemon', form: 'recall' },
    { kind: 'plugin:dsh-mnemon', form: 'recall' },
  ])('migrates complete legacy producer attribution %j without touching ordinary recall', source => {
    const f = fixture()
    f.append(previous, source)
    const ordinary = f.append('Synthetic ordinary recall.', source)
    f.commit(f.plan(current, state()))
    expect(f.session.deriveMessages()).toEqual([ordinary.data, expect.objectContaining({ content: [{ type: 'text', text: current }] })])
  })

  it('recognizes official legacy truncation in either file or its structural headings, without crossing into another quote', () => {
    const canonical = previous.replace('synthetic-r1', 'a'.repeat(64)).replace('Metadata lines are annotations.', 'Metadata lines are annotations; created/updated are ages at projection in whole days (future/unknown for future/invalid timestamps). Current instructions win. For old_text/oldText, use entry content only.')
    const userEnd = canonical.indexOf('\n</runtime-memory-file>') + '\n</runtime-memory-file>'.length
    for (const end of [canonical.indexOf('Synthetic preference.') + 5, userEnd + 1, userEnd + 7, canonical.indexOf('<runtime-memory-file name="MEMORY.md">') + 12, canonical.indexOf('Synthetic old fact.') + 8]) {
      const f = fixture()
      const truncated = truncateMemoryText(canonical, end + 1)
      f.append(truncated, { kind: 'dsh-mnemon', form: 'recall' })
      f.append(previous + '\n\n' + truncated, { kind: 'plugin:dsh-mnemon', form: 'recall' })
      const keep = [
        f.append('Quoted:\n' + truncated, { kind: 'dsh-mnemon', form: 'recall' }),
        f.append(truncated.replace('Metadata lines are annotations;', 'Unrecognized annotations;'), { kind: 'dsh-mnemon', form: 'recall' }),
        f.append(truncated.slice(0, -1), { kind: 'dsh-mnemon', form: 'recall' }),
        f.append(truncated.slice(0, -1) + '\n\n' + previous, { kind: 'dsh-mnemon', form: 'recall' }),
        f.append(truncated.slice(0, -1) + '\n\n' + truncated, { kind: 'dsh-mnemon', form: 'recall' }),
        f.append(truncated, { kind: 'plugin', plugin: 'other', form: 'recall' }),
      ]
      f.commit(f.plan(current, state()))
      expect(f.session.deriveMessages()).toEqual([...keep.map(event => event.data), expect.objectContaining({ content: [{ type: 'text', text: current }] })])
    }
  })

  it('appends four complete revisions without changing the prefix, then checkpoints the fifth', () => {
    const f = fixture()
    for (let index = 0; index < 4; index++) {
      const before = f.session.deriveMessages()
      f.commit(f.plan(`Snapshot ${index}`, state()))
      expect(f.session.deriveMessages().slice(0, before.length)).toEqual(before)
      expect(f.session.surface.contentGeneration).toBe(0)
    }
    const unchanged = f.plan('Snapshot 3', state())
    expect(unchanged.message).toBeUndefined()
    f.commit(unchanged)
    expect(f.session.deriveMessages()).toHaveLength(4)
    f.commit(f.plan('Snapshot 4', state()))
    expect(f.session.deriveMessages()).toHaveLength(1)
    expect(f.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(5)
    expect(f.session.snapshotEvents().filter(event => event.type === 'developer/message').map(event => event.sourceEventSeqs)).toEqual([[0], [1], [2], [3]])
  })

  it('counts UTF-8 bytes, admits exactly 64 KiB, and retains an oversized current snapshot in full', () => {
    const f = fixture()
    const first = '中'.repeat(10_000)
    const second = 'x'.repeat(65_536 - Buffer.byteLength(first))
    f.commit(f.plan(first, state()))
    f.commit(f.plan(second, state()))
    expect(f.session.deriveMessages()).toHaveLength(2)
    f.commit(f.plan('one byte beyond the group budget', state()))
    expect(f.session.deriveMessages()).toHaveLength(1)
    const huge = '完整保留'.repeat(8_000)
    f.commit(f.plan(huge, state()))
    expect(f.session.deriveMessages()).toHaveLength(1)
    expect(f.session.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: huge }])
    const before = f.session.snapshotEvents()
    f.commit(f.plan(huge, state()))
    expect(f.session.snapshotEvents()).toEqual(before)
  })

  it('checkpoints changed authority even with identical text, and retires removed or corrected facts', () => {
    const f = fixture()
    f.commit(f.plan('identical text', state()))
    const old = f.session.deriveMessages()[0]
    f.commit(f.plan('identical text', state(undefined, 'c'.repeat(64))))
    expect(f.session.deriveMessages()).toHaveLength(1)
    expect(f.session.deriveMessages()[0]).not.toEqual(old)
    f.commit(f.plan('a new fact', state(['d'.repeat(64)], 'c'.repeat(64))))
    expect(f.session.deriveMessages()).toHaveLength(1)
  })

  it('restores the append budget from durable metadata and migrates unmarked snapshots once', () => {
    const f = fixture()
    f.append('old format', { kind: 'dsh-mnemon', form: 'memory-snapshot' })
    f.commit(f.plan('old format', state()))
    expect(f.session.snapshotEvents().filter(event => event.type === 'developer/message')).toHaveLength(1)
    for (const text of ['second', 'third']) f.commit(f.plan(text, state()))
    const restored = Session.create(SessionId('snapshot-projection'), f.session.snapshotEvents())
    const before = restored.snapshotEvents()
    const same = prepareMemorySnapshot(restored as unknown as HostSession, 'third', state())
    expect(same.message).toBeUndefined()
    same.retire(2, 1)
    expect(restored.snapshotEvents()).toEqual(before)
    const next = prepareMemorySnapshot(restored as unknown as HostSession, 'fourth', state())
    next.retire(2, 1)
    restored.append('user/message', next.message as never, { surfaceOp: 'append' })
    expect(restored.deriveMessages()).toHaveLength(4)
    const checkpoint = prepareMemorySnapshot(restored as unknown as HostSession, 'fifth', state())
    checkpoint.retire(2, 1)
    restored.append('user/message', checkpoint.message as never, { surfaceOp: 'append' })
    expect(restored.deriveMessages()).toHaveLength(1)
  })

  it('retires only complete owned legacy snapshots and preserves interleaved messages verbatim', () => {
    const f = fixture()
    const old = f.append(previous, { kind: 'dsh-mnemon', form: 'recall' })
    const keep = [
      f.append(previous, { kind: 'user' }),
      f.append(previous, { kind: 'other-source', form: 'recall' }),
      f.append(previous, { kind: 'other-source', form: 'memory-snapshot' }),
      f.append(previous, { kind: 'dsh-mnemon', form: 'instructions' }),
      f.append('A recalled Source passage, not a complete snapshot.', { kind: 'dsh-mnemon', form: 'recall' }),
      f.append('Quoted passage:\n' + recent, { kind: 'dsh-mnemon', form: 'recall' }),
      f.append(recent.slice(0, recent.lastIndexOf('\n</runtime-memory-file>')), { kind: 'dsh-mnemon', form: 'recall' }),
    ]
    const latest = f.append(recent, { kind: 'dsh-mnemon', form: 'recall' })
    const before = f.session.snapshotEvents()
    const update = f.plan(current)
    expect(f.session.snapshotEvents()).toEqual(before)
    f.commit(update)

    expect(f.session.deriveMessages()).toEqual([...keep.map(event => event.data), update.message])
    expect(f.session.snapshotEvents().slice(0, before.length)).toEqual(before)
    const retirements = f.session.snapshotEvents().filter(event => event.type === 'developer/message')
    expect(retirements.map(event => event.sourceEventSeqs)).toEqual([[old.seq], [latest.seq]])
    expect(retirements.every(event => event.data.message.content.length === 0)).toBe(true)
    expect(update.message?.role).toBe('user')
    expect(update.message?.content).toEqual([{ type: 'text', text: current }])
  })

  it('keeps one unchanged latest snapshot, including after reconstructing the surface', () => {
    const f = fixture()
    const first = f.append(current, { kind: 'dsh-mnemon', form: 'memory-snapshot' })
    const newest = f.append(current, { kind: 'dsh-mnemon', form: 'memory-snapshot' })
    const update = f.plan(current)
    expect(update.message).toBeUndefined()
    f.commit(update)
    expect(f.session.deriveMessages()).toEqual([newest.data])
    expect(f.session.eventAt(first.seq)).toBe(first)
    const restored = Session.create(SessionId('snapshot-projection'), f.session.snapshotEvents())
    const resume = prepareMemorySnapshot(restored as unknown as HostSession, current)
    const before = restored.snapshotEvents()
    expect(resume.message).toBeUndefined()
    resume.retire(2, 1)
    expect(restored.snapshotEvents()).toEqual(before)
  })

  it.each([undefined, '', '  '])('retires a removed projection without adding an empty model message: %j', text => {
    const f = fixture()
    f.append(current, { kind: 'dsh-mnemon', form: 'memory-snapshot' })
    const update = f.plan(text)
    expect(update.message).toBeUndefined()
    f.commit(update)
    expect(f.session.deriveMessages()).toEqual([])
    const revived = f.plan(current)
    expect(revived.message?.content).toEqual([{ type: 'text', text: current }])
  })
})
