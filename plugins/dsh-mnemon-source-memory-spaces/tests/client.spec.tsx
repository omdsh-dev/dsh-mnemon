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
import { MemorySpacesSourcePage, installMemorySpacesUI } from '../src/client.ts'

describe('independent Memory Spaces Source client', () => {
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
    expect([...entries]).toEqual(['memory-spaces/spaces', 'memory-spaces/explore', 'memory-spaces/entities', 'memory-spaces/remember', 'memory-spaces/content'])
    release()
    expect(entries.size).toBe(0)
  })
})
