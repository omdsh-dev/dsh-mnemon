import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import type { RecordSnapshot, RecordValue } from 'dsh-mnemon/source-sdk'
import { createCollaborationSource } from '../src/index.ts'

it('enforces addressed evidence, external approval, membership and pinned reservation versions through Core', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mnemon-rooms-')),
    filename = join(directory, 'app.ts')
  await writeFile(filename, '// synthetic project file')
  const runner = new MemoryCompositionRunner(),
    delivered: string[] = []
  const scope = { storage: 'custom' as const, workspaceId: directory, sessionId: 'creator' }
  await runner.mount(
    {
      apply(ctx: Context) {
        installMemory(ctx, {
          sources: [
            createCollaborationSource(
              { dataDir: directory },
              {
                async validate(id) {
                  if (!['creator', 'member', 'outsider'].includes(id)) throw new Error('Unknown project session')
                },
                async deliver(id, text, _scope, wake) {
                  delivered.push(`${id}:${wake}:${text}`)
                },
                async list() {
                  return []
                },
              },
            ),
          ],
        })
      },
    },
    { instanceId: 'rooms' },
  )
  await runner.mount(
    {
      apply(ctx: Context) {
        installMemory(ctx, {
          strategies: [
            defineMemoryStrategy({
              manifest: {
                apiVersion: COMPOSABLE_MEMORY_API_VERSION,
                kind: 'strategy',
                typeId: 'test-policy',
                packageName: 'test-policy',
                deterministic: true,
                supportedSourceRoles: ['collaboration'],
                maxSources: 4,
                maxRoutes: 8,
                maxActions: 16,
              },
              compose(_request, sources) {
                return {
                  strategyTypeId: 'test-policy',
                  explanation: 'Test public operations',
                  sources: sources.map((source) => ({
                    sourceInstanceKey: source.sourceInstanceKey,
                    projection: { mode: 'routed', maxCharacters: 10000 },
                    routeIds: source.routeIds,
                    actionIds: source.actionIds,
                  })),
                }
              },
            }),
          ],
        })
      },
    },
    { instanceId: 'policy' },
  )
  try {
    const client = await runner.managementClient('source:rooms', scope)
    const created = await client.mutate('create', { kind: 'room', title: 'Synthetic room' }, { confirmed: true })
    const id = (created.value as unknown as RecordSnapshot).records[0]!.id
    await client.mutate('invite-member', { id, memberId: 'member' }, { confirmed: true })
    const turn = await runner.beginTurn({ scope }),
      send = turn.view.actionOffers.find((offer) => offer.sourceActionId === 'send-message')!
    const payload = { id, message: 'Directed evidence', recipients: ['member'], wake: false, attachments: [{ path: filename }] }
    await expect(turn.executeAction(send.id, payload, () => false)).rejects.toThrow(/authoriz/i)
    expect(delivered).toHaveLength(0)
    await turn.executeAction(send.id, payload, () => true)
    expect(delivered[0]).toContain('member:false:Collaboration')
    const member = await runner.managementClient('source:rooms', { ...scope, sessionId: 'member' })
    const outsider = await runner.managementClient('source:rooms', { ...scope, sessionId: 'outsider' })
    const received = (await member.read('snapshot')).value as unknown as RecordSnapshot
    const message = received.records.find(record => record.kind === 'message')!
    const assetId = (message.data.assets as Array<{ id: string }>)[0]!.id
    await writeFile(filename, '// changed after sending')
    const retained = (await member.read('asset', { id: message.id, assetId })).value as { base64: string }
    expect(Buffer.from(retained.base64, 'base64').toString()).toBe('// synthetic project file')
    await expect(outsider.read('asset', { id: message.id, assetId })).rejects.toThrow(/addressed/)
    expect(((await outsider.read('snapshot')).value as unknown as RecordSnapshot).records.some(record => record.kind === 'message')).toBe(false)
    await member.mutate('mark-read', { id: message.id }, { confirmed: true })
    expect((await member.read('room-history', { id, unread: true })).value).toMatchObject({ total: 0 })
    await client.read('snapshot')
    await client.mutate('declare-resource', { id, resourceType: 'file', resource: join(directory, 'future/new.ts'), label: 'Future file', notes: 'Planned' }, { confirmed: true })
    await client.mutate('declare-resource', { id, resourceType: 'service', resource: 'http://127.0.0.1:5000', label: 'Preview' }, { confirmed: true })
    for (let index = 0; index < 26; index++) await client.mutate('declare-resource', { id, resourceType: 'note', resource: `Pagination note ${index}`, label: `Pagination note ${index}` }, { confirmed: true })
    const firstPage = (await member.read('resources', { resourceType: 'note' })).value as unknown as { items: RecordValue[]; total: number }
    const nextPage = (await member.read('resources', { resourceType: 'note', offset: 25 })).value as unknown as { items: RecordValue[]; total: number }
    expect(firstPage.total).toBe(26)
    expect(firstPage.items).toHaveLength(25)
    expect(nextPage.items).toHaveLength(1)
    expect(new Set([...firstPage.items, ...nextPage.items].map(record => record.id)).size).toBe(26)
    expect((await member.read('resources', { query: 'Future', resourceType: 'file' })).value).toMatchObject({ total: 1 })
    const memberTurn = await runner.beginTurn({ scope: { ...scope, sessionId: 'member' } })
    expect(
      (await memberTurn.executeRoute(memberTurn.view.routes[0]!.id, { kind: 'message' })).items[0]?.text,
    ).toContain('Directed evidence')
    const outsideTurn = await runner.beginTurn({ scope: { ...scope, sessionId: 'outsider' } })
    expect((await outsideTurn.executeRoute(outsideTurn.view.routes[0]!.id, { kind: 'message' })).items).toHaveLength(0)
    const reserve = memberTurn.view.actionOffers.find((offer) => offer.sourceActionId === 'reserve-file')!
    await memberTurn.executeAction(reserve.id, { id, filename, minutes: 30 }, () => true)
    await client.read('snapshot')
    await expect(client.mutate('reserve-file', { id, filename, minutes: 30 }, { confirmed: true })).rejects.toThrow(
      /another session/,
    )
    await client.mutate('remove-member', { id, memberId: 'member' }, { confirmed: true })
    await expect(memberTurn.executeAction(reserve.id, { id, filename, minutes: 30 }, () => true)).rejects.toThrow(
      /changed/,
    )
    await expect(turn.executeAction(send.id, payload, () => true)).rejects.toThrow(/members/)
    await client.mutate('close-room', { id }, { confirmed: true })
    expect((await client.read('resources', { resourceType: 'file' })).value).toMatchObject({ total: 0 })
    expect(JSON.stringify((await client.read('room-history', { id })).value)).toContain('Directed evidence')
    await client.mutate('restore', { id }, { confirmed: true })
    const restored = (await client.read('snapshot')).value as unknown as RecordSnapshot
    expect(restored.records.find((record) => record.id === id)).toMatchObject({
      state: 'active',
      data: { status: 'open' },
    })
    await client.mutate('archive-message', { id: message.id }, { confirmed: true })
    expect((await client.read('room-history', { id, query: 'Directed', archived: true })).value).toMatchObject({ total: 1 })
    await client.mutate('restore-message', { id: message.id }, { confirmed: true })
  } finally {
    await runner.dispose()
  }
})
