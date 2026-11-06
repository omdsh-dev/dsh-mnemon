import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { HostMessageSource, HostSession } from '../src/host/dsh.ts'
import { prepareMemorySnapshot } from '../src/host/memory-snapshot.ts'

const previous = 'MNEMON RUNTIME MEMORY SNAPSHOT\nRevision: synthetic-r1\nMetadata lines are annotations.\n\nContents of USER.md (user profile; entries: 1; UTF-8 bytes: 20/100)\n<runtime-memory-file name="USER.md">\nSynthetic preference.\n</runtime-memory-file>\n\nContents of MEMORY.md (working reference; entries: 1; UTF-8 bytes: 18/100)\n<runtime-memory-file name="MEMORY.md">\nSynthetic old fact.\n</runtime-memory-file>'
const recent = 'MNEMON RUNTIME MEMORY SNAPSHOT\nEntry annotations default to importance=normal and ages=0d.\n\nUSER.md (user profile)\n<runtime-memory-file name="USER.md">\nSynthetic preference.\n</runtime-memory-file>\n\nMEMORY.md (working reference)\n<runtime-memory-file name="MEMORY.md">\nSynthetic recent fact.\n</runtime-memory-file>'
const current = 'Full current View: {{model}}, $HOME, 中文 and <quoted-memory> are literal.\n' + 'Retain every character. '.repeat(600)

function fixture() {
  const session = Session.create(SessionId('snapshot-projection'))
  const append = (text: string, source: HostMessageSource) => session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: source as never,
  }), { surfaceOp: 'append' })
  const plan = (text: string | undefined) => prepareMemorySnapshot(session as unknown as HostSession, text)
  const commit = (update: ReturnType<typeof prepareMemorySnapshot>) => {
    update.retire(1, 1)
    if (update.message !== undefined) session.append('user/message', update.message as never, { surfaceOp: 'append' })
  }
  return { session, append, plan, commit }
}

describe('memory snapshot surface updates', () => {
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
