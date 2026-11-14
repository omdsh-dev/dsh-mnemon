import { describe, expect, it, vi } from 'vitest'
import type { MnemonClient } from '../src/client/api.ts'
import { describeChange } from '../src/client/component-feedback.ts'
import { createComponentHosts } from '../src/client/component-host.ts'
import { componentModel, conflicts, enhancementApplies, mainPlan, sourceOf, switchPlan, unmetRequirements, type SwitchPlan } from '../src/client/component-model.ts'
import { MEMORY_SPACES_PACKAGE, RUNTIME_PACKAGE } from '../src/client/component-settings.tsx'
import { translateEn } from '../src/client/locales.ts'
import { createMemorySourcePageClient } from '../src/client/page-client.tsx'
import { MnemonViewStore } from '../src/client/view-store.ts'
import type { Config } from '../src/host/config.ts'
import type { ClientConnectionHandle } from '../src/host/dsh.ts'
import type { MemoryPluginEntryView, MemoryViewConfigurationRequest, MemoryViewDashboard } from '../src/host/view-protocol.ts'
import { liveSettingsScope, settingsScope } from './helpers/settings-scope.ts'

describe('component model and switch planning', () => {
  function entry(entryId: string, roles: MemoryPluginEntryView['roles'], overrides: Partial<MemoryPluginEntryView> = {}): MemoryPluginEntryView {
    return {
      entryId, packageName: 'dsh-mnemon-' + entryId, roles, label: { en: entryId, 'zh-CN': entryId }, description: { en: '', 'zh-CN': '' },
      fields: [], provides: [], requires: [], requiredBy: [], enabled: true, active: true, writable: true, config: {}, ...overrides,
    }
  }

  function dashboard(entries: MemoryPluginEntryView[], strategyTypeId = 'default-three-tier'): MemoryViewDashboard {
    return { revision: 'r1', writable: true, strategyTypeId, entries, sources: [], diagnostics: [], pluginInstallation: { supported: false, suggestions: [] } }
  }

  const main = (typeId: string, overrides: Partial<MemoryPluginEntryView> = {}) => entry('strategy-' + typeId, ['strategy'], { typeId, provides: [{ id: 'strategy', exclusive: false }], ...overrides })
  const off = { enabled: false, active: false }

  describe('memory component model', () => {
    it('composes with the selected main Strategy and marks the others as idle', () => {
      const model = componentModel(dashboard([main('default-three-tier'), main('general')]))
      expect(model.composing?.typeId).toBe('default-three-tier')
      expect(model.idle.map(value => value.typeId)).toEqual(['general'])
      expect(model.contenders).toEqual([])
    })

    it('falls back to the only running main Strategy, as the Host does', () => {
      const model = componentModel(dashboard([main('default-three-tier', off), main('general')]))
      expect(model.selected?.typeId).toBe('default-three-tier')
      expect(model.composing?.typeId).toBe('general')
      expect(model.idle).toEqual([])
    })

    it('composes with nothing while several others run and the selected one does not', () => {
      const model = componentModel(dashboard([main('default-three-tier', off), main('general'), main('focus')]))
      expect(model.composing).toBeUndefined()
      expect(model.contenders.map(value => value.typeId)).toEqual(['general', 'focus'])
    })

    it('composes with nothing while no main Strategy runs', () => {
      const model = componentModel(dashboard([main('default-three-tier', off), main('general', off)]))
      expect(model.composing).toBeUndefined()
      expect(model.contenders).toEqual([])
      expect(componentModel(dashboard([main('default-three-tier', { active: false })])).composing).toBeUndefined()
    })

    it('finds the Source of a memory layer, including a shipped one that is off and has no type', () => {
      const documents = entry('source-documents', ['source'], { typeId: 'documents' })
      const spaces = entry('source-memory-spaces', ['source'], off)
      const value = dashboard([documents, spaces])
      expect(sourceOf(value, 'documents')).toBe(documents)
      expect(sourceOf(value, 'memory-spaces')).toBe(spaces)
      expect(sourceOf(value, 'runtime')).toBeUndefined()
    })

    it('names the requirements no switched-on component provides, with the ones that could', () => {
      const spaces = entry('source-memory-spaces', ['source'], { ...off, provides: [{ id: 'source.durable-evidence', exclusive: false }] })
      const capture = entry('strategy-auto-capture', ['strategy-extension'], { requires: ['strategy', 'source.durable-evidence'] })
      const value = dashboard([main('default-three-tier'), capture, spaces])
      expect(unmetRequirements(value, capture)).toEqual([{ requirement: 'source.durable-evidence', providers: [spaces] }])
      expect(unmetRequirements(dashboard([main('default-three-tier'), capture]), capture)).toEqual([{ requirement: 'source.durable-evidence', providers: [] }])
    })

    it('applies an enhancement to the Strategy it targets or to any Strategy', () => {
      const composing = main('general')
      expect(enhancementApplies(entry('any', ['strategy-extension'], { strategyTypeId: '*' }), composing)).toBe(true)
      expect(enhancementApplies(entry('general-only', ['strategy-extension'], { strategyTypeId: 'general' }), composing)).toBe(true)
      expect(enhancementApplies(entry('three-tier-only', ['strategy-extension'], { strategyTypeId: 'default-three-tier' }), composing)).toBe(false)
      expect(enhancementApplies(entry('any', ['strategy-extension']), undefined)).toBe(false)
    })
  })

  describe('switch planning', () => {
    const source = (layer: string, overrides: Partial<MemoryPluginEntryView> = {}) => entry('source-' + layer, ['source'], {
      typeId: layer, provides: [{ id: 'source', exclusive: false }, ...layer === 'memory-spaces' ? [{ id: 'source.durable-evidence', exclusive: false }] : []], ...overrides,
    })
    const threeTier = main('default-three-tier', { requires: ['source'], provides: [{ id: 'strategy', exclusive: false }, { id: 'strategy.default-three-tier', exclusive: false }] })
    const capture = entry('strategy-auto-capture', ['strategy-extension'], { ...off, requires: ['strategy', 'source.durable-evidence'], provides: [{ id: 'strategy.capture', exclusive: true }] })
    const moves = (plan: SwitchPlan) => plan.changes?.map(change => [change.entry.entryId, change.enabled, change.reason ?? 'asked'])

    it('brings what a component needs and nothing already provides', () => {
      const value = dashboard([threeTier, source('runtime'), source('memory-spaces', off), capture])
      expect(moves(switchPlan(value, capture, true))).toEqual([['source-memory-spaces', true, 'needed'], ['strategy-auto-capture', true, 'asked']])
      expect(moves(switchPlan(dashboard([threeTier, source('memory-spaces'), capture]), capture, true))).toEqual([['strategy-auto-capture', true, 'asked']])
    })

    it('takes along what loses a capability it requires, but not what never had it', () => {
      const value = dashboard([threeTier, source('runtime'), source('memory-spaces'), { ...capture, enabled: true, active: true }])
      expect(moves(switchPlan(value, value.entries[2]!, false))).toEqual([['source-memory-spaces', false, 'asked'], ['strategy-auto-capture', false, 'dependent']])
      const broken = dashboard([main('default-three-tier', { requires: ['source'] }), entry('focus', ['strategy-extension'], off)])
      expect(moves(switchPlan(broken, broken.entries[1]!, true))).toEqual([['focus', true, 'asked']])
    })

    it('refuses to take the last Source from a main Strategy', () => {
      const value = dashboard([threeTier, source('runtime', off), source('memory-spaces')])
      expect(switchPlan(value, value.entries[2]!, false)).toEqual({ blocked: 'last-source' })
    })

    it('turns off what cannot run beside a component, by claimed capability or by slot', () => {
      const light = entry('light', ['strategy-extension'], { provides: [{ id: 'strategy.projection', exclusive: true }] })
      const compact = entry('compact', ['strategy-extension'], { ...off, provides: [{ id: 'strategy.projection', exclusive: false }] })
      expect(conflicts(light, compact)).toBe(true)
      expect(moves(switchPlan(dashboard([threeTier, light, compact]), compact, true))).toEqual([['light', false, 'conflict'], ['compact', true, 'asked']])
      const slotted = (id: string, strategyTypeId: string | undefined, values: Partial<MemoryPluginEntryView> = {}) => entry(id, ['strategy-extension'], { slot: 'recall', ...strategyTypeId === undefined ? {} : { strategyTypeId }, ...values })
      expect(conflicts(slotted('a', 'general'), slotted('b', 'general'))).toBe(true)
      expect(conflicts(slotted('a', '*'), slotted('b', 'general'))).toBe(true)
      expect(conflicts(slotted('a', 'general'), slotted('b', 'default-three-tier'))).toBe(false)
    })

    it('switches the main Strategy with whatever only the previous one could take', () => {
      const general = main('general', { ...off, requires: ['source'], provides: [{ id: 'strategy', exclusive: false }, { id: 'strategy.general', exclusive: false }] })
      const tiered = entry('tiered', ['strategy-extension'], { requires: ['strategy.default-three-tier'] })
      const value = dashboard([threeTier, general, source('runtime'), tiered])
      expect(moves(mainPlan(value, general))).toEqual([['strategy-default-three-tier', false, 'asked'], ['strategy-general', true, 'asked'], ['tiered', false, 'dependent']])
    })

    it('counts the capabilities of a running Source the plugin manager does not manage', () => {
      const value = { ...dashboard([threeTier, { ...capture }]), sources: [{ sourceInstanceKey: 'notes/default', sourceTypeId: 'notes', packageName: 'acme-notes', role: 'durable-evidence', label: 'Notes' }] }
      expect(unmetRequirements(value, capture)).toEqual([])
      expect(moves(switchPlan(value, capture, true))).toEqual([['strategy-auto-capture', true, 'asked']])
    })
  })
})

