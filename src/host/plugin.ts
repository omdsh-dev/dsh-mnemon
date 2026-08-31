import { Config, InteractionConfig, resolveConfig, resolveInteractionConfig, type Config as MnemonConfig } from './config.ts'
import { registerCommands } from './commands.ts'
import type { HostContextShape, HostWorkspaceRegistry } from './dsh.ts'
import { registerGuidance } from './guidance.ts'
import { createRuntimeGraph, LiveMnemonRuntime, type MnemonRuntimeGraph } from './runtime.ts'
import { MnemonLifecycle } from './lifecycle.ts'
import { registerRpc } from './rpc.ts'
import { migrateLegacyDisplayMode, registerSettingsRpc } from './settings.ts'
import { MnemonSubagentCoordinator } from './subagent.ts'
import { registerTools } from './tools.ts'
import { registerMnemonSubagentTokenUsageProjection } from './subagent-token-usage.ts'
import { provideMemoryRuntime } from '../core/runtime.ts'
import { MemoryStrategyManagement } from './strategy-management.ts'
import { registerViewRpc } from './view-rpc.ts'
import { MNEMON_VIEW_SETTINGS_NAMESPACE } from './view-protocol.ts'

export const name = 'dsh-mnemon'
export const provide = ['mnemonMemory']
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents']
export { Config }
export type { MnemonConfig }

/** Resolve the optional Web workspace service at call time, not plugin-mount time. */
function optionalWorkspaceRegistry(ctx: HostContextShape): HostWorkspaceRegistry {
  const current = (): HostWorkspaceRegistry | undefined => ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  return {
    get: id => current()?.get(id),
    list: () => current()?.list() ?? [],
  }
}

/** DSH owns assembly; this Host only wires scope, phases and user preferences. */
export function apply(rawContext: unknown, config: MnemonConfig = {}): void {
  const ctx = rawContext as unknown as HostContextShape
  registerMnemonSubagentTokenUsageProjection(ctx)
  const extensions = provideMemoryRuntime(ctx)
  const viewStrategies = new MemoryStrategyManagement(ctx, extensions)
  const effectiveConfig = (value: Config) => viewStrategies.resolveConfig(resolveConfig(value))
  const prepared = new Map<object, { graph: MnemonRuntimeGraph; token: symbol }>()
  const disposePrepared = (): void => {
    for (const candidate of prepared.values()) candidate.graph.dispose()
    prepared.clear()
  }
  const settings = ctx.settings.register<Config>('mnemon', Config, {
    base: config,
    applies: 'live',
    validate: value => {
      disposePrepared()
      const candidate = { graph: createRuntimeGraph(effectiveConfig(value), undefined, extensions), token: Symbol('prepared-runtime') }
      prepared.set(value, candidate)
      // Settings commits synchronously after validation. A standalone/cancelled
      // validation has no commit event, so retire its attached graph next tick.
      queueMicrotask(() => {
        if (prepared.get(value)?.token !== candidate.token) return
        prepared.delete(value)
        candidate.graph.dispose()
      })
    },
  })
  const initialSettings = settings.get()
  const initialCandidate = prepared.get(initialSettings)
  if (initialCandidate !== undefined) prepared.delete(initialSettings)
  const runtime = new LiveMnemonRuntime(initialCandidate?.graph ?? createRuntimeGraph(effectiveConfig(initialSettings), undefined, extensions), optionalWorkspaceRegistry(ctx), ctx.agents, extensions)
  const resolved = runtime.config
  ctx.on('settings/updated', ((namespace: string, next: Config) => {
    if (namespace === MNEMON_VIEW_SETTINGS_NAMESPACE) {
      runtime.swap(createRuntimeGraph(effectiveConfig(settings.get()), undefined, extensions))
      return
    }
    if (namespace !== 'mnemon') return
    const candidate = prepared.get(next)
    if (candidate !== undefined) prepared.delete(next)
    disposePrepared()
    runtime.swap(candidate?.graph ?? createRuntimeGraph(effectiveConfig(next), undefined, extensions))
  }) as never)
  ctx.effect(() => viewStrategies.start(), 'dsh-mnemon: strategy Entry settings')
  ctx.settings.register('mnemon-ui', InteractionConfig, {
    base: resolveInteractionConfig(resolved.conversationInteraction),
    applies: 'live',
  })
  ctx.effect(() => {
    let disposed = false
    const migrate = (): void => {
      if (disposed) return
      void migrateLegacyDisplayMode(ctx.settings).catch(error => {
        console.warn('dsh-mnemon: could not persist the builtin displayMode migration', error)
      })
    }
    const unsubscribe = ctx.on('settings/document-updated', ((namespace: string) => {
      if (namespace === 'mnemon') migrate()
    }) as never)
    migrate()
    return () => { disposed = true; unsubscribe() }
  }, 'dsh-mnemon: canonical displayMode migration')
  const coordinator = new MnemonSubagentCoordinator(ctx.subagents, runtime, ctx, () => {
    const taskAgentModel = runtime.config.taskAgentModel
    if (taskAgentModel.mode !== 'fixed') return undefined
    const provider = taskAgentModel.provider?.trim()
    const model = taskAgentModel.model?.trim()
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    return { provider, model }
  }, () => runtime.config.runtimeMemory.maintenanceMaxTokens)
  const lifecycle = new MnemonLifecycle(ctx, coordinator, runtime.config, runtime)
  ctx.effect(() => {
    const stop = lifecycle.start()
    return () => {
      stop()
      disposePrepared()
      runtime.dispose()
    }
  }, 'dsh-mnemon.lifecycle-root()')
  registerTools(ctx, runtime, coordinator)
  registerCommands(ctx.commands, runtime, coordinator)
  registerGuidance(ctx, resolved)
  ctx.inject(['connection'], (webContext) => {
    // `inject` guarantees the service at runtime; retain the defensive guard
    // because HostContextShape also models profiles where it is absent.
    if (webContext.connection === undefined) return
    // Keep one branch-free call shape across both supported DSH generations:
    // rc.2 enforces this legacy channel authority, while 0.1.2-alpha.1 ignores
    // the extra JavaScript argument and authenticates every Host API uniformly.
    const managementAuthority = resolved.remoteAccess === 'trusted-host' ? 'trusted-host' : 'loopback'
    registerRpc(webContext.connection, runtime, lifecycle, undefined, managementAuthority)
    registerSettingsRpc(webContext.connection, ctx.settings, managementAuthority)
    registerViewRpc(webContext.connection, runtime, extensions, viewStrategies, lifecycle, managementAuthority)
  })
}
