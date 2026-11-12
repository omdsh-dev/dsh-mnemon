import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import * as cordis from '@deepseek-ai/cordis'
import * as store from '@deepseek-ai/dsh-client-store'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import * as reactDom from 'react-dom'
import * as zod from 'zod'
import type { ConversationNodeAssembler, ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { describe, expect, it } from 'vitest'
import { retiredMemorySnapshot } from '../src/client/retired-memory-snapshot.ts'
import { dsh021, requireDsh } from './helpers/installed-dsh.ts'

// The published /client export is a DSH browser-module factory, not Node ESM.
// Load its public exports just as DSH does; never import an upstream source file.
const dependencies: Record<string, unknown> = {
  '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-store': store,
  '@deepseek-ai/dsh-client-ui-slots': slots, '@deepseek-ai/dsh-client-ui-primitives': primitives,
  react, 'react/jsx-runtime': jsx, 'react-dom': reactDom, zod,
}
let conversation!: typeof import('@deepseek-ai/dsh-client-ui-conversation/client')
runInNewContext(readFileSync(requireDsh.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8'), {
  window: { __ModuleLoader__: { load(module: { factory: (require: (id: string) => unknown) => typeof conversation }) {
    conversation = module.factory(id => {
      if (!(id in dependencies)) throw new Error(`Undeclared browser test dependency: ${id}`)
      return dependencies[id]
    })
  } } },
  console,
})

type SessionEventLikeEntry = Parameters<ConversationNodeAssembler['append']>[0]

function entry(seq: number, source: unknown = { kind: 'dsh-mnemon', form: 'memory-snapshot-retired' }, content: unknown = [], type = 'developer/message'): SessionEventLikeEntry {
  return { type: 'event', event: {
    seq, type, time: seq,
    data: { turn: 1, step: 1, message: { id: `message-${seq}`, role: 'developer', source, content } },
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0],
  } } as unknown as SessionEventLikeEntry // Negative cases deliberately contain invalid/foreign message data.
}

describe('retired memory snapshot presentation', () => {
  it.each([
    { kind: 'dsh-mnemon' }, { kind: 'plugin:dsh-mnemon' }, { kind: 'plugin', plugin: 'dsh-mnemon' },
  ])('recognizes only our empty retirement message: %j', source => {
    expect(retiredMemorySnapshot.match(entry(1, { ...source, form: 'memory-snapshot-retired' }).event))
      .toEqual({ id: 'message-1', role: 'start', exclusive: true })
  })

  it.each([
    entry(1, { kind: 'other', form: 'memory-snapshot-retired' }),
    entry(1, { kind: 'plugin', plugin: 'other', form: 'memory-snapshot-retired' }),
    entry(1, { kind: 'dsh-mnemon', form: 'memory-snapshot' }),
    entry(1, { kind: 'dsh-mnemon', form: 'recall' }),
    entry(1, { kind: 'dsh-mnemon', form: 'instructions' }),
    entry(1, null),
    entry(1, undefined, [{ type: 'text', text: 'Keep this message visible.' }]),
    entry(1, undefined, [{ type: 'text', text: '' }]),
    entry(1, undefined, undefined, 'user/message'),
  ])('preserves other producers, forms, roles and nonempty content (%#)', input => {
    expect(retiredMemorySnapshot.match(input.event)).toBeNull()
  })
})

/** Observe nodes from the published assembler without depending on Chat's private builders. */
function view(target: string): ConversationViewDefinition {
  return { target, create() {
    let nodes = new Map<string, ConversationViewNode>()
    return {
      empty: [],
      replace(input) { nodes = new Map(input.nodes.map(node => [node.key, node])); return [...nodes.values()] },
      apply(input) { for (const node of input.upserts) nodes.set(node.key, node); return [...nodes.values()] },
    }
  } }
}

// Older UI hosts need no suppression; they may not expose the conversation registry.
describe.skipIf(typeof conversation.ConversationNodeAssembler !== 'function' || typeof conversation.ConversationEventRegistry !== 'function')('published conversation projection', () => {
  it.each(['before', 'after'])('suppresses generic Chat and fallback cards regardless of registration order (%s), retaining other targets', async order => {
    const ctx = new Context()
    try {
      const events = new conversation.ConversationEventRegistry(ctx)
      let stop: () => void = () => {}
      if (order === 'before') stop = events.register(retiredMemorySnapshot)
      // A generic context renderer and an unmatched-event fallback must both be suppressed.
      const generic = (kind: string, target: string): ConversationNodeDefinition => ({
        kind, target,
        match: event => event.type === 'developer/message' ? { id: String(event.seq), role: 'start' } : null,
        start: (_context, match) => match.event,
        update: context => context.state,
        buildViewNode: context => ({ key: context.key, kind, id: context.id, target, data: context.state }),
      })
      const stopGeneric = events.register(generic('generic-developer', 'chat'))
      events.registerFallback(generic('unknown-context', 'chat'))
      events.register(generic('audit-message', 'audit'))
      if (order === 'after') stop = events.register(retiredMemorySnapshot)
      const views = [view('chat'), view('audit')]
      const assembler = new conversation.ConversationNodeAssembler(events, { entries: () => views })
      const history = [entry(1), entry(2), entry(3), entry(4, undefined, [{ type: 'text', text: 'Visible context' }])]
      const original = JSON.stringify(history)
      assembler.activateTarget('chat')
      assembler.activateTarget('audit')
      for (const event of history) assembler.append(event)
      assembler.flush()
      const visible = () => (assembler.snapshot('chat') as ConversationViewNode[]).map(node => node.id)
      // 0.2.0 ignores exclusive claims; its existing presentation is preserved.
      const expected = dsh021 ? ['4'] : ['1', '2', '3', '4']
      expect(visible()).toEqual(expected)
      expect(assembler.snapshot('audit')).toHaveLength(4)
      // Opening/reloading a historical session follows the same projection.
      assembler.replaceWindow(history, false)
      assembler.flush()
      expect(visible()).toEqual(expected)
      expect(JSON.stringify(history)).toBe(original)
      if (!dsh021) return // 0.2.0 also uses a different, target-global fallback contract.
      stopGeneric()
      assembler.rebuildRegistry()
      assembler.flush()
      expect(visible()).toEqual(expected)
      expect(JSON.stringify(history)).toBe(original)
      // Disabling/unloading Mnemon restores the Host-owned presentation.
      stop()
      assembler.rebuildRegistry()
      assembler.flush()
      expect(visible()).toEqual(['1', '2', '3', '4'])
    } finally { await ctx.fiber.dispose() }
  })
})
