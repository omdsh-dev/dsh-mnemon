import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { createFilesSource } from '../src/index.ts'
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mnemon-files-')), workspace = join(directory, 'workspace'), outside = join(directory, 'outside')
  await mkdir(workspace); await mkdir(outside)
  await writeFile(join(workspace, 'README.md'), 'Project atlas\nThe launch token is a synthetic canary.\n')
  await writeFile(join(workspace, 'main.ts'), 'const atlas = true')
  await writeFile(join(workspace, '.env'), 'atlas-secret')
  await writeFile(join(outside, 'secret.md'), 'atlas-outside')
  await symlink(join(outside, 'secret.md'), join(workspace, 'escape.md'))
  const config = { dataDir: join(directory, 'data'), roots: [] as string[] }
  const runner = new MemoryCompositionRunner()
  await runner.mount({ apply(ctx: Context) { installMemory(ctx, { sources: [createFilesSource(config)], strategies: [defineMemoryStrategy({ manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'file-policy', packageName: 'file-policy', deterministic: true, supportedSourceRoles: ['file-search'], maxSources: 1, maxRoutes: 8, maxActions: 2 }, compose(_request, sources) { return { strategyTypeId: 'file-policy', explanation: 'File testing', sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey, routeIds: source.routeIds, actionIds: source.actionIds })) } } })] }) } }, { instanceId: 'files' })
  const scope = { storage: 'custom' as const, workspaceId: workspace }
  const turn = await runner.beginTurn({ scope })
  return { runner, turn, workspace, outside, config, route: (id: string) => turn.view.routes.find(route => route.sourceRouteId === id)!.id }
}
describe('file Source', () => {
  it('searches names and text with document defaults and explicit all-type selection', async () => {
    const f = await fixture()
    try {
      const documents = await f.turn.executeRoute(f.route('find'), { query: 'atlas', mode: 'content' })
      expect(documents.items).toHaveLength(1)
      expect(documents.items[0]?.text).toContain('Project atlas')
      const all = await f.turn.executeRoute(f.route('find'), { query: 'atlas', mode: 'content', types: 'all' })
      expect(all.items).toHaveLength(2)
      const names = await f.turn.executeRoute(f.route('find'), { query: 'README', mode: 'name' })
      expect(names.items).toHaveLength(1)
      const excerpt = await f.turn.executeRoute(f.route('read-file'), { path: join(f.workspace, 'README.md'), startLine: 2, lines: 1 })
      expect(excerpt.items[0]?.text).toBe('2: The launch token is a synthetic canary.')
      expect(JSON.stringify(all)).not.toMatch(/atlas-secret|atlas-outside/)
    } finally { await f.runner.dispose() }
  })
  it('pins directory authority and rejects credential, traversal and symlink reads', async () => {
    const f = await fixture()
    try {
      f.config.roots.push(f.outside)
      for (const path of [join(f.outside, 'secret.md'), join(f.workspace, 'escape.md'), join(f.workspace, '.env'), '../outside/secret.md']) {
        await expect(f.turn.executeRoute(f.route('read-file'), { path })).rejects.toThrow(/root|path|available/i)
      }
      await expect(f.turn.executeRoute(f.route('find'), { query: 'atlas', root: f.outside })).rejects.toThrow(/root/)
    } finally { await f.runner.dispose() }
  })
})
