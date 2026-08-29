import {
  MNEMON_SETTINGS_NAMESPACE,
  MNEMON_UI_SETTINGS_NAMESPACE,
  normalizeDisplayMode,
  type ClientConnectionHandle,
  type Config,
  type InteractionConfig,
  type MnemonDisplayMode,
} from '../shared/contracts.ts'
import { MnemonSettingsCard } from './MnemonSettingsCard.tsx'
import { MnemonTurnTail, selectMnemonTurnTail } from './MnemonTurnTail.tsx'
import { MnemonSaveAction } from './MnemonSaveAction.tsx'
import { MNEMON_ANCHOR_EVENT, type MnemonAnchor } from './anchor.ts'
import { en, zh, type MnemonKey } from './locales.ts'
import { MnemonSettingsScope } from './settings.ts'
import type { MnemonClientContext } from './dsh-compat.ts'
import {
  createMemorySourcePageDirectory,
  installBuiltinMemorySourceUI,
} from './source-pages.tsx'
import {
  createMnemonWorkspaceNavigation,
  MnemonWorkspaceHost,
  mountMnemonWorkspace,
} from './workspace-mount.tsx'
import { mountSubagentTokenUsageOverride } from './subagent-token-usage.tsx'

export {
  installMemorySourceUI,
  memorySourcePageEntryId,
  MNEMON_SOURCE_PAGE_SLOT,
  MNEMON_SOURCE_CONFIGURATION_MUTATE,
  MNEMON_SOURCE_CONFIGURATION_READ,
  type MemorySourcePageComponent,
  type MemorySourcePageDefinition,
  type MemorySourcePageProps,
  type MemorySourceUIContribution,
} from './source-pages.tsx'
export type { MnemonSourceManagementClient } from './dsh-compat.ts'

export const inject = ['slots', 'sessions', 'workspaces', 'connection', 'locale']

/** Interaction surfaces: slot name, settings toggle, and the registrations it owns. */
type MnemonNamespace = 'mnemon'
type InteractionSlot = 'conversation.chat.turnTail' | 'conversation.chat.assistant-actions'
type InteractionRegister = (ctx: MnemonClientContext, namespace: MnemonNamespace, translate: (key: MnemonKey, params?: Record<string, unknown>) => string, settings: MnemonSettingsScope<Config>) => () => void

interface InteractionUnit {
  slot: InteractionSlot
  enabled: (value: unknown) => boolean
  register: InteractionRegister
}

const INTERACTION_UNITS: Record<'turnBar' | 'saveAction', InteractionUnit> = {
  turnBar: {
    slot: 'conversation.chat.turnTail',
    enabled: (value: unknown): boolean => enabledOf(value, 'turnBar'),
    register(ctx: MnemonClientContext, namespace: MnemonNamespace, translate: (key: MnemonKey, params?: Record<string, unknown>) => string): () => void {
      return ctx.slots.register({
        name: 'conversation.chat.turnTail',
        locale: namespace,
        select: selectMnemonTurnTail,
        inject: (sessionId: unknown): { sessionId?: string; connection: ClientConnectionHandle; t: (key: MnemonKey, params?: Record<string, unknown>) => string } => ({
          ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
          connection: ctx.connection,
          t: translate as (key: MnemonKey, params?: Record<string, unknown>) => string,
        }),
      }, MnemonTurnTail)
    },
  },
  saveAction: {
    slot: 'conversation.chat.assistant-actions',
    enabled: (value: unknown): boolean => enabledOf(value, 'saveAction'),
    register(ctx: MnemonClientContext, namespace: MnemonNamespace, translate: (key: MnemonKey, params?: Record<string, unknown>) => string, settings: MnemonSettingsScope<Config>): () => void {
      return ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'mnemon-save',
        order: 90,
        locale: namespace,
        inject: (sessionId: unknown): { sessionId?: string; connection: ClientConnectionHandle; settingsScope: MnemonSettingsScope<Config>; t: (key: MnemonKey, params?: Record<string, unknown>) => string } => ({
          ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
          connection: ctx.connection,
          settingsScope: settings,
          t: translate as (key: MnemonKey, params?: Record<string, unknown>) => string,
        }),
      }, MnemonSaveAction)
    },
  },
}

type InteractionUnitKey = keyof typeof INTERACTION_UNITS

/** Ready snapshots default each interaction on; loading has no value and mounts nothing. */
function enabledOf(value: unknown, key: 'turnBar' | 'saveAction'): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return (value as Partial<Record<typeof key, boolean>>)[key] !== false
}

type DisplayMode = NonNullable<Config['displayMode']>

