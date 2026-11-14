import type { CommandDefinition, CommandInvocation, CommandResult, CommandService } from "./dsh.ts"
import type { Insight, MemorySpacesStatus } from 'dsh-mnemon-source-memory-spaces/contracts'
import { agentScope, type MnemonAgentRuntimeSource } from './runtime.ts'
import { mutationResultCommitted } from './receipts.ts'
import { assertAgentMemoryIncluded } from './workspace-exclusion.ts'
import type { MnemonSubagentCoordinator } from './subagent.ts'

/** What a memory saved without a vector means, in the words the WebUI receipts use (#388). */
const UNEMBEDDED_LINE = '未生成向量：嵌入没有成功，这条记忆暂时不参与语义匹配。嵌入服务可用后，可在 Mnemon Native 嵌入设置的「测试状态」中补齐。'
/** The same, while DSH does not manage the embedding settings: no embedding service is set up, as on a default install. */
const UNEMBEDDED_NO_SERVICE_LINE = '这条记忆暂未生成向量：当前没有可用的嵌入服务，它暂不参与语义匹配，关键词检索不受影响。连接嵌入服务后，可在 Mnemon Native 嵌入设置的「测试状态」中补齐。'

const USAGE = '用法：/mnemon [status|recall <查询>|related <ID>|remember <内容>|forget <ID>]'

function error(text: string): CommandResult {
  return { kind: 'error', text: `${text}\n${USAGE}` }
}

function clip(value: string, max = 600): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function insightLine(insight: Insight, index: number): string {
  const meta = [
    insight.memoryBodyId === undefined ? undefined : `space=${insight.memoryBodyId}`,
    insight.category,
    insight.score === undefined ? undefined : `score=${insight.score.toFixed(3)}`,
    insight.depth === undefined ? undefined : `depth=${insight.depth}`,
  ].filter((value): value is string => value !== undefined).join(' · ')
  return `${index + 1}. ${clip(insight.content)}\n   ID: ${insight.id}${meta === '' ? '' : ` · ${meta}`}`
}

function splitInput(rawInput: string): { verb: string; argument: string } {
  const input = rawInput.trim()
  if (input === '') return { verb: 'status', argument: '' }
  const separator = input.search(/\s/u)
  return separator < 0
    ? { verb: input.toLowerCase(), argument: '' }
    : { verb: input.slice(0, separator).toLowerCase(), argument: input.slice(separator).trim() }
}

