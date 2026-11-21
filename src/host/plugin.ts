import { Context } from '@deepseek-ai/cordis'
import {
  credentialPort,
  DEFAULT_SKILLS_CONFIG,
  InteractionConfig,
  migrateLegacyDisplayMode,
  PlainConfig,
  ProfileMnemonSettings,
  registerSettingsRpc,
  resolveConfig,
  resolveInteractionConfig,
  SkillsConfig,
  validateRuntimeComposition,
} from './config/index.ts'
import { LiveConfig, plainHostConfig, type LiveHostConfig } from './config/live.ts'
import { MnemonAutoBackupScheduler } from './auto-backup.ts'
import { registerCommands } from './commands.ts'
import type { HostContextShape, HostCredentialsService, HostWorkspaceRegistry } from './dsh.ts'
import { MnemonGitHubAuth } from './github-auth.ts'
import { registerGuidance } from './guidance.ts'
import { createRuntimeGraph, LiveMnemonRuntime } from './runtime.ts'
import { MnemonLifecycle, taskRoute } from './lifecycle.ts'
import { SkillEvolution } from './skill-evolution.ts'
import type { Config as MnemonConfig, ResolvedSkillsConfig } from './protocol.ts'
import { skillsSourceFor } from './skill-source.ts'
import { registerRpc } from './rpc.ts'
import { hasNativeDirectoryPicker } from './directory-picker.ts'
import { MnemonSubagentCoordinator } from './subagent.ts'
import { registerTools } from './tools.ts'
import { registerMemoryWriteApproval } from './write-approval.ts'
import { registerSubagentTokenUsage } from './subagent-token-usage.ts'
import { provideMemoryRuntime } from '../core/runtime.ts'
import { MemoryPluginManagement } from './plugin-management.ts'
import { registerViewRpc } from './view-rpc.ts'
import { MemoryPluginInstallation } from './plugin-installation.ts'
import { MnemonRemoteService } from './remote-rpc.ts'
import { dshPluginCommand, VersionUpdateManager, type DshBundleInstaller } from './version-updates.ts'

export const name = 'dsh-mnemon'
export const provide = ['mnemonMemory']
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents']
export { LiveConfig as Config }
export type { MnemonConfig }

function optionalWorkspaceRegistry(ctx: HostContextShape): HostWorkspaceRegistry {
  const current = (): HostWorkspaceRegistry | undefined => ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  return {
    get: id => current()?.get(id),
    list: () => current()?.list() ?? [],
  }
}

function optionalGitHubAuth(ctx: HostContextShape): MnemonGitHubAuth {
  const current = (): HostCredentialsService | undefined => (ctx.get('credentials') ?? ctx.credentials) as HostCredentialsService | undefined
  return new MnemonGitHubAuth(credentialPort(current))
}

