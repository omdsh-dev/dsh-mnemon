import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { COMPOSABLE_MEMORY_API_VERSION, DEFAULT_MEMORY_VIEW_BUDGET, type MemoryJsonValue } from 'dsh-mnemon/contracts'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import type { RecordSnapshot, RecordValue } from 'dsh-mnemon/source-sdk'
import { createPlaybooksSource } from '../src/index.ts'
import type { SkillBasis } from '../src/skill-store.ts'

it('inspects owned evidence, keeps drafts out of native reads and requires every file before refinement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mnemon-skill-source-')), runner = new MemoryCompositionRunner()
  const scope = { storage: 'custom' as const, workspaceId: '/project-a', sessionId: 'session-a' }
  const json = (value: unknown): MemoryJsonValue => JSON.parse(JSON.stringify(value)) as MemoryJsonValue
  await runner.mount({ apply(ctx: Context) { installMemory(ctx, { sources: [createPlaybooksSource({ dataDir: root })], strategies: [defineMemoryStrategy({ manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'skill-test', packageName: 'skill-test', deterministic: true, supportedSourceRoles: ['instruction-library'], maxSources: 1, maxRoutes: 8, maxActions: 16 }, compose(_request, sources) { return { strategyTypeId: 'skill-test', explanation: 'Verify skill ownership and review boundaries', sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey, routeIds: source.routeIds, actionIds: source.actionIds, projection: { mode: 'eager', maxCharacters: 2000 } })) } } })] }) } }, { instanceId: 'skills' })
  try {
    const management = await runner.managementClient('source:skills', scope)
    await management.read('snapshot')
    await management.mutate('create', { title: 'Review output', content: 'Check numeric units and compare totals with the inputs.', kind: 'skill', data: { slug: 'output-review' } }, { confirmed: true })
    const read = () => management.read('skills-snapshot', {})
    const snapshot = (await read()).value as unknown as RecordSnapshot & { bases: SkillBasis[] }
    const basis = snapshot.bases[0]!
    const bundle = { name: 'output-review', description: 'Check numeric output.', files: [{ path: 'SKILL.md', content: '---\nname: output-review\ndescription: Check numeric output.\n---\nRead references/checklist.md before approving totals.' }, { path: 'references/checklist.md', content: 'Check units and compare totals with the inputs.' }], checks: [] }
    const turn = await runner.beginTurn({ scope, budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 80000 } })
    const action = (id: string) => turn.view.actionOffers.find(offer => offer.sourceActionId === id)!.id
    const route = (id: string) => turn.view.routes.find(route => route.sourceRouteId === id)!.id
    const input = { basisId: basis.id, title: 'Output review', reason: 'Repeated review procedure', bundle }
    await expect(turn.executeAction(action('propose-skill'), json(input), () => true)).rejects.toThrow('Inspect skill-context')
    expect((await turn.executeRoute(route('skill-context'), {})).items[0]?.text).toContain(basis.id)
    const proposal = await turn.executeAction(action('propose-skill'), json(input), () => true)
    expect(proposal.completion).toBe('candidate')
    const candidateId = (proposal.details as { id: string }).id
    await expect(turn.executeRoute(route('skill-read'), { id: candidateId })).rejects.toThrow('published skill')
    let state = (await read()).value as unknown as RecordSnapshot, candidate = state.records.find(record => record.id === candidateId)!
    await management.mutate('skills-publish', { id: candidate.id, version: candidate.version }, { confirmed: true })
    state = (await read()).value as unknown as RecordSnapshot; candidate = state.records.find(record => record.id === candidateId)!
    await management.mutate('skills-feedback', { id: candidate.id, version: candidate.version, verdict: 'incorrect', quote: 'The checklist needs empty-input handling.' }, { confirmed: true })
    const later = await runner.beginTurn({ scope, budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 80000 } })
    const laterAction = (id: string) => later.view.actionOffers.find(offer => offer.sourceActionId === id)!.id
    const laterRoute = (id: string) => later.view.routes.find(route => route.sourceRouteId === id)!.id
    const context = JSON.parse((await later.executeRoute(laterRoute('skill-context'), {})).items[0]!.text) as { opportunities: SkillBasis[] }
    const feedback = context.opportunities.find(basis => basis.kind === 'feedback')!
    const revised = structuredClone(bundle); revised.files[1]!.content += '\nReject empty inputs.'
    const revision = { basisId: feedback.id, title: 'Output review', reason: 'Handle empty input', bundle: revised, baseId: candidate.id }
    await later.executeRoute(laterRoute('skill-read'), { id: candidate.id })
    await expect(later.executeAction(laterAction('propose-skill'), json(revision), () => true)).rejects.toThrow('Read every file')
    const resource = await later.executeRoute(laterRoute('skill-read'), { id: candidate.id, path: 'references/checklist.md' })
    expect(resource.items[0]?.reference).toEqual({ id: candidate.id, revision: candidate.data.contentDigest, path: 'references/checklist.md' })
    expect((await later.executeAction(laterAction('propose-skill'), json(revision), () => true)).completion).toBe('candidate')
    const other = await runner.managementClient('source:skills', { ...scope, workspaceId: '/project-b' })
    expect(((await other.read('skills-snapshot', {})).value as unknown as RecordSnapshot).records).toHaveLength(0)
    expect(((await read()).value as unknown as RecordSnapshot).records.filter(record => record.kind === 'skill-version').map(record => record.state)).toEqual(['active', 'pending'])
    for (let n = 0; n < 9; n++) {
      await management.read('snapshot')
      await management.mutate('create', { title: 'Procedure ' + n, content: 'Review reusable procedure ' + n, kind: 'skill', data: { slug: 'procedure-' + n } }, { confirmed: true })
    }
    const bounded = await runner.beginTurn({ scope, budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 80000 } })
    const contextRoute = bounded.view.routes.find(route => route.sourceRouteId === 'skill-context')!.id
    const listing = JSON.parse((await bounded.executeRoute(contextRoute, {})).items[0]!.text) as { opportunities: SkillBasis[]; omitted: Array<{ id: string }> }
    expect(listing.opportunities).toHaveLength(8)
    expect(listing.omitted).toHaveLength(1)
    const omitted = listing.omitted[0]!.id, defer = bounded.view.actionOffers.find(offer => offer.sourceActionId === 'defer-skill')!.id
    await expect(bounded.executeAction(defer, { basisId: omitted, reason: 'Already covered by a native skill.' }, () => true)).rejects.toThrow('exact opportunity')
    await bounded.executeRoute(contextRoute, { basisId: omitted })
    expect((await bounded.executeAction(defer, { basisId: omitted, reason: 'Already covered by a native skill.' }, () => true)).completion).toBe('committed')
  } finally { await runner.dispose(); await rm(root, { force: true, recursive: true }) }
})
