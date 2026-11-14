import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostAgent, HostSessionEvent, HostSubagentRun, HostSubagentsService, ToolExecution } from '../src/host/dsh.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { cleanupSubagentFixtures, createCoordinator, parent as subagentParent, runtimeSource, subagents, toolRegistry } from './fixtures/subagent-coordinator.ts'
import { IdleReviewWatermarkStore } from '../src/host/idle-review-watermark.ts'
import { POST_TURN_REVIEW_POLICY, scoreReviewActivity } from '../src/host/review-activity.ts'
import { reviewCheckpoint } from '../src/host/review-checkpoint.ts'
import { idleReviewBlockReason, reviewLayerPolicy, startGuardedChild, startGuardedReview, type ReviewToolHost } from '../src/host/review-tools.ts'
import { WorkspaceMemoryPolicy } from '../src/host/workspace-exclusion.ts'
import { sessionLog } from './fixtures/session-log.ts'

describe('review tool guards', () => {
  function fixture() {
    const listeners = new Set<(event: { agent: HostAgent }) => void>()
    const owners = new Map<string, HostAgent>()
    const observerDispose = vi.fn()
    const host: ReviewToolHost = {
      agents: { isOwnedBy: (id, owner) => owners.get(id) === owner },
      on(_name, listener) {
        const callback = listener as (event: { agent: HostAgent }) => void
        listeners.add(callback)
        return () => { listeners.delete(callback); observerDispose() }
      },
    }
    const parent = { id: 'parent' } as HostAgent
    const child = (id: string) => {
      const guards = new Set<(execution: ToolExecution) => string | undefined>()
      const release = vi.fn()
      const agent = { id, ctx: { tools: { guard(callback: (execution: ToolExecution) => string | undefined) {
        guards.add(callback)
        return () => { guards.delete(callback); release() }
      } } } } as unknown as HostAgent
      const runDispose = vi.fn(async () => {})
      const run: HostSubagentRun = new class {
        get id() { return id }
        get localAgent() { return agent }
        get result() { return Promise.resolve({ output: [], stopReason: 'completed' }) }
        dispose() { return runDispose() }
      }()
      return { agent, guards, release, run, runDispose,
        denial(name: string) { return [...guards].map(guard => guard({ name, agent, signal: new AbortController().signal })).find(Boolean) },
      }
    }
    const publish = (agent: HostAgent, owner = parent) => {
      owners.set(agent.id, owner)
      for (const listener of listeners) listener({ agent })
    }
    return { host, parent, child, publish, listeners, observerDispose }
  }

  describe('review publication and execution boundary', () => {
    it.each(['parent', 'child'] as const)('refuses a disposed %s without installing a tool guard', async target => {
      const f = fixture(), child = f.child('disposed-child')
      const ctx = new Context()
      const fiber = await ctx.plugin({ name: 'mnemon-disposed-context', apply() {} })
      await fiber.dispose()
      const agent = target === 'parent' ? f.parent : child.agent
      Object.assign(agent, { ctx: { ...agent.ctx, fiber } })
      const start = vi.fn(async () => { f.publish(child.agent); return child.run })
      await expect(startGuardedReview(f.host, f.parent, ['allowed'], start)).rejects.toThrow('cannot create effect on inactive context')
      expect(start).toHaveBeenCalledTimes(target === 'parent' ? 0 : 1)
      expect(child.guards.size).toBe(0)
      expect(f.listeners.size).toBe(0)
    })

    it.each([false, true])('respects the enabled Team task-board API without the retired teammate tool: %s', enabled => {
      const team = { isEnabled: vi.fn(() => enabled) }
      const parent = { ctx: { get: () => team, tools: { get: (name: string) => name === 'team_task_create' ? {} : undefined } } } as unknown as HostAgent
      expect(idleReviewBlockReason(parent)).toBe(enabled ? 'agent-team' : undefined)
      expect(idleReviewBlockReason(parent, 'scoped')).toBeUndefined()
    })

    it.each([[false, false], [true, false], [false, true], [true, true]])('checks scoped Team tools together with the public service: %s/%s', (service, capability) => {
      const get = vi.fn(() => capability ? {} : undefined)
      const parent = { ctx: { get: (name: string) => service && name === 'agentTeams' ? {} : undefined, tools: { get } } } as unknown as HostAgent
      expect(idleReviewBlockReason(parent)).toBe(service && capability ? 'agent-team' : undefined)
      expect(idleReviewBlockReason(parent, 'pause')).toBe(service && capability ? 'agent-team' : undefined)
      expect(idleReviewBlockReason(parent, 'scoped')).toBeUndefined()
      if (service) expect(get).toHaveBeenCalledWith('spawn_teammate', parent)
    })

    it('separates nested same-parent reviews and leaves other parents alone', async () => {
      const f = fixture()
      const outer = f.child('outer'), inner = f.child('inner'), unrelated = f.child('unrelated')
      let innerRun: HostSubagentRun | undefined
      const outerRun = await startGuardedReview(f.host, f.parent, ['outer-result'], async () => {
        innerRun = await startGuardedReview(f.host, f.parent, ['inner-result'], async () => {
          f.publish(unrelated.agent, { id: 'another-parent' } as HostAgent)
          f.publish(inner.agent)
          expect(inner.guards.size).toBe(1)
          expect(inner.denial('inner-result')).toBeUndefined()
          return inner.run
        })
        f.publish(outer.agent)
        expect(outer.denial('outer-result')).toBeUndefined()
        return outer.run
      })
      expect(outerRun.id).toBe('outer')
      expect(outerRun.localAgent).toBe(outer.agent)
      await expect(outerRun.result).resolves.toMatchObject({ stopReason: 'completed' })
      expect(inner.denial('outer-result')).toContain('Mnemon review')
      expect(outer.denial('inner-result')).toContain('Mnemon review')
      expect(unrelated.guards.size).toBe(0)
      expect(f.listeners.size).toBe(0)
      await innerRun!.dispose()
      await outerRun.dispose()
      expect(inner.guards.size + outer.guards.size).toBe(0)
    })

    it('keeps independently overlapping allowlists separate', async () => {
      const f = fixture()
      const first = f.child('first'), second = f.child('second')
      const release = Promise.withResolvers<void>()
      const firstRun = startGuardedReview(f.host, f.parent, ['first-result'], async () => {
        await release.promise
        f.publish(first.agent)
        return first.run
      })
      const secondRun = await startGuardedReview(f.host, f.parent, ['second-result'], async () => {
        f.publish(second.agent)
        return second.run
      })
      release.resolve()
      const active = await firstRun
      expect(first.guards.size).toBe(1)
      expect(second.guards.size).toBe(1)
      expect(first.denial('second-result')).toContain('Mnemon review')
      expect(second.denial('first-result')).toContain('Mnemon review')
      await active.dispose()
      await secondRun.dispose()
    })

    it('allows the supplied capabilities and PTC transport while retaining guards through child cleanup', async () => {
      const f = fixture(), child = f.child('child')
      const release = Promise.withResolvers<void>()
      child.runDispose.mockImplementation(() => release.promise)
      const run = await startGuardedReview(f.host, f.parent, ['mnemon_document_search', 'mnemon_subagent_result'], async () => {
        f.publish(child.agent)
        return child.run
      })
      expect(child.denial('mnemon_document_search')).toBeUndefined()
      expect(child.denial('mnemon_subagent_result')).toBeUndefined()
      expect(child.denial('run_code')).toBeUndefined()
      expect(child.denial('mcp__aoci__aoci_overview')).toContain('reuse the inherited checkpoint')
      for (const name of ['spawn_teammate', 'send_message', 'team_task_create', 'fork_agent', 'spawn_agent']) {
        expect(child.denial(name)).toContain('Mnemon review cannot execute')
      }
      const disposing = run.dispose()
      expect(child.guards.size).toBe(1)
      release.resolve()
      await disposing
      expect(child.guards.size).toBe(0)
    })

    it('cleans up the owned child if removing the publication observer fails', async () => {
      const f = fixture(), child = f.child('child')
      f.observerDispose.mockImplementation(() => { throw new Error('observer disposer failure') })
      await expect(startGuardedReview(f.host, f.parent, [], async () => {
        f.publish(child.agent)
        return child.run
      })).rejects.toThrow('observer disposer failure')
      expect(child.runDispose).toHaveBeenCalledOnce()
      expect(child.release).toHaveBeenCalledOnce()
      expect(f.listeners.size).toBe(0)
    })

    it('attempts every guard disposer even when one fails', async () => {
      const f = fixture(), first = f.child('first'), second = f.child('second')
      first.release.mockImplementation(() => { throw new Error('guard disposer failure') })
      const run = await startGuardedReview(f.host, f.parent, [], async () => {
        f.publish(first.agent)
        f.publish(second.agent)
        return first.run
      })
      await expect(run.dispose()).rejects.toThrow('guard cleanup failed')
      expect(first.release).toHaveBeenCalledOnce()
      expect(second.release).toHaveBeenCalledOnce()
    })

    it('removes publication state and guards when provider startup rejects', async () => {
      const f = fixture(), child = f.child('child')
      await expect(startGuardedReview(f.host, f.parent, [], async () => {
        f.publish(child.agent)
        throw new Error('provider rolled back')
      })).rejects.toThrow('provider rolled back')
      expect(child.guards.size).toBe(0)
      expect(f.listeners.size).toBe(0)
    })

    it('finds the guarded child by id when the run names it only by id (#356)', async () => {
      const f = fixture(), child = f.child('child'), other = f.child('other')
      const byId = { id: 'child', result: child.run.result, dispose: () => child.run.dispose() }
      const run = await startGuardedReview(f.host, f.parent, ['mnemon_subagent_result'], async () => {
        f.publish(child.agent)
        return byId
      })
      expect(run.localAgent).toBe(child.agent)
      expect(child.denial('mcp__aoci__aoci_overview')).toContain('Mnemon review cannot execute')
      await run.dispose()
      expect(child.guards.size).toBe(0)
      await expect(startGuardedReview(f.host, f.parent, [], async () => {
        f.publish(other.agent)
        return byId
      })).rejects.toThrow('scoped tool guard')
      expect(other.guards.size).toBe(0)
    })

    it('fails before starting when ownership is unavailable and rejects an unguarded published child', async () => {
      const f = fixture(), child = f.child('child'), start = vi.fn(async () => child.run)
      await expect(startGuardedReview({ on: f.host.on }, f.parent, [], start)).rejects.toThrow('ownership')
      expect(start).not.toHaveBeenCalled()
      await expect(startGuardedReview(f.host, f.parent, [], start)).rejects.toThrow('scoped tool guard')
      expect(child.runDispose).toHaveBeenCalledOnce()
      expect(f.listeners.size).toBe(0)
    })
  })

  describe('an optional guard on a delegated write (#387)', () => {
    const refuse = () => 'refused'
    const optional = { purpose: 'write', optional: true }

    it('guards a published child as a review does', async () => {
      const f = fixture(), child = f.child('child')
      const run = await startGuardedChild(f.host, f.parent, async () => { f.publish(child.agent); return child.run }, refuse, optional)
      expect(child.denial('mnemon_remember')).toBe('refused')
      await run.dispose()
      expect(child.guards.size).toBe(0)
    })

    it('runs a child unguarded only where it cannot be guarded', async () => {
      const f = fixture(), child = f.child('child')
      await expect(startGuardedChild({ on: f.host.on }, f.parent, async () => child.run, refuse, optional)).resolves.toBe(child.run)
      const plain = { id: 'plain' } as HostAgent
      const plainRun = { id: 'plain', localAgent: plain, result: child.run.result, dispose: async () => {} } as HostSubagentRun
      await expect(startGuardedChild(f.host, f.parent, async () => { f.publish(plain); return plainRun }, refuse, optional)).resolves.toBe(plainRun)
      const remote = { id: 'remote', result: child.run.result, dispose: async () => {} } as HostSubagentRun
      await expect(startGuardedChild(f.host, f.parent, async () => remote, refuse, optional)).resolves.toBe(remote)
      expect(f.listeners.size).toBe(0)
    })

    it('fails closed for a local child it could guard but did not see published', async () => {
      const f = fixture(), child = f.child('child')
      await expect(startGuardedChild(f.host, f.parent, async () => child.run, refuse, optional)).rejects.toThrow('scoped tool guard')
      expect(child.runDispose).toHaveBeenCalledOnce()
      const other = f.child('other')
      const byId = { id: 'other', result: other.run.result, dispose: () => other.run.dispose() }
      const registry: ReviewToolHost = { ...f.host, agents: { ...f.host.agents, get: id => id === 'other' ? other.agent : undefined } }
      await expect(startGuardedChild(registry, f.parent, async () => byId, refuse, optional)).rejects.toThrow('scoped tool guard')
      expect(other.runDispose).toHaveBeenCalledOnce()
      expect(f.listeners.size).toBe(0)
    })
  })

  describe('one layer per idle review pass (#319)', () => {
    const call = (name: string, args?: unknown): ToolExecution => ({ name, arguments: args, signal: new AbortController().signal })

    it('refuses working memory after a Document, and a Document after working memory', () => {
      const documentsFirst = reviewLayerPolicy()
      expect(documentsFirst(call('mnemon_document_create', { title: 'Boot account resolution' }))).toBeUndefined()
      for (const action of ['add', 'replace', 'remove']) {
        expect(documentsFirst(call('mnemon_runtime_memory', { action, target: 'memory' }))).toContain('already created a Document')
      }
      const memoryFirst = reviewLayerPolicy()
      expect(memoryFirst(call('mnemon_runtime_memory', { action: 'add', target: 'memory', content: 'Run pnpm verify before pushing.' }))).toBeUndefined()
      expect(memoryFirst(call('mnemon_document_create', { title: 'Release checklist' }))).toContain('already changed working memory')
    })

    it('leaves profile changes, reads and the claimed layer alone', () => {
      const policy = reviewLayerPolicy()
      expect(policy(call('mnemon_document_search', { query: 'boot account' }))).toBeUndefined()
      expect(policy(call('mnemon_runtime_memory', { action: 'add', target: 'user', content: 'Prefers short answers.' }))).toBeUndefined()
      expect(policy(call('mnemon_document_create', { title: 'Boot account resolution' }))).toBeUndefined()
      expect(policy(call('mnemon_document_create', { title: 'Boot account resolution' }))).toBeUndefined()
      expect(policy(call('mnemon_runtime_memory', { action: 'replace', target: 'user', old_text: 'short' }))).toBeUndefined()
      expect(policy(call('run_code', { code: 'await tools.mnemon_document_search({ query: "boot" })' }))).toBeUndefined()
      expect(policy(call('mnemon_subagent_result', {}))).toBeUndefined()
    })

    it('claims no layer for a runtime call without target=memory', () => {
      const policy = reviewLayerPolicy()
      for (const args of [undefined, null, 'memory', { action: 'add' }, { action: 'add', target: 'project' }]) {
        expect(policy(call('mnemon_runtime_memory', args))).toBeUndefined()
      }
      expect(policy(call('mnemon_document_create', { title: 'Boot account resolution' }))).toBeUndefined()
    })

    it('judges only calls the allowlist admits, including PTC sub-dispatches', async () => {
      const f = fixture(), child = f.child('child')
      const run = await startGuardedReview(f.host, f.parent, ['mnemon_document_create', 'mnemon_runtime_memory'], async () => {
        f.publish(child.agent)
        return child.run
      }, undefined, reviewLayerPolicy())
      const [guard] = child.guards
      expect(guard!(call('run_code', {}))).toBeUndefined()
      expect(guard!({ ...call('mnemon_document_create', { title: 'Boot account resolution' }), parent: Symbol('run_code') })).toBeUndefined()
      expect(guard!(call('mnemon_runtime_memory', { action: 'add', target: 'memory' }))).toContain('already created a Document')
      expect(guard!(call('mnemon_remember', { content: 'Same fact.' }))).toContain('Mnemon review cannot execute')
      await run.dispose()
    })
  })
})

