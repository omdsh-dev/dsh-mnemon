import { mkdtemp, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { newRecord, RecordStore } from 'dsh-mnemon/source-sdk'
import { Coordination, type CoordinationHooks } from '../src/lifecycle.ts'
import { declareResource, localProjectFile, writeConflicts } from '../src/resources.ts'
import { reserveFile } from '../src/rooms.ts'
import { subscribeCoordination } from '../src/dsh.ts'
const scope = { storage: 'custom' as const, workspaceId: '/project', sessionId: 'writer' }
const room = () => newRecord('room', 'Room', '', 'project', scope, { creator: 'writer', members: ['writer', 'peer'], openJoin: false, status: 'open' })
const file = { path: '/project/future.ts', key: 'opaque-target-key' }
describe('resource ownership and public filesystem hooks', () => {
  it('wraps an already registered terminal filesystem version policy through the actual Cordis waterfall', async () => {
    const ctx = new Context()
    ctx.provide('fs', { resolve: async () => ({ targetKey: 'root' }), contains: () => true, processPath: () => file.path } as any)
    ctx.provide('agents', { roots: () => [] } as any)
    const version = { version: 'observed-version' } as any
    ctx.on('fs/write-intent', async () => version)
    const hooks = { beforeWrite: vi.fn(async () => {}), written: vi.fn(), presence: vi.fn(), disposed: vi.fn() }
    const stop = subscribeCoordination(ctx, hooks), target = { targetKey: file.key } as any
    const actor = { token: Symbol('execution'), signal: new AbortController().signal, agent: { session: { id: 'writer', header: { cwd: '/project' } } } }
    expect(await ctx.waterfall('fs/write-intent', target, actor, () => undefined)).toBe(version)
    expect(hooks.beforeWrite).toHaveBeenCalledOnce()
    ctx.emit('fs/observed', target, { kind: 'present', version: 'observed-version' } as any, actor)
    expect(hooks.written).toHaveBeenCalledOnce()
    stop()
  })
  it('resolves future files but rejects paths and symlinks that escape the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mnemon-resources-')), outside = await mkdtemp(join(tmpdir(), 'mnemon-outside-'))
    try {
      const result = await localProjectFile('future/nested.ts', { ...scope, workspaceId: root })
      expect(result.path).toMatch(/future\/nested.ts$/)
      await expect(localProjectFile('../escape.ts', { ...scope, workspaceId: root })).rejects.toThrow(/outside/)
      await symlink(outside, join(root, 'link'))
      await expect(localProjectFile('link/future.ts', { ...scope, workspaceId: root })).rejects.toThrow(/outside/)
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })
  it('keeps declarations distinct from expiring leases and rejects foreign project membership', () => {
    const value = room(), records = [value]
    declareResource(records, { id: value.id, resourceType: 'file', label: 'Future file' }, scope, file)
    expect(writeConflicts(records, file, scope)).toHaveLength(0)
    expect(writeConflicts(records, file, { ...scope, sessionId: 'peer' })).toHaveLength(1)
    expect(() => declareResource(records, { id: value.id, resourceType: 'service', resource: 'https://user:password@example.com' }, scope)).toThrow(/credentials/)
    expect(() => declareResource(records, { id: value.id, resourceType: 'note', label: 'Note' }, { ...scope, workspaceId: '/other' })).toThrow(/project/)
    const lease = reserveFile(records, '/project/second.ts', scope, 1)
    lease.data.expiresAt = new Date(0).toISOString()
    expect(writeConflicts(records, { path: '/project/second.ts', key: '/project/second.ts' }, { ...scope, sessionId: 'peer' })).toHaveLength(0)
  })
  it('serializes presence and successful writes, warns or denies before writing, and releases ownership on disposal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mnemon-coordination-')), store = new RecordStore(directory)
    const value = room(), events: unknown[] = [], warning = vi.fn(), stop = vi.fn()
    await store.change(undefined, records => { records.push(value) })
    let hooks!: CoordinationHooks
    const coordinator = new Coordination(store, {}, { subscribe(value) { hooks = value; return stop }, warning, activity: event => events.push(event) }, 'source:team')
    try {
      hooks.presence(scope, 'running'); hooks.presence(scope, 'running'); hooks.written(file, scope)
      await coordinator.flush()
      expect(events).toHaveLength(1)
      expect((await store.read()).records.find(record => record.kind === 'resource')?.data).toMatchObject({ automatic: true, targetKey: file.key })
      await coordinator.beforeWrite(file, { ...scope, sessionId: 'peer' })
      expect(warning).toHaveBeenCalledOnce()
      const strict = new Coordination(store, { writeConflictPolicy: 'deny' }, {}, 'source:strict')
      await expect(strict.beforeWrite(file, { ...scope, sessionId: 'peer' })).rejects.toThrow(/Shared file conflict/)
      await strict.dispose()
      hooks.disposed(scope); await coordinator.flush()
      expect((await store.read()).records.find(record => record.kind === 'resource')?.state).toBe('archived')
      expect((await store.read()).records.find(record => record.kind === 'presence')?.data.status).toBe('closed')
      await coordinator.dispose()
      expect(stop).toHaveBeenCalledOnce()
      hooks.written(file, scope); await coordinator.flush()
      expect((await store.read()).records.filter(record => record.kind === 'resource')).toHaveLength(1)
    } finally { await coordinator.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
  it('preserves downstream version guards, ignores reads and failed tool attempts, and records successful writes once', async () => {
    const listeners = new Map<string, (...args: any[]) => any>()
    const ctx = { on(name: string, listener: (...args: any[]) => any) { listeners.set(name, listener); return () => listeners.delete(name) },
      fs: { resolve: async () => ({ targetKey: 'root' }), contains: () => true, processPath: () => file.path }, agents: { roots: () => [] } }
    const hooks = { beforeWrite: vi.fn(async () => {}), written: vi.fn(), presence: vi.fn(), disposed: vi.fn() }
    const stop = subscribeCoordination(ctx as any, hooks)
    const actor = { token: Symbol('execution'), signal: new AbortController().signal, agent: { session: { id: 'writer', header: { cwd: '/project' } } } }
    const target = { targetKey: file.key }, guard = { version: 'version-guard' }
    listeners.get('fs/observed')!(target, { kind: 'present' }, actor)
    expect(hooks.written).not.toHaveBeenCalled()
    const next = vi.fn(async () => guard)
    expect(await listeners.get('fs/write-intent')!(target, actor, next)).toBe(guard)
    expect(next).toHaveBeenCalledOnce()
    listeners.get('fs/observed')!(target, { kind: 'present' }, actor)
    listeners.get('fs/observed')!(target, { kind: 'present' }, actor)
    expect(hooks.written).toHaveBeenCalledOnce()
    await listeners.get('fs/edit-intent')!(target, actor, next)
    listeners.get('tools/result')!(actor)
    listeners.get('fs/observed')!(target, { kind: 'present' }, actor)
    expect(hooks.written).toHaveBeenCalledOnce()
    hooks.beforeWrite.mockRejectedValueOnce(new Error('Conflict'))
    await expect(listeners.get('fs/write-intent')!(target, actor, next)).rejects.toThrow('Conflict')
    expect(next).toHaveBeenCalledTimes(2)
    stop(); expect(listeners.size).toBe(0)
  })
})
