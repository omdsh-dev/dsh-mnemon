// @vitest-environment jsdom
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import type { Context } from '@deepseek-ai/cordis'
import copy from '../presentation/locales.json' with { type: 'json' }
import type { MemorySpaceCatalog } from '../src/contracts.ts'
import { strategy } from './fixture.ts'
import { bankProvider } from './bank-provider.ts'

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

describe('Read only on the Memory Spaces page (#434)', () => {
  it('is an explicit choice in the space settings, shown on its card, and applies to the namespace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-write-policy-page-'))
    const runner = new MemoryCompositionRunner()
    const { module, writes } = bankProvider({ legacy: [{ id: 'old-1', content: 'Legacy decision', score: 0.9 }], fresh: [] })
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'bank', module, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'spaces' })
      const management = await runner.managementClient('source:spaces')
      await management.mutate('provider-service-update', { providerId: 'bank', settings: {}, enabled: true }, { confirmed: true })
      const mutate = management.mutate.bind(management)
      const operations: string[] = []
      management.mutate = (operation, ...rest) => { operations.push(operation); return mutate(operation, ...rest) }
      const page = (refreshKey = 0) => <MemorySpacesSourcePage page="spaces" sourceTypeId="memory-spaces" sourceInstanceKey="source:spaces" sourceInstances={[]} locale="en" writable management={management} refreshKey={refreshKey} />
      const view = render(page())
      fireEvent.click(await screen.findByRole('button', { name: en['overview.editSpaceAria'].replace('{name}', 'legacy') }))
      const dialog = screen.getByRole('dialog', { name: en['overview.editSpaceAria'].replace('{name}', 'legacy') })
      const group = within(dialog).getByRole('group', { name: en['overview.writePolicy'] })
      // Both choices are named, the current one selected, each with what it means beside it.
      expect((within(group).getByRole('radio', { name: new RegExp(`^${en['overview.writable']}`, 'u') }) as HTMLInputElement).checked).toBe(true)
      expect(within(group).getByText(en['overview.readOnlyHint'])).not.toBeNull()
      fireEvent.click(within(group).getByRole('radio', { name: new RegExp(`^${en['common.readOnlySpace']}`, 'u') }))
      fireEvent.click(within(dialog).getByRole('button', { name: en['overview.saveSpace'] }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      // Only the write choice changed, so only it is saved.
      expect(operations).toEqual(['body-write-policy'])
      const card = (await screen.findByRole('button', { name: en['overview.editSpaceAria'].replace('{name}', 'legacy') })).closest('article')!
      expect(within(card).getByText(en['common.readOnlySpace'])).not.toBeNull()
      const items = ((await management.read('body-directory')).value as unknown as MemorySpaceCatalog).items
      expect(items.find(space => space.name === 'legacy')).toMatchObject({ writePolicy: 'read-only' })
      expect(items.find(space => space.name === 'fresh')).not.toHaveProperty('writePolicy')
      expect(writes).toEqual([])
      // Save to memory on this page offers no read-only space to write to.
      fireEvent.click(screen.getByRole('button', { name: en['nav.rememberAction'] }))
      const remember = screen.getByRole('dialog', { name: en['remember.title'] })
      fireEvent.click(within(remember).getByRole('button', { name: new RegExp(`^${en['remember.target']}`, 'u') }))
      expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([expect.stringMatching(/^fresh · /u)])
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      fireEvent.click(within(remember).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      // And back: the saved choice is shown when the settings open again.
      fireEvent.click(screen.getByRole('button', { name: en['overview.editSpaceAria'].replace('{name}', 'legacy') }))
      const again = within(screen.getByRole('dialog')).getByRole('group', { name: en['overview.writePolicy'] })
      expect((within(again).getByRole('radio', { name: new RegExp(`^${en['common.readOnlySpace']}`, 'u') }) as HTMLInputElement).checked).toBe(true)
      fireEvent.click(within(again).getByRole('radio', { name: new RegExp(`^${en['overview.writable']}`, 'u') }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['overview.saveSpace'] }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(screen.queryByText(en['common.readOnlySpace'])).toBeNull())
      // A policy file that cannot be read is said on the page, with a confirmed way back.
      writeFileSync(join(directory, 'state', 'memory-provider-write-policy.json'), '{ not json')
      view.rerender(page(1))
      const reset = await screen.findByRole('button', { name: en['overview.writePolicyReset'] })
      expect(screen.getByText(new RegExp(en['overview.writePolicyProblem'].split(':')[0]!, 'u'))).not.toBeNull()
      fireEvent.click(reset)
      fireEvent.click(await screen.findByRole('button', { name: en['overview.writePolicyResetConfirm'] }))
      await waitFor(() => expect(screen.queryByRole('button', { name: en['overview.writePolicyResetConfirm'] })).toBeNull())
      expect(existsSync(join(directory, 'state', 'memory-provider-write-policy.json'))).toBe(false)
    } finally { cleanup(); await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  }, 15_000)
})
