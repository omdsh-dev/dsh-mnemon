// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { MemorySourcePageFrame, translateEn } from 'dsh-mnemon/client'
import copy from '../presentation/locales.json' with { type: 'json' }
import { descriptor, provider, strategy } from './fixture.ts'

const { settingsSupport } = vi.hoisted(() => ({ settingsSupport: vi.fn(() => false) }))
afterEach(() => settingsSupport.mockReturnValue(false))

// Load the installed Core's actual DSH browser artifact; no repository source alias.
vi.mock('dsh-mnemon/client', async () => {
  const { createRequire } = await import('node:module')
  const { loadMemoryClientArtifact } = await import('dsh-mnemon/testing')
  const client = loadMemoryClientArtifact<Record<string, unknown>>(createRequire(import.meta.url).resolve('dsh-mnemon/client'), {
    react: await vi.importActual('react'),
    'react/jsx-runtime': await vi.importActual('react/jsx-runtime'),
    'react-dom': await vi.importActual('react-dom'),
    '@deepseek-ai/dsh-client-ui-primitives': await vi.importActual('@deepseek-ai/dsh-client-ui-primitives'),
  })
  // Only the new-host cases advertise migrated sections; all other exports stay published.
  return { ...client, supportsMemoryComponentSettingsSection: settingsSupport }
})
afterEach(cleanup)

import type { Context } from '@deepseek-ai/cordis'
import type { EntityMemoriesView, EntityRelatedView, EntityView, Insight } from '../src/contracts.ts'
import { installMemorySpaces } from '../src/index.ts'
import { defineMemorySpaceProvider, MEMORY_SPACE_PROVIDER_API_VERSION, NORMALIZED_RELEVANCE_SCORE } from '../src/provider-sdk.ts'
import { MemorySpacesSourcePage, installMemorySpacesUI, memorySpacesPageClient } from '../src/client.ts'
import { MemoryGraph } from '../src/client/memory-graph.tsx'
import { SyncFreshnessText } from '../src/client/overview-page.tsx'