async function execute(serviceOrSource: MnemonAgentRuntimeSource, coordinator: MnemonSubagentCoordinator, invocation: CommandInvocation): Promise<CommandResult> {
  assertAgentMemoryIncluded(serviceOrSource, invocation.agent)
  const graph = serviceOrSource.forAgent(invocation.agent)
  const source = graph.source('memory-spaces', agentScope(invocation.agent, graph.config))
  const { verb, argument } = splitInput(invocation.rawInput)
  switch (verb) {
    case 'status': {
      if (argument !== '') return error('status 不接受额外参数。')
      const status = await source.read<MemorySpacesStatus>('status', null, invocation.signal)
      if (!status.healthy) return { kind: 'error', text: `Mnemon 不可用：${status.error ?? '未知错误'}` }
      const stats = status.stats
      // Mnemon Native is optional: without its CLI the other providers still serve memory.
      const nativeInstalled = status.commandFound !== false
      return {
        kind: 'success',
        text: [
          nativeInstalled ? `Mnemon ${status.version ?? ''} · default=${status.mnemonDefaultStore}`.trim() : 'Mnemon Native: 未安装 CLI（可选，其他 Provider 不受影响）',
          `DSH 已激活: ${status.dshActiveStores.join(', ') || 'none'}`,
          ...(nativeInstalled ? [`CLI: ${status.cliPath}`] : []),
          `数据目录: ${status.dataDir}`,
          `有效记忆: ${stats?.totalInsights ?? 0} · 连接: ${stats?.edgeCount ?? 0} · 已删除: ${stats?.deletedInsights ?? 0}`,
          `模式: ${status.writeEnabled ? '读写' : '只读'} · 默认召回: ${status.defaultRecallLimit}`,
        ].join('\n'),
      }
    }
    case 'recall': {
      if (argument === '') return error('recall 需要一个明确查询。')
      const response = await coordinator.recall(invocation.agent, {
        query: argument,
        limit: Math.min(graph.config.defaultRecallLimit, 10),
      }, invocation.signal)
      // A read that did not run found nothing either way; say why rather than that nothing matched (#389).
      if (response.notRun === true) return { kind: 'error', text: response.budgetExhausted === true ? `本回合的召回次数已用完，“${argument}”没有查询。` : `“${argument}”没有查询。` }
      if (response.results.length === 0) return { kind: 'success', text: `没有找到与“${argument}”相关的记忆。` }
      return { kind: 'success', text: `召回 ${response.results.length} 条：\n\n${response.results.map(insightLine).join('\n\n')}` }
    }
    case 'related': {
      if (argument === '') return error('related 需要 recall 返回的完整 ID。')
      const response = await coordinator.related(invocation.agent, argument, undefined, invocation.signal)
      const results = response.results
      // Related starts only from a memory the same turn's recall returned, and each command runs a turn of its own.
      if (response.notRun === true) return { kind: 'error', text: response.budgetExhausted === true ? `本回合的关联查询次数已用完，ID ${argument} 没有查询。` : `ID ${argument} 没有查询：关联查询只从同一回合召回返回的记忆出发，请在对话中召回后再查关联。` }
      if (results.length === 0) return { kind: 'success', text: `ID ${argument} 的两跳内没有关联记忆。` }
      return { kind: 'success', text: `关联记忆 ${results.length} 条：\n\n${results.map(insightLine).join('\n\n')}` }
    }
    case 'remember': {
      if (!graph.config.writeEnabled) return { kind: 'error', text: 'Mnemon 当前为只读模式，不能写入记忆。' }
      if (argument === '') return error('remember 需要一条自包含的记忆内容。')
      const result = await coordinator.remember(invocation.agent, { content: argument, source: 'user' }, invocation.signal)
      const written = mutationResultCommitted({ action: result.action }) || result.action === 'partial'
      const vectorless = !written || (result.unembedded ?? []).length === 0 ? '' : '\n' + (graph.config.embedding.enabled ? UNEMBEDDED_LINE : UNEMBEDDED_NO_SERVICE_LINE)
      return { kind: 'success', text: `Mnemon 记忆 Agent 已处理：${result.action}${result.memoryBodyIds.length === 0 ? '' : ` · 记忆空间 ${result.memoryBodyIds.join(', ')}`}${result.summary === '' ? '' : `\n${result.summary}`}${vectorless}` }
    }
    case 'forget': {
      if (!graph.config.writeEnabled) return { kind: 'error', text: 'Mnemon 当前为只读模式，不能删除记忆。' }
      if (argument === '' || /\s/u.test(argument)) return error('forget 需要一条记忆的精确 ID。')
      const result = await coordinator.write(invocation.agent, 'forget', { id: argument }, invocation.signal)
      if (result.action !== 'forgotten') return { kind: 'error', text: `Mnemon 未确认删除记忆：${argument}（${result.action}）${result.summary === '' ? '' : `\n${result.summary}`}` }
      return { kind: 'success', text: `已软删除 Mnemon 记忆：${argument}` }
    }
    default:
      return error(`未知 Mnemon 子命令：${verb}`)
  }
}

export function createMnemonCommand(service: MnemonAgentRuntimeSource, coordinator: MnemonSubagentCoordinator): CommandDefinition {
  return {
    name: 'mnemon',
    description: '查看、召回或管理 Mnemon 外置记忆',
    input: { hint: '[status|recall <查询>|related <ID>|remember <内容>|forget <ID>]' },
    handler: invocation => execute(service, coordinator, invocation).catch((reason: unknown) => ({
      kind: 'error',
      text: reason instanceof Error ? reason.message : String(reason),
    })),
  }
}

export function registerCommands(commands: CommandService, service: MnemonAgentRuntimeSource, coordinator: MnemonSubagentCoordinator): void {
  commands.register(createMnemonCommand(service, coordinator))
}
