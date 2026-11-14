import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { canonicalWorkspacePath } from '../sdk/workspace-storage.ts'
import type { HostAgent, HostAgentsService, HostWorkspaceRegistry } from './dsh.ts'
import type { WorkspaceMemoryParticipation } from './protocol.ts'
import type { MnemonAgentRuntimeSource } from './runtime.ts'

export const WORKSPACE_MEMORY_EXCLUDED = 'Memory is disabled for this workspace by excludedWorkspaces. Remove the workspace from that setting to resume memory participation; existing data is retained.'

function existingWorkspace(path: string | undefined): string | undefined {
  if (path === undefined || path.trim() === '') return undefined
  const value = path.trim()
  const expanded = value === '~' ? homedir() : /^~[/\\]/u.test(value) ? join(homedir(), value.slice(2)) : value
  try {
    const canonical = canonicalWorkspacePath(expanded)
    return statSync(canonical).isDirectory() ? canonical : undefined
  } catch { return undefined }
}

/** Local opt-out, independent of data placement; never modifies a store. */
export class WorkspaceMemoryPolicy {
  // Remember only the parent workspace after unload, not its Agent/history.
  // A different child cwd cannot shed inherited opt-out.
  private readonly parentWorkspaces = new WeakMap<HostAgent, string>()
  constructor(private readonly entries: () => readonly string[], private readonly agents?: Pick<HostAgentsService, 'get'>,
    private readonly workspaces?: HostWorkspaceRegistry) {}

  forWorkspace(path?: string): WorkspaceMemoryParticipation {
    const entries = this.entries()
    if (entries.length === 0) return { excluded: false }
    const invalidEntries: number[] = []
    const roots = new Set(entries.flatMap((entry, index) => {
      const root = existingWorkspace(entry)
      if (root === undefined) { invalidEntries.push(index); return [] }
      return [root]
    }))
    const workspace = existingWorkspace(path)
    return {
      excluded: workspace !== undefined && roots.has(workspace),
      ...(workspace === undefined ? { reason: 'workspace-unavailable' as const } : {}),
      ...(invalidEntries.length === 0 ? {} : { invalidEntries }),
    }
  }

  forAgent(agent: HostAgent): WorkspaceMemoryParticipation {
    let owner = agent
    let workspace: string | undefined
    const seen = new Set<HostAgent>()
    while (!seen.has(owner)) {
      seen.add(owner)
      const id = owner.session.header?.origin === 'subagent' ? owner.session.header.parentSession?.trim() : undefined
      if (!id) { workspace = owner.session.header?.cwd; break }
      const parent = this.agents?.get(id)
      if (parent === undefined) {
        // A resumed child may outlive its parent's loaded Agent. The public
        // workspace catalog still identifies the parent's persisted session.
        workspace = this.parentWorkspaces.get(owner) ?? this.workspaces?.list().find(workspace => workspace.sessionIds?.includes(id))?.path
        break
      }
      owner = parent
    }
    if (agent.session.header?.origin === 'subagent' && workspace !== undefined) this.parentWorkspaces.set(agent, workspace)
    return this.forWorkspace(workspace)
  }
}

export function assertAgentMemoryIncluded(runtime: Pick<MnemonAgentRuntimeSource, 'memoryParticipation'>, agent: HostAgent): void {
  if (runtime.memoryParticipation?.(agent).excluded) throw new Error(WORKSPACE_MEMORY_EXCLUDED)
}