describe('post-turn background review score', () => {
  it('uses the original constants without provider token accounting', () => {
    expect(POST_TURN_REVIEW_POLICY).toEqual({
      reviewThreshold: 5,
      textLengthScoreUnit: 50,
      textLengthScoreCap: 3,
      toolCountScoreUnit: 5,
      toolCountScoreCap: 2,
      toolDiversityThreshold: 3,
      toolDiversityScoreCap: 2,
      turnScore: 1,
    })
  })

  it('caps text and tool volume while scoring turns and tool diversity independently', () => {
    expect(scoreReviewActivity({
      totalUserTextLength: 1_000,
      turnCount: 2,
      toolCallCount: 100,
      uniqueToolCount: 8,
    })).toMatchObject({
      textLengthScore: 3,
      turnScore: 2,
      toolCallScore: 2,
      toolDiversityScore: 2,
      score: 9,
      threshold: 5,
      eligible: true,
    })
  })

  it('matches the threshold examples exactly', () => {
    expect(scoreReviewActivity({ totalUserTextLength: 150, turnCount: 1, toolCallCount: 0, uniqueToolCount: 0 }).score).toBe(4)
    expect(scoreReviewActivity({ totalUserTextLength: 150, turnCount: 2, toolCallCount: 0, uniqueToolCount: 0 }).score).toBe(5)
    expect(scoreReviewActivity({ totalUserTextLength: 100, turnCount: 1, toolCallCount: 5, uniqueToolCount: 3 }).score).toBe(5)
    expect(scoreReviewActivity({ totalUserTextLength: 0, turnCount: 5, toolCallCount: 0, uniqueToolCount: 0 }).score).toBe(5)
  })
})

