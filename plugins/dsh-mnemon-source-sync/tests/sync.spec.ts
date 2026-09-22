import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryOperationScope, MemoryTransferSnapshot } from 'dsh-mnemon/contracts'
import { json } from 'dsh-mnemon/source-sdk'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as workspace from 'dsh-mnemon-strategy-workspace'
import * as sync from '../src/index.ts'
import { SyncEngine, mergeTracks } from '../src/engine.ts'
import { git, remoteAddress, repositoryIdentity } from '../src/git.ts'
import type { SyncPlan, Binding } from '../src/protocol.ts'
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const track = (...contents: string[]): MemoryTransferSnapshot => ({ format: 'mnemon-source-transfer/v1', track: 'project', entries: contents.map((content, i) => ({ id: 'record-' + i, value: { content } })) })
const binding: Binding = { slot: 'notes-project', sourceKey: 'source:local-notes', track: 'project' }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mnemon-sync-')); directories.push(root)
  const remote = join(root, 'remote.git'), workspace = join(root, 'code'); await mkdir(workspace); await git(['init', '--initial-branch=main', workspace]); await git(['init', '--bare', remote])
  const scope: MemoryOperationScope = { storage: 'custom', workspaceId: workspace, sessionId: 'test' }
  const create = async (name: string) => {
    const engine = new SyncEngine(join(root, name), { allowLocalRemotes: true })
    const result = await engine.configure(scope, { title: name, scope: 'project', projectKey: 'host/owner/project', remote, bindings: json([binding]) }, (await engine.store.read()).revision)
    const targets = (result.value as unknown as { targets: { id: string }[] }).targets
    return { engine, id: targets[0]!.id }
  }
  return { root, remote, workspace, scope, create }
}
async function prepare(value: { engine: SyncEngine; id: string }, scope: MemoryOperationScope, snapshot: MemoryTransferSnapshot) {
  return (await value.engine.prepare(scope, { id: value.id, captures: json([{ binding, revision: 'source-version', snapshot }]) }, (await value.engine.store.read()).revision)).value as unknown as SyncPlan
}
async function change(value: { engine: SyncEngine; id: string }, scope: MemoryOperationScope, plan: SyncPlan, operation: string, extra: object = {}) {
  return (await value.engine.changePlan(operation, scope, { id: value.id, planId: plan.id, ...json(extra) as object }, (await value.engine.store.read()).revision)).value as unknown as SyncPlan
}
async function commit(value: { engine: SyncEngine; id: string }, scope: MemoryOperationScope, plan: SyncPlan) {
  plan = await change(value, scope, plan, 'begin-apply')
  for (const capture of plan.local) plan = await change(value, scope, plan, 'record-apply', { slot: capture.binding.slot, sourceRevision: 'accepted-source-version', snapshot: plan.merged.tracks[capture.binding.slot] })
  return change(value, scope, plan, 'commit-plan')
}
async function push(value: { engine: SyncEngine; id: string }, scope: MemoryOperationScope) {
  const inspected = await value.engine.pushPlan(scope, value.id)
  await value.engine.push(scope, { ...inspected.value as object, id: value.id }, inspected.revision)
}
describe('independent reviewed snapshots', () => {
  it('merges real divergent Git histories and resolves local, remote and both without checking out code', async () => {
    const f = await fixture(), a = await f.create('a'), b = await f.create('b')
    const initial = await commit(a, f.scope, await prepare(a, f.scope, track('base-0', 'base-1', 'base-2'))); await push(a, f.scope)
    const imported = await commit(b, f.scope, await prepare(b, f.scope, track()))
    expect(imported.merged.tracks[binding.slot]!.entries).toHaveLength(3)
    await commit(b, f.scope, await prepare(b, f.scope, track('remote-0', 'remote-1', 'remote-2'))); await push(b, f.scope)
    let plan = await prepare(a, f.scope, track('local-0', 'local-1', 'local-2'))
    expect(plan.commonHead).toBe(initial.commit); expect(plan.conflicts).toHaveLength(3)
    await expect(commit(a, f.scope, plan)).rejects.toThrow('Resolve every conflict')
    for (const [i, choice] of ['local', 'remote', 'both'].entries()) plan = await change(a, f.scope, plan, 'resolve-conflict', { key: plan.conflicts[i]!.key, choice })
    plan = await commit(a, f.scope, plan); expect(plan.status).toBe('complete')
    expect(plan.merged.tracks[binding.slot]!.entries.map(entry => (entry.value as {content:string}).content).sort()).toEqual(['local-0', 'local-2', 'remote-1', 'remote-2'])
    await push(a, f.scope)
    const parents = await git(['--git-dir', f.remote, 'rev-list', '--parents', '-n', '1', plan.branch])
    expect(parents.split(' ')).toHaveLength(3)
    expect(await git(['-C', f.workspace, 'branch', '--show-current'])).toBe('main')
    expect(await git(['-C', f.workspace, 'status', '--porcelain'])).toBe('')
    await expect(change(a, f.scope, plan, 'commit-plan')).rejects.toThrow('Every selected Source')
  }, 20000)
  it('retains a plan across engine replacement, fences scope/configuration, and requires exact push review', async () => {
    const f = await fixture(), a = await f.create('a'), plan = await prepare(a, f.scope, track('saved'))
    const restarted = { engine: new SyncEngine(a.engine.directory, { allowLocalRemotes: true }), id: a.id }
    expect((await restarted.engine.plan(f.scope, a.id)).value).toMatchObject({ id: plan.id, status: 'ready' })
    await expect(restarted.engine.plan({ ...f.scope, workspaceId: join(f.root, 'unrelated') }, a.id)).rejects.toThrow('not available')
    await expect(a.engine.configure(f.scope, { id: a.id, scope: 'project', projectKey: 'changed', remote: f.remote, bindings: json([binding]) }, (await a.engine.store.read()).revision)).rejects.toThrow('existing merge')
    const completed = await commit(restarted, f.scope, plan), reviewed = await restarted.engine.pushPlan(f.scope, a.id)
    await expect(restarted.engine.push(f.scope, { ...reviewed.value as object, id: a.id, remote: '/different.git' }, reviewed.revision)).rejects.toThrow('exact destination')
    expect(await git(['--git-dir', f.remote, 'for-each-ref', '--format=%(refname)'])).toBe('')
    await push(restarted, f.scope)
    expect(await git(['--git-dir', f.remote, 'rev-parse', completed.branch])).toBe(completed.commit)
  })
  it('rejects malformed remote identity and stale revisions without applying Source writes', async () => {
    const f = await fixture(), a = await f.create('a')
    const stale = (await a.engine.store.read()).revision
    const plan = await prepare(a, f.scope, track('base'))
    await expect(a.engine.changePlan('begin-apply', f.scope, { id: a.id, planId: plan.id }, stale)).rejects.toThrow('revision changed')
    await change(a, f.scope, plan, 'cancel-plan')
    await expect(prepare(a, f.scope, { ...track('x'), entries: [{id:'../escape',value:'bad'}] })).rejects.toThrow('entry id')
    expect(await git(['--git-dir', f.remote, 'for-each-ref', '--format=%(refname)'])).toBe('')
    expect(remoteAddress('https://host/owner/private.git', false)).toBe('https://host/owner/private.git')
    expect(() => remoteAddress('ext::shell', true)).toThrow()
    expect(() => remoteAddress('https://secret@host/repo', false)).toThrow('credentials')
    expect(() => remoteAddress(f.remote, false)).toThrow()
    expect(repositoryIdentity('git@host:owner/repo.git')).toBe(repositoryIdentity('https://host/owner/repo.git'))
  })
  it('handles one-sided additions, removals and explicit tombstones deterministically', () => {
    const base = track('a', 'b'), local = track('a', 'local'), remote = { ...track('a', 'b'), entries: [track('a').entries[0]!, {id:'remote-new',value:{state:'deleted'}}] }
    const merged = mergeTracks(base, local, remote, binding.slot)
    expect(merged.conflicts).toHaveLength(1)
    expect(merged.snapshot.entries.map(entry => entry.id)).toEqual(['record-0', 'remote-new'])
    expect(mergeTracks(track('a'), track('a'), track(), binding.slot).snapshot.entries).toEqual([])
  })
  it('recovers the same Git commit after an interrupted local receipt write', async () => {
    const f = await fixture(), a = await f.create('a')
    let plan = await prepare(a, f.scope, track('retained'))
    plan = await change(a, f.scope, plan, 'begin-apply')
    plan = await change(a, f.scope, plan, 'record-apply', { slot: binding.slot, sourceRevision: 'imported', snapshot: plan.merged.tracks[binding.slot] })
    const save = (a.engine as any).savePlan.bind(a.engine)
    ;(a.engine as any).savePlan = async (value: SyncPlan) => { if (value.status === 'complete') throw new Error('Simulated receipt interruption'); return save(value) }
    await expect(change(a, f.scope, plan, 'commit-plan')).rejects.toThrow('receipt interruption')
    const reopened = { engine: new SyncEngine(a.engine.directory, { allowLocalRemotes: true }), id: a.id }
    const resumed = await change(reopened, f.scope, plan, 'begin-apply')
    expect(resumed.status).toBe('applying')
    const recovered = await change(reopened, f.scope, resumed, 'commit-plan')
    expect(recovered.status).toBe('complete')
    await push(reopened, f.scope)
    expect(await git(['--git-dir', f.remote, 'rev-list', '--count', recovered.branch])).toBe('1')
  })
})

