export const STARTER_COMPONENT_ROWS: ReadonlyArray<{ rowId: string; packageName: string }> = [
  { rowId: 'mnemon-source-runtime', packageName: 'dsh-mnemon-source-runtime' },
  { rowId: 'mnemon-source-documents', packageName: 'dsh-mnemon-source-documents' },
  { rowId: 'mnemon-source-memory-spaces', packageName: 'dsh-mnemon-source-memory-spaces' },
  { rowId: 'mnemon-source-skills', packageName: 'dsh-mnemon-source-skills' },
  { rowId: 'mnemon-strategy-default-three-tier', packageName: 'dsh-mnemon-strategy-default-three-tier' },
  { rowId: 'mnemon-strategy-general', packageName: 'dsh-mnemon-strategy-general' },
  { rowId: 'mnemon-strategy-auto-capture', packageName: 'dsh-mnemon-strategy-auto-capture' },
  { rowId: 'mnemon-strategy-light-context', packageName: 'dsh-mnemon-strategy-light-context' },
  { rowId: 'mnemon-strategy-scoped', packageName: 'dsh-mnemon-strategy-scoped' },
]

export const STARTER_ENHANCEMENT_PACKAGES: readonly string[] = [
  'dsh-mnemon-strategy-scoped', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-auto-capture',
]

export const STARTER_SELF_REGISTERING_PACKAGES: readonly string[] = [
  'dsh-mnemon-strategy-scoped', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-auto-capture', 'dsh-mnemon-strategy-general',
]
