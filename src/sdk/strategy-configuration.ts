import type { MemoryInstallContribution } from './service.ts'
import type { MemoryJsonValue } from '../core/contracts/index.ts'

/** Human-facing metadata only. It is never added to a model View. */
export interface MemoryLocalizedText { en: string; 'zh-CN': string }

export interface MemoryStrategyConfigurationField {
  key: string
  label: MemoryLocalizedText
  description?: MemoryLocalizedText
  input: 'number' | 'text' | 'textarea' | 'string-list' | 'source-list'
  defaultValue?: MemoryJsonValue
  minimum?: number
  maximum?: number
  sourceRoles?: string[]
}

/**
 * Optional module export named `memoryStrategyConfiguration`.
 * An installed, trusted Cordis Entry owns its fields and its pure factory.
 * The Host may preview that factory, but mounting/disposal still belongs to
 * Cordis. Configuration here must be public; credentials belong to Sources.
 */
export interface MemoryStrategyConfiguration {
  apiVersion: 'dsh-mnemon/strategy-configuration/v1'
  kind: 'strategy' | 'strategy-extension'
  typeId: string
  label: MemoryLocalizedText
  description: MemoryLocalizedText
  fields: readonly MemoryStrategyConfigurationField[]
  /** Same factory used by apply(); must not perform I/O or register a Fiber. */
  create(config: Record<string, MemoryJsonValue>): MemoryInstallContribution
}

export function defineMemoryStrategyConfiguration(value: Omit<MemoryStrategyConfiguration, 'apiVersion'>): MemoryStrategyConfiguration {
  return Object.freeze({ ...value, apiVersion: 'dsh-mnemon/strategy-configuration/v1' as const })
}
