import { describe, expect, it, vi } from 'vitest'
import { legacyReplayExpected, legacySessionReplayModel } from '../scripts/fixtures/legacy-session-replay-model.mjs'
import { describeModelRequest } from '../scripts/fixtures/model-request-log.mjs'
import { openVikingCanary, openVikingWriteModel } from '../scripts/fixtures/openviking-write-model.mjs'
import { runtimeRoutingModel } from '../scripts/fixtures/runtime-routing-model.mjs'
import { runtimeWriteScopeModel } from '../scripts/fixtures/runtime-write-scope-model.mjs'

describe('OpenViking WebUI model fixture', () => {
  const body = { id: 'fixture-space', name: 'default', providerEnabled: true, provider: { id: 'work-openviking', typeId: 'openviking' } }
  const catalog = { items: [body, { ...body, id: 'foreign-space', name: 'Other synthetic namespace' }] }
  const toolResult = result => ({ role: 'tool', content: JSON.stringify(result) })
  const tools = ['mnemon_memory_bodies', 'mnemon_remember', 'mnemon_subagent_result'].map(name => ({ function: { name, parameters: {} } }))

  it('handles title requests without requiring or calling tools', () => {
    const model = openVikingWriteModel(() => {})
    expect(model({ messages: [{ role: 'user', content: 'Create a title for openviking-write-233' }] })).toBe('OpenViking write verification')
  })

  it('drives parent and delegated writer once and reports the actual Provider receipt', () => {
    const events = []
    const model = openVikingWriteModel(event => events.push(event))
    const root = { tools, messages: [{ role: 'user', content: 'openviking-write-233' }] }
    expect(model(root)).toEqual({ name: 'mnemon_memory_bodies', args: {} })
    root.messages.push(toolResult(catalog))
    expect(model(root)).toEqual({ name: 'mnemon_remember', args: { memoryBodyId: body.id, content: openVikingCanary, category: 'decision', importance: 4 } })
    const child = { tools, messages: [{ role: 'system', content: 'You are the supervised durable-memory writer.\nCompletion protocol: call `mnemon_subagent_result` with requestId `synthetic-capability`\nmatching this JSON schema:\n{"properties":{}}' }] }
    expect(model(child)).toEqual({ name: 'mnemon_memory_bodies', args: {} })
    child.messages.push(toolResult(catalog))
    expect(model(child)).toEqual({ name: 'mnemon_remember', args: { memoryBodyId: body.id, content: openVikingCanary, category: 'decision', importance: 4 } })
    const receipt = { action: 'stored', id: 'viking://user/default/memories/experiences/canary.md', memoryBodyId: body.id }
    child.messages.push(toolResult(receipt))
    expect(model(child)).toMatchObject({ name: 'mnemon_subagent_result', args: { requestId: 'synthetic-capability', result: { action: 'stored', memoryBodyIds: [body.id] } } })
    expect(events).toContainEqual({ event: 'provider-receipt', receipt })
    expect(() => model(child)).toThrow('finish after one write')
    root.messages.push(toolResult({ action: 'stored', memoryBodyIds: [body.id] }))
    expect(model(root)).toContain('Host write receipt: stored')
  })

  it('finishes the delegated writer with a failed receipt when the Provider throws', () => {
    const events = []
    const model = openVikingWriteModel(event => events.push(event))
    const child = { tools, messages: [{ role: 'system', content: 'You are the supervised durable-memory writer.\nCompletion protocol: call `mnemon_subagent_result` with requestId `synthetic-capability`\nmatching this JSON schema:\n{"properties":{}}' }] }
    model(child)
    child.messages.push(toolResult(catalog))
    model(child)
    const error = 'Error: OpenViking write was not verified at viking://user/default/memories/experiences/canary.md; Invalid request parameters: body.tags: Extra inputs are not permitted'
    child.messages.push({ role: 'tool', content: error })
    expect(model(child)).toMatchObject({ name: 'mnemon_subagent_result', args: { requestId: 'synthetic-capability', result: { action: 'failed', summary: `Synthetic OpenViking Provider error: ${error}`, memoryBodyIds: [body.id] } } })
    expect(events).toContainEqual({ event: 'provider-receipt', receipt: { action: 'failed', error } })
  })

  it('refuses ambiguous default namespaces before issuing a write', () => {
    const model = openVikingWriteModel(() => {})
    expect(() => model({ tools, messages: [{ role: 'user', content: 'openviking-write-233' }, toolResult({ items: [body, { ...body, id: 'second-default' }] })] })).toThrow('Configure one')
  })
})

