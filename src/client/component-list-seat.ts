import { HeldSeat } from './shared/dom-seat.ts'

/** The id of the Starter's grouping row in its `cordis.patch.yml`. */
export const STARTER_GROUP_ROW_ID = 'mnemon-bundle'

/**
 * Whether DSH's component list on the dsh-mnemon page shows the Starter's
 * grouping row, which it shows as off. DSH 0.2.0 and earlier list it; DSH
 * 0.2.1 lists only the components. The page's head controls see the rows DSH
 * draws and report them here for the configuration above the list.
 */
export class MnemonComponentListSeat extends HeldSeat<boolean> {
  /** Report whether the open page lists the row until the returned disposer runs; a newer report replaces it. */
  report(groupRow: boolean): () => void {
    return this.hold(groupRow)
  }
}
