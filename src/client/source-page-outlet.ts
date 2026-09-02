import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

export type MnemonSourcePageRenderer = PropsRenderSlots<'mnemon.source.page'>['renderSlot']

/**
 * Shares the one DSH-authorized child-Slot renderer with optional client
 * placements. The Source page registry and ownership stay in DSH Slots; this
 * object only carries the live outlet created by Mnemon's shell entry.
 */
export class MnemonSourcePageOutlet {
  private renderSlot: MnemonSourcePageRenderer | undefined
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): MnemonSourcePageRenderer | undefined => this.renderSlot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  attach(renderSlot: MnemonSourcePageRenderer): () => void {
    this.renderSlot = renderSlot
    this.emit()
    return () => {
      if (this.renderSlot !== renderSlot) return
      this.renderSlot = undefined
      this.emit()
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