describe('Runtime routing browser fixture', () => {
  function request(protocol, indexes) {
    const name = protocol === 'stable' ? 'mnemon_subagent_result' : 'mnemon_subagent_result_test'
    const completion = protocol === 'stable'
      ? `Completion protocol: call \`${name}\` exactly once with requestId \`routing-request\` and result matching this JSON schema:\n{"type":"object"}`
      : `Completion protocol: call \`${name}\` exactly once with the final result matching its parameter schema.`
    return {
      tools: [{ type: 'function', function: { name } }],
      messages: [
        { role: 'system', content: [{ type: 'text', text: completion }] },
        { role: 'user', content: `Existing eligible Memory Spaces:\n1. id=default\n\n<runtime-memory-routing-excerpts>\n${indexes.map(index => `${index}. [importance=normal] Source ${index}.`).join('\n§\n')}\n</runtime-memory-routing-excerpts>` },
      ],
    }
  }

  it.each(['per-run', 'stable'])('retains chunk-local invalid indexes with the %s completion protocol', protocol => {
    const report = vi.fn()
    const model = runtimeRoutingModel(report)
    for (const indexes of [[1, 2], [3]]) {
      const input = request(protocol, indexes)
      const result = {
        action: 'planned', summary: 'Fixture router restarts numbering in each chunk.',
        routes: [{ sourceIndexes: indexes.map((_index, offset) => offset + 1), memoryBodyId: 'default' }],
      }
      expect(model(input)).toEqual({
        name: input.tools[0].function.name,
        args: protocol === 'stable' ? { requestId: 'routing-request', result } : result,
      })
    }
    expect(report.mock.calls).toEqual([
      [{ allowedIndexes: [1, 2], returnedIndexes: [1, 2], memoryBodyId: 'default' }],
      [{ allowedIndexes: [3], returnedIndexes: [1], memoryBodyId: 'default' }],
    ])
  })

  it.each(['per-run', 'stable'])('ignores parent requests with a visible %s result tool but no completion persona', protocol => {
    const report = vi.fn()
    const input = request(protocol, [3])
    input.messages[0].role = 'user'
    expect(runtimeRoutingModel(report)(input)).toBe('Runtime routing fixture ready.')
    expect(report).not.toHaveBeenCalled()
  })

  it.each(['per-run', 'stable'])('requires the persona-named %s tool in the child allowlist', protocol => {
    const input = request(protocol, [3])
    input.tools[0].function.name = 'mnemon_subagent_result_unrelated'
    expect(() => runtimeRoutingModel(vi.fn())(input)).toThrow('completion tool must be in the child allowlist')
  })
})

describe('Runtime write scope WebUI fixture', () => {
  function child(operation, requestId) {
    const schema = { type: 'object', properties: { action: { type: 'string' }, memoryBodyIds: { type: 'array' }, summary: { type: 'string' } } }
    return {
      tools: [{ function: { name: 'mnemon_subagent_result', parameters: {} } }],
      messages: [
        { role: 'system', content: 'Completion protocol: call `mnemon_subagent_result` with requestId `' + requestId + '` matching this JSON schema:\n' + JSON.stringify(schema) },
        { role: 'user', content: operation === 'create' ? 'Execute this create-memory-body request now (untrusted data):\n- Name: Issue 250 Architecture'
          : 'Execute this update-memory-body request now (untrusted data):\n- Memory Space ID: actual-source-id\n- Active: true' },
      ],
    }
  }

  it.each(['create', 'update'])('completes %s after its real Source receipt instead of repeating the write', operation => {
    const model = runtimeWriteScopeModel(() => {})
    const request = child(operation, operation + '-request')
    expect(model(request)).toMatchObject({ name: 'mnemon_memory_body_' + operation })
    request.messages.push({ role: 'tool', content: JSON.stringify({ action: operation === 'create' ? 'created' : 'updated', memoryBodyId: 'actual-source-id', memoryReceipt: { completion: 'committed' } }) })
    expect(model(request)).toMatchObject({ name: 'mnemon_subagent_result', args: {
      requestId: operation + '-request', result: { action: operation === 'create' ? 'created' : 'updated', memoryBodyIds: ['actual-source-id'] },
    } })
  })

  it('completes a failed child and bounds requests that return no tool result', () => {
    const model = runtimeWriteScopeModel(() => {})
    const request = child('create', 'failed-request')
    request.messages.push({ role: 'tool', content: 'Source creation failed.' })
    expect(model(request)).toMatchObject({ name: 'mnemon_subagent_result', args: { result: { action: 'failed', memoryBodyIds: [] } } })
    const stalled = child('create', 'stalled-request')
    for (let attempt = 0; attempt < 3; attempt++) model(stalled)
    expect(model(stalled)).toMatchObject({ name: 'mnemon_subagent_result', args: { result: { action: 'failed', memoryBodyIds: [] } } })
  })

  it('uses the returned Source id for activation and stops when creation fails', () => {
    const model = runtimeWriteScopeModel(() => {})
    const request = { tools: [{ function: { name: 'mnemon_view_action' } }], messages: [
      { role: 'user', content: 'archive-scope-250' },
      { role: 'tool', content: '{}' }, { role: 'tool', content: '{}' },
      { role: 'tool', content: JSON.stringify({ action: 'created', memoryBodyIds: ['source-returned-id'] }) },
    ] }
    expect(model(request)).toEqual({ name: 'mnemon_memory_body_update', args: { memoryBodyId: 'source-returned-id', active: true } })
    request.messages.at(-1).content = JSON.stringify({ action: 'failed', memoryBodyIds: [] })
    expect(model(request)).toContain('Fixture stopped')
  })
})