describe('bounded review checkpoint', () => {
  it('uses whole visible messages and excludes rewound, plugin and unfinished evidence', () => {
    const message = (seq: number, text: string, type = 'user/message', kind = 'user'): HostSessionEvent => {
      const body = { source: { kind }, content: [{ type: 'text', text }] }
      return { seq, type, data: type === 'user/message' ? body : { message: body } }
    }
    const events = [message(0, 'rewound fact'), message(1, 'plugin assertion', 'user/message', 'plugin'),
      message(2, 'Please remember the explicit decision to use SQLite.'), message(3, 'oversized '.repeat(500)),
      message(4, 'bounded artifact', 'assistant/message'), message(5, 'successful tool evidence', 'tool/result'),
      { seq: 6, type: 'turn/end', data: {} }, message(7, 'unfinished fact')]
    const prompt = reviewCheckpoint({ ...sessionLog(events), surface: { nodes: [1, 2, 3, 4, 5, 7] } }, 1_000)
    expect(prompt.length).toBeLessThanOrEqual(1_000)
    expect(prompt).toContain('Please remember the explicit decision to use SQLite.')
    expect(prompt).toContain('bounded artifact')
    expect(prompt).toContain('successful tool evidence')
    expect(prompt).not.toMatch(/rewound fact|plugin assertion|oversized|unfinished fact/)
    expect(prompt).toContain('skip candidates needing missing evidence')
  })

  it('reads published flat user events without promoting injected or unknown sources (issue 275)', () => {
    const event = (seq: number, text: string, source?: object): HostSessionEvent => ({ seq, type: 'user/message',
      data: { id: `user-${seq}`, role: 'user', content: [{ type: 'text', text }], ...(source === undefined ? {} : { source }) },
    })
    const events = [
      event(0, 'Remember the explicit SQLite project decision.', { kind: 'user', rpcId: 'synthetic-rpc' }),
      event(1, 'Do not write this checkpoint to memory. 不记录本轮的临时诊断信息。', { kind: 'user' }),
      event(2, 'Injected runtime snapshot.', { kind: 'dsh-mnemon', form: 'recall' }),
      event(3, 'Old plugin wrapper.', { kind: 'plugin', plugin: 'dsh-mnemon' }),
      event(4, 'Namespaced plugin wrapper.', { kind: 'plugin:dsh-mnemon' }),
      event(5, 'Runtime policy.', { kind: 'runtime-context' }),
      event(6, 'Compacted summary.', { kind: 'summary' }),
      event(7, 'No known source.'),
      { seq: 8, type: 'turn/end', data: {} },
    ]
    const checkpoint = reviewCheckpoint({ ...sessionLog(events), surface: { nodes: events.map(event => event.seq!) } }, 2_000)
    expect(checkpoint).toContain('[user/message; checkpoint event 0]\nRemember the explicit SQLite project decision.')
    expect(checkpoint).toContain('[user/message; checkpoint event 1]\nDo not write this checkpoint to memory. 不记录本轮的临时诊断信息。')
    expect(checkpoint).not.toMatch(/Injected|wrapper|Runtime policy|Compacted|No known source/u)
  })

  it('skips review before any completed checkpoint', () => {
    expect(reviewCheckpoint(sessionLog(), 1_000)).toContain('No completed checkpoint')
  })
})

