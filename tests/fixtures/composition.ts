import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as runtimePlugin from 'dsh-mnemon-source-runtime'
import * as documentsPlugin from 'dsh-mnemon-source-documents'
import * as spacesPlugin from 'dsh-mnemon-source-memory-spaces'
import * as strategyPlugin from 'dsh-mnemon-strategy-default-three-tier'
import native from 'dsh-mnemon-provider-mnemon-native'
import holographic from 'dsh-mnemon-provider-holographic'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryBodyView, MemoryBodyCatalog } from 'dsh-mnemon-source-memory-spaces/contracts'
import type { MemorySpaceProviderEntry } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { resolveConfig, type Config } from '../../src/host/config.ts'
import { createRuntimeGraph, LiveMnemonRuntime } from '../../src/host/runtime.ts'
import type { HostWorkspaceRegistry, HostAgentsService } from '../../src/host/dsh.ts'

/** Compose real, public Cordis modules. No Source controller or Host business binding. */
export async function compositionFixture(options: Config = {}, host: {
  workspaceRegistry?: HostWorkspaceRegistry; agents?: HostAgentsService; providers?: MemorySpaceProviderEntry[]
  entryPrefix?: string
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mnemon-composition-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const dataDir = join(root, 'data')
  const config = resolveConfig({ storageScope: 'custom', runtimeUserScope: 'storage', dataDir, cliPath: '/fake/mnemon', ...options })
  const runner = new MemoryCompositionRunner({ sourceConfiguration: () => ({ dataDir, userDataDir: dataDir }) })
  const entryId = (id: string) => (host.entryPrefix ? host.entryPrefix + ':' : '') + id
  const releases = [
    await runner.mount(runtimePlugin, { instanceId: entryId('mnemon-source-runtime') }),
    await runner.mount(documentsPlugin, { instanceId: entryId('mnemon-source-documents') }),
    await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
      await spacesPlugin.installMemorySpaces(ctx, [
        { instanceId: native.id, module: native, config: undefined },
        { instanceId: holographic.id, module: holographic, config: undefined },
        ...(host.providers ?? []),
      ])
    } }, { instanceId: entryId('mnemon-source-memory-spaces') }),
    await runner.mount(strategyPlugin, { instanceId: entryId('mnemon-strategy-default-three-tier') }),
  ]
  const graph = createRuntimeGraph(config, workspace, runner.runtime)
  const workspaceRegistry = host.workspaceRegistry ?? {
    list: () => [{ id: 'workspace', title: 'Fixture', path: workspace }],
    get: (id: string) => id === 'workspace' ? { id, title: 'Fixture', path: workspace } : undefined,
  }
  const live = new LiveMnemonRuntime(graph, workspaceRegistry, host.agents, runner.runtime)
  async function memorySpace() {
    const source = graph.source('memory-spaces')
    await source.mutate('provider-service-update', {
      providerId: 'holographic', settings: { dataPath: join(config.dataDir ?? dataDir, 'fixture-facts.json') }, enabled: true,
    })
    const catalog = await source.read<MemoryBodyCatalog>('body-directory')
    const body = catalog.items.find(item => item.provider.id === 'holographic')
    if (body === undefined) throw new Error('Fixture Provider did not discover its namespace')
    return body
  }
  async function dispose() {
    live.dispose()
    await runner.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  return { root, workspace, config, runner, extensions: runner.runtime, graph, live, releases, memorySpace, dispose }
}
