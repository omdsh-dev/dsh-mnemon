import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RecordStore } from 'dsh-mnemon/source-sdk'
import { JournalProgress } from '../src/progress.ts'
it('tracks only completed human turns, stays due, resets on writes and survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mnemon-journal-progress-')), progress = new JournalProgress(new RecordStore(directory), 2)
  const scope = { storage: 'custom' as const, workspaceId: '/project', sessionId: 'one' }
  let events: any[] = [], start = Date.now() - 10000
  const agent = { session: { id: 'one', header: { cwd: '/project' }, ownEvents: () => events } } as any
  const turn = (number: number, human = true) => {
    events = [{ type: 'turn/start', seq: number * 3, time: start + number, data: { turn: number } }, { type: 'user/message', surfaceOp: 'append', seq: number * 3 + 1, time: start + number, data: createUserMessage({ content: [{ type: 'text', text: 'Visible' }], source: human ? { kind: 'user' } : { kind: 'plugin', plugin: 'test' } }) }, { type: 'turn/end', seq: number * 3 + 2, time: start + number, data: { turn: number } }]
    return events[2]
  }
  await progress.completed(agent, turn(1)); await progress.completed(agent, turn(1))
  expect(await progress.status(scope)).toMatchObject({ gap: 1, due: false })
  await progress.completed(agent, turn(2, false)); expect((await progress.status(scope)).gap).toBe(1)
  await progress.completed(agent, turn(3)); await progress.completed(agent, turn(4))
  expect(await new JournalProgress(new RecordStore(directory), 2).status(scope)).toMatchObject({ gap: 3, due: true })
  expect((await progress.status({ ...scope, sessionId: 'other' })).gap).toBe(0)
  await progress.written(scope); expect(await progress.status(scope)).toMatchObject({ gap: 0, due: false })
  start = Date.now() + 1000
  await progress.completed(agent, turn(5)); expect((await progress.status(scope)).gap).toBe(1)
  agent.session.header.origin = 'subagent'; await progress.completed(agent, turn(6)); expect((await progress.status(scope)).gap).toBe(1)
})
