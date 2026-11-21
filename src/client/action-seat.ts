import { HeldSeat } from './shared/dom-seat.ts'

export class MnemonActionSeat extends HeldSeat<() => void> {
  provide(action: () => void): () => void {
    return this.hold(action)
  }
}
