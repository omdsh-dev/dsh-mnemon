import { ExternalStore } from './shared/store.ts'

interface MnemonNativeSidebarPlacement {
  available: boolean
  target?: HTMLElement
}

/** Keep the shell-owned Source tree alive across native main-panel navigation. */
export class MnemonNativeSidebarSeat extends ExternalStore<MnemonNativeSidebarPlacement> {
  constructor() {
    super({ available: false })
  }

  setAvailable(available: boolean): void {
    if (this.snapshot.available === available) return
    this.setSnapshot({ ...this.snapshot, available })
  }

  attach(parent: HTMLElement): () => void {
    let target = this.snapshot.target
    if (target === undefined) {
      target = document.createElement('div')
      target.style.display = 'contents'
      this.setSnapshot({ ...this.snapshot, target })
    }
    parent.append(target)
    return () => {
      if (target.parentElement === parent) target.remove()
    }
  }
}
