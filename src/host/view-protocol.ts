import type { MemoryJsonValue, MemoryViewGuidance, MemoryViewSourcePresentation } from '../core/contracts/index.ts'
import type { TurnMemoryActivity } from './protocol.ts'
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
  sourcePresentations?: MemoryViewSourcePresentation[]
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
  /** Durable activity observed after the frozen current View was compiled. */
  activity?: TurnMemoryActivity
  currentUnavailable?: 'no-session' | 'unaligned' | 'not-generated'
  sources: Array<{ sourceInstanceKey: string; sourceTypeId: string; packageName: string; role: string; label: string }>
  pluginInstallation: MemoryPluginInstallationEnvironment
  registeredPlugins: MemoryRegisteredPluginView[]
  diagnostics: string[]
}

export interface MemoryViewConfigurationRequest {
  expectedRevision: string
  strategyTypeId: string
  entries: Record<string, MemoryStrategyPreference>
}

export type MemoryPluginKind = 'source' | 'strategy'

export interface MemoryPluginInstallationEnvironment {
  supported: boolean
  profileName?: string
  reason?: 'loader-unavailable' | 'profile-unavailable' | 'cli-unavailable'
  suggestions: string[]
}

export interface MemoryPluginInspection {
  packageName: string
  version: string
  kind: MemoryPluginKind
  description?: string
  mnemonPeerRange: string
  installed: boolean
}

export interface MemoryPluginInstallResult {
  packageName: string
  version: string
  profileName: string
  installed: true
  restartRequired: true
}

export interface MemoryRegisteredPluginView {
  entryId: string
  packageName: string
  kind: MemoryPluginKind
  enabled: boolean
  active: boolean
  writable: boolean
  diagnostic?: string
}
