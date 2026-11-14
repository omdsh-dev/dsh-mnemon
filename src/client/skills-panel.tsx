import { Component, createElement, type ErrorInfo, type JSX, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconSkillOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientSettingsScope, Config, SkillsConfig } from '../host/protocol.ts'
import { MNEMON_ANCHOR_EVENT, type MnemonAnchor } from './anchor.ts'
import type { MnemonActionSeat } from './action-seat.ts'
import type { MnemonChangeSignal } from './change-signal.ts'
import type { MnemonClientContext } from './dsh-context.ts'
import type { MnemonTranslate } from './locales.ts'
import { ExternalStore } from './shared/store.ts'
import { MNEMON_SOURCE_PAGE_SLOT, type MemorySourcePageDirectory } from './source-pages.tsx'
import { MnemonWorkspaceHost } from './workspace-mount.tsx'
import css from './MnemonWorkspace.module.css'

/** The sidebar panel 技能管理 opens as, when it has an entry of its own. */
export const SKILLS_PANEL_ID = 'mnemon-skills' as MainPanelId
/** 技能管理's Source type, which its pages are named after. */
export const SKILLS_SOURCE_TYPE = 'skills'

/** Whether a Memory System page belongs to 技能管理. */
export function isSkillsPage(page: string): boolean {
  return page.split('/')[0] === SKILLS_SOURCE_TYPE
}

/**
 * Whether 技能管理 has its own sidebar entry right now. The Memory System
 * leaves its page out while it does, and its links open the entry instead.
 */
export class SkillsPanelSeat extends ExternalStore<boolean> {
  constructor() {
    super(false)
  }

  set(available: boolean): void {
    this.setSnapshot(available)
  }
}

/** A page that fails renders nothing and leaves the panel around it working. */
class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('dsh-mnemon: the Skills page failed', error, info.componentStack)
  }
  override render(): ReactNode { return this.state.failed ? null : this.props.children }
}

type SourcePageRenderer = NonNullable<Parameters<typeof MnemonWorkspaceHost>[0]['renderSlot']>

/**
 * Render a Source page this panel does not declare, as DSH's row page renders
 * a component's settings: the Memory System declares the page region, and a
 * region has one declaring entry.
 */
function pageRenderer(ctx: MnemonClientContext): SourcePageRenderer {
  const render = (_slot: string, props: unknown, options?: { only?: string }): ReactNode => {
    const entry = ctx.slots.entriesOfSlot(MNEMON_SOURCE_PAGE_SLOT).find(candidate => candidate.options.id === options?.only)
    return entry === undefined ? null : createElement(PageBoundary, null, createElement(entry.component as (props: object) => ReactNode, props as object))
  }
  return render as unknown as SourcePageRenderer
}

export interface SkillsPanelServices {
  connection: MnemonClientContext['connection']
  settingsScope: ClientSettingsScope<Config>
  skillsScope: ClientSettingsScope<SkillsConfig>
  sessions: MnemonClientContext['sessions']
  workspaces: MnemonClientContext['workspaces']
  currentSession: MnemonClientContext['uiSession']['adapter']['current']
  localeRuntime: MnemonClientContext['locale']
  sourcePageDirectory: MemorySourcePageDirectory
  configuration: MnemonActionSeat
  componentChanges: MnemonChangeSignal
  t: MnemonTranslate
}

function SkillsSidebarIcon({ size }: Pick<PropsRuntime<'sidebar.panellist'>, 'size'>): JSX.Element {
  return <span data-dsh-plugin="dsh-mnemon" data-dsh-part="skills-sidebar-icon" style={{ display: 'inline-flex' }}><IconSkillOutlineRegular size={size} /></span>
}

type UsePanelInfoHook = <T>(selector: (info: { activePanelId: string | null }) => T) => T

/** The panel: the Memory System workbench focused on 技能管理, its title the window's top edge. */
function SkillsMainPanel(props: SkillsPanelServices & { render: SourcePageRenderer; navigation: { open(): void; close(): void }; usePanelInfo?: UsePanelInfoHook }): JSX.Element {
  const title = props.t('skills.label')
  const active = props.usePanelInfo === undefined ? true : props.usePanelInfo(info => info.activePanelId === SKILLS_PANEL_ID)
  return <div className={css.nativeWorkspace} data-dsh-mnemon-main-seat>
    <div className={css.windowDragBand} data-window-drag aria-hidden="true" />
    <section className={css.nativeWorkspace} aria-label={title}>
      <MnemonWorkspaceHost connection={props.connection} settingsScope={props.settingsScope} skillsScope={props.skillsScope} sessions={props.sessions} workspaces={props.workspaces}
        currentSession={props.currentSession} localeRuntime={props.localeRuntime} sourcePageDirectory={props.sourcePageDirectory} configuration={props.configuration}
        componentChanges={props.componentChanges} t={props.t} active={active} titleBar focus={{ sourceTypeId: SKILLS_SOURCE_TYPE, title }} renderSlot={props.render} navigation={props.navigation} />
    </section>
  </div>
}

/**
 * 技能管理 as a DSH sidebar panel of its own, after the Memory System. A layout
 * without native panel seats keeps 技能管理 in the Memory System instead.
 * Links to a skills page open this panel while it lasts.
 */
export function mountSkillsPanel(ctx: MnemonClientContext, services: SkillsPanelServices, seat: SkillsPanelSeat): () => void {
  const render = pageRenderer(ctx)
  // Back to the conversation, as the Memory System's panel goes: "Use" and the header's back both take it.
  const navigation = { open: () => ctx.layout.selectPanel(SKILLS_PANEL_ID), close: () => ctx.layout.selectPanel(null) }
  const openFromAnchor = (event: Event): void => {
    const anchor = (event as CustomEvent<MnemonAnchor>).detail
    if (anchor !== undefined && seat.getSnapshot() && isSkillsPage(anchor.page)) ctx.layout.selectPanel(SKILLS_PANEL_ID)
  }
  const stopNative = ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
    const stopMain = ctx.slots.register({ name: 'main', key: SKILLS_PANEL_ID, inject: () => ({ ...services, render, navigation }) }, SkillsMainPanel as never)
    let stopIcon: (() => void) | undefined
    try {
      stopIcon = ctx.slots.register({ name: 'sidebar.panellist', id: SKILLS_PANEL_ID, order: 31, label: () => services.t('skills.label'), locale: 'mnemon' }, SkillsSidebarIcon)
      seat.set(true)
    } catch (error) {
      seat.set(false)
      stopIcon?.()
      stopMain()
      throw error
    }
    return () => {
      seat.set(false)
      stopIcon?.()
      stopMain()
    }
  }))
  if (typeof window !== 'undefined') window.addEventListener(MNEMON_ANCHOR_EVENT, openFromAnchor)
  return () => {
    if (typeof window !== 'undefined') window.removeEventListener(MNEMON_ANCHOR_EVENT, openFromAnchor)
    stopNative()
    seat.set(false)
  }
}
