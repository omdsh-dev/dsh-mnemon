// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MemoryFileEditor } from '../src/client/plugin-files.tsx'

afterEach(cleanup)
const originals = [{ path: 'SKILL.md', content: '---\nname: report-review\ndescription: Review the report.\n---\n# Read the report' }, { path: 'scripts/check.mjs', content: 'original script' }, { path: 'references/old.md', content: 'old note' }]
it('compares edits without losing resource content when navigating or previewing', () => {
  function Editor() {
    const [files, setFiles] = useState(originals.slice(0, 2))
    return <MemoryFileEditor locale="en" files={files} originalFiles={originals} onChange={setFiles} />
  }
  render(<Editor />)
  fireEvent.click(screen.getByRole('button', { name: 'scripts/check.mjs' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Resource content' }), { target: { value: 'reviewed script' } })
  fireEvent.click(screen.getByRole('button', { name: 'Compare versions' }))
  expect(screen.getByText('original script')).toBeTruthy()
  expect(screen.getByText('reviewed script')).toBeTruthy()
  expect(screen.getByText(/Removed resources: references\/old.md/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close comparison' }))
  fireEvent.click(screen.getByRole('button', { name: 'SKILL.md' }))
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
  expect(screen.getByRole('heading', { name: 'Read the report' })).toBeTruthy()
  expect(screen.getByText('Document metadata')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show text' }))
  expect((screen.getByRole('textbox', { name: 'Resource content' }) as HTMLTextAreaElement).value).toBe(originals[0]!.content)
  fireEvent.click(screen.getByRole('button', { name: /scripts\/check.mjs/ }))
  expect((screen.getByRole('textbox', { name: 'Resource content' }) as HTMLTextAreaElement).value).toBe('reviewed script')
})
it('keeps native file structure fixed while allowing text edits, and prevents published edits', () => {
  const ui = render(<MemoryFileEditor locale="en" files={originals} onChange={() => {}} allowResourceChanges={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'scripts/check.mjs' }))
  expect(screen.getByRole('textbox', { name: 'Resource content' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Remove resource' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Add resource' })).toBeNull()
  ui.rerender(<MemoryFileEditor locale="en" files={originals} onChange={() => {}} readOnly />)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByText('original script')).toBeTruthy()
})
