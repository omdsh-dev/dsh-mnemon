import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { createSessionsSource } from '../src/index.ts'
import { parseImportedSession } from '../src/imported.ts'
const lines = (cwd: string) => [JSON.stringify({ type: 'session_meta', payload: { cwd } }), '{damaged', ...[
  { role: 'user', content: [{ type: 'input_text', text: 'Where is the atlas deployment?' }] },
  { role: 'assistant', content: [{ type: 'output_text', text: 'The atlas deployment uses port 8302.' }] },
  { role: 'assistant', channel: 'analysis', content: [{ type: 'text', text: 'SECRET private reasoning' }] },
  { role: 'system', content: [{ type: 'text', text: 'SECRET system instructions' }] },
].map(payload => JSON.stringify({ type: 'response_item', timestamp: '2026-09-09T00:00:00.000Z', payload: { type: 'message', ...payload } })), JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'SECRET tool output' } })].join('\n')
describe('imported conversation history', () => {
  it('tolerates malformed lines and excludes reasoning, tools and system text', () => {
    const parsed = parseImportedSession(lines('/project'), '/imports/one.jsonl')
    expect(parsed.malformed).toBe(1); expect(parsed.messages).toHaveLength(2)
    expect(JSON.stringify(parsed.messages)).not.toContain('SECRET')
  })
  it('searches only the current project and returns neighboring messages with stable references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mnemon-history-')), imports = join(directory, 'history')
    await mkdir(imports); await writeFile(join(imports, 'one.jsonl'), lines('/project-a')); await writeFile(join(imports, 'other.jsonl'), lines('/project-b'))
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount({ apply(ctx: Context) { installMemory(ctx, { sources: [createSessionsSource({ dataDir: join(directory, 'data'), historyRoots: [imports] })], strategies: [defineMemoryStrategy({ manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'history-policy', packageName: 'history-policy', deterministic: true, supportedSourceRoles: ['session-history'], maxSources: 1, maxRoutes: 8, maxActions: 8 }, compose(_request, sources) { return { strategyTypeId: 'history-policy', explanation: 'History testing', sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey, routeIds: source.routeIds, actionIds: source.actionIds })) } } })] }) } }, { instanceId: 'history' })
      const turn = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: '/project-a' } })
      const search = turn.view.routes.find(route => route.sourceRouteId === 'history')!
      const result = await turn.executeRoute(search.id, { query: 'atlas' })
      expect(result.items).toHaveLength(2); expect(JSON.stringify(result)).not.toMatch(/SECRET|other.jsonl/)
      const reference = result.items[1]!.provenance as { sessionId: string; seq: number }
      const read = turn.view.routes.find(route => route.sourceRouteId === 'conversation')!
      expect((await turn.executeRoute(read.id, { sessionId: reference.sessionId, seq: reference.seq, radius: 1 })).items).toHaveLength(2)
      const other = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: '/no-history' } })
      expect((await other.executeRoute(other.view.routes.find(route => route.sourceRouteId === 'history')!.id, { query: 'atlas' })).items).toHaveLength(0)
    } finally { await runner.dispose() }
  })
})
