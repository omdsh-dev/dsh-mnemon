import { Component, createElement, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'

/**
 * A component's own settings, on its page: keyed by the component's package
 * name, rendered after the page's generated state, relations and options.
 */
export const MNEMON_COMPONENT_SETTINGS_SLOT = 'mnemon.component.settings' as const
/**
 * The priority at which dsh-mnemon keeps the settings of a shipped component
 * that once had no settings of its own (today Memory Spaces). DSH renders, for
 * each key, the registration with the lowest priority, so the component's own
 * registration, at the default 0, replaces dsh-mnemon's while it lasts.
 *
 * Exporting this is a promise to those components, and a component may rely on
 * it alone: dsh-mnemon keeps their settings at this priority, so registering
 * their own does not collide with it, and lends their settings `host` (see
 * {@link MemoryComponentSettingsProps.host}). dsh-mnemon 0.5.31 and earlier
 * export neither and draw those settings at the default priority.
 */
export const MNEMON_COMPONENT_FALLBACK_PRIORITY = 100

const COMPONENT_SETTINGS_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  'dsh-mnemon-source-memory-spaces': ['policy', 'recall'],
  'dsh-mnemon-source-skills': ['models', 'market'],
}

/**
 * Sections this Core supplies, including the configuration access they need.
 * A generic open-settings callback alone does not promise these sections. Source
 * clients must keep their own controls when this export is absent or returns false.
 */
export function supportsMemoryComponentSettingsSection(packageName: string, section: string): boolean {
  return Object.hasOwn(COMPONENT_SETTINGS_SECTIONS, packageName) && COMPONENT_SETTINGS_SECTIONS[packageName]!.includes(section)
}

/**
 * What a component's card on the Memory System's Status page says while it
 * runs, keyed by the component's package name. A card that is not running
 * shows the page's own note instead.
 */
export const MNEMON_COMPONENT_STATUS_SLOT = 'mnemon.component.status' as const
type ComponentRegion = typeof MNEMON_COMPONENT_SETTINGS_SLOT | typeof MNEMON_COMPONENT_STATUS_SLOT

const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u

/** What the host tells a component's settings about the page they are on. */
export interface MemoryComponentSettingsProps {
  /** The component the page is about, as the host shows it. */
  component: {
    packageName: string
    label: string
    /** Whether the component is switched on. */
    enabled: boolean
  }
  /** Whether the configuration can be written now; settings stay read-only otherwise. */
  writable: boolean
  /** The active DSH locale id. */
  language: string
  /** The conversation and workspace the page was opened for, when there is one. */
  sessionId?: string
  workspace?: { id: string; label?: string }
  /** Optional target section inside the component's settings when deep-linked. */
  section?: string | undefined
  /**
   * What the page lends the settings registered under the key of a shipped
   * component whose settings dsh-mnemon used to draw (today Memory Spaces):
   * the configuration keys and Host operations dsh-mnemon serves it. It goes
   * with the key, not with who registered: settings under any other key
   * receive none.
   */
  host?: MemoryComponentHost
}

/** dsh-mnemon's configuration as a component's settings read it. */
export interface MemoryComponentConfigurationSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  /** The configuration keys the page shares with this component. */
  value?: Readonly<Record<string, unknown>>
  /** Moves with every saved change, made on this page or anywhere else. */
  revision?: number
  /** Whether the Host takes a write now. */
  writable: boolean
}

/**
 * dsh-mnemon's configuration and Host operations, bound to one component and
 * to the page's conversation and workspace, as Source pages get a scoped
 * management client: never the settings service or the transport itself.
 */
export interface MemoryComponentHost {
  configuration: {
    getSnapshot(): MemoryComponentConfigurationSnapshot
    subscribe(listener: () => void): () => void
    /** Save one key the component owns, fenced by the revision the page read like every settings write. */
    set(key: string, value: MemoryJsonValue): Promise<void>
  }
  /** The Host operations dsh-mnemon serves this component; absent while the page has no Host connection. */
  operations?: {
    read(operation: string, input?: MemoryJsonValue): Promise<unknown>
    write(operation: string, input: MemoryJsonValue): Promise<unknown>
  }
  /** The component changed its data here, so the Memory System reads its pages again. */
  changed(): void
  /**
   * What the settings keep for as long as the page's client runs, one store per
   * component, conversation and workspace like the host itself. The settings
   * can mount again under an open page: dsh-mnemon draws a shipped component's
   * settings until the component's own client registers them, so turning the
   * component on swaps one for the other. What the first mount kept here lets
   * the next start where it was.
   */
  readonly retained: Map<string, unknown>
}

