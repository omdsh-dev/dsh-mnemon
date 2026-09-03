// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { translateEn as t } from 'dsh-mnemon/client'
import { strategy } from './fixture.ts'

// Load the installed Core's actual DSH browser artifact; no repository source alias.
vi.mock('dsh-mnemon/client', async () => {
  const { createRequire } = await import('node:module')
  const { loadMemoryClientArtifact } = await import('dsh-mnemon/testing')
  return loadMemoryClientArtifact(createRequire(import.meta.url).resolve('dsh-mnemon/client'), {
    react: await vi.importActual('react'),
    'react/jsx-runtime': await vi.importActual('react/jsx-runtime'),
    'react-dom': await vi.importActual('react-dom'),
    '@deepseek-ai/dsh-client-ui-primitives': await vi.importActual('@deepseek-ai/dsh-client-ui-primitives'),
  })
})
afterEach(cleanup)

import * as plugin from '../src/index.ts'
import { RuntimeSourcePage, installRuntimeMemoryUI } from '../src/client.ts'

describe('independent Runtime Source client', () => {
  it('clicks through an actual Source write and keeps a second instance isolated', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-runtime-client-'))
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      for (const id of ['work', 'personal']) await runner.mount(plugin, { instanceId: id, config: { dataDir: join(directory, id) } })
      const work = await runner.managementClient('source:work')
      const personal = await runner.managementClient('source:personal')
      const base = { sourceTypeId: 'runtime', sourceInstances: [], locale: 'en', writable: true }
      const view = render(<RuntimeSourcePage {...base} sourceInstanceKey="source:work" management={work} />)
      fireEvent.click(await screen.findByRole('button', { name: t('runtime.addButton') }))
      const textarea = await screen.findByRole('textbox', { name: t('runtime.content') })
      await waitFor(() => expect(document.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true))
      fireEvent.change(textarea, { target: { value: 'Source-owned runtime entry' } })
      fireEvent.click(screen.getByRole('button', { name: t('runtime.addAction') }))
      expect(await screen.findByText('Source-owned runtime entry')).not.toBeNull()
      expect((await work.read('snapshot')).value).toMatchObject({ entries: [expect.objectContaining({ content: 'Source-owned runtime entry' })] })
      view.rerender(<RuntimeSourcePage {...base} sourceInstanceKey="source:personal" management={personal} />)
      await waitFor(() => expect(screen.queryByText('Source-owned runtime entry')).toBeNull())
      expect((await personal.read('snapshot')).value).toMatchObject({ entries: [] })
      view.rerender(<RuntimeSourcePage {...base} writable={false} sourceInstanceKey="source:personal" management={personal} />)
      expect(screen.queryByRole('textbox', { name: t('runtime.content') })).toBeNull()
    } finally { cleanup(); await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('clears branch restrictions through the Sidebar editor and real Source', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-runtime-editor-'))
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'work', config: { dataDir: directory } })
      const management = await runner.managementClient('source:work')
      await management.mutate('mutate', { action: 'add', target: 'memory', content: 'branch-scoped note', branches: ['main'] }, { confirmed: true })
      render(<RuntimeSourcePage sourceTypeId="runtime" sourceInstanceKey="source:work" sourceInstances={[]} locale="en" writable management={management} />)
      await screen.findByText('branch-scoped note')
      fireEvent.click(screen.getByRole('button', { name: t('runtime.editAction') }))
      fireEvent.change(screen.getByRole('textbox', { name: t('runtime.branches') }), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: t('runtime.saveEdit') }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      const { value } = await management.read('snapshot')
      expect((value as { entries: object[] }).entries[0]).not.toHaveProperty('branches')
    } finally { cleanup(); await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('owns one complete, disposable page contribution', () => {
    const entries = new Map<string, unknown>()
    const release = installRuntimeMemoryUI({ slots: {
      inject: (_name: string, factory: () => () => void) => factory(),
      register: (options: { id: string }, component: unknown) => { entries.set(options.id, component); return () => entries.delete(options.id) },
    } } as never)
    expect([...entries.keys()]).toEqual(['runtime/entries'])
    expect(entries.get('runtime/entries')).toEqual(expect.any(Function))
    release()
    expect(entries.size).toBe(0)
  })
})
