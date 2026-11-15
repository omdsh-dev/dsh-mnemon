import { ExternalStore } from './shared/store.ts'

interface MnemonWorkspaceSnapshot {
  open: boolean
}

/** Small framework-neutral state holder shared by the sidebar row and panel. */
export class MnemonWorkspaceController extends ExternalStore<MnemonWorkspaceSnapshot> {
  constructor() {
    super({ open: false })
  }

  // Explicit navigation must reassert the panel even if a sibling took over
  // without announcing it and our last snapshot still says open.
  open(): void { this.setOpen(true, true) }
  close(): void { this.setOpen(false) }

  private setOpen(open: boolean, reassert = false): void {
    if (this.snapshot.open === open && !reassert) return
    this.setSnapshot({ open }, reassert)
  }
}
