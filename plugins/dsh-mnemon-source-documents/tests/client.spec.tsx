// @vitest-environment jsdom
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
import { DocumentsSourcePage, installDocumentsMemoryUI } from '../src/client.ts'

describe('independent Documents Source client', () => {
  it('creates and edits through the Source management contract without a legacy session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-documents-client-'))
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'notes', config: { dataDir: join(directory, 'data') } })
      const management = await runner.managementClient('source:notes', { storage: 'custom', workspaceId: workspace })
      render(<DocumentsSourcePage sourceTypeId="documents" sourceInstanceKey="source:notes" sourceInstances={[]} locale="en" writable management={management} />)
      fireEvent.click(await screen.findByRole('button', { name: t('documents.new') }))
      fireEvent.change(screen.getByLabelText(t('documents.name')), { target: { value: 'Owned document' } })
      fireEvent.change(screen.getByLabelText(t('documents.markdown')), { target: { value: 'Independent document content' } })
      fireEvent.click(screen.getByRole('button', { name: t('documents.create') }))
      expect(await screen.findByRole('heading', { name: 'Owned document' })).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: t('documents.edit') }))
      fireEvent.change(screen.getByLabelText(t('documents.markdown')), { target: { value: 'Edited through Source management' } })
      fireEvent.click(screen.getByRole('button', { name: t('documents.save') }))
      expect(await screen.findByText('Edited through Source management')).not.toBeNull()
      expect((await management.read('snapshot')).value).toMatchObject({ total: 1 })
    } finally { cleanup(); await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('owns its page registration and releases it', () => {
    const entries = new Set<string>()
    const release = installDocumentsMemoryUI({ slots: {
      inject: (_name: string, factory: () => () => void) => factory(),
      register: (options: { id: string }) => { entries.add(options.id); return () => entries.delete(options.id) },
    } } as never)
    expect([...entries]).toEqual(['documents/library'])
    release()
    expect(entries.size).toBe(0)
  })
})