function mountCanonicalMemoryView(ctx: MnemonClientContext, settings: MnemonSettingsScope<Config>, namespace: MnemonNamespace, translate: (key: MnemonKey, params?: Record<string, unknown>) => string, surface: DisplayMode): () => void {
  const navigation = createMnemonWorkspaceNavigation(translate)
  const sourcePageDirectory = createMemorySourcePageDirectory(ctx)
  const disposeView = ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mnemon',
    order: 30,
    label: () => translate('tab.label'),
    locale: namespace,
    children: {
      'mnemon.source.page': { kind: 'list', scope: 'session' },
    },
    inject: () => ({
      connection: ctx.connection,
      settingsScope: settings,
      sessions: ctx.sessions,
      workspaces: ctx.workspaces,
      localeRuntime: ctx.locale,
      sourcePageDirectory,
      navigation,
      surface,
      t: translate,
    }),
  }, MnemonWorkspaceHost))
  if (typeof window === 'undefined' || typeof document === 'undefined') return disposeView
  const openMemoryView = (): void => { navigation.open() }
  window.addEventListener(MNEMON_ANCHOR_EVENT, openMemoryView)
  const disposeLauncher = surface === 'sidebar' ? mountMnemonWorkspace(ctx, settings, translate, navigation) : () => {}
  return () => {
    disposeLauncher()
    window.removeEventListener(MNEMON_ANCHOR_EVENT, openMemoryView)
    disposeView()
  }
}

/** Mount the memory workspace plus the optional in-conversation interaction surfaces. */
export function apply(rawContext: unknown): void {
  const ctx = rawContext as MnemonClientContext
  const settings = new MnemonSettingsScope<Config>(ctx.connection, MNEMON_SETTINGS_NAMESPACE)
  const interactionSettings = new MnemonSettingsScope<InteractionConfig>(ctx.connection, MNEMON_UI_SETTINGS_NAMESPACE)
  const namespace: MnemonNamespace = 'mnemon'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-mnemon: locale dictionaries')
  const translate = ctx.locale.bind(namespace)
  installBuiltinMemorySourceUI(ctx, translate)
  ctx.slots.inject(
    'conversation.session.header.lineage',
    () => mountSubagentTokenUsageOverride(ctx),
  )
  let activeMemoryWorkspace: { mode: DisplayMode; dispose: () => void } | undefined
  const reconcileMemoryWorkspace = (): void => {
    const snapshot = settings.getSnapshot()
    // Wait for both persisted switches so Builtin never flashes a sidebar row.
    const mode = snapshot.status === 'loading' || snapshot.value?.tabEnabled === false
      ? undefined
      : normalizeDisplayMode(snapshot.value?.displayMode)
    if (activeMemoryWorkspace?.mode === mode) return
    activeMemoryWorkspace?.dispose()
    activeMemoryWorkspace = mode === undefined
      ? undefined
      : {
          mode,
          dispose: mountCanonicalMemoryView(ctx, settings, namespace, translate, mode),
        }
  }
  ctx.effect(() => {
    const unsubscribe = settings.subscribe(reconcileMemoryWorkspace)
    reconcileMemoryWorkspace()
    return () => {
      unsubscribe()
      activeMemoryWorkspace?.dispose()
      activeMemoryWorkspace = undefined
    }
  }, 'dsh-mnemon: memory workspace entry')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mnemon',
    order: 20,
    label: () => translate('tab.label'),
    locale: namespace,
    inject: (): { scope: MnemonSettingsScope<Config>; interactionScope: MnemonSettingsScope<InteractionConfig>; connection: ClientConnectionHandle; sessionId?: string; workspaceId?: string; workspaceLabel?: string; t: (key: MnemonKey, params?: Record<string, unknown>) => string } => {
      const sessions = ctx.sessions?.list?.getSnapshot?.() ?? { current: undefined, byId: {} }
      const workspaces = ctx.workspaces?.list?.getSnapshot?.() ?? { items: [] }
      const sessionId = sessions.current
      const cwd = sessionId === undefined ? undefined : sessions.byId[sessionId]?.cwd
      const normalizePath = (value: string): string => value.replace(/[\\/]+$/u, '')
      const workspace = cwd === undefined
        ? workspaces.items[0]
        : workspaces.items.find(candidate => normalizePath(candidate.path) === normalizePath(cwd))
      return {
        scope: settings,
        interactionScope: interactionSettings,
        connection: ctx.connection,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(workspace === undefined ? {} : { workspaceId: String(workspace.workspaceId), workspaceLabel: workspace.title }),
        t: translate as (key: MnemonKey, params?: Record<string, unknown>) => string,
      }
    },
  }, MnemonSettingsCard))

  // In-conversation interaction surfaces default on and are bound live: each
  // settings change registers or disposes the slot contributions without a
  // reload. Until the snapshot loads, nothing registers (conservative default).
  const active = new Map<InteractionUnitKey, () => void>()
  const reconcile = (): void => {
    const value = interactionSettings.getSnapshot().value
    for (const key of Object.keys(INTERACTION_UNITS) as InteractionUnitKey[]) {
      const unit = INTERACTION_UNITS[key]
      const enabled = unit.enabled(value)
      if (enabled && !active.has(key)) {
        active.set(key, ctx.slots.inject(unit.slot, () => unit.register(ctx, namespace, translate, settings)))
      } else if (!enabled && active.has(key)) {
        active.get(key)!()
        active.delete(key)
      }
    }
  }
  ctx.effect(() => {
    const unsubscribe = interactionSettings.subscribe(reconcile)
    reconcile()
    return () => {
      unsubscribe()
      for (const dispose of [...active.values()].reverse()) dispose()
      active.clear()
    }
  }, 'dsh-mnemon: interaction surfaces')
}
