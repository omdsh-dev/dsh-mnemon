import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPOSABLE_MEMORY_API_VERSION } from '../src/core/contracts/index.ts'
import { MemoryRuntime } from '../src/core/runtime.ts'
import { defineMemorySource } from '../src/sdk/index.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function source(typeId: string) {
  return defineMemorySource({
    manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId, packageName: 'third-party-source', role: 'external-memory', capabilities: ['project'], consistency: 'exact-snapshot' },
    create: context => ({
      facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: typeId, role: 'external-memory', availability: 'ready', revision: '1', capabilities: ['project'], routeIds: [], actionIds: [] }),
      project: () => ({ fragments: [] }),
    }),
  })
}

async function fixture(types = ['runtime', 'documents', 'memory-spaces']) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const runtime = new MemoryRuntime()
  const mount = (type: string, id = type) => runtime.service.installContributions({ sources: [source(type)] }, { instanceId: id })
  const releases = Object.fromEntries(types.map(type => [type, mount(type)]))
  const host = ctx as unknown as HostContextShape
  const coordinator = new MnemonSubagentCoordinator({} as never, {} as never, host)
  // The fourth argument supplies global definitions, independent of any selected View.
  const stop = registerTools(host, {} as never, coordinator, runtime)
  cleanups.push(async () => { if (typeof stop === 'function') stop(); coordinator.dispose(); await runtime.dispose(); await ctx.fiber.dispose() })
  return { ctx, runtime, mount, releases, stop, names: () => ctx.tools.schemas().map(tool => tool.name) }
}

describe('global Source tool lifecycle (issue 522)', () => {
  it.each([
    { types: ['runtime', 'documents', 'memory-spaces'], count: 17 },
    { types: ['runtime', 'documents'], count: 7 },
    { types: ['runtime', 'memory-spaces'], count: 14 },
    { types: ['documents', 'memory-spaces'], count: 16 },
    { types: [], count: 3 },
  ])('advertises $count tools with $types registered', async ({ types, count }) => {
    const f = await fixture(types)
    expect(f.names()).toHaveLength(count)
    expect(f.names()).toEqual(expect.arrayContaining(['mnemon_subagent_result', 'mnemon_view_route', 'mnemon_view_action']))
  })

  it('removes the last instance, restores repeated cycles, and keeps other families registered', async () => {
    const f = await fixture()
    const runtimeTool = f.ctx.tools.get('mnemon_runtime_memory')
    for (let cycle = 0; cycle < 3; cycle++) {
      f.releases['memory-spaces']!()
      expect(f.names()).toHaveLength(7)
      expect(f.ctx.tools.get('mnemon_recall')).toBeUndefined()
      expect(f.ctx.tools.get('mnemon_runtime_memory')).toBe(runtimeTool)
      f.releases['memory-spaces'] = f.mount('memory-spaces')
      expect(f.names()).toHaveLength(17)
    }
  })

  it('counts every live same-type instance, including a third-party replacement', async () => {
    const f = await fixture()
    const recall = f.ctx.tools.get('mnemon_recall')
    const replacement = f.mount('memory-spaces', 'third-party-spaces')
    f.releases['memory-spaces']!()
    expect(f.ctx.tools.get('mnemon_recall')).toBe(recall)
    replacement()
    expect(f.ctx.tools.get('mnemon_recall')).toBeUndefined()
    f.mount('memory-spaces', 'another-vendor')
    expect(f.names()).toHaveLength(17)
  })

  it('follows Sources loaded after Host bootstrap', async () => {
    const f = await fixture([])
    expect(f.names()).toHaveLength(3)
    f.mount('documents')
    expect(f.names()).toHaveLength(6)
    f.mount('runtime')
    expect(f.names()).toHaveLength(7)
  })

  it('publishes only the committed final registry through nested transactions and rollback', async () => {
    const f = await fixture()
    const recall = f.ctx.tools.get('mnemon_recall')
    const changes: string[][] = []
    f.ctx.on('tools/change', () => { changes.push(f.names()) })
    await expect(f.runtime.batch(async () => {
      f.releases['memory-spaces']!()
      expect(f.ctx.tools.get('mnemon_recall')).toBe(recall)
      await f.runtime.batch(async () => {
        f.releases['memory-spaces'] = f.mount('memory-spaces')
        expect(f.ctx.tools.get('mnemon_recall')).toBe(recall)
      })
      // Plugin-management rollback restores definitions before leaving batch.
      throw new Error('synthetic validation failure')
    })).rejects.toThrow('synthetic validation failure')
    expect(changes).toEqual([])
    expect(f.ctx.tools.get('mnemon_recall')).toBe(recall)
    await f.runtime.batch(async () => {
      f.releases['memory-spaces']!()
      expect(f.ctx.tools.get('mnemon_recall')).toBe(recall)
    })
    expect(f.names()).toHaveLength(7)
  })

  it('uses the committed baseline when Host registration starts in a transaction', async () => {
    const f = await fixture()
    let stop: (() => void) | undefined
    await f.runtime.batch(async () => {
      f.releases['memory-spaces']!()
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
      cleanups.push(() => ctx.fiber.dispose())
      stop = registerTools(ctx as unknown as HostContextShape, {} as never, {} as never, f.runtime)
      expect(ctx.tools.schemas()).toHaveLength(16)
      f.releases['memory-spaces'] = f.mount('memory-spaces')
      expect(ctx.tools.schemas()).toHaveLength(16)
    })
    stop?.()
  })

  it('unsubscribes and disposes its tools without disposing the independent result tool', async () => {
    const f = await fixture()
    expect(typeof f.stop).toBe('function')
    f.stop()
    f.stop()
    expect(f.names()).toEqual(['mnemon_subagent_result'])
    f.releases['memory-spaces']!()
    f.mount('memory-spaces')
    expect(f.names()).toEqual(['mnemon_subagent_result'])
  })
})
