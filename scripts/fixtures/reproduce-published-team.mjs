// Optional integration evidence. Dependencies resolve only from --profile.
// All model responses are synthetic; no model provider API is contacted.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  profile: { type: 'string' },
  guard: { type: 'boolean', default: false },
  'mnemon-root': { type: 'string' },
  output: { type: 'string' },
} })
if (!values.profile) throw new Error('Pass --profile <isolated npm directory> with DSH 0.1.5-rc.2 and both Agent Teams packages 0.1.5-alpha.2 installed.')
const require = createRequire(join(resolve(values.profile), 'package.json'))
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const guarded = values.guard
const mnemonRoot = resolve(values['mnemon-root'] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'))
const { idleReviewBlockReason } = guarded
  ? await import(pathToFileURL(join(mnemonRoot, 'src/host/review-tools.ts')).href)
  : {}
const versions = Object.fromEntries(await Promise.all([
  'dsh', 'dsh-agent', 'dsh-agent-loop', 'dsh-subagent', 'dsh-subagent-in-process-driver',
  'dsh-subagent-fork-in-process', 'dsh-subagent-spawn-in-process',
  'dsh-experimental-agent-team', 'dsh-experimental-tool-agent-team',
].map(async name => [name, JSON.parse(await readFile(require.resolve(`@deepseek-ai/${name}/package.json`), 'utf8')).version])))
for (const [name, version] of Object.entries(versions)) {
  assert.equal(version, name.includes('experimental-') ? '0.1.5-alpha.2' : '0.1.5-rc.2', `Unexpected published ${name} version`)
}
const [
  { Context }, { default: AgentRegistry }, { default: AgentLoop },
  { default: LlmRuntime, LlmAdapter, createUserMessage }, { default: SessionStore, SessionId },
  { default: JsonlSessionPersistence }, { default: SessionProjectionRegistry },
  { default: SqliteSessionQuery }, { default: SubagentRuntime, foldSubagentDescriptor }, Fork, Spawn,
  { default: SystemPrompt }, { default: ToolRuntime }, { default: TeamService }, TeamTools,
] = await Promise.all([
  'cordis', 'dsh-agent', 'dsh-agent-loop', 'dsh-llm', 'dsh-session',
  'dsh-session-persistence-jsonl', 'dsh-session-projection', 'dsh-session-query-sqlite',
  'dsh-subagent', 'dsh-subagent-fork-in-process', 'dsh-subagent-spawn-in-process',
  'dsh-system-prompt', 'dsh-tools', 'dsh-experimental-agent-team', 'dsh-experimental-tool-agent-team',
].map(load))

class SyntheticAdapter extends LlmAdapter {
  constructor(respond) { super(); this.respond = respond; this.calls = 0 }
  async *stream(options) {
    const reply = this.respond(options)
    const id = `lifecycle-probe-${++this.calls}`
    if (typeof reply === 'string') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    } else {
      const args = JSON.stringify(reply.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: reply.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: reply.name, arguments: args } }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: typeof reply === 'string' ? 'stop' : 'tool-calls' } }
  }
}

const conciseError = error => ({ name: error?.name, code: error?.code, message: error?.message ?? String(error) })

