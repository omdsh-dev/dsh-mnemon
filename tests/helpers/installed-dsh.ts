import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * The DSH a real-host spec composes: the repository's pinned one, or the installation
 * DSH_HOST_ROOT names when `pnpm run test:installed-dsh` runs the root tests against it.
 */
export const requireDsh = createRequire(process.env.DSH_HOST_ROOT === undefined
  ? realpathSync(new URL('../../node_modules/@deepseek-ai/dsh/package.json', import.meta.url))
  : process.env.DSH_HOST_ROOT + '/package.json')

/** The version of the DSH the specs compose. */
export const dshVersion = (requireDsh('@deepseek-ai/dsh/package.json') as { version: string }).version

/**
 * Whether a DSH version is 0.2.1 or later, prereleases included. DSH 0.2.1 starts every child through
 * `startActivation`, has no `both` tools mode and refuses a filtered tool inside `run_code` before it
 * runs; DSH 0.2.0, the other supported host, does none of these.
 */
export function isDsh021(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/u).slice(0, 3).map(Number)
  return major > 0 || minor > 2 || (minor === 2 && patch >= 1)
}

/** Whether the DSH the specs compose is 0.2.1 or later. */
export const dsh021 = isDsh021(dshVersion)

/**
 * Compose the published tool stack, including the separate executor plugins introduced in
 * DSH 0.2.2-alpha.2. Return the scoped PTC selection used by native/PTC real-host fixtures.
 * This changes test composition only: shipped DSH profiles own their executor selection.
 */
export async function loadTools(ctx: Context, mode: 'native' | 'both' = 'native', host: NodeJS.Require = requireDsh): Promise<(scope: Context) => Promise<void>> {
  const { default: ToolRuntime } = await import(host.resolve('@deepseek-ai/dsh-tools'))
  if (typeof ToolRuntime.prototype.setExecutor !== 'function') {
    await ctx.plugin(ToolRuntime, { mode })
    return async scope => { scope.tools.presentAs('ptc') }
  }
  const [native, ptc] = await Promise.all([
    import(host.resolve('@deepseek-ai/dsh-tool-executor-native')),
    import(host.resolve('@deepseek-ai/dsh-tool-executor-ptc')),
  ])
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(native)
  return async scope => { await scope.plugin(ptc) }
}

/** Execute a single fixture probe through the Host's real guarded execution pipeline. */
export async function executeTool(ctx: Context, input: ToolExecutionInput): Promise<ToolExecutionResult> {
  const tools = ctx.tools as typeof ctx.tools & { setExecutor?: unknown }
  if (typeof tools.setExecutor !== 'function') return tools.execute(input)
  // The executor-based Host accepts model-call batches, including for calls outside a turn.
  const batchTools = tools as unknown as {
    execute(input: unknown): Promise<{ results: { callId: string; result: ToolExecutionResult }[] }>
  }
  const batch = await batchTools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    agent: input.agent,
    signal: input.signal,
  })
  const result = batch.results.find(result => result.callId === input.callId)
  if (!result) throw new Error(`DSH omitted the result of fixture call ${input.callId}`)
  return result.result
}

/**
 * DSH 0.2.1's subagent runtime needs the working directory service, which needs fs; DSH 0.2.0 has neither.
 * `host` resolves from the DSH being composed, the one the specs compose unless a spec names another. The
 * version decides, not whether the package resolves: under `pnpm run`, NODE_PATH reaches this repository's
 * own DSH packages from any installation.
 */
export async function loadWorkingDirectory(ctx: { get(name: string): unknown; plugin(plugin: never, config?: never): unknown }, host: NodeJS.Require = requireDsh): Promise<void> {
  if (!isDsh021((host('@deepseek-ai/dsh/package.json') as { version: string }).version)) return
  if (ctx.get('fs') === undefined) {
    const fs = await import(host.resolve('@deepseek-ai/dsh-fs-local')) as { default: unknown }
    await ctx.plugin(fs.default as never, { cwd: tmpdir() } as never)
  }
  const workingDirectory = await import(host.resolve('@deepseek-ai/dsh-working-directory')) as { default: unknown }
  await ctx.plugin(workingDirectory.default as never)
}
