import type { MemoryJsonValue } from './index.ts'
import type { MemoryPluginLocalizedText } from './plugin.ts'

export interface MemoryStrategyConfigurationFieldOption {
  value: string
  label: MemoryPluginLocalizedText
}

export interface MemoryStrategyConfigurationField {
  key: string
  label: MemoryPluginLocalizedText
  description?: MemoryPluginLocalizedText
  /** Numbers are finite integers; lists have at most 32 unique, nonempty strings. */
  input: 'number' | 'text' | 'textarea' | 'string-list' | 'source-list'
  defaultValue?: MemoryJsonValue
  minimum?: number
  maximum?: number
  options?: readonly MemoryStrategyConfigurationFieldOption[]
  sourceRoles?: string[]
}