async function reproduce(provider, teams) {
  const root = await mkdtemp(join(tmpdir(), 'mnemon-team-lifecycle-'))
  const ctx = new Context()
  const report = { provider, teams, guarded, parentModelCalls: 0, childModelCalls: 0, probeExecutions: [], events: [] }
  let run
  let parent
  let child
  let ordinal = 0
  const descriptor = agent => foldSubagentDescriptor(agent.session.snapshotEvents()) ?? null
  const membership = agent => teams === 'off' ? null : (ctx.agentTeams.tryMembership(agent)?.role ?? null)
  const observe = (stage, agent, detail = {}) => report.events.push({ ordinal: ++ordinal, stage,
    subject: agent === parent || agent.id === 'parent' ? 'parent' : 'child',
    origin: agent.session.header.origin, parentSession: agent.session.header.parentSession,
    descriptor: descriptor(agent), teamRole: membership(agent), ...detail })
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Fork, { providerName: 'fork' })
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    if (teams !== 'off') await ctx.plugin(TeamService)
    if (teams === 'tools') await ctx.plugin(TeamTools)
    ctx.llm.registerAdapter(['synthetic'], new SyntheticAdapter(options => {
      if (options.sessionId === 'parent') {
        report.parentModelCalls++
        return 'Synthetic completed parent checkpoint.'
      }
      report.childModelCalls++
      report.childModelToolNames = options.tools?.map(tool => tool.name)
      observe('model-request', ctx.agents.get(options.sessionId), {
        tools: report.childModelToolNames,
        promptCallsChildLead: `${options.system ?? ''}${JSON.stringify(options.messages)}`.includes('Your Team role is lead'),
      })
      return report.childModelCalls === 1
        ? { name: 'lifecycle_probe', args: {} }
        : 'Synthetic child completed.'
    }))
    ctx.tools.register({
      name: 'lifecycle_probe', description: 'Return a fixed local diagnostic marker.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, execution) {
        report.probeExecutions.push(execution.agent?.id ?? 'none')
        return 'probe-complete'
      },
    })
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin === 'subagent') child = agent
      observe('created', agent, { tools: agent.ctx.tools.schemas(agent).map(tool => tool.name) })
    })
    ctx.on('agent/disposed', ({ agent }) => observe('disposed', agent))
    ctx.on('agent/error', ({ agent, error }) => observe('error', agent, { error: conciseError(error) }))
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'subagent/descriptor') return
      const agent = ctx.agents.get(session.id)
      if (agent) observe('descriptor-appended', agent)
    })
    parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'synthetic', model: 'synthetic' }, { cwd: root })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Finish a synthetic parent turn.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    assert.equal(report.parentModelCalls, 1)
    assert.equal(parent.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 1)
    report.preflight = {
      hasTeamService: parent.ctx.get('agentTeams') !== undefined,
      hasScopedTeamSpawnTool: parent.ctx.tools.get('spawn_teammate', parent) !== undefined,
      hasGlobalTeamSpawnTool: parent.ctx.tools.get('spawn_teammate') !== undefined,
      ...(guarded ? { blockReason: idleReviewBlockReason(parent) } : {}),
    }
    assert.equal(report.preflight.hasTeamService, teams !== 'off')
    assert.equal(report.preflight.hasScopedTeamSpawnTool, teams === 'tools')
    assert.equal(report.preflight.hasGlobalTeamSpawnTool, false)
    if (guarded) assert.equal(report.preflight.blockReason, teams === 'tools' ? 'agent-team' : undefined)
    if (report.preflight.blockReason === 'agent-team') {
      report.guardOutcome = 'skipped before child creation'
      report.catalogAfterSkip = await ctx.subagents.remoteExportList(parent.id, new AbortController().signal)
      assert.equal(report.events.filter(event => event.stage === 'created' && event.subject === 'child').length, 0)
      assert.deepEqual(report.catalogAfterSkip.entries, [])
      const teamResult = await parent.ctx.tools.execute({
        name: 'team_task_create',
        arguments: { subject: 'Synthetic Team preservation probe', description: 'Confirm the compatibility skip keeps the Team plugin operational.' },
        agent: parent, callId: 'team-preservation', signal: new AbortController().signal,
      })
      report.parentTeamToolSucceeded = !teamResult.isError
      assert.equal(report.parentTeamToolSucceeded, true)
      report.parentTeamTaskCount = ctx.agentTeams.listTasks(parent).length
      assert.equal(report.parentTeamTaskCount, 1)
      return report
    }
    run = await ctx.subagents.start(provider, {
      label: 'Mnemon idle checkpoint review',
      parent,
      prompt: [{ type: 'text', text: 'Call lifecycle_probe once, then finish with a short plain-text completion.' }],
      persona: 'You are a bounded synthetic idle checkpoint reviewer. Call lifecycle_probe once and finish.',
      maxDepth: 1,
      toolFilter: { allow: ['lifecycle_probe'] },
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(run.localAgent, child)
    observe('start-returned', child)
    report.result = await run.result
    observe('result-settled', child)
    report.residentBeforeDispose = ctx.agents.get(run.id) === child
    const catalog = async () => {
      try { return await ctx.subagents.remoteExportList(parent.id, new AbortController().signal) }
      catch (error) { return { error: conciseError(error) } }
    }
    report.catalogBeforeDispose = await catalog()
    report.childEventTypes = child.session.snapshotEvents().map(event => event.type)
    await run.dispose()
    report.residentAfterDispose = ctx.agents.get(run.id) !== undefined
    report.catalogAfterDispose = await catalog()
    assert.equal(report.residentBeforeDispose, true)
    assert.equal(report.residentAfterDispose, false)
    assert.equal(report.events.find(event => event.stage === 'created' && event.subject === 'child').descriptor, null)
    assert.equal(report.catalogAfterDispose.entries.length, 1)
    assert.equal(report.catalogAfterDispose.entries[0].id, run.id)
    assert.equal(report.catalogAfterDispose.entries[0].mode, 'one-shot')
    assert.equal(report.catalogAfterDispose.entries[0].activity, 'inactive')
    if (teams === 'tools') {
      assert.equal(report.result.stopReason, 'error')
      assert.equal(report.childModelCalls, 1)
      assert.equal(report.probeExecutions.length, 1)
      assert.equal(report.events.find(event => event.stage === 'created' && event.subject === 'child').teamRole, 'lead')
      assert.equal(report.events.find(event => event.stage === 'descriptor-appended').teamRole, null)
      assert.ok(report.events.some(event => event.error?.code === 'TEAM_NOT_MEMBER'))
    } else {
      assert.equal(report.result.stopReason, 'completed')
      assert.equal(report.childModelCalls, 2)
      assert.equal(report.probeExecutions.length, 1)
    }
    return report
  } catch (error) {
    report.harnessError = conciseError(error)
    return report
  } finally {
    await run?.dispose()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

const results = []
for (const teams of ['off', 'service', 'tools']) {
  for (const provider of ['fork', 'spawn']) {
    const report = await reproduce(provider, teams)
    results.push(report)
    console.log(JSON.stringify({ provider, teams, result: report.result, modelCalls: report.childModelCalls,
      probes: report.probeExecutions.length, residentBeforeDispose: report.residentBeforeDispose,
      residentAfterDispose: report.residentAfterDispose, guardOutcome: report.guardOutcome,
      parentTeamToolSucceeded: report.parentTeamToolSucceeded, harnessError: report.harnessError }))
  }
}
if (values.output) await writeFile(resolve(values.output), JSON.stringify({ versions, results }, null, 2) + '\n')
if (results.some(result => result.harnessError)) process.exitCode = 1
