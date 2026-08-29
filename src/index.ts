import { Config, InteractionConfig, resolveConfig, resolveInteractionConfig, type Config as MnemonConfig } from './config.ts'
import { registerCommands } from './commands.ts'
import type { HostContextShape } from './contracts.ts'
import { DocumentManager } from './documents.ts'
import { registerGuidance, registerMemoryPromptInterpolation } from './guidance.ts'
import { createRuntimeGraph, LiveMnemonRuntime, type MnemonRuntimeGraph } from './live-runtime.ts'
import { MnemonLifecycle } from './lifecycle.ts'
import { registerRpc } from './rpc.ts'
import { createRunner } from './runner.ts'
import { RuntimeMemoryController } from './runtime-memory.ts'
import { MnemonService } from './service.ts'
import { migrateLegacyDisplayMode, registerSettingsRpc } from './settings.ts'
import { MnemonSubagentCoordinator } from './subagent.ts'
import { registerTools } from './tools.ts'
import { StorageScopeInspector } from './storage-scope.ts'
import { MnemonPackManager } from './pack.ts'
import { VersionUpdateManager } from './version-updates.ts'
import { registerMnemonSubagentTokenUsageProjection } from './subagent-token-usage.ts'
import type { HostWorkspaceRegistry } from './contracts.ts'
import { MemoryBoot, MemoryExtensionHost, MemoryRuntime, memoryBoot } from '../packages/extension-sdk/src/index.ts'
import { installBundledComposableMemory } from './composable/defaults.ts'

export {
  BALANCED_RECALL_QUALITY_POLICY,
  EXHAUSTIVE_RECALL_QUALITY_POLICY,
  RecallQualityPolicyRegistry,
  STRICT_RECALL_QUALITY_POLICY,
  recallQualityPolicies,
  registerRecallQualityPolicy,
} from './recall-quality/index.ts'
export type {
  RecallQualityCandidate,
  RecallQualityDecision,
  RecallQualityPolicy,
  RecallQualityPolicyContext,
} from './recall-quality/index.ts'

export const name = 'dsh-mnemon'
export const provide = ['mnemonMemory']
// workspaceRegistry belongs to the Web profile. Core tools, lifecycle hooks,
// and per-Agent cwd routing must also mount in profiles such as Headless.
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents']
export { Config, InteractionConfig, resolveConfig, resolveInteractionConfig, DocumentManager, LiveMnemonRuntime, MemoryBoot, MemoryExtensionHost, MemoryRuntime, MnemonLifecycle, MnemonService, MnemonSubagentCoordinator, RuntimeMemoryController, StorageScopeInspector, MnemonPackManager, VersionUpdateManager, createRunner, createRuntimeGraph }
export type { MnemonConfig }

/** Resolve the optional Web workspace service at call time, not plugin-mount time. */
function optionalWorkspaceRegistry(ctx: HostContextShape): HostWorkspaceRegistry {
  const current = (): HostWorkspaceRegistry | undefined => ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  return {
    get: id => current()?.get(id),
    list: () => current()?.list() ?? [],
  }
}

/** Mount native model tools on every DSH surface and UI RPC only when Web connection exists. */
export interface ApplyCoreOptions {
  /** Install the legacy in-process Source/Strategy defaults with the core. */
  compatibilityBundle: boolean
}

export function applyCore(rawContext: unknown, config: MnemonConfig = {}, options: ApplyCoreOptions = { compatibilityBundle: true }): void {
  const ctx = rawContext as unknown as HostContextShape
  registerMnemonSubagentTokenUsageProjection(ctx)
  const extensions = new MemoryRuntime(memoryBoot)
  ctx.provide?.('mnemonMemory', extensions)
  const releaseBundledMemory = options.compatibilityBundle ? installBundledComposableMemory(extensions) : undefined
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
      const candidate = { graph: createRuntimeGraph(resolveConfig(value), undefined, extensions), token: Symbol('prepared-runtime') }
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
  const runtime = new LiveMnemonRuntime(initialCandidate?.graph ?? createRuntimeGraph(resolveConfig(initialSettings), undefined, extensions), optionalWorkspaceRegistry(ctx), ctx.agents, extensions)
  const resolved = runtime.config
  ctx.on('settings/updated', ((namespace: string, next: Config) => {
    if (namespace !== 'mnemon') return
    const candidate = prepared.get(next)
    if (candidate !== undefined) prepared.delete(next)
    disposePrepared()
    runtime.swap(candidate?.graph ?? createRuntimeGraph(resolveConfig(next), undefined, extensions))
  }) as never)
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
  const coordinator = new MnemonSubagentCoordinator(ctx.subagents, runtime, undefined, ctx, () => {
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
      releaseBundledMemory?.()
    }
  }, 'dsh-mnemon.lifecycle-root()')
  registerTools(ctx, runtime, coordinator)
  registerCommands(ctx.commands, runtime, coordinator)
  registerGuidance(ctx, resolved)
  registerMemoryPromptInterpolation(ctx)
  ctx.inject(['connection'], (webContext) => {
    // `inject` guarantees the service at runtime; retain the defensive guard
    // because HostContextShape also models profiles where it is absent.
    if (webContext.connection === undefined) return
    // Keep one branch-free call shape across both supported DSH generations:
    // rc.2 enforces this legacy channel authority, while 0.1.2-alpha.1 ignores
    // the extra JavaScript argument and authenticates every Host API uniformly.
    const managementAuthority = resolved.remoteAccess === 'trusted-host' ? 'trusted-host' : 'loopback'
    registerRpc(webContext.connection, runtime, lifecycle, undefined, undefined, undefined, undefined, managementAuthority)
    registerSettingsRpc(webContext.connection, ctx.settings, managementAuthority)
  })
}

/** Backward-compatible one-Entry package surface. */
export function apply(rawContext: unknown, config: MnemonConfig = {}): void {
  applyCore(rawContext, config, { compatibilityBundle: config.bundledContributions !== false })
}
