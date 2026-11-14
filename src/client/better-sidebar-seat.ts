import { HeldSeat } from './shared/dom-seat.ts'

export interface MnemonWorkspaceScope {
  sessionId: string
  cwd?: string
}

interface MnemonBetterSidebarPlacement {
  target: HTMLElement
  scope: MnemonWorkspaceScope
  visible: boolean
}

/**
 * Carries only Better Sidebar's DOM seat and scope into the DSH-owned renderer
 * tree. Source child Slots never cross this boundary: the shell entry renders
 * them itself and portals the resulting workspace into the supplied seat.
 */
export class MnemonBetterSidebarSeat extends HeldSeat<MnemonBetterSidebarPlacement> {
  attach(target: HTMLElement, scope: MnemonWorkspaceScope, visible: boolean): () => void {
    return this.hold({ target, scope, visible })
  }
}