export type MemoryComponentSettingsComponent = (props: MemoryComponentSettingsProps) => ReactNode

/** What the Status page tells a component's card: the component it is about. */
export interface MemoryComponentStatusProps {
  component: {
    packageName: string
    label: string
    enabled: boolean
  }
  /** The active DSH locale id. */
  language: string
  /** The conversation and workspace the Memory System shows, when there is one. */
  sessionId?: string
  workspace?: { id: string; label?: string }
}

export type MemoryComponentStatusComponent = (props: MemoryComponentStatusProps) => ReactNode

/** Everything one component adds to dsh-mnemon's interface beyond its declaration. */
export interface MemoryComponentUIContribution {
  /** The npm package name the component's plugin declaration names. */
  packageName: string
  /** Its own settings, shown on its page. Each saves on its own. */
  settings?: MemoryComponentSettingsComponent
  /** What its card on the Status page says while it runs: a headline and one line. */
  status?: MemoryComponentStatusComponent
}

/** The DSH Slot capability narrowed to the component regions. */
export interface MemoryComponentUIContext {
  slots: {
    inject(name: ComponentRegion, setup: () => () => void): () => void
    register(options: { name: typeof MNEMON_COMPONENT_SETTINGS_SLOT; key: string }, component: MemoryComponentSettingsComponent): () => void
    register(options: { name: typeof MNEMON_COMPONENT_STATUS_SLOT; key: string }, component: MemoryComponentStatusComponent): () => void
  }
}

/**
 * Register a component's interface into the regions dsh-mnemon declares, the
 * way shipped components do. Registration waits for each region to exist and
 * is released by the returned function.
 */
export function installMemoryComponentUI(ctx: MemoryComponentUIContext, contribution: MemoryComponentUIContribution): () => void {
  return installRegions(ctx, contribution, {})
}

/**
 * dsh-mnemon's own registration of a shipped component's interface, kept for
 * that component's versions that register none: at
 * MNEMON_COMPONENT_FALLBACK_PRIORITY, so the component's own replaces it. Not
 * part of `dsh-mnemon/client`.
 */
export function installMemoryComponentFallbackUI(ctx: MemoryComponentUIContext, contribution: MemoryComponentUIContribution): () => void {
  return installRegions(ctx, contribution, { priority: MNEMON_COMPONENT_FALLBACK_PRIORITY })
}

function installRegions(ctx: MemoryComponentUIContext, contribution: MemoryComponentUIContribution, order: { priority?: number }): () => void {
  const key = contribution.packageName
  if (!PACKAGE_NAME.test(key)) throw new Error('memory component UI requires the package name of the component')
  const { settings, status } = contribution
  // DSH's register takes the priority beside the key; the public capability type leaves it out.
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

/** The components that registered into one region, as the pages that show it need to know. */
export interface ComponentRegionDirectory {
  getSnapshot(): ReadonlySet<string>
  subscribe(listener: () => void): () => void
}
/** The components that registered settings. */
export type ComponentSettingsDirectory = ComponentRegionDirectory

/** Thin adapter over a DSH child Slot: it keeps no registry of its own. */
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

/** A contribution that fails renders nothing and leaves the page around it working. */
class ContributionBoundary extends Component<{ packageName: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`dsh-mnemon: the interface ${this.props.packageName} contributed failed`, error, info.componentStack)
  }
  override render(): ReactNode { return this.state.failed ? null : this.props.children }
}

/**
 * Render what one component registered into a region, where the page is not
 * the region's declaring owner, as DSH's row page for a component is not:
 * a child slot has one declaring entry, the configuration's.
 */
export function renderComponentRegion<P extends object>(ctx: ComponentRegionEntriesContext, region: ComponentRegion, packageName: string, props: P): ReactNode {
  const entry = ctx.slots.entriesOfSlot(region).find(candidate => candidate.options.key === packageName)
  return entry === undefined ? null : createElement(ContributionBoundary, { packageName, children: createElement(entry.component as ComponentType<P>, props) })
}
