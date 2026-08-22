import { Config, InteractionConfig, resolveConfig, resolveInteractionConfig, type Config as MnemonConfig } from './config.ts'
import { registerCommands } from './commands.ts'
import type { HostContextShape } from './contracts.ts'
import { DocumentManager } from './documents.ts'
import { registerGuidance, registerRuntimeMemoryContext } from './guidance.ts'
import { createRuntimeGraph, LiveMnemonRuntime, type MnemonRuntimeGraph } from './live-runtime.ts'
import { MnemonLifecycle } from './lifecycle.ts'
import { registerRpc } from './rpc.ts'
import { createRunner } from './runner.ts'
import { RuntimeMemoryController } from './runtime-memory.ts'
import { MnemonService } from './service.ts'
import { registerSettingsRpc } from './settings.ts'
import { MnemonSubagentCoordinator } from './subagent.ts'
import { registerTools } from './tools.ts'
import { StorageScopeInspector } from './storage-scope.ts'
import { MnemonPackManager } from './pack.ts'
import { VersionUpdateManager } from './version-updates.ts'
import type { HostWorkspaceRegistry } from './contracts.ts'

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
// workspaceRegistry belongs to the Web profile. Core tools, lifecycle hooks,
// and per-Agent cwd routing must also mount in profiles such as Headless.
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents']
export { Config, InteractionConfig, resolveConfig, resolveInteractionConfig, DocumentManager, LiveMnemonRuntime, MnemonLifecycle, MnemonService, MnemonSubagentCoordinator, RuntimeMemoryController, StorageScopeInspector, MnemonPackManager, VersionUpdateManager, createRunner, createRuntimeGraph }
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
export function apply(rawContext: unknown, config: MnemonConfig = {}): void {
  const ctx = rawContext as unknown as HostContextShape
  const prepared = new WeakMap<object, MnemonRuntimeGraph>()
  const settings = ctx.settings.register<Config>('mnemon', Config, {
    base: config,
    applies: 'live',
    validate: value => {
      prepared.set(value, createRuntimeGraph(resolveConfig(value)))
    },
  })
  const initialSettings = settings.get()
  const runtime = new LiveMnemonRuntime(prepared.get(initialSettings) ?? createRuntimeGraph(resolveConfig(initialSettings)), optionalWorkspaceRegistry(ctx), ctx.agents)
  const resolved = runtime.config
  ctx.on('settings/updated', ((namespace: string, next: Config) => {
    if (namespace !== 'mnemon') return
    runtime.swap(prepared.get(next) ?? createRuntimeGraph(resolveConfig(next)))
  }) as never)
  ctx.settings.register('mnemon-ui', InteractionConfig, {
    base: resolveInteractionConfig(resolved.conversationInteraction),
    applies: 'live',
  })
  const coordinator = new MnemonSubagentCoordinator(ctx.subagents, runtime, undefined, ctx, () => {
    const taskAgentModel = runtime.config.taskAgentModel
    if (taskAgentModel.mode !== 'fixed') return undefined
    const provider = taskAgentModel.provider?.trim()
    const model = taskAgentModel.model?.trim()
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    return { provider, model }
  }, runtime)
  const lifecycle = new MnemonLifecycle(ctx, coordinator, runtime.config, runtime)
  ctx.effect(() => lifecycle.start(), 'dsh-mnemon.lifecycle-root()')
  registerTools(ctx, runtime, coordinator)
  registerCommands(ctx.commands, runtime, coordinator)
  registerGuidance(ctx, resolved)
  registerRuntimeMemoryContext(ctx, runtime.runtimeMemory)
  ctx.inject(['connection'], (webContext) => {
    // `inject` guarantees the service at runtime; retain the defensive guard
    // because HostContextShape also models profiles where it is absent.
    if (webContext.connection === undefined) return
    // This authority is deliberately sampled once at Host startup. Remote Web
    // pages cannot promote themselves by mutating live Mnemon settings.
    const managementAuthority = resolved.remoteAccess === 'trusted-host' ? 'trusted-host' : 'loopback'
    registerRpc(webContext.connection, runtime, lifecycle, undefined, undefined, undefined, undefined, managementAuthority)
    registerSettingsRpc(webContext.connection, ctx.settings, managementAuthority)
  })
}
