// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import type { Context } from '@deepseek-ai/cordis'
import copy from '../presentation/locales.json' with { type: 'json' }
import type { MemorySpaceCatalog, MemoryProviderViewRequest, MemoryProviderViewResult } from '../src/contracts.ts'
import { strategy } from './fixture.ts'
import { shelfProvider } from './shelf-provider.ts'

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

import { installMemorySpaces } from '../src/index.ts'
import { MemorySpacesSourcePage } from '../src/client.ts'

const en = copy.en
const PNG = 'data:image/png;base64,iVBORw0KGgo='

function shelf(request: MemoryProviderViewRequest): MemoryProviderViewResult {
  if (request.view === 'log') return { kind: 'changes', changes: [{ id: 'run-1', at: '2026-10-23T12:39:13Z', origin: 'session-1', operations: [{ action: 'update', uri: 'shelf://main/language', before: 'Prefers Chinese.', after: 'Prefers English.' }] }] }
  if (request.uri === 'shelf://main/photo.png') return { kind: 'file', uri: request.uri, name: 'photo.png', size: 8, mediaType: 'image/png', dataUrl: PNG }
  return { kind: 'entries', uri: 'shelf://main', entries: [{ uri: 'shelf://main/photo.png', name: 'photo.png', directory: false, size: 8, summary: 'A photo of the status page.' }] }
}

describe('Provider views and a vendor plugin on the Memory Spaces page', () => {
  it('browses the declared views, shows the plugin as reported, and makes the space read only only when asked', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-provider-views-page-'))
    const runner = new MemoryCompositionRunner()
    const integration = { packageName: '@vendor/dsh-plugin', label: 'Vendor', version: '1.2.3', automation: { autoRecall: true, autoCapture: true, skipSubagentSessions: true }, sameNamespace: true, state: 'active' as const }
    const { module, writes } = shelfProvider(shelf, integration)
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'shelf', module, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'spaces' })
      const management = await runner.managementClient('source:spaces')
      await management.mutate('provider-service-update', { providerId: 'shelf', settings: {}, enabled: true }, { confirmed: true })
      render(<MemorySpacesSourcePage page="spaces" sourceTypeId="memory-spaces" sourceInstanceKey="source:spaces" sourceInstances={[]} locale="en" writable management={management} />)
      const browse = await screen.findByRole('button', { name: en['providerViews.browseAria'].replace('{name}', 'main') })
      const card = browse.closest('article')!
      // The card names the plugin and suggests, and nothing has changed yet.
      await waitFor(() => expect(within(card).getByText(en['integration.suggestReadOnly'])).not.toBeNull())
      expect(within(card).getByText(`${en['integration.chip'].replace('{label}', 'Vendor')} 1.2.3`)).not.toBeNull()
      const policy = async () => ((await management.read('body-directory')).value as unknown as MemorySpaceCatalog).items[0]!.writePolicy
      expect(await policy()).toBeUndefined()

      fireEvent.click(browse)
      const dialog = screen.getByRole('dialog', { name: 'main' })
      expect(within(dialog).getByText(en['integration.runsOnItsOwn'])).not.toBeNull()
      expect(within(dialog).getByRole('tab', { name: 'Shelf' }).getAttribute('aria-selected')).toBe('true')
      fireEvent.click(await within(dialog).findByRole('button', { name: /photo\.png/u }))
      expect((await within(dialog).findByRole('img', { name: 'photo.png' })).getAttribute('src')).toBe(PNG)
      fireEvent.click(within(dialog).getByRole('tab', { name: 'Log' }))
      fireEvent.click(await within(dialog).findByRole('button', { expanded: false }))
      expect(within(dialog).getByText('Prefers English.')).not.toBeNull()
      fireEvent.click(within(dialog).getAllByRole('button', { name: en['common.close'] })[0]!)
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      // The one action, pressed: the space becomes read only and the suggestion goes.
      fireEvent.click(within(card).getByRole('button', { name: en['integration.makeReadOnly'] }))
      await waitFor(async () => expect(await policy()).toBe('read-only'))
      await waitFor(() => expect(screen.queryByText(en['integration.suggestReadOnly'])).toBeNull())
      expect(writes).toEqual([])
    } finally { cleanup(); await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  }, 15_000)
})
