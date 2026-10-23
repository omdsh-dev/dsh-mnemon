import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { installMemorySpaces } from '../src/index.ts'
import { defineMemorySpaceProviderDefinition, MEMORY_SPACE_PROVIDER_API_VERSION } from '../src/provider-sdk.ts'
import type { MemoryProviderViewResult, MemorySpaceCatalog } from '../src/contracts.ts'
import { createProviderProfile, readOnlyView } from '../src/providers/profile.ts'
import { strategy } from './fixture.ts'
import { bankProvider, capabilities, fields } from './bank-provider.ts'
import { SHELF_VIEWS, shelfProvider } from './shelf-provider.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const VIEWS = SHELF_VIEWS

async function mount(module: ReturnType<typeof shelfProvider>['module'] | ReturnType<typeof bankProvider>['module'], providerId: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mnemon-provider-views-'))
  directories.push(directory)
  const runner = new MemoryCompositionRunner()
  await runner.mount(strategy, { instanceId: 'strategy' })
  await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
    await installMemorySpaces(ctx, [{ instanceId: providerId, module, config: undefined }], { config: { dataDir: directory } })
  } }, { instanceId: 'spaces' })
  const client = await runner.managementClient('source:spaces', { storage: 'custom' })
  await client.mutate('provider-service-update', { providerId, settings: {}, enabled: true }, { confirmed: true })
  const catalog = (await client.read('body-directory')).value as unknown as MemorySpaceCatalog
  return { runner, client, catalog, space: catalog.items.find(item => item.provider.id === providerId)! }
}

describe('Provider views on the Memory Spaces page', () => {
  it('serves a declared view through the Source, in the declared shapes and bounded', async () => {
    const entries = Array.from({ length: 600 }, (_, index) => ({ uri: `shelf://main/${index}`, name: `item ${index}`, directory: false, size: index, secret: 'x' }))
    const { module, lent } = shelfProvider(() => ({ kind: 'entries', uri: 'shelf://main', entries }) as MemoryProviderViewResult)
    const f = await mount(module, 'shelf')
    try {
      expect(f.catalog.providers.find(provider => provider.id === 'shelf')?.views).toEqual(VIEWS)
      const view = (await f.client.read('provider-view', { memoryBodyId: f.space.id, view: 'shelf' })).value as unknown as MemoryProviderViewResult
      expect(view).toMatchObject({ kind: 'entries', uri: 'shelf://main', truncated: true })
      if (view.kind !== 'entries') throw new Error('entries expected')
      expect(view.entries).toHaveLength(500)
      expect(view.entries[1]).toEqual({ uri: 'shelf://main/1', name: 'item 1', directory: false, size: 1 })
      await expect(f.client.read('provider-view', { memoryBodyId: f.space.id, view: 'elsewhere' })).rejects.toThrow('Shelf fixture has no view "elsewhere"')
      await expect(f.client.read('provider-view', { memoryBodyId: 'missing', view: 'shelf' })).rejects.toThrow('unknown memory space: missing')
      // The Provider runtime was lent a read-only profile.
      expect(lent.some(profile => typeof profile?.service === 'function' && typeof profile.rows === 'function')).toBe(true)
    } finally { await f.runner.dispose() }
  })

  it('passes images only as png, jpeg, gif or webp data URLs, and text up to its bound', async () => {
    const script = { kind: 'file', uri: 'shelf://main/a.svg', name: 'a.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', text: 'x'.repeat(70_000) } as MemoryProviderViewResult
    const f = await mount(shelfProvider(() => script).module, 'shelf')
    try {
      const view = (await f.client.read('provider-view', { memoryBodyId: f.space.id, view: 'shelf' })).value as unknown as Record<string, unknown>
      expect(view).not.toHaveProperty('dataUrl')
      expect(String(view.text)).toHaveLength(64_000)
      expect(view.truncated).toBe(true)
    } finally { await f.runner.dispose() }
  })

  it('shows what a Provider says of a vendor plugin by named fields, at most six notes of 300 characters', async () => {
    const notes = Array.from({ length: 8 }, (_, index) => ({ id: `note-${index}`, tone: index === 0 ? 'caution' as const : 'info' as const, text: 'n'.repeat(400) }))
    const integration = { packageName: '@vendor/dsh-plugin', label: 'Vendor', version: '1.2.3', automation: { autoCapture: true, extra: 1 },
      endpoint: 'http://127.0.0.1:1', sameNamespace: true, state: 'active' as const, notes, apiKey: 'synthetic-only-key' }
    const f = await mount(shelfProvider(() => ({ kind: 'changes', changes: [] }), integration as never).module, 'shelf')
    try {
      const space = ((await f.client.read('bodies')).value as unknown as MemorySpaceCatalog).items.find(item => item.id === f.space.id)!
      expect(space.integration).toEqual({ packageName: '@vendor/dsh-plugin', label: 'Vendor', version: '1.2.3', automation: { autoCapture: true },
        endpoint: 'http://127.0.0.1:1', sameNamespace: true, state: 'active',
        notes: notes.slice(0, 6).map(note => ({ ...note, text: 'n'.repeat(300) })) })
      expect(JSON.stringify(space)).not.toContain('synthetic-only-key')
    } finally { await f.runner.dispose() }
  })

  it('leaves a Provider that declares no views as it was: no views, no integration, no view read', async () => {
    const f = await mount(bankProvider({ legacy: [] }).module, 'bank')
    try {
      expect(f.catalog.providers.find(provider => provider.id === 'bank')).not.toHaveProperty('views')
      const items = ((await f.client.read('bodies')).value as unknown as MemorySpaceCatalog).items
      for (const item of items) expect(item).not.toHaveProperty('integration')
      await expect(f.client.read('provider-view', { memoryBodyId: items[0]!.id, view: 'shelf' })).rejects.toThrow('has no view')
    } finally { await f.runner.dispose() }
  })

  it('refuses views it cannot draw where the Provider is defined', () => {
    const base = { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider' as const, typeId: 'shelf', packageName: 'p', version: '1.0.0', label: 'L', summary: 'S',
      origin: 'third-party' as const, locality: 'remote' as const, workspaceBinding: 'provider-global' as const, fields, secrets: [], scoreSemantics: 'none' as const, capabilities }
    const create = () => { throw new Error('unused') }
    expect(() => defineMemorySpaceProviderDefinition({ manifest: { ...base, views: [VIEWS[0]!, VIEWS[0]!] }, create })).toThrow('duplicate Memory Space Provider view: shelf')
    expect(() => defineMemorySpaceProviderDefinition({ manifest: { ...base, views: [{ id: 'graph', kind: 'graph' as never, label: 'G' }] }, create })).toThrow('unsupported Memory Space Provider view kind: graph')
  })
})

