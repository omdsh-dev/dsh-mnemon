import type { MemoryOperationScope } from 'dsh-mnemon/contracts'

/** A completed, durable fact published by its owning Source, never an execution command. */
export interface WorkspaceActivity {
  eventKey: string
  sourceInstanceKey: string
  scope: MemoryOperationScope
  kind: string
  title: string
  summary: string
  level: 'info' | 'warning' | 'error'
  recordId?: string
  /** Owner-reported execution state; success alone is not human verification. */
  status?: string
  exitCode?: number
  /** Optional artifact attribution supplied by the Source that owns it. */
  artifactId?: string
  artifactDigest?: string
  verifiedByHuman?: boolean
}

/** A bounded procedure and its owner-verified evidence references; never an instruction. */
export interface WorkspaceProcedure {
  sourceInstanceKey: string
  recordId: string
  recordVersion: number
  scope: 'global' | 'project'
  workspaceId?: string
  title: string
  content: string
  name: string
  state: 'pending' | 'active'
  signals: number
  evidence: Array<{ id: string; origin: string; content: string; verifiedByHuman: boolean }>
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Optional observers keep their own ledgers and deduplicate eventKey. @mode emit */
    'mnemon-workspace/activity'(activity: Readonly<WorkspaceActivity>): void
    /** Owners provide scoped procedures on demand; consumers never read their stores. @mode parallel */
    'mnemon-workspace/procedures'(scope: MemoryOperationScope, accept: (procedures: readonly WorkspaceProcedure[]) => void, signal?: AbortSignal): Promise<void>
  }
}