describe('persistent idle-review admission', () => {
  const roots: string[] = []
  afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
  function fixture(sessionId = '../../unsafe/session') {
    const root = fs.mkdtempSync(join(tmpdir(), 'mnemon-watermark-'))
    roots.push(root)
    const directory = join(root, 'state', 'idle-review')
    const path = join(directory, createHash('sha256').update(sessionId).digest('hex') + '.json')
    const store = new IdleReviewWatermarkStore(root, sessionId)
    const seed = (value: unknown) => { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }
    return { root, directory, path, store, seed }
  }
  const policy = { maxPerSession: 2, minIntervalMs: 5_000, now: 10_000 }

  it.each(['', 'x'.repeat(4097), '\0'.repeat(4096)])('refuses session ids that cannot fit a bounded validated record', sessionId => {
    expect(() => new IdleReviewWatermarkStore('/unused-synthetic-root', sessionId)).toThrow(/Idle review watermark/)
  })

  it('keeps missing state empty without creating files and hashes unsafe session ids', () => {
    const f = fixture()
    expect(f.store.load()).toEqual({ version: 1, sessionId: '../../unsafe/session', attempts: 0, lastReviewAttemptAt: null })
    expect(fs.existsSync(f.directory)).toBe(false)
    expect(f.store.reserve(policy)).toMatchObject({ attempts: 1, lastReviewAttemptAt: 10_000 })
    expect(JSON.parse(fs.readFileSync(f.path, 'utf8'))).toMatchObject({ sessionId: '../../unsafe/session', attempts: 1 })
    if (process.platform !== 'win32') {
      expect(fs.statSync(f.path).mode & 0o777).toBe(0o600)
      expect(fs.statSync(f.directory).mode & 0o777).toBe(0o700)
    }
  })

  it('reloads under the lock so independent stores cannot reuse a quota or cooling interval', () => {
    const f = fixture('parent')
    const other = new IdleReviewWatermarkStore(f.root, 'parent')
    expect(f.store.reserve(policy)?.attempts).toBe(1)
    expect(other.reserve({ ...policy, now: 14_999 })).toBeUndefined()
    expect(other.reserve({ ...policy, now: 15_000 })?.attempts).toBe(2)
    expect(f.store.reserve({ ...policy, now: 20_000 })).toBeUndefined()
    expect(f.store.load().attempts).toBe(2)
  })

  it('admits at most one attempt across independent Node processes sharing the same root', async () => {
    const f = fixture('parent')
    const script = `
      const { IdleReviewWatermarkStore } = await import(process.argv[1]);
      try {
        const result = new IdleReviewWatermarkStore(process.argv[2], 'parent').reserve({ now: 10000, minIntervalMs: 5000, maxPerSession: 1 });
        process.stdout.write(result ? 'reserved' : 'blocked');
      } catch (error) {
        if (!error.message.includes('(busy)')) throw error;
        process.stdout.write('blocked');
      }
    `
    const launch = () => promisify(execFile)(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script,
      new URL('../src/host/idle-review-watermark.ts', import.meta.url).href, f.root], { env: { ...process.env, NODE_NO_WARNINGS: '1' } })
    const results = await Promise.all([launch(), launch()])
    expect(results.map(result => result.stdout).sort()).toEqual(['blocked', 'reserved'])
    expect(f.store.load().attempts).toBe(1)
  })

  it('preserves the in-memory usage floor on first opt-in and refuses backwards clocks and a zero budget', () => {
    const f = fixture('parent')
    expect(f.store.reserve({ ...policy, floor: { attempts: 1, lastReviewAttemptAt: 10_000 }, now: 15_000 })?.attempts).toBe(2)
    expect(f.store.reserve({ ...policy, now: 5_000 })).toBeUndefined()
    const fresh = fixture('new-parent')
    expect(fresh.store.reserve({ ...policy, maxPerSession: 0 })).toBeUndefined()
    expect(fs.existsSync(fresh.path)).toBe(false)
  })

  it.each([
    '{', { version: 2, sessionId: 'parent', attempts: 1, lastReviewAttemptAt: 1 },
    { version: 1, sessionId: 'other', attempts: 1, lastReviewAttemptAt: 1 },
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(attempts => ({ version: 1, sessionId: 'parent', attempts, lastReviewAttemptAt: 1 })),
    ...[-1, 1.5, 8_640_000_000_000_001, null, '1'].map(lastReviewAttemptAt => ({ version: 1, sessionId: 'parent', attempts: 1, lastReviewAttemptAt })),
    { version: 1, sessionId: 'parent', attempts: 0, lastReviewAttemptAt: 1 },
    ' '.repeat(16_385),
  ])('refuses damaged state without granting a budget (%j)', value => {
    const f = fixture('parent'); f.seed(value)
    expect(() => f.store.load()).toThrow(/Idle review watermark/)
    expect(() => f.store.reserve(policy)).toThrow(/Idle review watermark/)
    expect(fs.readFileSync(f.path, 'utf8')).toBe(typeof value === 'string' ? value : JSON.stringify(value))
  })

  it('fails closed on an existing lock and never deletes another writer lock', () => {
    const f = fixture('parent')
    fs.mkdirSync(f.directory, { recursive: true }); fs.mkdirSync(f.path + '.lock')
    expect(() => f.store.reserve(policy)).toThrow(/busy/)
    expect(fs.existsSync(f.path + '.lock')).toBe(true)
    expect(fs.existsSync(f.path)).toBe(false)
  })

  it('preserves the old file and removes only its temporary file when atomic replacement fails', () => {
    const f = fixture('parent')
    f.store.reserve(policy)
    const previous = fs.readFileSync(f.path, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Object.assign(new Error('private-path sk-secret'), { code: 'EACCES' }) })
    expect(() => f.store.reserve({ ...policy, now: 15_000 })).toThrow(/EACCES/)
    expect(fs.readFileSync(f.path, 'utf8')).toBe(previous)
    expect(fs.readdirSync(f.directory)).toEqual([f.path.split('/').at(-1)])
  })

  it('redacts lock cleanup failures after retaining the consumed reservation', () => {
    const f = fixture('parent')
    vi.spyOn(fs, 'rmdirSync').mockImplementationOnce(() => { throw Object.assign(new Error('private-root sk-privatecredential'), { code: 'EACCES' }) })
    expect(() => f.store.reserve(policy)).toThrow(/Idle review watermark unavailable.*EACCES/)
    expect(f.store.load().attempts).toBe(1)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('treats an unreadable watermark as a failure, not an empty budget', () => {
    const f = fixture('parent'); f.store.reserve(policy)
    fs.chmodSync(f.path, 0)
    try { expect(() => f.store.load()).toThrow(/EACCES/) }
    finally { fs.chmodSync(f.path, 0o600) }
  })

  it('does not treat a non-file or a non-ENOENT read failure as a fresh session', () => {
    const f = fixture('parent'); fs.mkdirSync(f.path, { recursive: true })
    expect(() => f.store.load()).toThrow(/Idle review watermark/)
    expect(() => f.store.reserve(policy)).toThrow(/Idle review watermark/)
  })
})

