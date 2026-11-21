import { ExternalStore } from './shared/store.ts'

interface MnemonWorkspaceSnapshot {
  open: boolean
}

export class MnemonWorkspaceController extends ExternalStore<MnemonWorkspaceSnapshot> {
  constructor() {
    super({ open: false })
  }

  open(): void { this.setOpen(true, true) }
  close(): void { this.setOpen(false) }

  private setOpen(open: boolean, reassert = false): void {
    if (this.snapshot.open === open && !reassert) return
    this.setSnapshot({ open }, reassert)
  }
}