describe('The profile a Provider may read', () => {
  it('lends services read only: properties read, nothing called or changed', () => {
    const service = { config: { autoCapture: true, nested: { user: 'alice' } }, capture() { throw new Error('called') } }
    const view = readOnlyView(service)
    expect(view.config.nested.user).toBe('alice')
    expect(() => view.capture()).toThrow('read only')
    expect(Reflect.set(view.config, 'autoCapture', false)).toBe(false)
    expect(service.config.autoCapture).toBe(true)
  })

  it('lists the plugin rows without values under secret-looking keys or js expressions', () => {
    const ctx = new Context()
    const entries = [
      { id: 'mem0', disabled: false, fiber: { state: 2 }, options: { id: 'mem0', name: '@mem0/deepseek-plugin', config: { userId: 'alice', apiKey: 'k', autoCapture: false, nested: { token: 't', host: 'h' } } } },
      { id: 'agentmemory', disabled: true, options: { id: 'agentmemory', name: '@deepseek-ai/dsh-mcp-client', config: { env: { AGENTMEMORY_SECRET: { __jsExpr: 'process.env.X' }, AGENTMEMORY_URL: { __jsExpr: 'u' } }, command: 'npx' } } },
    ]
    ctx.provide('loader', { entries: () => entries })
    const rows = createProviderProfile(ctx).rows()
    expect(rows).toEqual([
      { id: 'mem0', packageName: '@mem0/deepseek-plugin', disabled: false, running: true, config: { userId: 'alice', autoCapture: false, nested: { host: 'h' } } },
      { id: 'agentmemory', packageName: '@deepseek-ai/dsh-mcp-client', disabled: true, running: false, config: { env: {}, command: 'npx' } },
    ])
    expect(createProviderProfile(ctx).service('openvikingMemory')).toBeUndefined()
  })
})