describe('workspace memory exclusion policy', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  function paths() {
    const root = mkdtempSync(join(tmpdir(), 'mnemon-exclusion-')); roots.push(root)
    const excluded = join(root, 'excluded'), other = join(root, 'other')
    mkdirSync(excluded); mkdirSync(other)
    return { root, excluded, other }
  }
  const agent = (id: string, cwd: string, parentSession?: string) => ({ id, session: { header: { cwd, ...(parentSession === undefined ? {} : { origin: 'subagent', parentSession }) } } }) as HostAgent

  it('does nothing by default and matches only an existing canonical workspace', () => {
    const { root, excluded, other } = paths()
    let entries: string[] = []
    const policy = new WorkspaceMemoryPolicy(() => entries)
    expect(policy.forWorkspace(excluded)).toEqual({ excluded: false })
    entries = [excluded + '/']
    const alias = join(root, 'alias'); symlinkSync(excluded, alias, 'dir')
    expect(policy.forWorkspace(alias).excluded).toBe(true)
    expect(policy.forWorkspace(other).excluded).toBe(false)
    const nested = join(excluded, 'nested'); mkdirSync(nested)
    expect(policy.forWorkspace(nested).excluded).toBe(false)
    entries = ['~']
    expect(policy.forWorkspace(homedir()).excluded).toBe(true)
  })

  it('ignores unavailable/invalid paths with bounded diagnostics instead of excluding everything', () => {
    const { root, other } = paths()
    const policy = new WorkspaceMemoryPolicy(() => ['relative', join(root, 'missing'), other])
    expect(policy.forWorkspace(other)).toEqual({ excluded: true, invalidEntries: [0, 1] })
    expect(policy.forWorkspace(join(root, 'missing'))).toEqual({ excluded: false, reason: 'workspace-unavailable', invalidEntries: [0, 1] })
    expect(policy.forWorkspace()).toEqual({ excluded: false, reason: 'workspace-unavailable', invalidEntries: [0, 1] })
  })

  it('inherits the live parent workspace across a different child cwd and parent disposal', () => {
    const { excluded, other } = paths()
    let entries = [excluded]
    const parent = agent('parent', excluded), child = agent('child', other, 'parent'), grandchild = agent('grandchild', other, 'child')
    const agents = new Map([parent, child, grandchild].map(value => [value.id, value]))
    const policy = new WorkspaceMemoryPolicy(() => entries, { get: id => agents.get(id) })
    expect(policy.forAgent(child).excluded).toBe(true)
    expect(policy.forAgent(grandchild).excluded).toBe(true)
    agents.delete('parent')
    expect(policy.forAgent(child).excluded).toBe(true)
    entries = []
    expect(policy.forAgent(child).excluded).toBe(false)
    entries = [other]
    expect(policy.forAgent(child).excluded).toBe(false)
    expect(policy.forAgent(agent('independent', other)).excluded).toBe(true)
  })

  it('resolves an unloaded parent from the Host workspace catalog and diagnoses an unknown parent', () => {
    const { excluded, other } = paths()
    const workspace = { id: 'project', title: 'Project', path: excluded, sessionIds: ['parent'] }
    const policy = new WorkspaceMemoryPolicy(() => [excluded], { get: () => undefined }, {
      get: id => id === workspace.id ? workspace : undefined, list: () => [workspace],
    })
    expect(policy.forAgent(agent('resumed-child', other, 'parent'))).toEqual({ excluded: true })
    expect(policy.forAgent(agent('unknown-child', other, 'unknown'))).toEqual({ excluded: false, reason: 'workspace-unavailable' })
  })
})

