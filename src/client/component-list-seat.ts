import { HeldSeat } from './shared/dom-seat.ts'

export const STARTER_GROUP_ROW_ID = 'mnemon-bundle'

export class MnemonComponentListSeat extends HeldSeat<boolean> {
  report(groupRow: boolean): () => void {
    return this.hold(groupRow)
  }
}