it('rejects a fetched bundle for a different project identity', async () => {
  const f = await fixture(), a = await f.create('identity-check')
  const first = await commit(a, f.scope, await prepare(a, f.scope, track('private'))); await push(a, f.scope)
  const options = { directory: f.remote, allowLocal: true }
  const bundle = JSON.parse(await git(['show', first.commit + ':bundle.json'], options))
  bundle.identity = 'foreign-project'
  const blob = await git(['hash-object', '-w', '--stdin'], { ...options, input: JSON.stringify(bundle) })
  const tree = await git(['mktree'], { ...options, input: `100644 blob ${blob}\tbundle.json\n` })
  const changed = await git(['commit-tree', tree, '-p', first.commit!], { ...options, input: 'test(memory): mismatched identity\n' })
  await git(['update-ref', 'refs/heads/' + first.branch, changed, first.commit!], options)
  await expect(prepare(a, f.scope, track('private'))).rejects.toThrow('identity or format')
  expect((await a.engine.plan(f.scope, a.id)).value).toMatchObject({ id: first.id, status: 'complete' })
})
it('exposes scoped human operations through real Core without granting model sync authority', async () => {
  const f = await fixture(), runner = new MemoryCompositionRunner({ strategyTypeId: 'workspace' })
  try {
    await runner.mount(sync, { instanceId: 'sync-a', config: { dataDir: join(f.root, 'managed'), allowLocalRemotes: true } })
    const disposeB = await runner.mount(sync, { instanceId: 'sync-b', config: { dataDir: join(f.root, 'managed'), allowLocalRemotes: true } })
    await runner.mount(workspace, { instanceId: 'workspace' })
    const client = await runner.managementClient('source:sync-a', f.scope)
    const state = await client.read('status')
    const saved = await client.mutate('configure', { title: 'Human target', scope: 'project', projectKey: 'validation', remote: f.remote, bindings: json([binding]) }, { expectedRevision: state.revision, confirmed: true })
    const targetId = (saved.value as unknown as { targets: { id: string }[] }).targets[0]!.id
    await expect(client.mutate('prepare', { id: targetId, captures: [] }, { expectedRevision: state.revision, confirmed: true })).rejects.toThrow(/revision/i)
    const other = await runner.managementClient('source:sync-b', f.scope)
    expect((await other.read('status')).value).toMatchObject({ targets: [] })
    const unrelated = await runner.managementClient('source:sync-a', { ...f.scope, workspaceId: join(f.root, 'other') })
    await expect(unrelated.read('plan', { id: targetId })).rejects.toThrow('not available')
    const shared = await runner.beginTurn({ scope: f.scope })
    expect(shared.view.projection).toHaveLength(2)
    expect(shared.view.routes).toEqual([])
    expect(shared.view.actionOffers).toEqual([])
    shared.release()
    await disposeB()
    const turn = await runner.beginTurn({ scope: f.scope })
    expect(turn.view.routes).toEqual([]); expect(turn.view.actionOffers).toEqual([])
    turn.release()
  } finally { await runner.dispose() }
})
