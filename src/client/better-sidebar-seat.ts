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

export class MnemonBetterSidebarSeat extends HeldSeat<MnemonBetterSidebarPlacement> {
  attach(target: HTMLElement, scope: MnemonWorkspaceScope, visible: boolean): () => void {
    return this.hold({ target, scope, visible })
  }
}