function t(key: string, params: Record<string, unknown> = {}): string {
  const own = (copy.en as Record<string, string>)[key]
  const text = own ?? translateEn(key as Parameters<typeof translateEn>[0], params)
  return own === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

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

  it('makes its own searches inspections and leaves Ask Agent a use (issue 338)', async () => {
    const read = vi.fn(async () => ({ revision: 'r2', value: {} }))
    const execute = vi.fn(async () => ({ revision: 'r3', value: {} }))
    const client = memorySpacesPageClient({ sourceInstanceKey: 'source:spaces', revision: 'r1', read, mutate: vi.fn(),
      assistance: { operations: ['agent-search'], execute } })
    await client.search({ query: 'release gate' })
    expect(read).toHaveBeenLastCalledWith('search', expect.objectContaining({ query: 'release gate', inspect: true }))
    await client.agentSearch({ query: 'release gate' })
    expect(execute).toHaveBeenLastCalledWith('agent-search', expect.not.objectContaining({ inspect: expect.anything() }), expect.anything())
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

  it('starts a new Memory Space on a ready provider when Mnemon Native is not installed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-create-'))
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: provider, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'spaces' })
      const management = await runner.managementClient('source:spaces')
      await management.mutate('provider-service-update', { providerId: 'account', settings: {}, enabled: true }, { confirmed: true })
      render(<MemorySpacesSourcePage page="spaces" sourceTypeId="memory-spaces" sourceInstanceKey="source:spaces" sourceInstances={[]} locale="en" writable management={management} />)
      fireEvent.click(await screen.findByRole('button', { name: 'New' }))
      const dialog = screen.getByRole('dialog', { name: 'Create Memory Space' })
      await waitFor(() => expect((within(dialog).getByRole('radio', { name: /Fixture/u }) as HTMLInputElement).checked).toBe(true))
    } finally { cleanup(); await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('opens related memories when an older Host supplies no scroll callbacks', async () => {
    const read = vi.fn(async (operation: string) => ({ revision: 'r1', value: operation === 'status-summary'
      ? { writeEnabled: false, memoryBodies: [], defaultRecallLimit: 12 }
      : operation === 'search' ? { results: [{ id: 'first', content: 'Related compatibility evidence', memoryCapabilities: { related: true } }], sources: [] }
      : [] }))
    render(<MemorySpacesSourcePage page="explore" sourceTypeId="memory-spaces" sourceInstanceKey="source:old-host" sourceInstances={[]} locale="en" management={{ sourceInstanceKey: 'source:old-host', revision: 'r1', read, mutate: vi.fn() }} />)
    fireEvent.change(await screen.findByRole('textbox', { name: t('search.queryAria') }), { target: { value: 'compatibility' } })
    fireEvent.click(screen.getByRole('button', { name: t('search.action') }))
    fireEvent.click(await screen.findByRole('button', { name: t('card.related') }))
    expect(await screen.findByText(t('search.noRelated'))).not.toBeNull()
    // The page looks at memory: its searches do not count as uses (#338).
    expect(read).toHaveBeenCalledWith('search', expect.objectContaining({ query: 'compatibility', inspect: true }))
    fireEvent.click(screen.getByRole('button', { name: t('search.closeRelated') }))
    expect(screen.queryByRole('heading', { name: t('search.related') })).toBeNull()
    // CI's packed-plugin job runs this in four parallel standalone installs, where it has taken 5-5.5 s.
  }, 15_000)

  it('runs the query it opens with, as a conversation turn sends it', async () => {
    const read = vi.fn(async (operation: string, input?: unknown) => ({ revision: 'r1', value: operation === 'status-summary'
      ? { writeEnabled: false, memoryBodies: [], defaultRecallLimit: 12 }
      : operation === 'search' ? { results: [{ id: 'first', content: `Recalled for ${(input as { query: string }).query}` }], sources: [] }
      : [] }))
    render(<MemorySpacesSourcePage page="explore" sourceTypeId="memory-spaces" sourceInstanceKey="source:turn" sourceInstances={[]} locale="en" navigationInput={{ seed: 'Consumers dedupe by event_id.', nonce: 1 }} management={{ sourceInstanceKey: 'source:turn', revision: 'r1', read, mutate: vi.fn() }} />)
    expect(await screen.findByText('Recalled for Consumers dedupe by event_id.')).not.toBeNull()
    expect((screen.getByRole('textbox', { name: t('search.queryAria') }) as HTMLInputElement).value).toBe('Consumers dedupe by event_id.')
    expect(read).toHaveBeenCalledWith('search', expect.objectContaining({ query: 'Consumers dedupe by event_id.', limit: 12 }))
  })

  // The status says whether DSH manages Mnemon Native's embedding settings; at their default no embedding service is set
  // up, so a memory without a vector gets a neutral note. A status from before the field keeps the caution.
  it.each([
    [false, 'receipt.unembeddedNoService', 'neutral'],
    [true, 'receipt.unembedded', 'caution'],
    [undefined, 'receipt.unembedded', 'caution'],
  ] as const)('words a memory saved without a vector by its status, through the task Agent and with constraints (managed: %s)', async (managed, key, tone) => {
    const space = { id: 'project', name: 'Project', active: true, provider: { id: 'mnemon-native', label: 'Mnemon Native', capabilities: { remember: true } } }
    const read = vi.fn(async (operation: string) => ({ revision: 'r1', value: operation === 'status-summary'
      ? { writeEnabled: true, memoryBodies: [space], defaultRecallLimit: 12, ...(managed === undefined ? {} : { embeddingManaged: managed }) }
      : [] }))
    let embedded = false
    const mutate = vi.fn(async () => ({ revision: 'r2', value: { action: 'added', id: 'm2', memoryBodyId: 'project', embedded } }))
    const execute = vi.fn(async () => ({ revision: 'r3', value: { delegated: true, summary: 'Saved to Project.', action: 'added', memoryBodyIds: ['project'], unembedded: [{ memoryBodyId: 'project', id: 'm1' }] } }))
    // Opened from the Recall page's header, which reads nothing else on its own.
    render(<MemorySpacesSourcePage page="explore" sourceTypeId="memory-spaces" sourceInstanceKey="source:remember" sourceInstances={[]} locale="en" writable
      management={{ sourceInstanceKey: 'source:remember', revision: 'r1', read, mutate, assistance: { operations: ['supervise'], execute } }} />)
    const open = await screen.findByRole('button', { name: 'Save to memory' }) as HTMLButtonElement
    await waitFor(() => expect(open.disabled).toBe(false))
    fireEvent.click(open)
    const note = () => screen.queryByText(t(key))
    const other = () => screen.queryByText(t(key === 'receipt.unembedded' ? 'receipt.unembeddedNoService' : 'receipt.unembedded'))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Content' }), { target: { value: 'Grafana on staging listens on port 3300.' } })
    const send = await screen.findByRole('button', { name: 'Save' }) as HTMLButtonElement
    await waitFor(() => expect(send.disabled).toBe(false))
    fireEvent.click(send)
    await screen.findByText('Saved to Project.')
    expect(note()?.getAttribute('data-tone')).toBe(tone)
    expect(other()).toBeNull()
    // With constraints, Mnemon Native's own receipt says embedded: false.
    fireEvent.change(screen.getByRole('textbox', { name: 'Content' }), { target: { value: 'Prometheus on staging listens on port 9090.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save with options' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('remember', expect.objectContaining({ content: 'Prometheus on staging listens on port 9090.', memoryBodyId: 'project' }), expect.anything()))
    await waitFor(() => expect(note()?.getAttribute('data-tone')).toBe(tone))
    expect(screen.queryByText('Saved to Project.')).toBeNull()
    expect(other()).toBeNull()
    // A memory saved with its vector says nothing about one.
    embedded = true
    fireEvent.change(screen.getByRole('textbox', { name: 'Content' }), { target: { value: 'Loki on staging listens on port 3100.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save with options' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    await screen.findByText(t('receipt.written'))
    expect(note()).toBeNull()
    expect(other()).toBeNull()
    // Three saves through the page: CI's packed-plugin job has taken more than 5 s for them, as for the case above.
  }, 15_000)

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

describe('Rediscover on the Memory Spaces page (#373)', () => {
  const directories: string[] = []
  afterEach(() => {
    globalThis.localStorage?.clear()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  type Namespace = { externalId: string; name: string }
  /** How the simulated Provider answers: as listed, with an error, or once the test lets it. */
  type Upstream = { error?: string; hold?: Promise<void> }

  /** A Provider whose namespaces the test grows, as someone working on the Provider side would. */
  function upstream(namespaces: Namespace[], behaviour: Upstream) {
    return defineMemorySpaceProvider<undefined>({ id: 'banks', apply(ctx, host) {
      host.install(ctx, {
        manifest: { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider', typeId: 'banks',
          packageName: 'dsh-mnemon-provider-banks-test', version: '1.0.0', label: 'Banks', summary: 'Simulated Provider; real Source.',
          origin: 'third-party', locality: 'remote', workspaceBinding: 'provider-global', fields: [], secrets: [], scoreSemantics: 'normalized-relevance',
          capabilities: descriptor.capabilities,
        },
        create: () => ({ id: 'banks', scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
          discover: async () => {
            if (behaviour.hold !== undefined) await behaviour.hold
            if (behaviour.error !== undefined) throw new Error(behaviour.error)
            return namespaces.map(namespace => ({ ...namespace, description: 'An upstream bank.', connection: {} }))
          },
          status: async () => ({ healthy: true }), list: async () => [], search: async () => ({ results: [] }),
          graph: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }), remember: async () => ({ action: 'stored' }),
        }),
      })
    } })
  }

  async function mounted(namespaces: Namespace[], behaviour: Upstream = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-rediscovery-page-'))
    directories.push(directory)
    const runner = new MemoryCompositionRunner()
    await runner.mount(strategy, { instanceId: 'strategy' })
    await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
      await installMemorySpaces(ctx, [{ instanceId: 'banks', module: upstream(namespaces, behaviour), config: undefined }], { config: { dataDir: directory } })
    } }, { instanceId: 'spaces' })
    const management = await runner.managementClient('source:spaces')
    await management.mutate('provider-service-update', { providerId: 'banks', settings: {}, enabled: true }, { confirmed: true })
    return { runner, management }
  }

  const page = (management: Awaited<ReturnType<typeof mounted>>['management'], writable = true) =>
    render(<MemorySpacesSourcePage page="spaces" sourceTypeId="memory-spaces" sourceInstanceKey="source:spaces" sourceInstances={[]} locale="en" writable={writable} management={management} />)
  /**
   * Each test renders the whole page. On a shared CI runner that installs every plugin on its own, one
   * such test has taken 5.5 seconds where it takes 0.3 s locally; the default 5 s limit is too tight.
   */
  const PAGE_TEST_TIMEOUT_MS = 15_000
  /** One card of the space directory, by the name it shows. */
  const card = (name: string) => [...document.querySelectorAll('article')].find(article => article.querySelector('strong')?.textContent === name)
  const shown = async (name: string, timeout?: number) => { await waitFor(() => expect(card(name)).toBeTruthy(), timeout === undefined ? undefined : { timeout }); return card(name)! }

  it('asks the Providers again, and says what it found until the news is dismissed', async () => {
    const namespaces = [{ externalId: 'alice', name: 'Alice' }]
    const { runner, management } = await mounted(namespaces)
    try {
      page(management)
      await shown('Alice')
      // Created on the Provider side after its settings were saved.
      namespaces.push({ externalId: 'research', name: 'Research' })
      fireEvent.click(screen.getByRole('button', { name: 'Rediscover' }))
      expect(await screen.findByText('New spaces found: 1. They join recall once you switch them on.')).toBeTruthy()
      await waitFor(async () => expect(within(await shown('Research')).getByText('New')).toBeTruthy())
      expect(within(card('Research')!).getByRole('switch').getAttribute('aria-checked')).toBe('false')
      expect(within(card('Alice')!).queryByText('New')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByText(/New spaces found/u)).toBeNull()
      expect(within(card('Research')!).queryByText('New')).toBeNull()
      // Asked again with nothing new, the page still answers.
      fireEvent.click(screen.getByRole('button', { name: 'Rediscover' }))
      expect(await screen.findByText('No new spaces.')).toBeTruthy()
    } finally {
      await runner.dispose()
    }
  }, PAGE_TEST_TIMEOUT_MS)

  it('shows what a pass the page did not start found, and why a Provider could not finish', async () => {
    const behaviour: Upstream = {}
    const namespaces = [{ externalId: 'alice', name: 'Alice' }]
    const { runner, management } = await mounted(namespaces, behaviour)
    try {
      behaviour.error = 'connect ECONNREFUSED 127.0.0.1:18889'
      // As the Host asks when it starts.
      await management.mutate('provider-rediscover', { trigger: 'startup' }, { confirmed: true })
      page(management)
      expect(await screen.findByText('Banks could not finish discovery: connect ECONNREFUSED 127.0.0.1:18889')).toBeTruthy()
      await shown('Alice')
    } finally {
      await runner.dispose()
    }
  }, PAGE_TEST_TIMEOUT_MS)

  it('follows a pass the Host is running when the page opens, and its switches keep working', async () => {
    let release!: () => void
    const behaviour: Upstream = {}
    const namespaces = [{ externalId: 'alice', name: 'Alice' }]
    const { runner, management } = await mounted(namespaces, behaviour)
    try {
      behaviour.hold = new Promise(resolve => { release = resolve })
      // The Host's start-up pass, still waiting for the Provider when the page opens.
      const startup = management.mutate('provider-rediscover', { trigger: 'startup' }, { confirmed: true })
      page(management)
      await shown('Alice')
      const button = await screen.findByRole('button', { name: 'Rediscovering…' })
      expect(button.getAttribute('aria-busy')).toBe('true')
      expect(button.hasAttribute('disabled')).toBe(false)

      namespaces.push({ externalId: 'research', name: 'Research' })
      release()
      await startup
      // The page looks again on its own and shows what the pass found.
      expect(await screen.findByText('New spaces found: 1. They join recall once you switch them on.', undefined, { timeout: 6_000 })).toBeTruthy()
      expect(within(await shown('Research')).getByText('New')).toBeTruthy()
      await screen.findByRole('button', { name: 'Rediscover' })
      // The directory changed under the page; a switch still answers instead of failing on a stale revision.
      fireEvent.click(within(card('Research')!).getByRole('switch'))
      await waitFor(() => expect(within(card('Research')!).getByRole('switch').getAttribute('aria-checked')).toBe('true'))
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      await runner.dispose()
    }
  }, PAGE_TEST_TIMEOUT_MS)

  it('offers no rediscovery on a read-only page', async () => {
    const { runner, management } = await mounted([{ externalId: 'alice', name: 'Alice' }])
    try {
      page(management, false)
      await shown('Alice')
      expect(screen.queryByRole('button', { name: 'Rediscover' })).toBeNull()
    } finally {
      await runner.dispose()
    }
  }, PAGE_TEST_TIMEOUT_MS)
})

describe('Entities page', { timeout: 30_000 }, () => {
  // CI's packed-plugin job runs these tests in four parallel standalone installs, where this suite
  // measured 13 times slower than in the workspace (40.5 s against 3.1 s). Allow for that load.
  beforeAll(() => configure({ asyncUtilTimeout: 5_000 }))
  afterAll(() => configure({ asyncUtilTimeout: 1_000 }))
  // The choice to find related memories lasts a browser session; each test starts collapsed.
  afterEach(() => sessionStorage.clear())

  /** The Source's own copy first, then the Core's, as the page resolves it. */
  function t(key: string, params: Record<string, unknown> = {}): string {
    const own = (copy.en as Record<string, string>)[key]
    const text = own ?? translateEn(key as Parameters<typeof translateEn>[0], params)
    return own === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
  }

  const CAPABILITIES = { search: true, browse: true, graph: true, entities: true, related: true, remember: true, link: true, forget: true, writeMode: 'exact', deletionMode: 'soft' } as const
  const SPACE = {
    id: 'work', name: 'Work', description: 'Project memory', active: true, providerEnabled: true, dbPath: '', mnemonDefault: true, healthy: false, statusLoading: true,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    provider: { id: 'mnemon-native', label: 'Mnemon Native', kind: 'local', location: '', apiKeyConfigured: false, settings: {}, configuredSecrets: [], capabilities: CAPABILITIES },
  }
  const SOURCE = { memoryBodyId: 'work', memoryBodyName: 'Work', providerId: 'mnemon-native', providerLabel: 'Mnemon Native', mode: 'entities', status: 'ready', itemCount: 2, memoryCount: 70, complete: true } as const

  function memory(id: string, content: string): Insight {
    return { id, content, importance: 3, entities: ['Atlas'], memoryBodyId: 'work', memoryBodyName: 'Work', memoryProviderId: 'mnemon-native', memoryProviderLabel: 'Mnemon Native', memoryCapabilities: CAPABILITIES }
  }
  const atlas = Array.from({ length: 60 }, (_, index) => memory(`a${index + 1}`, `Atlas memory ${index + 1}`))
  const rail: EntityView = { items: [{ entity: 'Atlas', count: 60 }, { entity: 'SQLite', count: 2 }], insights: [], total: 2, complete: true, sources: [SOURCE] }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }

  type Handler = (input: Record<string, unknown>) => unknown | Promise<unknown>
  function page(handlers: Partial<Record<string, Handler>>, options: { writable?: boolean } = {}) {
    const read = vi.fn(async (operation: string, input?: unknown) => {
      const handler = handlers[operation]
      const value = handler !== undefined ? await handler((input ?? {}) as Record<string, unknown>)
        : operation === 'status-summary' ? { writeEnabled: false, memoryBodies: [], defaultRecallLimit: 12 }
        : operation === 'body-directory' ? { items: [SPACE], providers: [], total: 1, activeCount: 1, directory: '/data', generatedAt: 'now' }
        : operation === 'entities' ? rail
        : operation === 'entity-memories' ? memoriesPage(input as Record<string, unknown>)
        : operation === 'entity-related' ? { entity: 'Atlas', items: [], sources: [] }
        : []
      return { revision: 'r1', value: value as never }
    })
    const mutate = vi.fn(async () => ({ revision: 'r2', value: {} as never }))
    render(<MemorySpacesSourcePage page="entities" sourceTypeId="memory-spaces" sourceInstanceKey="source:spaces" sourceInstances={[]} locale="en" writable={options.writable === true} management={{ sourceInstanceKey: 'source:spaces', revision: 'r1', read, mutate }} />)
    return read
  }

  function memoriesPage(input: Record<string, unknown>): EntityMemoriesView {
    const offset = Number(input.offset ?? 0)
    const limit = Number(input.limit ?? 48)
    const items = input.entity === 'SQLite' ? [memory('s1', 'SQLite memory 1'), memory('s2', 'SQLite memory 2')] : input.entity === 'Atlas' ? atlas : []
    return { entity: String(input.entity), total: items.length, offset, items: items.slice(offset, offset + limit), complete: true, sources: [SOURCE] }
  }

  const skeletons = (container: ParentNode) => container.querySelectorAll('[data-placeholder]').length
  const relatedReads = (read: ReturnType<typeof page>) => read.mock.calls.filter(([operation]) => operation === 'entity-related')
  const findRelated = () => screen.getByRole('button', { name: t('entities.findRelated') })

  it('lists every memory that carries the selected entity, and finds related memories only when asked', async () => {
    const related: EntityRelatedView = { entity: 'Atlas', items: [memory('r1', 'Release checklist mentions Atlas')], sources: [SOURCE] }
    const read = page({ 'entity-related': () => related })
    fireEvent.click(await screen.findByRole('button', { name: /^Atlas/u }))
    // The count shows at once from the rail, the same number the list then has.
    const heading = await screen.findByRole('heading', { name: 'Atlas', level: 3 })
    expect(within(heading.closest('div')!.parentElement!).getByText('60')).not.toBeNull()
    expect(await screen.findByText('Atlas memory 1')).not.toBeNull()
    expect(screen.queryByText('Atlas memory 7')).toBeNull()
    expect(screen.getByText(t('common.showing', { visible: 6, total: 60 }))).not.toBeNull()
    expect(screen.getByText(t('entities.sourceReady', { count: 2 }))).not.toBeNull()
    expect(read).toHaveBeenCalledWith('entity-memories', { entity: 'Atlas', offset: 0, limit: 48 })
    // Related memories stay collapsed and cost no recall until asked for.
    expect(screen.getByRole('heading', { name: t('entities.relatedTitle'), level: 3 })).not.toBeNull()
    expect(findRelated().getAttribute('aria-expanded')).toBe('false')
    expect(relatedReads(read)).toHaveLength(0)
    fireEvent.click(findRelated())
    expect(await screen.findByText('Release checklist mentions Atlas')).not.toBeNull()
    expect(read).toHaveBeenCalledWith('entity-related', { entity: 'Atlas', limit: 20, view: expect.any(String) })
    const hide = screen.getByRole('button', { name: t('entities.hideRelated') })
    expect(hide.getAttribute('aria-expanded')).toBe('true')
    // Hiding and opening again shows what was found, without another recall.
    fireEvent.click(hide)
    expect(screen.queryByText('Release checklist mentions Atlas')).toBeNull()
    fireEvent.click(findRelated())
    expect(await screen.findByText('Release checklist mentions Atlas')).not.toBeNull()
    expect(relatedReads(read)).toHaveLength(1)
  })

  it('remembers the choice to find related memories for the next entity until it is hidden', async () => {
    const read = page({ 'entity-related': input => ({ entity: String(input.entity), items: [memory(`r-${String(input.entity)}`, `Related to ${String(input.entity)}`)], sources: [] }) })
    fireEvent.click(await screen.findByRole('button', { name: /^Atlas/u }))
    await screen.findByText('Atlas memory 1')
    fireEvent.click(findRelated())
    expect(await screen.findByText('Related to Atlas')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^SQLite/u }))
    expect(await screen.findByText('Related to SQLite')).not.toBeNull()
    expect(relatedReads(read)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: t('entities.hideRelated') }))
    fireEvent.click(screen.getByRole('button', { name: /^Atlas/u }))
    await screen.findByText('Atlas memory 1')
    expect(findRelated().getAttribute('aria-expanded')).toBe('false')
    expect(relatedReads(read)).toHaveLength(2)
  })

  it('finds related memories at once when no memory carries the name', async () => {
    const read = page({ 'entity-related': () => ({ entity: 'Gateway', items: [memory('g1', 'The gateway fronts every Atlas call')], sources: [] }) })
    const input = await screen.findByRole('textbox', { name: t('entities.nameAria') })
    fireEvent.change(input, { target: { value: 'Gateway' } })
    fireEvent.click(screen.getByRole('button', { name: t('entities.action') }))
    expect(await screen.findByText(t('entities.noCarrying'))).not.toBeNull()
    expect(await screen.findByText('The gateway fronts every Atlas call')).not.toBeNull()
    expect(relatedReads(read)).toHaveLength(1)
    // With related memories as the only content, there is nothing to collapse.
    expect(screen.queryByRole('button', { name: t('entities.hideRelated') })).toBeNull()
  })

  it('drops a forgotten memory at once and keeps the rest in place until the refresh replaces them', async () => {
    const gateway = [memory('g1', 'The gateway fronts every Atlas call'), memory('g2', 'The gateway logs every request')]
    const again = deferred<EntityRelatedView>()
    let attempts = 0
    const read = page({
      'status-summary': () => ({ writeEnabled: true, memoryBodies: [], defaultRecallLimit: 12 }),
      'entity-related': () => (attempts += 1) === 1 ? { entity: 'Gateway', items: gateway, sources: [] } : again.promise,
    }, { writable: true })
    fireEvent.change(await screen.findByRole('textbox', { name: t('entities.nameAria') }), { target: { value: 'Gateway' } })
    fireEvent.click(screen.getByRole('button', { name: t('entities.action') }))
    const forgotten = await screen.findByText('The gateway logs every request')
    fireEvent.click(within(forgotten.closest('article')!).getByRole('button', { name: t('card.forget') }))
    fireEvent.click(await screen.findByRole('button', { name: t('card.confirmForget') }))
    await waitFor(() => expect(screen.queryByText('The gateway logs every request')).toBeNull())
    // The refresh reads related memories again; the one left stays shown while it waits.
    await waitFor(() => expect(relatedReads(read)).toHaveLength(2))
    expect(screen.getByText('The gateway fronts every Atlas call')).not.toBeNull()
    again.resolve({ entity: 'Gateway', items: [gateway[0]!], sources: [] })
    const results = screen.getByRole('region', { name: t('entities.relatedTitle') }).closest('section')!
    await waitFor(() => expect(results.getAttribute('aria-busy')).toBeNull())
    expect(screen.getByText('The gateway fronts every Atlas call')).not.toBeNull()
  })

  it('shows the spaces from the directory before their entity indexes arrive', async () => {
    const pending = deferred<EntityView>()
    page({ entities: () => pending.promise })
    expect(await screen.findByText('Work')).not.toBeNull()
    expect(screen.getByText(t('readSources.status.loading'))).not.toBeNull()
    pending.resolve(rail)
    expect(await screen.findByText(t('entities.sourceReady', { count: 2 }))).not.toBeNull()
  })

  it('keeps the latest selection when an earlier read answers late', async () => {
    const late = deferred<EntityMemoriesView>()
    page({ 'entity-memories': input => input.entity === 'Atlas' ? late.promise : memoriesPage(input) })
    fireEvent.click(await screen.findByRole('button', { name: /^Atlas/u }))
    fireEvent.click(screen.getByRole('button', { name: /^SQLite/u }))
    expect(await screen.findByText('SQLite memory 1')).not.toBeNull()
    late.resolve(memoriesPage({ entity: 'Atlas', offset: 0, limit: 48 }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.queryByText('Atlas memory 1')).toBeNull()
    expect(screen.getByRole('heading', { name: 'SQLite', level: 3 })).not.toBeNull()
  })

  it('loads the next page only when the revealed list reaches the memories already read', async () => {
    // A Host may answer with fewer memories than asked for; the page reads on from where it is.
    const read = page({ 'entity-memories': input => memoriesPage({ ...input, limit: Math.min(Number(input.limit ?? 48), 12) }) })
    fireEvent.click(await screen.findByRole('button', { name: /^Atlas/u }))
    await screen.findByText('Atlas memory 6')
    fireEvent.click(screen.getByRole('button', { name: t('common.showMore', { count: 6 }) }))
    expect(await screen.findByText('Atlas memory 12')).not.toBeNull()
    expect(read.mock.calls.filter(([operation]) => operation === 'entity-memories')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: t('common.showMore', { count: 6 }) }))
    expect(await screen.findByText('Atlas memory 18')).not.toBeNull()
    expect(read).toHaveBeenCalledWith('entity-memories', { entity: 'Atlas', offset: 12, limit: 48 })
    expect(screen.getByText(t('common.showing', { visible: 18, total: 60 }))).not.toBeNull()
  })

  it('shows placeholders only for a read that takes a while', async () => {
    const slow = deferred<EntityMemoriesView>()
    const related = deferred<EntityRelatedView>()
    page({ 'entity-memories': () => slow.promise, 'entity-related': () => related.promise })
    fireEvent.click(await screen.findByRole('button', { name: /^Atlas/u }))
    const section = screen.getByRole('heading', { name: 'Atlas', level: 3 }).closest('section')!
    expect(skeletons(section)).toBe(0)
    await waitFor(() => expect(skeletons(section)).toBeGreaterThan(0), { timeout: 1_000 })
    slow.resolve(memoriesPage({ entity: 'Atlas', offset: 0, limit: 48 }))
    related.resolve({ entity: 'Atlas', items: [], sources: [] })
    expect(await screen.findByText('Atlas memory 1')).not.toBeNull()
    await waitFor(() => expect(skeletons(section)).toBe(0))
  })

  it('retries a failed related read without dropping the memories already shown', async () => {
    let attempts = 0
    page({ 'entity-related': () => {
      attempts += 1
      if (attempts === 1) throw new Error('recall timed out')
      return { entity: 'Atlas', items: [memory('r1', 'Recovered related memory')], sources: [] }
    } })
    fireEvent.click(await screen.findByRole('button', { name: /^Atlas/u }))
    await screen.findByText('Atlas memory 1')
    fireEvent.click(findRelated())
    expect(await screen.findByText('recall timed out')).not.toBeNull()
    expect(screen.getByText('Atlas memory 1')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('entities.retry') }))
    expect(await screen.findByText('Recovered related memory')).not.toBeNull()
    expect(screen.getByText('Atlas memory 1')).not.toBeNull()
  })
})

