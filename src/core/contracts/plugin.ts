export const MEMORY_PLUGIN_API_VERSION = 'dsh-mnemon/plugin/v1' as const

export type MemoryPluginRole = 'source' | 'strategy' | 'strategy-extension'

export interface MemoryPluginLocalizedText {
  en: string
  'zh-CN': string
}

export interface MemoryPluginProvidedCapability {
  id: string
  exclusive?: true
}

export interface MemoryPluginDescriptor {
  apiVersion: typeof MEMORY_PLUGIN_API_VERSION
  packageName: string
  label: MemoryPluginLocalizedText
  description: MemoryPluginLocalizedText
  roles: MemoryPluginRole[]
  provides: MemoryPluginProvidedCapability[]
  requires?: string[]
}
