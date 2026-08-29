import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRuntime } from '../packages/extension-sdk/src/index.ts'
import { DEFAULT_MEMORY_VIEW_BUDGET } from '../packages/kernel/src/index.ts'
import { resolveConfig } from '../src/config.ts'
import { createRuntimeGraph } from '../src/live-runtime.ts'
import * as documentsPlugin from '../src/plugins/source-documents.ts'
import * as memorySpacesPlugin from '../src/plugins/source-memory-spaces.ts'
import * as runtimePlugin from '../src/plugins/source-runtime.ts'
import * as strategyPlugin from '../src/plugins/strategy-default-three-tier.ts'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0).reverse()) rmSync(path, { recursive: true, force: true })
})

function mount(runtime: MemoryRuntime, entryId: string, apply: (ctx: Context) => void): () => void {
  const releases: Array<() => void> = []
  const fiber = {}
  const ctx = {
    fiber,
    mnemonMemory: runtime,
    get(name: string) {
      return name === 'loader' ? { locate: (candidate?: unknown) => candidate === fiber ? entryId : undefined } : undefined
    },
    effect(factory: () => void | (() => void)) {
      const release = factory()
      if (typeof release === 'function') releases.push(release)
    },
  } as unknown as Context
  apply(ctx)
  return () => {
    for (const release of releases.reverse()) release()
  }
}

describe('five-Entry Composable View bundle', () => {
  it('installs each logical plugin through the same Fiber-owned SDK path', async () => {
    const runtime = new MemoryRuntime()
    const releases = [
      mount(runtime, 'mnemon-source-runtime', runtimePlugin.apply),
      mount(runtime, 'mnemon-source-documents', documentsPlugin.apply),
      mount(runtime, 'mnemon-source-memory-spaces', memorySpacesPlugin.apply),
      mount(runtime, 'mnemon-strategy-default-three-tier', strategyPlugin.apply),
    ]
    expect(runtime.contributionSnapshot()).toMatchObject({
      revision: 4,
      sources: [
        { instanceKey: 'source:mnemon-source-runtime', provenance: { packageName: 'dsh-mnemon-source-runtime' } },
        { instanceKey: 'source:mnemon-source-documents', provenance: { packageName: 'dsh-mnemon-source-documents' } },
        { instanceKey: 'source:mnemon-source-memory-spaces', provenance: { packageName: 'dsh-mnemon-source-memory-spaces' } },
      ],
      strategies: [{ instanceKey: 'strategy:mnemon-strategy-default-three-tier', provenance: { packageName: 'dsh-mnemon-strategy-default-three-tier' } }],
    })

    const root = mkdtempSync(join(tmpdir(), 'mnemon-plugin-bundle-'))
    temporary.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const graph = createRuntimeGraph(resolveConfig({ storageScope: 'custom', dataDir: join(root, 'data'), cliPath: '/fake/mnemon' }), workspace, runtime)
    expect(graph.memoryComposition?.inspect().evaluation.state).toBe('ready')
    const lease = graph.memoryComposition!.acquire()
    const view = await lease.generation.compose({
      scope: { storage: 'custom', workspaceId: workspace, sessionId: 'session' },
      scenario: 'plugin-bundle.test',
      budget: { ...DEFAULT_MEMORY_VIEW_BUDGET },
    })
    expect(view.projection.map(fragment => fragment.sourceInstanceKey)).toEqual([
      'source:mnemon-source-runtime', 'source:mnemon-source-documents', 'source:mnemon-source-memory-spaces',
    ])

    releases[0]!()
    expect(graph.memoryComposition?.inspect().servingGenerationId).toBeUndefined()
    expect(graph.memoryComposition?.inspect()).toMatchObject({
      evaluation: { state: 'rejected', diagnostics: [{ message: expect.stringContaining('Source') }] },
    })
    expect(lease.generation.id).toBe(view.runtimeGeneration)
    lease.release()
    for (const release of releases.slice(1).reverse()) release()
    graph.dispose()
  })

  it('exports one contribution kind per logical plugin with stable dsh-mnemon-* names', () => {
    expect([runtimePlugin.name, documentsPlugin.name, memorySpacesPlugin.name, strategyPlugin.name]).toEqual([
      'dsh-mnemon-source-runtime',
      'dsh-mnemon-source-documents',
      'dsh-mnemon-source-memory-spaces',
      'dsh-mnemon-strategy-default-three-tier',
    ])
    expect(runtimePlugin.RUNTIME_MEMORY_SOURCE.manifest.kind).toBe('source')
    expect(documentsPlugin.DOCUMENTS_MEMORY_SOURCE.manifest.kind).toBe('source')
    expect(memorySpacesPlugin.MEMORY_SPACES_SOURCE.manifest.kind).toBe('source')
    expect(strategyPlugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.manifest.kind).toBe('strategy')
  })
})
