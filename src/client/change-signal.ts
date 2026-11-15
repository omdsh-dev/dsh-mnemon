import { ChangeSignal } from './shared/store.ts'

/**
 * A revision other surfaces bump when something they cannot observe directly
 * changed, such as a component switched on DSH's Plugins page. Readers reload
 * their own data when the revision moves.
 */
export class MnemonChangeSignal extends ChangeSignal {}
