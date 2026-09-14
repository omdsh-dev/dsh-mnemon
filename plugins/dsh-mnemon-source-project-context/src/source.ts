import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RecordSourceOptions } from 'dsh-mnemon/source-sdk'
const execute = promisify(execFile)
export async function currentBranch(workspaceId?: string): Promise<string> {
  if (!workspaceId) return ''
  try { return (await execute('git', ['-C', workspaceId, 'branch', '--show-current'], { timeout: 1000, maxBuffer: 4096 })).stdout.trim() } catch { return '' }
}
export const sourceOptions: RecordSourceOptions = { context: {"mode":"eager","weight":10} satisfies import('dsh-mnemon/contracts').MemoryContextProfile,
  transfer: true, reviewedRevisions: true,
  typeId: 'project-context', role: 'project-context', label: 'Project notes', description: 'Branch-aware facts, decisions and working notes.',
  kinds: ['fact', 'decision', 'note'], scopes: ['project', 'session'], defaultScope: 'project',
  validate(record) {
    const branches = record.data.branches
    if (branches !== undefined && (!Array.isArray(branches) || branches.length > 64 || branches.some(branch => typeof branch !== 'string' || !branch.trim() || branch.length > 200))) throw new Error('Branches must be a list of branch names')
  },
  async visible(record, scope) {
    const branches = record.data.branches as string[] | undefined
    if (!branches?.length) return true
    const branch = await currentBranch(scope.workspaceId)
    return !branch || branches.includes(branch)
  },
  project(records) { return records.filter(record => record.kind !== 'note').map(record => `[${record.kind}] ${record.title}\n${record.content}${Array.isArray(record.data.branches) && record.data.branches.length ? '\nBranches: ' + record.data.branches.join(', ') : ''}`).join('\n\n') || 'No approved project facts. Search this Source for working notes.' },
}
