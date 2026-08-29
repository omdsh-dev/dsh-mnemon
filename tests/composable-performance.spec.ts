import { performance } from 'node:perf_hooks'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRuntime } from '../packages/extension-sdk/src/index.ts'
import { installBundledComposableMemory } from '../src/composable/defaults.ts'
import { resolveConfig } from '../src/config.ts'
import { createRuntimeGraph } from '../src/live-runtime.ts'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0).reverse()) rmSync(path, { recursive: true, force: true })
})

describe('Composable View performance fences', () => {
  it('composes repeated three-Source Views within a bounded local control-plane budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mnemon-composable-performance-'))
    temporary.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const runtime = new MemoryRuntime()
    installBundledComposableMemory(runtime)
    const graph = createRuntimeGraph(resolveConfig({ storageScope: 'custom', dataDir: join(root, 'data'), cliPath: '/fake/mnemon' }), workspace, runtime)
    await graph.runtimeMemory.mutate({ action: 'add', target: 'memory', content: 'Performance fixture.' })
    await graph.documents.forWorkspace(workspace).mutate({ action: 'create', title: 'Performance', content: 'Bounded fixture.' })
    const generation = graph.memoryComposition!.current()!
    const request = {
      scope: { storage: 'custom' as const, workspaceId: workspace, sessionId: 'performance' },
      scenario: 'performance.fixture',
      budget: {
        maxProjectionCharacters: 65_536,
        maxRoutes: 16,
        maxActions: 16,
        maxEvidenceResults: 16,
        maxEvidenceCharacters: 16_384,
      },
    }

    await generation.compose(request)
    const startedWall = performance.now()
    const startedCpu = process.cpuUsage()
    for (let index = 0; index < 100; index += 1) await generation.compose(request)
    const elapsedWall = performance.now() - startedWall
    const elapsedCpu = process.cpuUsage(startedCpu)
    const cpuMilliseconds = (elapsedCpu.user + elapsedCpu.system) / 1_000

    // CPU time isolates the control-plane cost from other Vitest workers. The
    // wall fence remains deliberately wider so accidental I/O still fails.
    expect(cpuMilliseconds).toBeLessThan(2_000)
    expect(elapsedWall).toBeLessThan(5_000)
    graph.dispose()
  })
})
