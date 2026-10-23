import type { Context } from '@deepseek-ai/cordis'
import { MEMORY_SPACE_PROVIDER_API_VERSION, defineMemorySpaceProvider, defineMemorySpaceProviderDefinition, type MemorySpaceProviderDefinition } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { OpenVikingProvider } from './driver.ts'
import { descriptor } from './descriptor.ts'
import { OFFICIAL_PLUGIN_SERVICE, readOfficialPlugin, type OfficialPluginSnapshot } from './official-plugin.ts'

export { OpenVikingProvider, descriptor }

/** The Provider's definition; `officialPlugin` reads OpenViking's own DSH plugin when the profile runs one. */
export function openVikingDefinition(officialPlugin?: () => OfficialPluginSnapshot | undefined): MemorySpaceProviderDefinition {
  return defineMemorySpaceProviderDefinition({
    manifest: {
      apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider',
      typeId: descriptor.id, packageName: 'dsh-mnemon-provider-openviking', version: '0.5.8',
      label: descriptor.label, icon: descriptor.icon, summary: descriptor.summary,
      ...(descriptor.summaryI18nKey === undefined ? {} : { summaryI18nKey: descriptor.summaryI18nKey }),
      origin: descriptor.origin, locality: descriptor.kind, workspaceBinding: descriptor.workspaceBinding,
      capabilities: descriptor.capabilities, fields: descriptor.fields,
      secrets: descriptor.fields.filter(field => field.input === 'secret').map(field => field.key),
      scoreSemantics: 'normalized-relevance',
      ...(descriptor.views === undefined ? {} : { views: descriptor.views }),
    },
    create: context => new OpenVikingProvider(context.memorySpaces ?? context.memoryBodies, {
      requestTimeoutMs: context.config.timeoutMs,
      ...(officialPlugin === undefined ? {} : { officialPlugin }),
    }),
  })
}

export const definition = openVikingDefinition()

export default defineMemorySpaceProvider<undefined>({
  id: descriptor.id,
  // The official plugin's service is read when a space's status is asked for, so it is found
  // whichever plugin loads first; nothing here waits for it, injects it or changes it.
  apply(ctx: Context, host) { host.install(ctx, openVikingDefinition(() => readOfficialPlugin(() => ctx.get(OFFICIAL_PLUGIN_SERVICE)))) },
})
