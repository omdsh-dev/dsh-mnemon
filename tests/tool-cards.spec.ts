import { toolContributions } from './fixtures/tool-contributions.ts'
import { describe, expect, it } from 'vitest'
import type { HostContextShape, ToolDefinition } from '../src/host/dsh.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'

/** The cards DSH shows of a tool call and its result in the conversation. */
interface ToolCards {
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, value: unknown): unknown
}

describe('memory tool cards', () => {
  it('shows every memory tool call and result with the card it always had, in registration order', () => {
    const tools: ToolDefinition[] = []
    const register = (tool: ToolDefinition) => { tools.push(tool); return () => {} }
    registerTools({ tools: { register } } as unknown as HostContextShape, {} as never, new MnemonSubagentCoordinator({} as never, {} as never), toolContributions())
    const args = { routeId: 'documents/search', offerId: 'runtime/mutate', query: 'release gates', id: 'm1', title: 'Release design', action: 'add', target: 'memory' }
    const cards = tools.map(tool => [tool.name, (tool as ToolCards).presentCall?.(args), (tool as ToolCards).presentResult?.(args, {})])
    expect(cards).toEqual([
      ['mnemon_view_route', { card: 'generic', title: 'Query composable memory', kind: 'search', rawInput: 'documents/search' }, { card: 'generic', title: 'Composable memory evidence ready' }],
      ['mnemon_view_action', { card: 'generic', title: 'Apply composable memory action', kind: 'edit', rawInput: 'runtime/mutate' }, { card: 'generic', title: 'Composable memory receipt ready' }],
      ['mnemon_memory_bodies', { card: 'generic', title: 'Inspect Mnemon Memory Spaces', kind: 'search' }, { card: 'generic', title: 'Mnemon Memory Spaces ready' }],
      ['mnemon_recall', { card: 'generic', title: 'Recall Mnemon memory', kind: 'search', rawInput: 'release gates' }, { card: 'generic', title: 'Mnemon recall complete' }],
      ['mnemon_related', { card: 'generic', title: 'Traverse Mnemon graph', kind: 'search', rawInput: 'm1' }, { card: 'generic', title: 'Mnemon graph traversal complete' }],
      ['mnemon_status', { card: 'generic', title: 'Check Mnemon status', kind: 'other' }, { card: 'generic', title: 'Mnemon status checked' }],
      ['mnemon_document_search', { card: 'generic', title: 'Search Mnemon Documents', kind: 'search', rawInput: 'release gates' }, { card: 'generic', title: 'Mnemon Documents ready' }],
      ['mnemon_document_create', { card: 'generic', title: 'Create Mnemon Document', kind: 'edit', rawInput: 'Release design' }, { card: 'generic', title: 'Mnemon Document created' }],
      ['mnemon_document_manage', { card: 'generic', title: 'add Mnemon Document', kind: 'edit', rawInput: 'Release design' }, { card: 'generic', title: 'Mnemon Document processed' }],
      ['mnemon_runtime_memory', { card: 'generic', title: 'add runtime memory memory', kind: 'edit' }, { card: 'generic', title: 'Runtime memory updated' }],
      ['mnemon_remember', { card: 'generic', title: 'Write Mnemon memory', kind: 'edit' }, { card: 'generic', title: 'Mnemon memory processed' }],
      ['mnemon_link', { card: 'generic', title: 'Link Mnemon insights', kind: 'edit' }, { card: 'generic', title: 'Mnemon insights linked' }],
      ['mnemon_forget', { card: 'generic', title: 'Forget Mnemon insight', kind: 'edit', rawInput: 'm1' }, { card: 'generic', title: 'Mnemon insight forgotten' }],
      ['mnemon_memory_body_create', { card: 'generic', title: 'Create Memory Space', kind: 'edit' }, { card: 'generic', title: 'Memory Space created' }],
      ['mnemon_memory_body_update', { card: 'generic', title: 'Update Mnemon Memory Space', kind: 'edit' }, { card: 'generic', title: 'Mnemon Memory Space updated' }],
      ['mnemon_memory_body_merge', { card: 'generic', title: 'Merge Mnemon Memory Spaces', kind: 'edit' }, { card: 'generic', title: 'Mnemon Memory Spaces merged' }],
    ])
  })
})
