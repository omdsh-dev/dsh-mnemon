import { Context } from '@deepseek-ai/cordis'
import { Config as PlainConfig, InteractionConfig, resolveConfig, resolveInteractionConfig, type Config as MnemonConfig } from './config.ts'
import { MnemonAutoBackupScheduler } from './auto-backup.ts'
import { registerCommands } from './commands.ts'
import type { HostContextShape, HostCredentialsService, HostWorkspaceRegistry } from './dsh.ts'
import { githubGrantFromRecord, MNEMON_SYNC_GITHUB_CREDENTIAL_KEY, MnemonGitHubAuth, type MnemonGitHubCredentialPort } from './github-auth.ts'
import { registerGuidance } from './guidance.ts'
import { createRuntimeGraph, LiveMnemonRuntime } from './runtime.ts'
import { MnemonLifecycle } from './lifecycle.ts'
import { registerRpc } from './rpc.ts'
import { migrateLegacyDisplayMode, MNEMON_SETTINGS_NAMESPACE, registerSettingsRpc } from './settings.ts'
import { MnemonSubagentCoordinator } from './subagent.ts'
import { registerTools } from './tools.ts'
import { registerMnemonSubagentTokenUsageProjection } from './subagent-token-usage.ts'
import { provideMemoryRuntime } from '../core/runtime.ts'
import { MemoryPluginManagement } from './plugin-management.ts'
import { registerViewRpc } from './view-rpc.ts'
import { MemoryPluginInstallation } from './plugin-installation.ts'
import { MnemonRemoteService } from './remote-rpc.ts'
import { plainHostConfig, type LiveHostConfig } from './live-config.ts'
import { ProfileMnemonSettings } from './settings-service.ts'
import { VersionUpdateManager, type DshBundleInstaller } from './version-updates.ts'

export const name = 'dsh-mnemon'
export const provide = ['mnemonMemory']
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents']
export { LiveConfig as Config } from './live-config.ts'
export type { MnemonConfig }

/** Resolve the optional Web workspace service at call time, not plugin-mount time. */
function optionalWorkspaceRegistry(ctx: HostContextShape): HostWorkspaceRegistry {
  const current = (): HostWorkspaceRegistry | undefined => ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  return {
    get: id => current()?.get(id),
    list: () => current()?.list() ?? [],
  }
}

/**
 * The one credentials record this plugin keeps, as DSH's store addresses it:
 * `<scope>/<id>`. Presence of the record is the whole fact, and every write
 * goes through `modifyRecord` so a replacement happens under the store's lock.
 */
function credentialPort(service: () => HostCredentialsService | undefined): MnemonGitHubCredentialPort {
  return {
    available: () => service() !== undefined,
    describe: async () => {
      const store = service()
      if (store === undefined) return { configured: false, writable: false }
      const info = await store.describeRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY)
      return { configured: info.configured, writable: info.writable }
    },
    read: async () => githubGrantFromRecord(await service()?.readRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY)),
    write: async grant => {
      const store = service()
      if (store === undefined) throw new Error('this DSH Host provides no credentials store, so GitHub sign-in is unavailable')
      await store.modifyRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY, async () => ({ kind: 'grant', payload: grant }))
    },
    clear: async () => {
      const store = service()
      if (store === undefined) return
      // An absent record is already the signed-out state; deleting one twice is not a failure.
      if (await store.readRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY) === undefined) return
      await store.deleteRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY)
    },
  }
}

/**
 * GitHub sign-in lives beside the sync channel, not inside it: one instance
 * spans every runtime generation, so a grant stored from the settings page is
 * the same one an Agent's workspace graph resolves. The credentials service is
 * read at call time, because a Headless profile may mount none at all.
 */
function optionalGitHubAuth(ctx: HostContextShape): MnemonGitHubAuth {
  const current = (): HostCredentialsService | undefined => (ctx.get('credentials') ?? ctx.credentials) as HostCredentialsService | undefined
  return new MnemonGitHubAuth(credentialPort(current))
}

