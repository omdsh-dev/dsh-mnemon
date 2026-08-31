import type { MemoryJsonValue, MemoryViewGuidance } from '../core/contracts/index.ts'
import type { MemoryLocalizedText, MemoryStrategyConfigurationField } from '../sdk/strategy-configuration.ts'

export const MNEMON_VIEW_CHANNEL = '/dsh-mnemon-view'
export const MNEMON_VIEW_WRITE_CHANNEL = '/dsh-mnemon-view-settings'
export const MNEMON_VIEW_SETTINGS_NAMESPACE = 'mnemon-view'

export interface MemoryStrategyPreference { enabled: boolean; config: Record<string, MemoryJsonValue> }
export interface MemoryViewPreferences {
  strategyTypeId?: string
  entries: Record<string, MemoryStrategyPreference>
}

export interface MemoryStrategyEntryView {
  entryId: string
  packageName: string
  typeId: string
  kind: 'strategy' | 'strategy-extension'
  strategyTypeId?: string
  slot?: string
  label: MemoryLocalizedText
  description: MemoryLocalizedText
  fields: readonly MemoryStrategyConfigurationField[]
  enabled: boolean
  active: boolean
  writable: boolean
  config: Record<string, MemoryJsonValue>
  diagnostic?: string
}

/** Browser read model, not a serialized authority envelope. No readGrants. */
export interface MemoryViewInspection {
  id: string
  digest: string
  generationId: string
  createdAt: string
  turn?: number
  state: 'active' | 'recent' | 'preview'
  strategyTypeId: string
  strategyInstanceKey: string
  extensions: Array<{ instanceKey: string; typeId: string; slot: string; digest: string }>
  projection: Array<{ id: string; sourceInstanceKey: string; mode: string; text: string; revision: string }>
  routes: Array<{ id: string; sourceInstanceKey: string; operationId: string; description: string; maxCalls: number }>
  actions: Array<{ id: string; sourceInstanceKey: string; operationId: string; description: string }>
  memoryText: string
  guidance?: MemoryViewGuidance
  diagnostics: string[]
}

export interface MemoryViewDashboard {
  revision: string
  writable: boolean
  strategyTypeId: string
  entries: MemoryStrategyEntryView[]
  current?: MemoryViewInspection
  currentUnavailable?: 'no-session' | 'unaligned' | 'not-generated'
  sources: Array<{ sourceInstanceKey: string; sourceTypeId: string; role: string; label: string }>
  diagnostics: string[]
}

export interface MemoryViewConfigurationRequest {
  expectedRevision: string
  strategyTypeId: string
  entries: Record<string, MemoryStrategyPreference>
}
