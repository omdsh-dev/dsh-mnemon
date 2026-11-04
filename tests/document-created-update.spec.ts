import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as general from 'dsh-mnemon-strategy-general'
import type { DocumentMutationResult } from 'dsh-mnemon-source-documents/contracts'
import type { MemoryMutationReceipt } from '../src/core/contracts/index.ts'
import { compositionFixture } from './fixtures/composition.ts'

const releases: Array<() => Promise<void>> = []
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })

async function fixture(strategyId = 'general') {
  const f = await compositionFixture({ memoryTopology: { strategyId } })
  releases.push(f.dispose)
  await f.memorySpace()
  if (strategyId === 'general') await f.mount(general, { instanceId: 'general' })
  const scope = { storage: 'custom' as const, workspaceId: f.workspace, sessionId: 'author', agentId: 'author' }
  const turns = f.graph.composableTurns
  const turn = await turns.beginTurn('author', scope)
  const create = turn.view.actionOffers.find(offer => offer.sourceActionId === 'create')!
  const manage = turn.view.actionOffers.find(offer => offer.sourceActionId === 'manage')!
  const read = (id: string) => f.graph.source('documents').read('document', { id })
  return { ...f, scope, turns, turn, create, manage, read }
}

const createdId = (receipt: MemoryMutationReceipt) => (receipt.details as unknown as DocumentMutationResult).document.id
const draft = { title: 'Same-turn draft', content: 'First draft.' }

describe('updating Documents created in the same execution (#559)', () => {
  it.each(['general', 'default-three-tier'])('allows create then update under %s without expanding pinned reads or bypassing authorization', async strategy => {
    const f = await fixture(strategy)
    const pinned = JSON.stringify(f.turn.view)
    const created = await f.turns.executeAction('author', f.create.id, draft, () => true)
    expect(created).toMatchObject({ completion: 'committed', details: { action: 'created' } })
    const id = createdId(created)
    await expect(f.turns.executeAction('author', f.manage.id, { action: 'update', id, content: 'Denied edit.' }, () => false)).rejects.toThrow(/not currently authorized/)
    expect(await f.read(id)).toMatchObject({ content: draft.content, revision: 1 })
    await expect(f.turns.executeAction('author', f.manage.id, { action: 'update', id, content: 'Corrected draft.' }, () => true))
      .resolves.toMatchObject({ completion: 'committed', details: { action: 'updated', document: { id, revision: 2 } } })
    expect(await f.read(id)).toMatchObject({ content: 'Corrected draft.', revision: 2 })
    const search = f.turn.view.routes.find(route => route.sourceInstanceKey === f.create.sourceInstanceKey && route.sourceRouteId === 'search')!
    const evidence = await f.turns.executeRoute('author', search.id, { query: draft.title })
    expect(evidence.items.some(item => item.id === id)).toBe(false)
    expect(JSON.stringify(f.turn.view)).toBe(pinned)
  })

  it('does not share created targets with another execution pinned to the exact same View', async () => {
    const f = await fixture()
    const sibling = f.turns.pinTurn('sibling', { ...f.scope, agentId: 'sibling' }, f.turn.view.id)
    expect(sibling.view).toBe(f.turn.view)
    const id = createdId(await f.turns.executeAction('author', f.create.id, draft, () => true))
    const edit = { action: 'update', id, content: 'Not this execution.' }
    await expect(f.turns.executeAction('sibling', f.manage.id, edit, () => true)).rejects.toThrow(/outside this View ReadGrant/)
    await expect(f.turns.executeAction('author', f.manage.id, { ...edit, content: 'Author correction.' }, () => true)).resolves.toMatchObject({ completion: 'committed' })
    f.turns.endTurn('author')
    f.turns.pinTurn('later', f.scope, sibling.view.id)
    await expect(f.turns.executeAction('later', f.manage.id, edit, () => true)).rejects.toThrow(/outside this View ReadGrant/)
    expect(await f.read(id)).toMatchObject({ content: 'Author correction.', revision: 2 })
  })

  it('does not admit documents created through management after the turn was pinned', async () => {
    const f = await fixture()
    const created = await f.graph.source('documents').mutate<DocumentMutationResult>('mutate', { action: 'create', ...draft })
    await expect(f.turns.executeAction('author', f.manage.id, { action: 'update', id: created.document.id, content: 'Unseen replacement.' }, () => true))
      .rejects.toThrow(/outside this View ReadGrant/)
    expect(await f.read(created.document.id)).toMatchObject({ content: draft.content, revision: 1 })
  })

  it('does not admit same-turn targets from a different workspace sharing the storage root', async () => {
    const f = await fixture()
    const workspace = join(f.root, 'other-workspace')
    mkdirSync(workspace)
    const other = await f.turns.beginTurn('other-workspace', { ...f.scope, workspaceId: workspace, agentId: 'other' })
    const manage = other.view.actionOffers.find(offer => offer.sourceActionId === 'manage')!
    const id = createdId(await f.turns.executeAction('author', f.create.id, draft, () => true))
    await expect(f.turns.executeAction('other-workspace', manage.id, { action: 'update', id, content: 'Other workspace.' }, () => true))
      .rejects.toThrow(/outside this View ReadGrant/)
    expect(await f.read(id)).toMatchObject({ content: draft.content, revision: 1 })
  })
})