describe('component feedback and View store', () => {
  function entry(entryId: string, roles: MemoryPluginEntryView['roles'], overrides: Partial<MemoryPluginEntryView> = {}): MemoryPluginEntryView {
    return {
      entryId, packageName: 'dsh-mnemon-' + entryId, roles, label: { en: entryId, 'zh-CN': entryId }, description: { en: '', 'zh-CN': '' },
      fields: [], provides: [], requires: [], requiredBy: [], enabled: true, active: true, writable: true, config: {}, ...overrides,
    }
  }
  const main = (typeId: string, overrides: Partial<MemoryPluginEntryView> = {}) => entry('strategy-' + typeId, ['strategy'], { typeId, ...overrides })
  const off = { enabled: false, active: false }
  function dashboard(entries: MemoryPluginEntryView[], strategyTypeId = 'default-three-tier', revision = 'r1'): MemoryViewDashboard {
    return { revision, writable: true, strategyTypeId, entries, sources: [], diagnostics: [], pluginInstallation: { supported: false, suggestions: [] } }
  }
  const name = (value: MemoryPluginEntryView) => value.entryId
  const say = (before: MemoryViewDashboard, after: MemoryViewDashboard, origin: 'own' | 'external' = 'own') => describeChange(before, after, origin, name, translateEn)

  describe('component change feedback', () => {
    it('leads with what a change does to memory as a whole', () => {
      const running = [main('default-three-tier'), main('general', off)]
      expect(say(dashboard(running), dashboard([main('default-three-tier', off), main('general', off)]), 'external'))
        .toMatchObject({ text: 'Memory is not in use: no main strategy is running', tone: 'warning' })
      expect(say(dashboard([main('default-three-tier', off), main('general', off)]), dashboard(running)))
        .toMatchObject({ text: 'Memory is back, composed by “strategy-default-three-tier”', tone: 'success' })
      expect(say(dashboard([main('default-three-tier'), main('general')]), dashboard([main('default-three-tier', off), main('general')]), 'external'))
        .toMatchObject({ text: '“strategy-default-three-tier” is off; “strategy-general” composes memory for now', tone: 'warning' })
    })

    it('names a main Strategy switch and the Strategies it turned off', () => {
      const before = dashboard([main('default-three-tier'), main('general', off)])
      const after = dashboard([main('default-three-tier', off), main('general')], 'general')
      expect(say(before, after)).toMatchObject({ text: 'Switched to “strategy-general” and turned off “strategy-default-three-tier”', tone: 'success', targets: ['overview', 'strategy'] })
      expect(say(before, after, 'external')).toMatchObject({ text: 'The main strategy is now “strategy-general”', tone: 'info' })
    })

    it('names a second main Strategy that starts running unused', () => {
      expect(say(dashboard([main('default-three-tier'), main('general', off)]), dashboard([main('default-three-tier'), main('general')]), 'external'))
        .toMatchObject({ text: '“strategy-general” is running too, but composes nothing', tone: 'warning' })
    })

    it('says what a Source switch does to its layer, and points at the layer and the Providers', () => {
      const spaces = entry('source-memory-spaces', ['source'], { typeId: 'memory-spaces' })
      const before = dashboard([main('default-three-tier'), spaces])
      const after = dashboard([main('default-three-tier'), { ...spaces, ...off }])
      expect(say(before, after)).toEqual({ text: 'Turned off “source-memory-spaces”; its layer stops reading and writing', tone: 'success', targets: ['overview', 'layer:memory-spaces', 'providers'] })
      expect(say(after, before, 'external')).toMatchObject({ text: '“source-memory-spaces” was turned on; its layer reads and writes again', tone: 'info' })
    })

    it('counts several switches, and says nothing for none', () => {
      const before = dashboard([main('default-three-tier'), entry('capture', ['strategy-extension']), entry('light', ['strategy-extension'])])
      const after = dashboard([main('default-three-tier'), entry('capture', ['strategy-extension'], off), entry('light', ['strategy-extension'], off)])
      expect(say(before, after)?.text).toBe('Updated 2 components')
      expect(say(before, before)).toBeUndefined()
    })

    it('names what a switch took along, and why', () => {
      const light = entry('light', ['strategy-extension'])
      const compact = entry('compact', ['strategy-extension'], off)
      const before = dashboard([main('default-three-tier'), light, compact])
      const after = dashboard([main('default-three-tier'), { ...light, ...off }, { ...compact, enabled: true, active: true }])
      expect(describeChange(before, after, 'own', name, translateEn, 'compact')?.text).toBe('Turned on “compact” and turned off “light”, which cannot run beside it')
      const spaces = entry('spaces', ['source'], { ...off, typeId: 'memory-spaces' })
      const capture = entry('capture', ['strategy-extension'], off)
      const on = { enabled: true, active: true }
      expect(describeChange(dashboard([main('default-three-tier'), spaces, capture]), dashboard([main('default-three-tier'), { ...spaces, ...on }, { ...capture, ...on }]), 'own', name, translateEn, 'capture')?.text)
        .toBe('Turned on “capture” and “spaces”, which it needs')
    })

    it('names the switches a new main Strategy brought along', () => {
      const runtime = entry('runtime', ['source'], { ...off, typeId: 'runtime' })
      const before = dashboard([main('default-three-tier'), main('general', off), runtime])
      const after = dashboard([main('default-three-tier', off), main('general'), { ...runtime, enabled: true, active: true }], 'general')
      expect(say(before, after)?.text).toBe('Switched to “strategy-general”: turned on “runtime” and turned off “strategy-default-three-tier”')
    })

    it('says a change of options, and whose', () => {
      const light = entry('light', ['strategy-extension'])
      const before = dashboard([main('default-three-tier'), light])
      const after = dashboard([main('default-three-tier'), { ...light, config: { maxProjectionCharacters: 2048 } }])
      expect(say(before, after)).toEqual({ text: 'Updated the options of “light”', tone: 'success', targets: ['overview', 'enhancement:light'] })
      expect(say(before, after, 'external')?.text).toBe('The options of “light” changed')
    })
  })

  describe('View store changes', () => {
    function client(initial: MemoryViewDashboard) {
      let current = initial
      const applied: MemoryViewConfigurationRequest[] = []
      let refuse = false
      const value = {
        viewDashboard: vi.fn(async () => structuredClone(current)),
        applyView: vi.fn(async (request: MemoryViewConfigurationRequest) => {
          if (refuse) throw new Error('refused')
          applied.push(request)
          current = { ...current, revision: current.revision + '+', strategyTypeId: request.strategyTypeId,
            entries: current.entries.map(item => request.entries[item.entryId] === undefined ? item : { ...item, enabled: request.entries[item.entryId]!.enabled, active: request.entries[item.entryId]!.enabled, config: request.entries[item.entryId]!.config }) }
          return { saved: true as const }
        }),
      }
      return {
        client: value as unknown as MnemonClient, applied,
        elsewhere: (next: (value: MemoryViewDashboard) => MemoryViewDashboard) => { current = next(current) },
        refuse: (value: boolean) => { refuse = value },
      }
    }
    const capture = entry('capture', ['strategy-extension'], off)

    it('records its own write with both sides, and puts it back on Undo', async () => {
      const fake = client(dashboard([main('default-three-tier'), capture]))
      const store = new MnemonViewStore(fake.client)
      await store.load()
      await store.setEnabled('enhancement:capture', [{ entry: capture, enabled: true }])
      const change = store.getSnapshot().change!
      expect(change).toMatchObject({ origin: 'own', key: 'enhancement:capture' })
      expect(change.after.entries.find(value => value.entryId === 'capture')?.enabled).toBe(true)
      await store.revert(change)
      expect(fake.applied.at(-1)).toEqual({ expectedRevision: 'r1+', strategyTypeId: 'default-three-tier', entries: { capture: { enabled: false, config: {} } } })
    })

    it('tells a change made elsewhere from the echo of its own write', async () => {
      const fake = client(dashboard([main('default-three-tier'), capture]))
      const store = new MnemonViewStore(fake.client)
      await store.load()
      await store.setEnabled('enhancement:capture', [{ entry: capture, enabled: true }])
      const own = store.getSnapshot().change!.seq
      await store.load()
      expect(store.getSnapshot().change?.seq).toBe(own)
      fake.elsewhere(value => ({ ...value, entries: value.entries.map(item => item.entryId === 'strategy-default-three-tier' ? { ...item, ...off } : item) }))
      await store.load()
      expect(store.getSnapshot().change).toMatchObject({ origin: 'external' })
      expect(store.getSnapshot().change!.seq).toBeGreaterThan(own)
    })

    it('writes options with the switch the Host holds, and puts them back on Undo', async () => {
      const light = entry('light', ['strategy-extension'], { config: { maxProjectionCharacters: 4096 } })
      const fake = client(dashboard([main('default-three-tier'), light]))
      const store = new MnemonViewStore(fake.client)
      await store.load()
      await store.configure('options:light', light, { maxProjectionCharacters: 2048 })
      expect(fake.applied.at(-1)).toEqual({ expectedRevision: 'r1', strategyTypeId: 'default-three-tier', entries: { light: { enabled: true, config: { maxProjectionCharacters: 2048 } } } })
      await store.revert(store.getSnapshot().change!)
      expect(fake.applied.at(-1)!.entries).toEqual({ light: { enabled: true, config: { maxProjectionCharacters: 4096 } } })
    })

    it('retries a refused write over the state the Host then holds', async () => {
      const fake = client(dashboard([main('default-three-tier'), capture]))
      const store = new MnemonViewStore(fake.client)
      await store.load()
      fake.refuse(true)
      expect(await store.setEnabled('enhancement:capture', [{ entry: capture, enabled: true }])).toBe(false)
      expect(store.getSnapshot().failure).toMatchObject({ key: 'enhancement:capture', kind: 'apply' })
      fake.refuse(false)
      expect(await store.retry()).toBe(true)
      expect(fake.applied).toEqual([{ expectedRevision: 'r1', strategyTypeId: 'default-three-tier', entries: { capture: { enabled: true, config: {} } } }])
    })
  })
})