export function apply(rawContext: unknown, rawConfig: MnemonConfig | LiveHostConfig = {}): void {
  const ctx = rawContext as unknown as HostContextShape
  const config = plainHostConfig(rawConfig)
  const hostSettings = new ProfileMnemonSettings(ctx, rawConfig)
  registerSubagentTokenUsage(ctx)
  const extensions = provideMemoryRuntime(ctx)
  const memoryPlugins = new MemoryPluginManagement(ctx, extensions, hostSettings)
  const pluginInstallation = new MemoryPluginInstallation(ctx)
  const skillSettings = hostSettings.register<ResolvedSkillsConfig>('mnemon-skills', SkillsConfig, {
    base: { ...DEFAULT_SKILLS_CONFIG },
    applies: 'live',
  })
  const effectiveConfig = (value: MnemonConfig) =>
    memoryPlugins.resolveConfig(resolveConfig({ ...value, skills: value.skills ?? skillSettings.get() }), value.memoryView ?? { entries: {} })
  const settings = hostSettings.register<MnemonConfig>('mnemon', PlainConfig, {
    base: config,
    applies: 'live',
    validate: value => validateRuntimeComposition(effectiveConfig(value), extensions),
  })
  const runtime = new LiveMnemonRuntime(createRuntimeGraph(effectiveConfig(settings.get()), undefined, extensions), optionalWorkspaceRegistry(ctx), ctx.agents, extensions)
  runtime.useGitHubAuth(optionalGitHubAuth(ctx))
  const autoBackup = new MnemonAutoBackupScheduler(runtime)
  runtime.useAutoBackup(() => autoBackup.snapshot())
  const resolved = runtime.config
  ctx.effect(() => hostSettings.onUpdated((namespace, value) => {
    if (namespace === 'mnemon-skills') {
      const nextSkills = skillSettings.get()
      const currentSkills = runtime.snapshot().config.skills
      if (
        runtime.snapshot().allowLinkedSkillUpdates !== nextSkills.allowLinkedUpdates
        || currentSkills?.dshHome !== nextSkills.dshHome
        || currentSkills?.agentsHome !== nextSkills.agentsHome
        || JSON.stringify(currentSkills?.skillRoots) !== JSON.stringify(nextSkills.skillRoots)
      ) {
        runtime.swap(createRuntimeGraph(effectiveConfig({ ...settings.get(), skills: nextSkills }), undefined, extensions))
      }
      return
    }
    if (namespace === memoryPlugins.settingsNamespace) {
      runtime.swap(createRuntimeGraph(effectiveConfig(settings.get()), undefined, extensions))
      return
    }
    if (namespace !== 'mnemon') return
    runtime.swap(createRuntimeGraph(effectiveConfig(value as MnemonConfig), undefined, extensions))
  }), 'dsh-mnemon: live runtime settings')
  ctx.effect(() => memoryPlugins.start(), 'dsh-mnemon: plugin graph settings')
  hostSettings.register('mnemon-ui', InteractionConfig, {
    base: resolveInteractionConfig(resolved.conversationInteraction),
    applies: 'live',
  })
  ctx.effect(() => {
    let disposed = false
    const migrate = (): void => {
      if (disposed) return
      void migrateLegacyDisplayMode(hostSettings).catch(error => {
        console.warn('dsh-mnemon: could not persist the builtin displayMode migration', error)
      })
    }
    const unsubscribe = ctx.on('settings/document-updated', ((namespace: string) => {
      if (namespace === 'mnemon') migrate()
    }) as never)
    const stopUpdated = hostSettings.onUpdated(namespace => {
      if (namespace === 'mnemon') migrate()
    })
    migrate()
    return () => { disposed = true; stopUpdated(); unsubscribe() }
  }, 'dsh-mnemon: canonical displayMode migration')
  ctx.effect(() => {
    let disposed = false
    const loader = ctx.get('loader') as { await?(): Promise<unknown> } | undefined
    void Promise.resolve(loader?.await?.()).then(async () => {
      if (disposed) return
      const catalog = await memoryPlugins.catalog()
      if (disposed) return
      await hostSettings.importLegacy(catalog.entries.filter(entry => entry.roles.includes('source')).map(entry => entry.entryId))
    }).catch(error => { console.warn('dsh-mnemon: could not recover retained legacy settings', error) })
    return () => { disposed = true }
  }, 'dsh-mnemon: retained settings migration')
  const coordinator: MnemonSubagentCoordinator = new MnemonSubagentCoordinator(ctx.subagents, runtime, ctx, () => {
    const taskAgentModel = runtime.config.taskAgentModel
    if (taskAgentModel.mode !== 'fixed') return undefined
    const provider = taskAgentModel.provider?.trim()
    const model = taskAgentModel.model?.trim()
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    return { provider, model }
  }, () => runtime.config.runtimeMemory.maintenanceMaxTokens,
  (scope, signal, operation) => lifecycle.runRuntimeMaintenanceTask(scope, signal, operation))
  const lifecycle = new MnemonLifecycle(ctx, coordinator, runtime.config, runtime)
  const skills = new SkillEvolution({
    settings: () => skillSettings.get(),
    source: agent => skillsSourceFor(runtime, agent),
    taskRoute: workspace => lifecycle.skillTaskRoute(workspace),
    runTask: (workspaceRoot, signal, operation, route) => lifecycle.runSkillTask(workspaceRoot, signal, operation, route),
    skillTask: (parent, label, prompt, schema, persona, signal, route, maxTokens) => coordinator.skillTask(parent, label, prompt, schema, persona, signal, route ?? taskRoute(parent), maxTokens),
  })
  ctx.effect(() => hostSettings.onUpdated(() => skills.settingsChanged()), 'dsh-mnemon: automatic skill adoption settings')
  lifecycle.useSkillEvolution(skills)
  ctx.effect(() => {
    const stop = autoBackup.start()
    return () => { stop() }
  }, 'dsh-mnemon: automatic Git backup')
  ctx.effect(() => {
    const stop = lifecycle.start()
    return async () => {
      stop()
      await skills.dispose()
      await coordinator.dispose()
      runtime.dispose()
    }
  }, 'dsh-mnemon.lifecycle-root()')
  ctx.effect(() => {
    const loader = ctx.get('loader') as { await?(): Promise<unknown> } | undefined
    return registerTools(ctx, runtime, coordinator, extensions, loader?.await?.())
  }, 'dsh-mnemon: Source tool lifecycle')
  registerCommands(ctx.commands, runtime, coordinator)
  ctx.effect(() => registerMemoryWriteApproval(ctx, runtime), 'dsh-mnemon: memory write approval')
  registerGuidance(ctx, resolved, runtime)
  ctx.inject(['connection', 'webServer'], (webContext) => {
    const connection = Context.is(webContext)
      ? webContext.extend({ webServer: webContext.get('webServer') }).connection
      : webContext.connection
    if (connection === undefined) return
    const versions = new VersionUpdateManager({
      mnemonCliPath: () => runtime.config.cliPath,
      bundleInstaller: () => ctx.get('pluginManager') as DshBundleInstaller | undefined,
      runningProfile: () => {
        const profile = ctx.get('profileContext') as { dir?: unknown; packageManager?: unknown } | undefined
        return typeof profile?.dir === 'string' ? { dir: profile.dir, packageManager: profile.packageManager !== undefined } : undefined
      },
      pluginCommand: () => dshPluginCommand(ctx.get('profileContext')),
    })
    const rpc = registerRpc(connection, runtime, lifecycle, versions, () => autoBackup.refresh(), () => hasNativeDirectoryPicker(ctx))
    const settings = registerSettingsRpc(connection, hostSettings, () => (ctx.get('credentials') ?? ctx.credentials) as HostCredentialsService | undefined)
    const view = registerViewRpc(connection, runtime, extensions, memoryPlugins, lifecycle, pluginInstallation)
    if (Context.is(webContext)) {
      new MnemonRemoteService(webContext, {
        ...rpc,
        settings,
        view: view.read,
        viewWrite: view.write,
        management: resolved.remoteAccess === 'trusted-host',
      })
    }
  })
}
