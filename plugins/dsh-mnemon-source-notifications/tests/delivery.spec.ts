import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationEngine, sameWorkspace } from '../src/engine.ts'
import { validateConfig, type ChannelPayload } from '../src/delivery.ts'
import { createNotificationsSource } from '../src/index.ts'
const directories: string[] = []
const scope = { storage: 'custom' as const, workspaceId: '/project', sessionId: 'owner' }
const config = { channels: [{ id: 'first', label: 'First', target: 'test-room', endpoint: 'http://127.0.0.1:1/notice' }, { id: 'second', label: 'Second', target: 'test-user', endpoint: 'http://127.0.0.1:1/message' }] }
const directory = async () => { const value = await mkdtemp(join(tmpdir(), 'mnemon-notifications-')); directories.push(value); return value }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
describe('reviewed channel delivery', () => {
  it('claims once across independent engines and rejects altered plans or workspace access', async () => {
    const path = await directory(), send = vi.fn(async (_channel: unknown, _payload: unknown) => 'Accepted')
    const first = new NotificationEngine(path, config, { send }), second = new NotificationEngine(path, config, { send })
    const draft = await first.stage({ title: 'Notice', content: 'Exact text', delivery: true, channels: 'all', mode: 'message' }, scope)
    const id = draft.record.id, plan = draft.record.data.plan
    await expect(first.send(id, { ...(plan as object), content: 'Changed text' }, scope)).rejects.toThrow(/plan/)
    await expect(first.send(id, plan, { ...scope, workspaceId: '/other' })).rejects.toThrow(/workspace/)
    expect(send).not.toHaveBeenCalled()
    const results = await Promise.allSettled([first.send(id, plan, scope), second.send(id, plan, scope)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[1]).toMatchObject({ title: 'Notice', content: 'Exact text', mode: 'message', target: 'test-room' })
    const record = (await first.store.read()).records[0]!
    expect(record.data).toMatchObject({ status: 'sent', read: false, receipts: { first: { status: 'accepted' }, second: { status: 'accepted' } } })
    await expect(second.send(id, plan, scope)).rejects.toThrow(/unsent/)
    await first.dispose(); await second.dispose()
  })
  it('sends actual bounded attachments to a loopback HTTP target and retains partial receipts', async () => {
    const requests: ChannelPayload[] = []
    const server = createServer(async (request, response) => {
      const parts = []; for await (const part of request) parts.push(part)
      requests.push(JSON.parse(Buffer.concat(parts).toString('utf8')))
      expect(request.headers['idempotency-key']).toMatch(/:loop$/)
      response.writeHead(202); response.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/notification`
    const engine = new NotificationEngine(await directory(), { channels: [{ id: 'loop', label: 'Loopback', target: 'synthetic-inbox', endpoint }] }, {})
    try {
      const draft = await engine.stage({ title: 'With file', delivery: true, channels: ['loop'], attachments: [{ base64: Buffer.from('Synthetic attachment').toString('base64'), name: 'proof.txt' }] }, scope)
      await engine.send(draft.record.id, draft.record.data.plan, scope)
      expect(requests[0]?.attachments[0]).toMatchObject({ name: 'proof.txt', mediaType: 'text/plain', base64: Buffer.from('Synthetic attachment').toString('base64') })
      expect((await engine.asset(draft.record.id, requests[0]!.attachments[0]!.id, scope)).base64).toBe(requests[0]!.attachments[0]!.base64)
      await expect(engine.asset(draft.record.id, requests[0]!.attachments[0]!.id, { ...scope, workspaceId: '/other' })).rejects.toThrow(/workspace/)
    } finally { await engine.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    const send = vi.fn(async (channel: { id: string }) => { if (channel.id === 'second') throw new Error('credential must never reach inbox'); return 'Accepted' })
    const partial = new NotificationEngine(await directory(), config, { send })
    const draft = await partial.stage({ title: 'Partial', delivery: true, channels: 'all' }, scope)
    const receipts = await partial.send(draft.record.id, draft.record.data.plan, scope)
    expect(receipts.first?.status).toBe('accepted'); expect(receipts.second?.status).toBe('uncertain')
    expect(JSON.stringify(await partial.store.read())).not.toContain('credential must never')
    await expect(partial.send(draft.record.id, draft.record.data.plan, scope)).rejects.toThrow(/unsent/)
    await partial.dispose()
  })
  it('checks channel changes and damaged assets before any external send', async () => {
    const send = vi.fn(async () => 'Accepted'), path = await directory(), settings = structuredClone(config)
    const engine = new NotificationEngine(path, settings, { send })
    const draft = await engine.stage({ title: 'Review', delivery: true, channels: ['first'], attachments: [{ base64: 'dGVzdA==', name: 'test.txt' }] }, scope)
    settings.channels[0]!.target = 'other-user'
    await expect(engine.send(draft.record.id, draft.record.data.plan, scope)).rejects.toThrow(/configuration/)
    settings.channels[0]!.target = config.channels[0]!.target
    const asset = (draft.record.data.assets as Array<{ id: string }>)[0]!
    await writeFile(join(path, 'assets', asset.id), 'fail')
    await expect(engine.send(draft.record.id, draft.record.data.plan, scope)).rejects.toThrow(/damaged|changed/)
    expect(send).not.toHaveBeenCalled(); expect((await engine.store.read()).records[0]?.data).toMatchObject({ status: 'partial', receipts: { first: { status: 'failed' } } })
    await engine.dispose()
  })
  it('does not retry a durable sending claim after restart, and drains activity listeners', async () => {
    const path = await directory(), send = vi.fn(async () => 'Accepted'), stop = vi.fn()
    let listener: (event: any) => void = () => {}
    const engine = new NotificationEngine(path, config, { send, subscribe(callback) { listener = callback; return stop } })
    const event = { eventKey: 'job-1', sourceInstanceKey: 'jobs/one', scope, kind: 'job-completed', title: 'Job complete', summary: 'Synthetic output', level: 'info' as const }
    listener(event); listener(event); await engine.dispose()
    expect(stop).toHaveBeenCalledOnce()
    // A live observer drains accepted work before disposal; aborted writes may be absent, never partial.
    const reopened = new NotificationEngine(path, config, { send })
    await reopened.capture(event); await reopened.capture(event)
    expect((await reopened.store.read()).records.filter(record => record.data.eventKey === 'job-1')).toHaveLength(1)
    const draft = await reopened.stage({ title: 'Interrupted', delivery: true, channels: ['first'] }, scope)
    await reopened.store.change(undefined, records => { records.find(record => record.id === draft.record.id)!.data.status = 'sending' })
    await reopened.dispose()
    const third = new NotificationEngine(path, config, { send })
    await expect(third.send(draft.record.id, draft.record.data.plan, scope)).rejects.toThrow(/unsent/)
    expect(send).not.toHaveBeenCalled(); await third.dispose()
  })
  it('unloads promptly when a custom transport ignores abort and preserves an uncertain receipt', async () => {
    const started = Promise.withResolvers<void>()
    const send = vi.fn(async () => { started.resolve(); return new Promise<string>(() => {}) })
    const engine = new NotificationEngine(await directory(), config, { send })
    const draft = await engine.stage({ title: 'Unload', delivery: true, channels: ['first'] }, scope)
    const pending = engine.send(draft.record.id, draft.record.data.plan, scope)
    await started.promise
    await engine.dispose()
    expect((await pending).first?.status).toBe('uncertain')
    expect((await engine.store.read()).records[0]?.data.status).toBe('partial')
    expect(send).toHaveBeenCalledOnce()
  })
  it('keeps model reads scoped while providing a personal inbox and revision-fenced controls', async () => {
    const definition = createNotificationsSource({ dataDir: await directory() })
    const runtime = definition.create({ sourceInstanceKey: 'notifications/default', configuration: {} } as any)
    const manage = async (operation: string, input: any = {}, mutate = false, revision?: string) => runtime.manage!({ mode: mutate ? 'mutate' : 'read', operation, input, scope, ...(mutate ? { confirmed: true, expectedRevision: revision } : {}) } as any)
    try {
      const before = await manage('inbox')
      const created = await manage('stage', { title: 'Personal activity', content: 'Local only' }, true, before.revision)
      const record = created.value as any
      expect(sameWorkspace(record, scope)).toBe(true); expect(sameWorkspace(record, { ...scope, workspaceId: '/other' })).toBe(false)
      await expect(manage('mark-read', { id: record.id }, true, before.revision)).rejects.toThrow(/revision/)
      await manage('mark-read', { id: record.id }, true, created.revision)
      expect((await manage('inbox')).value).toMatchObject({ unread: 0, total: 1 })
      await expect(manage('stage', { title: 'Bad path', attachments: [{ path: '/etc/passwd' }] }, true, (await manage('inbox')).revision)).rejects.toThrow()
    } finally { await runtime.dispose?.() }
    expect(() => validateConfig({ channels: [{ ...config.channels[0]!, endpoint: 'https://user:secret@example.com' }] })).toThrow(/credentials/)
  })
})