describe('what the configuration lends a shipped component\'s settings', () => {
  const ready = (value: Config) => ({ status: 'ready' as const, value, base: {}, user: {}, revision: 3, writable: true, mode: 'host' as const })

  it('lends Memory Spaces only the keys its settings read, and writes only the one it owns', async () => {
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>(ready({ storageScope: 'workspace', writeEnabled: false, displayMode: 'builtin', embedding: { enabled: true, model: 'nomic-embed-text' } }), mutate)
    const host = createComponentHosts({ scope })(MEMORY_SPACES_PACKAGE)!
    const snapshot = host.configuration.getSnapshot()
    expect(snapshot).toEqual({ status: 'ready', writable: true, revision: 3, value: { embedding: { enabled: true, model: 'nomic-embed-text' }, storageScope: 'workspace', writeEnabled: false } })
    expect(host.configuration.getSnapshot()).toBe(snapshot)

    await host.configuration.set('embedding', { enabled: false })
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['embedding'], value: { enabled: false } }])
    expect(host.configuration.getSnapshot()).not.toBe(snapshot)
    expect(host.configuration.getSnapshot().revision).toBe(4)
    await expect(host.configuration.set('storageScope', 'global')).rejects.toThrow('does not lend this component the setting storageScope')
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('lends nothing to a component whose settings dsh-mnemon never drew', () => {
    const hosts = createComponentHosts({ scope: settingsScope<Config>(ready({})) })
    expect(hosts(RUNTIME_PACKAGE)).toBeUndefined()
    expect(hosts('@acme/memory-notes')).toBeUndefined()
  })

  it('keeps one host per conversation and workspace, so a page\'s effects see the same one', () => {
    const connection = { rpc: { call: vi.fn() }, isLoopback: true } as unknown as ClientConnectionHandle
    const hosts = createComponentHosts({ scope: settingsScope<Config>(ready({})), connection })
    const first = hosts(MEMORY_SPACES_PACKAGE, 'session-1', 'workspace-1')!
    expect(hosts(MEMORY_SPACES_PACKAGE, 'session-1', 'workspace-1')).toBe(first)
    expect(hosts(MEMORY_SPACES_PACKAGE, 'session-1', 'workspace-2')).not.toBe(first)
    expect(hosts(MEMORY_SPACES_PACKAGE, 'session-1', 'workspace-2')!.configuration).toBe(first.configuration)
  })

  it('lends no Host operations without a Host connection', () => {
    expect(createComponentHosts({ scope: settingsScope<Config>(ready({})) })(MEMORY_SPACES_PACKAGE)!.operations).toBeUndefined()
  })

  it('tells the Memory System when the component changed its data', () => {
    const bump = vi.fn()
    createComponentHosts({ scope: settingsScope<Config>(ready({})), componentChanges: { bump } })(MEMORY_SPACES_PACKAGE)!.changed()
    expect(bump).toHaveBeenCalledOnce()
  })

  it('routes Provider service settings on the write channel, in the page\'s conversation and workspace', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { providerId: 'mem0', configured: true, settings: { endpoint: 'http://127.0.0.1:8888' }, configuredSecrets: [] } }))
    const host = createComponentHosts({ scope: settingsScope<Config>(ready({})), connection: { rpc: { call }, isLoopback: true } as ClientConnectionHandle })(MEMORY_SPACES_PACKAGE, 'session-1', 'workspace-1')!

    await host.operations!.write('provider-service-update', { providerId: 'mem0', settings: { endpoint: 'http://127.0.0.1:8888', mode: 'self-hosted' }, enabled: true })

    expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'provider-service-update', {
      providerId: 'mem0', settings: { endpoint: 'http://127.0.0.1:8888', mode: 'self-hosted' }, enabled: true, sessionId: 'session-1', workspaceId: 'workspace-1',
    })
    await host.operations!.write('embedding-fill', { memoryBodyId: 'tools' })
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-write', 'embedding-fill', { memoryBodyId: 'tools', sessionId: 'session-1', workspaceId: 'workspace-1' })
  })

  it('loads redacted Provider settings through the read channel and never masks an authentication rejection', async () => {
    const call = vi.fn(async (channel: string) => {
      if (channel === '/dsh-mnemon-read') return { ok: true as const, value: { providers: [], items: [], generatedAt: 'now' } }
      throw new Error(`unexpected channel: ${channel}`)
    })
    const host = createComponentHosts({ scope: settingsScope<Config>(ready({})), connection: { rpc: { call }, isLoopback: true } as ClientConnectionHandle })(MEMORY_SPACES_PACKAGE, 'session-1')!

    await host.operations!.read('provider-services')
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-read', 'provider-services', { sessionId: 'session-1' })

    call.mockReset()
    call.mockRejectedValue(new Error('transport failure for /dsh-mnemon-write/provider-services: HTTP 403'))
    await expect(host.operations!.read('provider-services')).rejects.toThrow('HTTP 403')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('does not retry an unavailable Provider catalog on a write endpoint', async () => {
    const call = vi.fn(async () => ({ ok: false as const, error: { code: 'bad-request' as const, message: 'unknown read endpoint: provider-services', details: { issues: [] } } }))
    const host = createComponentHosts({ scope: settingsScope<Config>(ready({})), connection: { rpc: { call }, isLoopback: true } as ClientConnectionHandle })(MEMORY_SPACES_PACKAGE)!
    await expect(host.operations!.read('provider-services')).rejects.toThrow('unknown read endpoint')
    expect(call.mock.calls).toEqual([['/dsh-mnemon-read', 'provider-services', {}]])
  })

  it('checks Mnemon embedding status in the selected runtime scope', async () => {
    const status = { available: true, model: 'qwen3-embedding:0.6b', totalInsights: 5, embedded: 4, coverage: '80%' }
    const call = vi.fn(async () => ({ ok: true as const, value: status }))
    const host = createComponentHosts({ scope: settingsScope<Config>(ready({})), connection: { rpc: { call }, isLoopback: true } as ClientConnectionHandle })(MEMORY_SPACES_PACKAGE, 'session-1', 'workspace-1')!

    await expect(host.operations!.read('embedding-status')).resolves.toEqual(status)
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'embedding-status', {
      sessionId: 'session-1', workspaceId: 'workspace-1',
    })
  })

  it('serves only the operations it lends, each on its own channel', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: {} }))
    const host = createComponentHosts({ scope: settingsScope<Config>(ready({})), connection: { rpc: { call }, isLoopback: true } as ClientConnectionHandle })(MEMORY_SPACES_PACKAGE)!
    await expect(host.operations!.read('provider-service-update')).rejects.toThrow('does not serve this component the read operation provider-service-update')
    await expect(host.operations!.write('provider-services', {})).rejects.toThrow('does not serve this component the write operation provider-services')
    await expect(host.operations!.write('body-delete', { memoryBodyId: 'default' })).rejects.toThrow('does not serve this component')
    await expect(host.operations!.write('embedding-fill', 'tools')).rejects.toThrow('embedding-fill takes an object')
    expect(call).not.toHaveBeenCalled()
  })

  it('runs every operation in the page\'s own conversation and workspace, never in ones the component names', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: {} }))
    const hosts = createComponentHosts({ scope: settingsScope<Config>(ready({})), connection: { rpc: { call }, isLoopback: true } as ClientConnectionHandle })
    const unscoped = hosts(MEMORY_SPACES_PACKAGE)!
    await unscoped.operations!.write('provider-service-update', { providerId: 'mem0', settings: {}, enabled: true })
    expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-write', 'provider-service-update', { providerId: 'mem0', settings: {}, enabled: true })
    for (const host of [unscoped, hosts(MEMORY_SPACES_PACKAGE, 'session-1', 'workspace-1')!]) {
      await expect(host.operations!.write('provider-service-update', { providerId: 'mem0', settings: {}, enabled: true, sessionId: 'other' })).rejects.toThrow('takes no sessionId')
      await expect(host.operations!.read('provider-services', { workspaceId: 'other' })).rejects.toThrow('takes no workspaceId')
      await expect(host.operations!.read('embedding-status', { sessionId: 'other', workspaceId: 'other' })).rejects.toThrow('takes no sessionId or workspaceId')
    }
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('joins a read the settings make on their own while it is under way at the same configuration revision', async () => {
    const answers: Array<(value: { ok: true; value: { commandFound: boolean } }) => void> = []
    const call = vi.fn((_channel: string, _endpoint: string) => new Promise(resolve => { answers.push(resolve) }))
    const scope = liveSettingsScope<Config>(ready({}))
    const hosts = createComponentHosts({ scope, connection: { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle })
    const host = hosts(MEMORY_SPACES_PACKAGE, 'session-1')!
    const first = host.operations!.read('status-summary')
    const second = host.operations!.read('status-summary')
    expect(call).toHaveBeenCalledTimes(1)
    await scope.mutate([{ op: 'set', path: ['embedding'], value: { enabled: false } }])
    void host.operations!.read('status-summary')
    expect(call).toHaveBeenCalledTimes(2)
    answers[0]!({ ok: true, value: { commandFound: true } })
    await expect(Promise.all([first, second])).resolves.toEqual([{ commandFound: true }, { commandFound: true }])
    void host.operations!.read('embedding-status')
    void host.operations!.read('embedding-status')
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'embedding-status')).toHaveLength(2)
  })

  it('keeps what the settings retain across their mounts, one store per conversation and workspace', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { commandFound: true } }))
    const hosts = createComponentHosts({ scope: settingsScope<Config>(ready({})), connection: { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle })
    const host = hosts(MEMORY_SPACES_PACKAGE, 'session-1')!
    await host.operations!.read('status-summary')
    await host.operations!.read('status-summary')
    expect(call).toHaveBeenCalledTimes(2)
    host.retained.set('provider-services', { providers: [] })
    expect(hosts(MEMORY_SPACES_PACKAGE, 'session-1')!.retained.get('provider-services')).toEqual({ providers: [] })
    expect(hosts(MEMORY_SPACES_PACKAGE, 'session-2')!.retained.size).toBe(0)
  })
})

