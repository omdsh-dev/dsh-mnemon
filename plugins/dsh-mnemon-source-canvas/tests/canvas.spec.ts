import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as workspace from 'dsh-mnemon-strategy-workspace'
import * as canvas from '../src/index.ts'
import { CanvasEngine, boardVisible } from '../src/engine.ts'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
const directories: string[] = []
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'mnemon-canvas-')); directories.push(path); return path }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
it('reads registered files live, reports removals and rejects escapes and private paths', async () => {
  const root = await directory(), outside = await directory(), engine = new CanvasEngine(join(root, 'data'))
  const scope = { storage: 'custom' as const, workspaceId: root, sessionId: 'one' }
  await writeFile(join(root, 'notes.txt'), 'original')
  const result = await engine.change('register-file', { path: 'notes.txt', scope: 'project' }, scope)
  const node = result.snapshot.records[0]!
  expect(Buffer.from((await engine.read(node)).base64, 'base64').toString()).toBe('original')
  await writeFile(join(root, 'notes.txt'), 'updated')
  expect(Buffer.from((await engine.read(node)).base64, 'base64').toString()).toBe('updated')
  await rm(join(root, 'notes.txt')); await expect(engine.read(node)).rejects.toThrow()
  await writeFile(join(outside, 'secret.txt'), 'private')
  await symlink(join(outside, 'secret.txt'), join(root, 'shortcut.txt'))
  await expect(engine.change('register-file', { path: 'shortcut.txt' }, scope)).rejects.toThrow(/outside/)
  await mkdir(join(root, '.config')); await writeFile(join(root, '.config', 'secret.txt'), 'private')
  await expect(engine.change('register-file', { path: '.config/secret.txt' }, scope)).rejects.toThrow(/Private/)
  await expect(engine.change('register-file', { path: join(outside, 'secret.txt') }, scope)).rejects.toThrow(/outside/)
})
it('isolates session ownership, provides explicit project/all views and fences edits', async () => {
  const root = await directory(), engine = new CanvasEngine(root), one = { storage: 'custom' as const, workspaceId: '/project', sessionId: 'one' }, two = { ...one, sessionId: 'two' }
  const first = await engine.change('add-note', { title: 'Session note', content: 'exact content', scope: 'session' }, one)
  const node = first.snapshot.records[0]!
  expect(boardVisible(node, two)).toBe(false); expect(boardVisible(node, two, 'project')).toBe(true); expect(boardVisible(node, { ...two, workspaceId: '/other' }, 'project')).toBe(false)
  expect(boardVisible(node, { ...two, workspaceId: '/other' }, 'all')).toBe(true)
  await expect(engine.change('edit', { id: node.id, title: 'wrong scope' }, two, first.snapshot.revision)).rejects.toThrow(/view/)
  const moved = await engine.change('move', { id: node.id, x: 42, y: -12, width: 450, height: 240, version: node.version }, one, first.snapshot.revision)
  await expect(engine.change('edit', { id: node.id, title: 'stale' }, one, first.snapshot.revision)).rejects.toThrow(/revision/)
  expect(moved.snapshot.records[0]!.data).toMatchObject({ x: 42, y: -12, width: 450, height: 240 })
  await expect(engine.change('move', { id: node.id, x: Infinity }, one)).rejects.toThrow(/position/)
  await engine.change('archive', { id: node.id }, one)
  await engine.change('restore', { id: node.id }, one)
  const reopened = new CanvasEngine(root)
  expect((await reopened.store.read()).records[0]).toMatchObject({ state: 'active', content: 'exact content', version: 4 })
})
it('retains uploaded copies independently, detects corruption, and refuses model file registration', async () => {
  const root = await directory(), engine = new CanvasEngine(root), scope = { storage: 'custom' as const }
  const uploaded = await engine.change('upload', { title: 'Sample', name: 'sample.txt', base64: Buffer.from('retained').toString('base64') }, scope)
  const node = uploaded.snapshot.records[0]!
  expect(Buffer.from((await engine.read(node)).base64, 'base64').toString()).toBe('retained')
  const asset = node.data.asset as { id: string }
  await writeFile(join(root, 'assets', asset.id), 'corrupt')
  await expect(engine.read(node)).rejects.toThrow(/damaged|changed/)
  await expect(engine.change('register-file', { path: '/etc/passwd' }, scope, undefined, undefined, true)).rejects.toThrow(/only add notes/)
})
it('keeps card contents out of projections and pins model reads to registered references through real Core composition', async () => {
  const root = await directory(), runner = new MemoryCompositionRunner({ strategyTypeId: 'workspace' })
  const scope = { storage: 'custom' as const, workspaceId: root, sessionId: 'owner' }
  try {
    await runner.mount(canvas, { instanceId: 'board', config: { dataDir: join(root, 'data') } })
    await runner.mount(workspace, { instanceId: 'workspace' })
    const client = await runner.managementClient('source:board', scope)
    const first = await client.mutate('add-note', { title: 'One', content: 'private note body', scope: 'session' }, { confirmed: true })
    const id = (first.value as { id: string }).id
    const turn = await runner.beginTurn({ scope })
    expect(JSON.stringify(turn.view.projection)).not.toContain('private note body')
    const route = turn.view.routes.find(route => route.sourceRouteId === 'read-node')!
    const evidence = await turn.executeRoute(route.id, { id })
    expect(evidence.items[0]!.text).toContain('private note body')
    const later = await client.mutate('add-note', { title: 'Later', content: 'not admitted' }, { confirmed: true })
    await expect(turn.executeRoute(route.id, { id: (later.value as { id: string }).id })).rejects.toThrow(/absent/)
    const action = turn.view.actionOffers.find(offer => offer.sourceActionId === 'add-note')!
    await turn.executeAction(action.id, { title: 'Model note', content: 'explicit new material' }, () => true)
    const board = (await client.read('board')).value as unknown as { records: RecordValue[] }
    expect(board.records.find(record => record.title === 'Model note')?.data.createdBy).toBe('model')
    const other = await runner.managementClient('source:board', { ...scope, sessionId: 'other' })
    await expect(other.read('read-node', { id })).rejects.toThrow(/view/)
    turn.release()
  } finally { await runner.dispose() }
})