describe('Mnemon idle review coordinator', () => {
  afterEach(cleanupSubagentFixtures)
  it('reviews without a fork provider using bounded spawn context (issue 255)', async () => {
    const host = subagents({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] })
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.review(subagentParent(), new AbortController().signal)).resolves.toMatchObject({ provider: 'spawn', action: 'skipped' })
    expect(host.start).toHaveBeenCalledOnce()
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({ agentOptions: { maxTokens: 16384 } }))
  })

  it.each(['spawn', 'fork'] as const)('keeps scoped Team %s startup failures closed without replay (issue 275)', async provider => {
    const host = subagents(undefined, 'error', ['spawn', 'fork'])
    host.start.mockRejectedValueOnce(new Error('Team policy startup failed'))
    const runtime = runtimeSource()
    Object.assign(runtime.config.idleReview, { provider, agentTeams: 'scoped' })
    const coordinator = createCoordinator(host.value, runtime)
    const lead = subagentParent()
    lead.ctx = { get: () => ({}), tools: { get: () => ({}) } } as never
    await expect(coordinator.review(lead, new AbortController().signal)).rejects.toMatchObject({
      message: 'Team policy startup failed', review: { status: 'failed', provider, receipts: [] },
    })
    expect(host.start).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ reviews: 0, failures: 1 })
    const request = host.start.mock.calls[0]![1]!
    expect(request.maxDepth).toBe(1)
    expect(request.toolFilter?.allow).not.toEqual(expect.arrayContaining(['spawn_teammate']))
    expect(request.persona).toContain('Those capabilities remain unavailable')
  })

  it.each(['spawn', 'skip'] as const)('handles an unavailable fork before startup with %s policy', async fallback => {
    const host = subagents({ summary: 'No mutation.', action: 'skipped', memoryBodyIds: [] })
    const runtime = runtimeSource()
    Object.assign(runtime.config.idleReview, { provider: 'fork', fallback })
    const coordinator = createCoordinator(host.value, runtime)
    await expect(coordinator.review(subagentParent(), new AbortController().signal)).resolves.toMatchObject({ delegated: fallback === 'spawn', action: 'skipped' })
    expect(host.start).toHaveBeenCalledTimes(fallback === 'spawn' ? 1 : 0)
    expect(coordinator.snapshot().failures).toBe(0)
  })

  it.each(['start', 'dispose'] as const)('does not count an inactive-context review %s as a failure', async phase => {
    const host = subagents({ summary: 'No mutation.', action: 'skipped', memoryBodyIds: [] })
    const error = Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
    if (phase === 'start') host.start.mockRejectedValueOnce(error)
    else host.dispose.mockRejectedValueOnce(error)
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.review(subagentParent(), new AbortController().signal)).rejects.toMatchObject({ cause: error, review: { status: 'failed', receipts: [] } })
    expect(coordinator.snapshot()).toMatchObject({ failures: 0, reviews: 0 })
    expect(host.start).toHaveBeenCalledOnce()
  })

  it('does not report review success when child disposal fails', async () => {
    const host = subagents({ summary: 'No mutation.', action: 'skipped', memoryBodyIds: [] })
    host.dispose.mockRejectedValueOnce(new Error('child disposal failed'))
    const coordinator = createCoordinator(host.value)
    await expect(coordinator.review(subagentParent(), new AbortController().signal)).rejects.toMatchObject({
      message: 'child disposal failed', review: { status: 'failed', receipts: [] },
    })
    expect(coordinator.snapshot()).toMatchObject({ failures: 1, reviews: 0 })
  })

  it.each([false, true])('retains own committed receipts after a failed review without replay, Code Mode=%s', async codeMode => {
    const registry = toolRegistry()
    const child = { ...subagentParent('subagent'), id: 'review-child', ctx: { tools: { guard: () => () => {} } } } as unknown as HostAgent
    const host = subagents(undefined, 'error', ['fork', 'spawn'])
    host.start.mockImplementationOnce(async (_provider, request) => {
      registry.publish(child, request!.parent)
      const token = Symbol('outer Code Mode')
      const committed = { action: 'created', document: { id: 'document-committed' }, memoryReceipt: { completion: 'committed', status: 'succeeded', committedAt: '2026-09-16T00:00:00Z' } }
      registry.emit('tools/result', { agent: child, name: 'mnemon_document_create', arguments: { title: 'private title' }, ...(codeMode ? { parent: token } : {}) }, { value: committed })
      registry.emit('tools/result', { agent: { ...child, id: 'unrelated-child' }, name: 'mnemon_document_create' }, { value: { ...committed, document: { id: 'unrelated-document' } } })
      registry.emit('tools/result', { agent: child, name: 'mnemon_runtime_memory', arguments: { target: 'memory' } }, { value: { action: 'added', revision: 'runtime-revision' } })
      registry.emit('tools/result', { agent: child, name: 'mnemon_runtime_memory' }, { value: { action: 'added' }, isError: true })
      if (codeMode) registry.emit('tools/result', { agent: child, name: 'run_code', token }, { isError: true })
      return { id: child.id, localAgent: child, result: Promise.resolve({ output: [], structured: undefined, stopReason: 'error', diagnostic: 'TeamError: lost membership' }), dispose: host.dispose }
    })
    const runtime = runtimeSource()
    runtime.config.idleReview.provider = 'fork'
    const coordinator = new MnemonSubagentCoordinator(host.value, runtime, registry.value)
    await expect(coordinator.review(subagentParent(), new AbortController().signal)).rejects.toMatchObject({
      message: expect.stringContaining('TeamError'), review: { status: 'partial', runId: child.id, provider: 'fork', receipts: [
        { tool: 'mnemon_document_create', action: 'created', documentId: 'document-committed' },
        { tool: 'mnemon_runtime_memory', action: 'added', target: 'memory', revision: 'runtime-revision' },
      ] },
    })
    expect(host.start).toHaveBeenCalledOnce()
    expect(host.dispose).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ failures: 1, reviews: 0 })
  })

  it('reviews a completed full-context checkpoint through fork with a maintenance-only tool set', async () => {
    const host = subagents({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] }, 'completed', ['spawn', 'fork'])
    const runtime = runtimeSource()
    runtime.config.idleReview.provider = 'fork'
    const coordinator = createCoordinator(host.value, runtime)

    await expect(coordinator.review(subagentParent(), new AbortController().signal)).resolves.toMatchObject({
      delegated: true,
      provider: 'fork',
      action: 'skipped',
    })
    expect(host.start).toHaveBeenCalledWith('fork', expect.objectContaining({
      toolFilter: { allow: expect.arrayContaining(['mnemon_document_search', 'mnemon_runtime_memory', 'mnemon_document_create']) },
      persona: expect.stringContaining('idle checkpoint reviewer'),
      prompt: [{ type: 'text', text: '[dsh-mnemon:delegated review]\nReview the inherited completed checkpoint now.' }],
    }))
    const reviewCall = (host.start.mock.calls[0] as unknown as [string, { persona: string; toolFilter: { allow: string[] } }])[1]
    expect(reviewCall.persona).toContain('Never move a document to cold archive in this pass')
    expect(reviewCall.persona).toContain('Deep Recall is unavailable after the parent TurnView closes')
    expect(reviewCall.persona).toContain('Reuse complete evidence already present in the inherited checkpoint')
    expect(reviewCall.persona).toContain('skip the candidate when that is insufficient')
    expect(reviewCall.persona).not.toContain('Memory View')
    expect(reviewCall.persona).toContain('Never update or replace an existing document')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_document_manage')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_view_action')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_forget')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_recall')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_related')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_memory_bodies')
    expect(reviewCall.toolFilter.allow).not.toContain('mnemon_memory_zoom')
    expect(coordinator.snapshot()).toMatchObject({ reviews: 1, writes: 0, lastOperation: 'review' })
  })

  it('keeps project records out of hot memory and considers a Document first (#319)', async () => {
    const host = subagents({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] })
    const coordinator = createCoordinator(host.value)
    await coordinator.review(subagentParent(), new AbortController().signal)
    const { persona } = (host.start.mock.calls[0] as unknown as [string, { persona: string }])[1]
    expect(persona).toContain('Record each piece of knowledge in one layer')
    expect(persona).toContain('Project records never qualify')
    expect(persona).toContain('target=memory only for a compact rule the user stated')
    expect(persona).not.toContain('stable project, environment, decisions')
    expect(persona.indexOf('Project Documents:')).toBeLessThan(persona.indexOf('Hot memory is loaded'))
    // The bounded spawn checkpoint keeps its own wording.
    expect(persona).toContain('Reuse complete evidence already present in the supplied bounded checkpoint')
  })

  it('refuses a second layer inside one review pass through the child guard (#319)', async () => {
    const host = subagents({ summary: 'Created one document.', action: 'created', memoryBodyIds: [] })
    const registry = toolRegistry()
    let guard: ((execution: ToolExecution) => string | undefined) | undefined
    const published: HostSubagentsService = { ...host.value, async start(provider, request) {
      const run = await host.value.start!(provider, request)
      const child = { ...subagentParent('subagent'), id: run.id, ctx: { tools: { guard: (callback: typeof guard) => { guard = callback; return () => {} } } } } as unknown as HostAgent
      registry.publish(child, request.parent)
      return { ...run, localAgent: child }
    } }
    const coordinator = new MnemonSubagentCoordinator(published, runtimeSource(), registry.value)
    await coordinator.review(subagentParent(), new AbortController().signal)
    const call = (name: string, args: unknown) => guard!({ name, arguments: args, signal: new AbortController().signal })
    expect(call('mnemon_document_search', { query: 'boot account resolution' })).toBeUndefined()
    expect(call('mnemon_document_create', { title: 'Boot account resolution' })).toBeUndefined()
    expect(call('mnemon_runtime_memory', { action: 'add', target: 'user', content: 'Prefers short answers.' })).toBeUndefined()
    expect(call('mnemon_runtime_memory', { action: 'add', target: 'memory', content: 'Boot entries never run the panel as root.' })).toContain('already created a Document')
  })

  it('withholds runtime memory from idle review when it is switched off', async () => {
    const host = subagents({ summary: 'No mutation needed.', action: 'skipped', memoryBodyIds: [] })
    const runtime = runtimeSource()
    runtime.config.idleReview.runtimeMemory = false
    const coordinator = createCoordinator(host.value, runtime)
    await expect(coordinator.review(subagentParent(), new AbortController().signal)).resolves.toMatchObject({ delegated: true, action: 'skipped' })
    const request = (host.start.mock.calls[0] as unknown as [string, { persona: string; toolFilter: { allow: string[] } }])[1]
    expect(request.toolFilter.allow).toEqual(expect.arrayContaining(['mnemon_document_search', 'mnemon_document_create']))
    expect(request.toolFilter.allow).not.toContain('mnemon_runtime_memory')
    expect(request.persona).toContain('Runtime memory is off for idle review')
    expect(request.persona).not.toContain('mnemon_runtime_memory')
    expect(request.persona).toContain('Never update or replace an existing document')
  })
})