describe('Source page revision tracking', () => {
  it('uses read-returned revisions and does not let an older concurrent read roll them back', async () => {
    let settleOld!: (value: { revision: string; value: null }) => void
    const old = new Promise<{ revision: string; value: null }>(resolve => { settleOld = resolve })
    const read = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce({ revision: 'r2', value: {} })
    const mutate = vi.fn().mockResolvedValue({ revision: 'r3', value: {} })
    const client = createMemorySourcePageClient({ sourceInstanceKey: 'source:notes', revision: 'r1', read, mutate })
    const pending = client.read('old')
    await client.read('fresh')
    settleOld({ revision: 'r1', value: null })
    await pending
    await client.mutate('save', {}, true)
    expect(mutate).toHaveBeenCalledWith('save', {}, { confirmed: true, expectedRevision: 'r2' })
  })

  it('does not retry a rejected mutation or drop the caller confirmation requirement', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('revision conflict'))
    const client = createMemorySourcePageClient({ sourceInstanceKey: 'source:notes', revision: 'r1', read: vi.fn(), mutate })
    await expect(client.mutate('save', {}, false as never)).rejects.toThrow('confirmation')
    expect(mutate).not.toHaveBeenCalled()
    await expect(client.mutate('save', {}, true)).rejects.toThrow('revision conflict')
    expect(mutate).toHaveBeenCalledOnce()
  })
})
