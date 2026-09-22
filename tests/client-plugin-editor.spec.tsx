// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryMarkdown, MemoryMarkdownEditor } from '../src/client/plugin-editor.tsx'
import { SkillFiles } from '../plugins/dsh-mnemon-source-playbooks/src/file-client.tsx'
import { Page as Canvas } from '../plugins/dsh-mnemon-source-canvas/src/client.tsx'
import { Page as Learning } from '../plugins/dsh-mnemon-source-learning/src/client.tsx'
import type { MemorySourcePageProps } from '../src/client/source-pages.tsx'

afterEach(cleanup)

it('previews with native Markdown and keeps unsafe markup inert', () => {
  render(<MemoryMarkdown locale="en" content={'# Review\n\n**Evidence** and [unsafe](javascript:alert(1))\n\n<script>window.injected = true</script>'} />)
  expect(screen.getByRole('heading', { name: 'Review' })).toBeTruthy()
  expect(screen.getByText('Evidence').tagName).toBe('STRONG')
  expect(document.querySelector('script')).toBeNull()
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
})

it('saves only changed writable drafts with either platform shortcut', () => {
  const save = vi.fn()
  function Editor({ disabled = false }: { disabled?: boolean }) {
    const [value, setValue] = useState('Original')
    return <MemoryMarkdownEditor label="Note" locale="en" value={value} savedValue="Original" disabled={disabled} onChange={setValue} onSave={save} />
  }
  const ui = render(<Editor />), input = screen.getByRole('textbox', { name: 'Note' })
  fireEvent.keyDown(input, { key: 's', metaKey: true })
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: 'Reviewed' } })
  expect(screen.getByText(/Unsaved changes/)).toBeTruthy()
  fireEvent.keyDown(input, { key: 's', metaKey: true })
  fireEvent.keyDown(input, { key: 's', ctrlKey: true })
  expect(save).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Preview Markdown' }))
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByText('Reviewed')).toBeTruthy()
  ui.rerender(<Editor disabled />)
  fireEvent.keyDown(screen.getByText('Reviewed'), { key: 's', metaKey: true })
  expect(save).toHaveBeenCalledTimes(2)
})

const props = (management: MemorySourcePageProps['management'], workspaceId = '/workspace'): MemorySourcePageProps => ({
  sourceInstanceKey: 'test/source', sourceTypeId: 'playbooks', locale: 'en', workspaceId, sessionId: 'test-session', writable: true, management,
} as MemorySourcePageProps)

it('replaces the running notice after a durable learning review completes', async () => {
  const cycle = { id: 'cycle', kind: 'cycle', data: { rounds: 2, completedRound: 0, status: 'idle' } }
  const read = vi.fn().mockImplementation(async () => ({ revision: 'r1', value: { records: [structuredClone(cycle)] } }))
  const mutate = vi.fn().mockImplementation(async () => { cycle.data.status = 'running'; return read() })
  const management = { sourceInstanceKey: 'test/source', read, mutate } as unknown as MemorySourcePageProps['management']
  render(<Learning {...props(management)} />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'Review learning' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Review learning' }))
  await screen.findByRole('button', { name: 'Reviewing…' })
  cycle.data.status = 'idle'; cycle.data.completedRound = 2
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('Review complete. Proposals are ready for approval.')
  expect(screen.queryByText('Reviewing…')).toBeNull()
})

it('retains skill edits after a failed save and never reuses them in another workspace', async () => {
  const read = vi.fn().mockResolvedValue({ revision: 'r1', value: { path: '/skills/review/SKILL.md', digest: 'v1', content: 'Original' } })
  const mutate = vi.fn().mockRejectedValue(new Error('Skill file changed; read it again before saving'))
  const management = { sourceInstanceKey: 'test/source', read, mutate } as unknown as MemorySourcePageProps['management']
  const ui = render(<SkillFiles {...props(management)} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Skill file path' }), { target: { value: '/skills/review/SKILL.md' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
  const input = await screen.findByRole('textbox', { name: 'Skill file content' })
  fireEvent.change(input, { target: { value: 'Keep this draft' } })
  fireEvent.keyDown(input, { key: 's', ctrlKey: true })
  await screen.findByRole('alert')
  expect(mutate).toHaveBeenCalledWith('save-skill-file', expect.objectContaining({ digest: 'v1', content: 'Keep this draft' }), { confirmed: true, expectedRevision: 'r1' })
  expect((screen.getByRole('textbox', { name: 'Skill file content' }) as HTMLTextAreaElement).value).toBe('Keep this draft')
  ui.rerender(<SkillFiles {...props(management, '/another')} />)
  expect(screen.queryByRole('textbox', { name: 'Skill file content' })).toBeNull()
  expect((screen.getByRole('textbox', { name: 'Skill file path' }) as HTMLInputElement).value).toBe('')
})

it('discards a late skill response when its workspace is no longer selected', async () => {
  let finish!: (value: unknown) => void
  const read = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const management = { sourceInstanceKey: 'test/source', read, mutate: vi.fn() } as unknown as MemorySourcePageProps['management']
  const ui = render(<SkillFiles {...props(management)} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Skill file path' }), { target: { value: '/skills/old.md' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
  ui.rerender(<SkillFiles {...props(management, '/another')} />)
  await act(async () => finish({ revision: 'old', value: { path: '/skills/old.md', content: 'Old workspace', digest: 'old' } }))
  expect(screen.queryByRole('textbox', { name: 'Skill file content' })).toBeNull()
  expect(screen.queryByText('Old workspace')).toBeNull()
})

it('keeps the canvas edit pinned to the version that was actually opened', async () => {
  let version = 1
  const record = () => ({ id: 'note', version, kind: 'note', state: 'active', title: 'Review note', content: 'Original', scope: 'project', data: { x: 0, y: 0, width: 320, height: 260 } })
  const read = vi.fn().mockImplementation(async () => ({ revision: 'r' + version, value: { records: [record()], maxFileBytes: 1000, openLocalFiles: false } }))
  const mutate = vi.fn().mockRejectedValue(new Error('Record version changed'))
  const management = { sourceInstanceKey: 'test/source', read, mutate } as unknown as MemorySourcePageProps['management']
  render(<Canvas {...props(management)} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
  const input = screen.getByRole('textbox', { name: 'Edit note' })
  fireEvent.change(input, { target: { value: 'My pending edit' } })
  version = 2
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a material' }), { target: { value: 'Review' } })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  fireEvent.keyDown(input, { key: 's', metaKey: true })
  await screen.findByRole('alert')
  expect(mutate).toHaveBeenCalledWith('edit', expect.objectContaining({ version: 1, content: 'My pending edit' }), expect.objectContaining({ expectedRevision: 'r2' }))
  expect((screen.getByRole('textbox', { name: 'Edit note' }) as HTMLTextAreaElement).value).toBe('My pending edit')
})
