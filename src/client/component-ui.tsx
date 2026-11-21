import { Component, createElement, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'

export const MNEMON_COMPONENT_SETTINGS_SLOT = 'mnemon.component.settings' as const
export const MNEMON_COMPONENT_FALLBACK_PRIORITY = 100

const COMPONENT_SETTINGS_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  'dsh-mnemon-source-memory-spaces': ['policy', 'recall'],
  'dsh-mnemon-source-skills': ['models', 'market'],
}

export function supportsMemoryComponentSettingsSection(packageName: string, section: string): boolean {
  return Object.hasOwn(COMPONENT_SETTINGS_SECTIONS, packageName) && COMPONENT_SETTINGS_SECTIONS[packageName]!.includes(section)
}

export const MNEMON_COMPONENT_STATUS_SLOT = 'mnemon.component.status' as const
type ComponentRegion = typeof MNEMON_COMPONENT_SETTINGS_SLOT | typeof MNEMON_COMPONENT_STATUS_SLOT

const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u

export interface MemoryComponentSettingsProps {
  component: {
    packageName: string
    label: string
    enabled: boolean
  }
  writable: boolean
  language: string
  sessionId?: string
  workspace?: { id: string; label?: string }
  section?: string | undefined
  host?: MemoryComponentHost
}

export interface MemoryComponentConfigurationSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value?: Readonly<Record<string, unknown>>
  revision?: number
  writable: boolean
}

export interface MemoryComponentHost {
  configuration: {
    getSnapshot(): MemoryComponentConfigurationSnapshot
    subscribe(listener: () => void): () => void
    set(key: string, value: MemoryJsonValue): Promise<void>
  }
  operations?: {
    read(operation: string, input?: MemoryJsonValue): Promise<unknown>
    write(operation: string, input: MemoryJsonValue): Promise<unknown>
  }
  changed(): void
  readonly retained: Map<string, unknown>
}

export type MemoryComponentSettingsComponent = (props: MemoryComponentSettingsProps) => ReactNode

export interface MemoryComponentStatusProps {
  component: {
    packageName: string
    label: string
    enabled: boolean
  }
  language: string
  sessionId?: string
  workspace?: { id: string; label?: string }
}

export type MemoryComponentStatusComponent = (props: MemoryComponentStatusProps) => ReactNode

export interface MemoryComponentUIContribution {
  packageName: string
  settings?: MemoryComponentSettingsComponent
  status?: MemoryComponentStatusComponent
}

export interface MemoryComponentUIContext {
  slots: {
    inject(name: ComponentRegion, setup: () => () => void): () => void
    register(options: { name: typeof MNEMON_COMPONENT_SETTINGS_SLOT; key: string }, component: MemoryComponentSettingsComponent): () => void
    register(options: { name: typeof MNEMON_COMPONENT_STATUS_SLOT; key: string }, component: MemoryComponentStatusComponent): () => void
  }
}

export function installMemoryComponentUI(ctx: MemoryComponentUIContext, contribution: MemoryComponentUIContribution): () => void {
  return installRegions(ctx, contribution, {})
}

export function installMemoryComponentFallbackUI(ctx: MemoryComponentUIContext, contribution: MemoryComponentUIContribution): () => void {
  return installRegions(ctx, contribution, { priority: MNEMON_COMPONENT_FALLBACK_PRIORITY })
}

function installRegions(ctx: MemoryComponentUIContext, contribution: MemoryComponentUIContribution, order: { priority?: number }): () => void {
  const key = contribution.packageName
  if (!PACKAGE_NAME.test(key)) throw new Error('memory component UI requires the package name of the component')
  const { settings, status } = contribution
  const register = ctx.slots.register as (options: { name: ComponentRegion; key: string; priority?: number }, component: (props: never) => ReactNode) => () => void
  const disposers: Array<() => void> = []
  if (settings !== undefined) disposers.push(ctx.slots.inject(MNEMON_COMPONENT_SETTINGS_SLOT, () => register.call(ctx.slots, { name: MNEMON_COMPONENT_SETTINGS_SLOT, key, ...order }, (props: MemoryComponentSettingsProps) => createElement(settings, props))))
  if (status !== undefined) disposers.push(ctx.slots.inject(MNEMON_COMPONENT_STATUS_SLOT, () => register.call(ctx.slots, { name: MNEMON_COMPONENT_STATUS_SLOT, key, ...order }, (props: MemoryComponentStatusProps) => createElement(status, props))))
  if (disposers.length === 0) throw new Error('memory component UI contributes nothing: ' + key)
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

interface ComponentRegionDirectoryContext {
  slots: {
    getVersion(name: ComponentRegion): number
    entriesOfSlot(name: ComponentRegion): readonly { options: { key?: string } }[]
    subscribe(name: ComponentRegion, listener: () => void): () => void
  }
}

export interface ComponentRegionDirectory {
  getSnapshot(): ReadonlySet<string>
  subscribe(listener: () => void): () => void
}
export type ComponentSettingsDirectory = ComponentRegionDirectory

export function createComponentRegionDirectory(ctx: ComponentRegionDirectoryContext, region: ComponentRegion): ComponentRegionDirectory {
  let version = -1
  let snapshot: ReadonlySet<string> = new Set()
  const read = (): ReadonlySet<string> => {
    const current = ctx.slots.getVersion(region)
    if (current === version) return snapshot
    version = current
    snapshot = new Set(ctx.slots.entriesOfSlot(region).flatMap(entry => entry.options.key === undefined ? [] : [entry.options.key]))
    return snapshot
  }
  return {
    getSnapshot: read,
    subscribe: listener => ctx.slots.subscribe(region, () => { read(); listener() }),
  }
}

export function createComponentSettingsDirectory(ctx: ComponentRegionDirectoryContext): ComponentSettingsDirectory {
  return createComponentRegionDirectory(ctx, MNEMON_COMPONENT_SETTINGS_SLOT)
}

interface ComponentRegionEntriesContext {
  slots: { entriesOfSlot(name: ComponentRegion): readonly { component: unknown; options: { key?: string } }[] }
}

class ContributionBoundary extends Component<{ packageName: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`dsh-mnemon: the interface ${this.props.packageName} contributed failed`, error, info.componentStack)
  }
  override render(): ReactNode { return this.state.failed ? null : this.props.children }
}

export function renderComponentRegion<P extends object>(ctx: ComponentRegionEntriesContext, region: ComponentRegion, packageName: string, props: P): ReactNode {
  const entry = ctx.slots.entriesOfSlot(region).find(candidate => candidate.options.key === packageName)
  return entry === undefined ? null : createElement(ContributionBoundary, { packageName, children: createElement(entry.component as ComponentType<P>, props) })
}
