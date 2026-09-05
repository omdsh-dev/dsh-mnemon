// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs'
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

import type { Context } from '@deepseek-ai/cordis'
import { installMemorySpaces } from '../src/index.ts'
import { provider } from './fixture.ts'
import { MemorySpacesSourcePage, installMemorySpacesUI, memorySpacesPageClient } from '../src/client.ts'

describe('independent Memory Spaces Source client', () => {
  it('selects advertised assistance for placement and activation while tracking revisions', async () => {
    const read = vi.fn(async () => ({ revision: 'r2', value: {} }))
    const mutate = vi.fn(async () => ({ revision: 'r4', value: {} }))
    const execute = vi.fn(async () => ({ revision: 'r3', value: {} }))
    const client = memorySpacesPageClient({ sourceInstanceKey: 'source:spaces', revision: 'r1', read, mutate,
      assistance: { operations: ['activation', 'body-create'], execute } })
    await client.reconnectBody('project')
    await client.updateBody('project', { active: true })
    expect(execute).toHaveBeenLastCalledWith('activation', { memoryBodyId: 'project', active: true }, { confirmed: true, expectedRevision: 'r2' })
    await client.updateBody('project', { name: 'Project' })
    expect(mutate).toHaveBeenLastCalledWith('body-update', { memoryBodyId: 'project', name: 'Project' }, { confirmed: true, expectedRevision: 'r3' })
    await client.createBody({ name: 'Team', description: 'Shared context', placement: { mode: 'automatic', prompt: 'Prefer shared context' } })
    expect(execute).toHaveBeenLastCalledWith('body-create', expect.objectContaining({ placement: { mode: 'automatic', prompt: 'Prefer shared context' } }), { confirmed: true, expectedRevision: 'r4' })
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('does not retry a rejected assisted activation as a general mutation', async () => {
    const mutate = vi.fn()
    const execute = vi.fn(async () => { throw new Error('activation denied') })
    const client = memorySpacesPageClient({ sourceInstanceKey: 'source:spaces', revision: 'r1', read: vi.fn(), mutate,
      assistance: { operations: ['activation'], execute } })
    await expect(client.updateBody('project', { active: true })).rejects.toThrow('activation denied')
    expect(execute).toHaveBeenCalledOnce()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('searches an explicitly mounted Provider through the selected Source', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-client-'))
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: provider, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'spaces' })
      const management = await runner.managementClient('source:spaces')
      await management.mutate('provider-service-update', { providerId: 'account', settings: {}, enabled: true }, { confirmed: true })
      await management.mutate('remember', { content: 'Provider-owned evidence' }, { confirmed: true })
      render(<MemorySpacesSourcePage page="explore" sourceTypeId="memory-spaces" sourceInstanceKey="source:spaces" sourceInstances={[]} locale="en" writable management={management} />)
      fireEvent.change(await screen.findByRole('textbox', { name: t('search.queryAria') }), { target: { value: 'evidence' } })
      fireEvent.click(screen.getByRole('button', { name: t('search.action') }))
      expect(await screen.findByText('Provider-owned evidence')).not.toBeNull()
      expect((screen.getByRole('button', { name: t('search.agentAction') }) as HTMLButtonElement).disabled).toBe(true)
    } finally { cleanup(); await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('owns five pages with one rollback/disposal boundary', () => {
    const entries = new Set<string>()
    const release = installMemorySpacesUI({ slots: {
      inject: (_name: string, factory: () => () => void) => factory(),
      register: (options: { id: string }) => { entries.add(options.id); return () => entries.delete(options.id) },
    } } as never)
    expect([...entries]).toEqual(['memory-spaces/spaces', 'memory-spaces/remember', 'memory-spaces/explore', 'memory-spaces/entities', 'memory-spaces/content'])
    release()
    expect(entries.size).toBe(0)
  })
})