/** DSH owns assembly; this Host only wires scope, phases and user preferences. */
export function apply(rawContext: unknown, rawConfig: MnemonConfig | LiveHostConfig = {}): void {
  const ctx = rawContext as unknown as HostContextShape
  const config = plainHostConfig(rawConfig)
  const hostSettings = new ProfileMnemonSettings(ctx, rawConfig)
  registerMnemonSubagentTokenUsageProjection(ctx)
  const extensions = provideMemoryRuntime(ctx)
  const memoryPlugins = new MemoryPluginManagement(ctx, extensions, hostSettings)
  const pluginInstallation = new MemoryPluginInstallation(ctx)
  const effectiveConfig = (value: MnemonConfig) => memoryPlugins.resolveConfig(resolveConfig(value), value.memoryView ?? { entries: {} })
  const settings = hostSettings.register<MnemonConfig>('mnemon', PlainConfig, {
    base: config,
    applies: 'live',
    // Profile writes commit asynchronously. Check that the candidate composes
    // now, then build from the committed live references on volatile-update.
    validate: value => createRuntimeGraph(effectiveConfig(value), undefined, extensions).dispose(),
  })
  const runtime = new LiveMnemonRuntime(createRuntimeGraph(effectiveConfig(settings.get()), undefined, extensions), optionalWorkspaceRegistry(ctx), ctx.agents, extensions)
  runtime.useGitHubAuth(optionalGitHubAuth(ctx))
  // The automatic Git backup is one timer for the whole Host, not one per
  // graph: a settings write builds and disposes a throwaway graph to validate
  // itself, and a timer owned by a graph would be armed and dropped again on
  // every keystroke in the settings form.
  const autoBackup = new MnemonAutoBackupScheduler(runtime)
  runtime.useAutoBackup(() => autoBackup.snapshot())
  const resolved = runtime.config
  ctx.effect(() => hostSettings.onUpdated((namespace, value) => {
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
    migrate()
    return () => { disposed = true; unsubscribe() }
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
  // Registered before the lifecycle root so teardown runs the other way round:
  // the timer stops first, and only then does the runtime it reads go away.
  ctx.effect(() => {
    const stop = autoBackup.start()
    return () => { stop() }
  }, 'dsh-mnemon: automatic Git backup')
  ctx.effect(() => {
    const stop = lifecycle.start()
    return async () => {
      stop()
      await coordinator.dispose()
      runtime.dispose()
    }
  }, 'dsh-mnemon.lifecycle-root()')
  registerTools(ctx, runtime, coordinator)
  registerCommands(ctx.commands, runtime, coordinator)
  registerGuidance(ctx, resolved)
  ctx.inject(['connection', 'webServer'], (webContext) => {
    // `inject` guarantees the service at runtime; retain the defensive guard
    // because HostContextShape also models profiles where it is absent.
    // Connection's RPC getter keeps its provider's injection scope. Carry
    // the explicitly injected server on our own Context so late registration
    // works without changing or restarting the shared Connection plugin.
    const connection = Context.is(webContext)
      ? webContext.extend({ webServer: webContext.get('webServer') }).connection
      : webContext.connection
    if (connection === undefined) return
    // The Starter updates through DSH's own plugin manager and profile, so a packaged
    // app's bundled pnpm serves it where no pnpm is on PATH.
    const versions = new VersionUpdateManager({
      mnemonCliPath: () => runtime.config.cliPath,
      bundleInstaller: () => ctx.get('pluginManager') as DshBundleInstaller | undefined,
      runningProfile: () => {
        const profile = ctx.get('profileContext') as { dir?: unknown; packageManager?: unknown } | undefined
        return typeof profile?.dir === 'string' ? { dir: profile.dir, packageManager: profile.packageManager !== undefined } : undefined
      },
    })
    // A completed data-directory move has to reach the live runtime, or every
    // later call keeps reading the directory that was just removed. Writing the
    // location back through the settings service is what does it: the write
    // publishes a new 'mnemon' generation, and the subscription above swaps in
    // a graph built on the new root.
    const relocation = {
      get writable(): boolean { return hostSettings.writable },
      relocate: async (directory: string): Promise<void> => {
        await hostSettings.mutate(MNEMON_SETTINGS_NAMESPACE, [
          { op: 'set', path: ['storageScope'], value: 'custom' },
          { op: 'set', path: ['dataDir'], value: directory },
        ])
      },
    }
    const rpc = registerRpc(connection, runtime, lifecycle, versions, () => autoBackup.refresh(), relocation)
    const settings = registerSettingsRpc(connection, hostSettings)
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
