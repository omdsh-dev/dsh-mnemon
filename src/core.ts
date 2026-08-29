import type { Config as MnemonConfig } from './config.ts'
import { Config, applyCore } from './index.ts'

export const name = 'dsh-mnemon-core'
export const provide = ['mnemonMemory']
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents']
export { Config }

/** Core-only entry used by the five-Entry Composable View bundle. */
export function apply(context: unknown, config: MnemonConfig = {}): void {
  applyCore(context, config, { compatibilityBundle: false })
}
