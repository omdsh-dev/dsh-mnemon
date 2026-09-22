import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import { agentMemoryScope } from 'dsh-mnemon-workspace-kit/dsh'
import type { CoordinationHooks } from './lifecycle.ts'
import type { ProjectFile } from './resources.ts'

export async function projectFile(ctx: Context, filename: string, scope: MemoryOperationScope, signal?: AbortSignal): Promise<ProjectFile> {
  if (!scope.workspaceId || !filename.trim()) throw new Error('Select a project file')
  const root = await ctx.fs.resolve(scope.workspaceId, { ...(signal ? { signal } : {}) })
  const target = await ctx.fs.resolve(filename, { cwd: scope.workspaceId, ...(signal ? { signal } : {}) })
  if (!ctx.fs.contains(root, target) || root.targetKey === target.targetKey) throw new Error('File is outside this project')
  return { path: ctx.fs.processPath(target), key: String(target.targetKey) }
}
/** Preserve DSH's write/edit version decisions and record only positive post-write observations. */
export function subscribeCoordination(ctx: Context, hooks: CoordinationHooks): () => void {
  const pending = new Map<ToolExecution['token'], Map<string, { file: ProjectFile; scope: MemoryOperationScope }>>()
  const intent = async (target: FsTarget, actor: object | undefined) => {
    const exec = actor as ToolExecution | undefined
    if (!exec?.agent?.session.header.cwd || typeof exec.token !== 'symbol') return
    const scope = agentMemoryScope(exec.agent)
    const root = await ctx.fs.resolve(scope.workspaceId!, { signal: exec.signal })
    if (!ctx.fs.contains(root, target)) return
    const file = { path: ctx.fs.processPath(target), key: String(target.targetKey) }
    await hooks.beforeWrite(file, scope, exec.signal)
    return { exec, file, scope }
  }
  const remember = (value: Awaited<ReturnType<typeof intent>>) => {
    if (!value) return
    const entries = pending.get(value.exec.token) ?? new Map()
    entries.set(value.file.key, { file: value.file, scope: value.scope }); pending.set(value.exec.token, entries)
  }
  const stops = [
    // The observation policy is a terminal single-slot decider. Wrap it first;
    // appending here would never observe an intent it already handled.
    ctx.on('fs/write-intent', async (target, actor, next) => { const value = await intent(target, actor); const decision = await next(); remember(value); return decision }, { prepend: true }),
    ctx.on('fs/edit-intent', async (target, actor, next) => { const value = await intent(target, actor); const decision = await next(); remember(value); return decision }, { prepend: true }),
    ctx.on('fs/observed', (target, observation, actor) => {
      const exec = actor as ToolExecution | undefined, entries = exec && pending.get(exec.token), key = String(target.targetKey), value = entries?.get(key)
      if (!value || observation.kind !== 'present') return
      entries!.delete(key); if (!entries!.size) pending.delete(exec!.token)
      hooks.written(value.file, value.scope)
    }),
    ctx.on('tools/result', exec => { pending.delete(exec.token); return undefined }),
    ctx.on('agent/created', ({ agent }) => hooks.presence(agentMemoryScope(agent), agent.status)),
    ctx.on('agent/status', ({ agent, status }) => hooks.presence(agentMemoryScope(agent), status)),
    ctx.on('agent/disposed', ({ agent }) => hooks.disposed(agentMemoryScope(agent))),
  ]
  for (const agent of ctx.agents.roots()) hooks.presence(agentMemoryScope(agent), agent.status)
  return () => { for (const stop of stops) stop(); pending.clear() }
}