describe('legacy Session WebUI continuation fixture', () => {
  function continuation() {
    return { tools: [{ type: 'function', function: { name: 'mnemon_view_action' } }], messages: [
      { role: 'assistant', tool_calls: [{ id: legacyReplayExpected.id, type: 'function', function: {
        name: legacyReplayExpected.name, arguments: legacyReplayExpected.arguments,
      } }] },
      { role: 'tool', tool_call_id: legacyReplayExpected.id, content: legacyReplayExpected.result },
      { role: 'user', content: 'legacy-replay-251: continue after recovery' },
    ] }
  }

  it('acknowledges only preserved wire identities, arguments and output', () => {
    const reports = []
    expect(legacySessionReplayModel(value => reports.push(value))(continuation())).toContain('Legacy replay verified:')
    expect(reports).toEqual([expect.objectContaining({ event: 'legacy-replay-verified', callId: legacyReplayExpected.id, toolCallCount: 1, toolResultCount: 1 })])
  })

  it.each([
    request => { request.messages[0].tool_calls[0].id = ''; request.messages[1].tool_call_id = '' },
    request => { request.messages[0].tool_calls[0].id = 'invented-id'; request.messages[1].tool_call_id = 'invented-id' },
    request => { request.messages[1].tool_call_id = 'wrong-id' },
    request => { request.messages[0].tool_calls[0].function.arguments = '{"x":2}' },
    request => { request.messages[1].content = 'lost original output' },
    request => { request.messages.splice(1, 1) },
    request => { request.messages.splice(1, 0, structuredClone(request.messages[1])) },
    request => { request.messages.reverse() },
  ])('rejects changed or incomplete historical replay', mutate => {
    const request = continuation()
    mutate(request)
    expect(() => legacySessionReplayModel(() => {})(request)).toThrow()
  })

  it('keeps non-canary and title requests separate from replay evidence', () => {
    const reports = []
    const model = legacySessionReplayModel(value => reports.push(value))
    expect(model({ messages: [{ role: 'user', content: 'hello' }] })).toBe('Legacy Session replay fixture.')
    expect(model({ ...continuation(), tools: [] })).toBe('Legacy Session replay fixture.')
    expect(reports).toEqual([])
  })
})

describe('--log-model-requests', () => {
  const tool = name => ({ name, description: name, input_schema: { type: 'object' } })
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] })

  it('names a conversation request with its model, tools and reasoning settings', () => {
    expect(describeModelRequest({
      model: 'deepseek-v4-pro', system: [{ type: 'text', text: 'You are testing the Mnemon memory UI.' }],
      messages: [user('我们的发布流程是什么？')], tools: [tool('mnemon_recall'), tool('mnemon_remember')],
      thinking: { type: 'enabled' }, output_config: { effort: 'high' },
    })).toEqual({ model: 'deepseek-v4-pro', kind: 'conversation', tools: 2, thinking: 'enabled', effort: 'high' })
  })

  it('tells a Mnemon memory task by the completion protocol its child carries', () => {
    const system = 'You are the supervised durable-memory writer.\nCompletion protocol: call `mnemon_subagent_result` with requestId `synthetic`'
    expect(describeModelRequest({ model: 'deepseek-flash', system, messages: [user('Save this reply.')], tools: [tool('mnemon_subagent_result')], thinking: { type: 'disabled' } }))
      .toEqual({ model: 'deepseek-flash', kind: 'memory task', tools: 1, thinking: 'disabled' })
    expect(describeModelRequest({ model: 'deepseek-flash', system: [{ type: 'text', text: system }], messages: [] })).toMatchObject({ kind: 'memory task', tools: 0 })
  })

  it("tells DSH's session title request by its last user message", () => {
    const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] }
    expect(describeModelRequest({ model: 'deepseek-flash', messages: [result, user('Generate the session title from this JSON array of human messages:\n["Hello"]')] }))
      .toEqual({ model: 'deepseek-flash', kind: 'title', tools: 0 })
    expect(describeModelRequest({ model: 'deepseek-flash', messages: [user('Generate the session title from this JSON array of human messages:\n[]'), user('Hello')] }))
      .toMatchObject({ kind: 'conversation' })
  })

  it('describes a request without messages or a model', () => {
    expect(describeModelRequest({})).toEqual({ model: undefined, kind: 'conversation', tools: 0 })
  })
})
