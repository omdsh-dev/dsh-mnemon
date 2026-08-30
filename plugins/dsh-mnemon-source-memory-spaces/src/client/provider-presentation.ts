import type {
  MemoryBodyProvider,
  MemoryProviderConfigField,
  MemoryProviderDescriptor,
} from '../contracts.ts'
import type { MnemonKey, MnemonTranslate } from 'dsh-mnemon/client'

const LEGACY_FIELD_I18N_KEYS: Readonly<Record<string, MnemonKey>> = {
  endpoint: 'overview.providerEndpoint', apiKey: 'overview.providerApiKey', targetUri: 'overview.providerTargetUri', account: 'overview.providerAccount', user: 'overview.providerUser', actorPeerId: 'overview.providerActorPeer',
  workspace: 'overview.providerField.workspace', userId: 'overview.providerField.userId', agentId: 'overview.providerField.agentId', mode: 'overview.providerField.mode', rerank: 'overview.providerField.rerank',
  bankId: 'overview.providerField.bankId', budget: 'overview.providerField.budget', dataPath: 'overview.providerField.dataPath', defaultTrust: 'overview.providerField.defaultTrust', minTrust: 'overview.providerField.minTrust',
  project: 'overview.providerField.project', cliPath: 'overview.providerField.cliPath', defaultDirectory: 'overview.providerField.defaultDirectory', workingDirectory: 'overview.providerField.workingDirectory', containerTag: 'overview.providerField.containerTag', searchMode: 'overview.providerField.searchMode',
}

/**
 * Rolling-upgrade adapter for descriptors emitted before presentation metadata
 * joined the complete Provider definition. New Hosts already supply every
 * field below; generic rendering never branches on Provider identity.
 */
export function normalizeProviderPresentation(provider: MemoryProviderDescriptor): MemoryProviderDescriptor {
  const typeId = provider.typeId ?? provider.id
  return {
    ...provider,
    icon: provider.icon ?? { kind: 'brand', value: typeId },
    summaryI18nKey: provider.summaryI18nKey ?? `overview.providerSummary.${typeId}`,
    fields: provider.fields.map(field => {
      const i18nKey = field.i18nKey ?? LEGACY_FIELD_I18N_KEYS[field.key]
      return {
        ...field,
        ...(i18nKey === undefined ? {} : { i18nKey }),
        ...(field.options === undefined ? {} : {
          options: field.options.map(option => ({
            ...option,
            i18nKey: option.i18nKey ?? `overview.providerOption.${option.value}`,
          })),
        }),
      }
    }),
  }
}

/** Rolling-upgrade adapter for the former body projection shape. */
export function normalizeBodyProviderPresentation(provider: MemoryBodyProvider): MemoryBodyProvider {
  if (provider.origin !== undefined) return provider
  const typeId = provider.typeId ?? provider.id
  const native = typeId === 'mnemon-native'
  return {
    ...provider,
    origin: native ? 'native' : 'third-party',
    icon: provider.icon ?? { kind: 'brand', value: native ? 'mnemon' : typeId },
    label: native && provider.label === 'Mnemon Native' ? 'mnemon' : provider.label,
  }
}

export function providerDisplayLabel(providerId: string, label: string): string {
  return providerId === 'mnemon-native' && label === 'Mnemon Native' ? 'mnemon' : label
}

/**
 * Old Insight payloads predate the explicit Provider capability projection.
 * Keep that one historical default at the compatibility edge so generic
 * components never need to know a Provider identity.
 */
export function providerCapabilityOrLegacy(
  capability: boolean | undefined,
  providerId: string | undefined,
): boolean {
  return capability ?? (providerId === undefined || providerId === 'mnemon-native')
}

export function providerSummary(t: MnemonTranslate, provider: MemoryProviderDescriptor): string {
  if (provider.summaryI18nKey === undefined) return provider.summary
  const localized = t(provider.summaryI18nKey as MnemonKey)
  return typeof localized !== 'string' || localized.length === 0 || localized === provider.summaryI18nKey ? provider.summary : localized
}

export function providerFieldLabel(t: MnemonTranslate, field: MemoryProviderConfigField): string {
  if (field.i18nKey === undefined) return field.label
  const localized = t(field.i18nKey as MnemonKey)
  return typeof localized !== 'string' || localized.length === 0 || localized === field.i18nKey ? field.label : localized
}

export function providerOptionLabel(t: MnemonTranslate, option: NonNullable<MemoryProviderConfigField['options']>[number]): string {
  if (option.i18nKey === undefined) return option.label
  const localized = t(option.i18nKey as MnemonKey)
  return typeof localized !== 'string' || localized.length === 0 || localized === option.i18nKey ? option.label : localized
}
