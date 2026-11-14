import { HeldSeat } from './shared/dom-seat.ts'

/**
 * One action a surface offers while its owner can perform it, such as opening
 * the dsh-mnemon page under DSH Plugins while that page provides navigation.
 * Readers render the control only while an action is present.
 */
export class MnemonActionSeat extends HeldSeat<() => void> {
  /** Offer the action until the returned disposer runs; a newer offer replaces it. */
  provide(action: () => void): () => void {
    return this.hold(action)
  }
}