describe('OverviewPage & MemoryGraph performance guardrails', () => {
  it('renders MemoryGraph on mount in a single frame without scheduling requestAnimationFrame clones', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    try {
      const graph = {
        generatedAt: '2026-10-20T00:00:00.000Z',
        nodes: [
          { id: 'space:work', kind: 'space' as const, category: 'space', content: 'Work', color: '#4f46e5' },
          { id: 'entity:atlas', kind: 'entity' as const, category: 'entity', content: 'Atlas', color: '#0ea5e9' },
          { id: 'mem-1', kind: 'memory' as const, category: 'architecture', content: 'Gateway fronts Atlas', color: '#10b981' },
        ],
        edges: [
          { sourceId: 'space:work', targetId: 'entity:atlas', label: 'scope', color: '#708199', type: 'scope' as const },
          { sourceId: 'entity:atlas', targetId: 'mem-1', label: 'entity', color: '#38bdf8', type: 'entity' as const },
        ],
      }
      render(<MemorySourcePageFrame locale="en"><MemoryGraph graph={graph} onSelect={vi.fn()} /></MemorySourcePageFrame>)
      expect(screen.getByText('Atlas')).not.toBeNull()
      expect(rafSpy).not.toHaveBeenCalled()
    } finally {
      rafSpy.mockRestore()
    }
  })

  it('isolates relative sync freshness ticks in SyncFreshnessText without re-rendering siblings', () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-10-20T12:00:00.000Z').getTime()
      vi.setSystemTime(now)
      let siblingRenders = 0
      function Sibling(): null {
        siblingRenders += 1
        return null
      }
      const syncedAt = now - 4_000
      const { container } = render(
        <MemorySourcePageFrame locale="en">
          <div><SyncFreshnessText lastFullSyncAt={syncedAt} /><Sibling /></div>
        </MemorySourcePageFrame>,
      )
      expect(siblingRenders).toBe(1)
      expect(container.textContent).toMatch(/just now/i)

      vi.advanceTimersByTime(2_000)
      expect(siblingRenders).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses parent refreshKey echoes when toggling Active on MemorySpacesSourcePage', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-echo-'))
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: provider, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'spaces' })
      const management = await runner.managementClient('source:spaces')
      await management.mutate('provider-service-update', { providerId: 'account', settings: {}, enabled: true }, { confirmed: true })
      await management.mutate('body-create', { name: 'Alpha', description: 'Primary space', providerId: 'account' }, { confirmed: true })
      const readSpy = vi.spyOn(management, 'read')

      let refreshKey = 0
      const baseProps = {
        page: 'spaces' as const,
        sourceTypeId: 'memory-spaces',
        sourceInstanceKey: 'source:spaces',
        sourceInstances: [],
        locale: 'en',
        writable: true,
        management,
      }
      let view!: ReturnType<typeof render>
      const onRefresh = () => {
        refreshKey += 1
        view.rerender(<MemorySpacesSourcePage {...baseProps} refreshKey={refreshKey} onRefresh={onRefresh} />)
      }
      view = render(<MemorySpacesSourcePage {...baseProps} refreshKey={refreshKey} onRefresh={onRefresh} />)
      const alphaCard = () => [...document.querySelectorAll('article')].find(article => article.querySelector('strong')?.textContent === 'Alpha')
      await waitFor(() => expect(alphaCard()).toBeTruthy())
      await waitFor(() => expect(within(alphaCard()!).getByRole('switch').getAttribute('aria-checked')).toBe('false'))

      readSpy.mockClear()
      fireEvent.click(within(alphaCard()!).getByRole('switch'))
      await waitFor(() => expect(within(alphaCard()!).getByRole('switch').getAttribute('aria-checked')).toBe('true'))
      const directoryReads = readSpy.mock.calls.filter(([operation]) => operation === 'body-directory').length
      const statusReads = readSpy.mock.calls.filter(([operation]) => operation === 'status-summary').length
      expect(directoryReads).toBe(1)
      expect(statusReads).toBe(1)

      // Sub-navigation tablist supports WAI-ARIA roving tabindex and keyboard navigation.
      const tablist = screen.getByRole('tablist')
      const tabs = within(tablist).getAllByRole('tab')
      expect(tabs.map(tab => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1'])
      fireEvent.keyDown(tablist, { key: 'End' })
      expect(within(tablist).getAllByRole('tab').map(tab => tab.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1', '0'])
      fireEvent.keyDown(tablist, { key: 'ArrowLeft' })
      expect(within(tablist).getAllByRole('tab').map(tab => tab.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1'])

      // Clearing the Content filter immediately triggers an unfiltered list reload.
      await waitFor(() => expect(screen.getByPlaceholderText('Filter content or ID…')).toBeTruthy())
      const filterInput = screen.getByPlaceholderText('Filter content or ID…')
      fireEvent.change(filterInput, { target: { value: 'missing-query' } })
      fireEvent.submit(filterInput.closest('form')!)
      await waitFor(() => expect(readSpy.mock.calls.some(([op, input]) => op === 'list' && (input as { query?: string })?.query === 'missing-query')).toBe(true))
      readSpy.mockClear()
      fireEvent.change(filterInput, { target: { value: '' } })
      await waitFor(() => expect(readSpy.mock.calls.some(([op, input]) => op === 'list' && (input as { query?: string })?.query === undefined)).toBe(true))
    } finally {
      cleanup()
      await runner.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('Settings deep-linking, error banner placement, and reduced-motion polish', { timeout: 20_000 }, () => {
  it.each([true, false])('keeps Space policy editable with a generic callback (migrated section supported=%s)', async supported => {
    settingsSupport.mockReturnValue(supported)
    const nativeProvider = {
      ...descriptor,
      id: 'mnemon-native',
      label: 'Mnemon Native',
      origin: 'native' as const,
      kind: 'local' as const,
      serviceConfigured: true,
    }
    const catalog = { items: [], providers: [nativeProvider], total: 0, activeCount: 0, directory: '/data', generatedAt: 'now' }
    const read = vi.fn(async (operation: string) => ({
      revision: 'r1',
      value: (operation === 'status-summary'
        ? { writeEnabled: true, memoryBodies: [], defaultRecallLimit: 10 }
        : operation === 'body-directory' || operation === 'bodies'
          ? catalog
          : operation === 'graph'
            ? { nodes: [], edges: [], generatedAt: 'now' }
            : []) as never,
    }))
    const onOpenSettings = vi.fn()
    const replace = vi.fn(async () => {})
    const management = { sourceInstanceKey: 'source:policy-link', revision: 'r1', read, mutate: vi.fn() }

    const view = render(
      <MemorySpacesSourcePage
        page="spaces"
        sourceTypeId="memory-spaces"
        sourceInstanceKey="source:policy-link"
        sourceInstances={[]}
        locale="en"
        writable
        onOpenSettings={onOpenSettings}
        preferences={{ value: {}, writable: true, replace }}
        management={management}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: t('strategy.action') }))
    if (supported) {
      expect(onOpenSettings).toHaveBeenCalledWith('policy')
      expect(screen.queryByRole('dialog', { name: t('strategy.title') })).toBeNull()

      view.rerender(
        <MemorySpacesSourcePage
          page="spaces"
          sourceTypeId="memory-spaces"
          sourceInstanceKey="source:policy-fallback"
          sourceInstances={[]}
          locale="en"
          writable
          preferences={{ value: {}, writable: true, replace }}
          management={{ ...management, sourceInstanceKey: 'source:policy-fallback' }}
        />,
      )

      fireEvent.click(await screen.findByRole('button', { name: t('strategy.action') }))
    } else {
      expect(onOpenSettings).not.toHaveBeenCalled()
    }
    const dialog = await screen.findByRole('dialog', { name: t('strategy.title') })
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /Smart selection/u })).toBeTruthy())
    fireEvent.click(within(dialog).getByRole('radio', { name: /Smart selection/u }))
    fireEvent.click(within(dialog).getByRole('button', { name: t('strategy.save') }))

    await waitFor(() => expect(replace).toHaveBeenCalledWith({
      persistenceStrategy: expect.objectContaining({ mode: 'automatic', providerId: 'mnemon-native' }),
    }))
  })

  it('deep-links unconfigured Providers from Create Memory Space dialog to onOpenSettings("providers")', async () => {
    const providers = [
      { ...descriptor, id: 'mnemon-native', label: 'Mnemon Native', origin: 'native' as const, kind: 'local' as const, serviceConfigured: true },
      { ...descriptor, id: 'openviking', label: 'OpenViking', origin: 'third-party' as const, kind: 'remote' as const, serviceConfigured: false },
    ]
    const catalog = { items: [], providers, total: 0, activeCount: 0, directory: '/data', generatedAt: 'now' }
    const read = vi.fn(async (operation: string) => ({
      revision: 'r1',
      value: (operation === 'status-summary'
        ? { writeEnabled: true, memoryBodies: [], defaultRecallLimit: 10 }
        : operation === 'body-directory' || operation === 'bodies'
          ? catalog
          : operation === 'graph'
            ? { nodes: [], edges: [], generatedAt: 'now' }
            : []) as never,
    }))
    const onOpenSettings = vi.fn()
    render(
      <MemorySpacesSourcePage
        page="spaces"
        sourceTypeId="memory-spaces"
        sourceInstanceKey="source:create-link"
        sourceInstances={[]}
        locale="en"
        writable
        onOpenSettings={onOpenSettings}
        management={{ sourceInstanceKey: 'source:create-link', revision: 'r1', read, mutate: vi.fn() }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: t('overview.newAction') }))
    const dialog = await screen.findByRole('dialog', { name: t('overview.createTitle') })
    expect(within(dialog).getByText(t('overview.providerEnableHint'))).toBeTruthy()
    const openProviders = within(dialog).getByRole('button', { name: t('overview.openProvidersSettings') })
    fireEvent.click(openProviders)

    expect(onOpenSettings).toHaveBeenCalledWith('providers')
    expect(screen.queryByRole('dialog', { name: t('overview.createTitle') })).toBeNull()
  })

  it('renders top-level workspace error alerts below the sticky memoryWorkspace header', async () => {
    const read = vi.fn(async (operation: string) => {
      if (operation === 'status-summary') throw new Error('workspace offline')
      return { revision: 'r1', value: [] }
    })
    render(
      <MemorySpacesSourcePage
        page="explore"
        sourceTypeId="memory-spaces"
        sourceInstanceKey="source:error-order"
        sourceInstances={[]}
        locale="en"
        management={{ sourceInstanceKey: 'source:error-order', revision: 'r1', read, mutate: vi.fn() }}
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('workspace offline')
    const workspaceSection = screen.getByRole('tablist', { name: t('nav.memory.aria') }).closest('section')!
    expect((workspaceSection.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
  })

  it('skips requestAnimationFrame camera tweening in MemoryGraph when prefers-reduced-motion: reduce is active', () => {
    const originalMatchMedia = window.matchMedia
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    try {
      const graph = {
        generatedAt: '2026-10-20T00:00:00.000Z',
        nodes: [
          { id: 'space:work', kind: 'space' as const, category: 'space', content: 'Work', color: '#4f46e5' },
          { id: 'entity:atlas', kind: 'entity' as const, category: 'entity', content: 'Atlas', color: '#0ea5e9' },
        ],
        edges: [
          { sourceId: 'space:work', targetId: 'entity:atlas', label: 'scope', color: '#708199', type: 'scope' as const },
        ],
      }
      render(<MemorySourcePageFrame locale="en"><MemoryGraph graph={graph} onSelect={vi.fn()} /></MemorySourcePageFrame>)
      rafSpy.mockClear()
      fireEvent.click(screen.getByRole('button', { name: t('graph.uniformAction') }))
      expect(screen.getByRole('img').getAttribute('data-layout')).toBe('uniform')
      expect(rafSpy).not.toHaveBeenCalled()
    } finally {
      rafSpy.mockRestore()
      window.matchMedia = originalMatchMedia
    }
  })
})
