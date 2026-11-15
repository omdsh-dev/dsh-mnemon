// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionHandle } from '../src/host/dsh.ts'
import type { SkillActivitySnapshot, SkillsConfig } from '../src/host/protocol.ts'
import { subscribeMnemonAnchor } from '../src/client/anchor.ts'
import { translateEn as t } from '../src/client/locales.ts'
import { SKILLS_PAGE, SkillTurnTail, invalidateSkillActivity } from '../src/client/SkillTurnTail.tsx'
import { supportsMemoryComponentSettingsSection } from '../src/client/extension-sdk.ts'
import { SKILLS_PACKAGE, SkillsSettings } from '../src/client/skills-settings.tsx'
import { MnemonChangeSignal } from '../src/client/change-signal.ts'
import { liveSettingsScope } from './helpers/settings-scope.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const page = { component: { packageName: SKILLS_PACKAGE, label: 'Skills', enabled: true }, writable: true, language: 'en' }
const locale = { active: 'en' as const, locales: [], revision: 0 }
const localeRuntime = { getSnapshot: () => locale, subscribe: () => () => {} }

describe('技能管理 settings under Plugins', () => {
  it('keeps linked updates off by default and saves an explicit opt-in while evolution is off', async () => {
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: {}, revision: 1, writable: true, mode: 'host' })
    render(<SkillsSettings scope={scope} page={page} t={t} />)
    const toggle = screen.getByRole('switch', { name: t('skills.allowLinkedUpdates') })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(scope.getSnapshot().value?.allowLinkedUpdates).toBe(true))
    fireEvent.click(toggle)
    await waitFor(() => expect(scope.getSnapshot().value?.allowLinkedUpdates).toBe(false))
  })

  it('stages daily candidate and time zone settings and keeps invalid values off the Host', async () => {
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: { evolution: true }, revision: 1, writable: true, mode: 'host' })
    render(<SkillsSettings scope={scope} page={page} t={t} />)
    const limit = screen.getByLabelText('Automatic candidates per day')
    const zone = screen.getByLabelText('Daily quota time zone')
    expect(limit).toHaveProperty('value', '2')
    expect(zone).toHaveProperty('value', 'local')
    fireEvent.change(limit, { target: { value: '3' } })
    fireEvent.change(zone, { target: { value: 'not/a-zone' } })
    expect(screen.getByRole('button', { name: t('options.apply') })).toHaveProperty('disabled', true)
    expect(scope.getSnapshot().value?.autoAdoptDailyLimit).toBeUndefined()
    fireEvent.change(zone, { target: { value: 'Asia/Shanghai' } })
    fireEvent.click(screen.getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(scope.getSnapshot().value).toMatchObject({ autoAdoptDailyLimit: 3, autoAdoptTimeZone: 'Asia/Shanghai' }))
  })

  it('stages both draft budgets while evolution is off and rejects invalid values', async () => {
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: {}, revision: 1, writable: true, mode: 'host' })
    const view = render(<SkillsSettings scope={scope} page={page} t={t} />)
    expect(screen.queryByLabelText('Draft output token limit')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('skills.draftGeneration') }))
    const first = screen.getByLabelText('Draft output token limit')
    const retry = screen.getByLabelText('Retry output token limit')
    expect(first).toHaveProperty('value', '32768')
    expect(retry).toHaveProperty('value', '65536')
    fireEvent.change(first, { target: { value: '49152' } })
    fireEvent.change(retry, { target: { value: '131073' } })
    expect(screen.getByRole('button', { name: t('options.apply') })).toHaveProperty('disabled', true)
    expect(scope.getSnapshot().value?.draftMaxTokens).toBeUndefined()
    fireEvent.change(retry, { target: { value: '49152' } })
    fireEvent.click(screen.getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(scope.getSnapshot().value).toMatchObject({ draftMaxTokens: 49152, draftRetryMaxTokens: 49152 }))
    view.unmount()
    render(<SkillsSettings scope={scope} page={page} t={t} />)
    expect(screen.queryByLabelText('Draft output token limit')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('skills.draftGeneration') }))
    expect(screen.getByLabelText('Draft output token limit')).toHaveProperty('value', '49152')
    expect(screen.getByLabelText('Retry output token limit')).toHaveProperty('value', '49152')
  })

  it('unmounts collapsed Parameters and Draft generation inputs so hidden fields cannot be focused or edited, while preserving staged edits', () => {
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: { evolution: true }, revision: 1, writable: true, mode: 'host' })
    const { container } = render(<SkillsSettings scope={scope} page={page} t={t} />)

    const parametersSection = container.querySelector('[data-settings-section="parameters"]') as HTMLElement
    const draftSection = container.querySelector('[data-settings-section="draft"]') as HTMLElement
    expect(parametersSection).not.toBeNull()
    expect(draftSection).not.toBeNull()
    expect(parametersSection.querySelectorAll('input, select, textarea, button:not([data-disclosure-open])')).toHaveLength(0)
    expect(draftSection.querySelectorAll('input, select, textarea, button:not([data-disclosure-open])')).toHaveLength(0)

    const draftToggle = screen.getByRole('button', { name: t('skills.draftGeneration') })
    expect(draftToggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(draftToggle)
    expect(draftToggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.change(screen.getByLabelText('Draft output token limit'), { target: { value: '40960' } })

    fireEvent.click(draftToggle)
    expect(draftToggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Draft output token limit')).toBeNull()
    expect(draftSection.querySelectorAll('input, select, textarea, button:not([data-disclosure-open])')).toHaveLength(0)

    fireEvent.click(draftToggle)
    expect(screen.getByLabelText('Draft output token limit')).toHaveProperty('value', '40960')
    expect(screen.getByRole('button', { name: t('options.apply') })).toHaveProperty('disabled', false)
  })

  it('stages the new-skill destination until Apply and restores it on Discard', async () => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: { evolution: true }, revision: 1, writable: true, mode: 'host' }, writes)
    render(<SkillsSettings scope={scope} page={page} t={t} />)
    const destination = screen.getByRole('button', { name: `${t('skills.targetScope')} ${t('skills.targetScope.user')}` })
    expect(destination.textContent).toContain(t('skills.targetScope.user'))
    fireEvent.click(destination)
    fireEvent.click(screen.getByRole('menuitem', { name: t('skills.targetScope.project') }))
    expect(writes).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('config.discard') }))
    expect(destination.textContent).toContain(t('skills.targetScope.user'))
    fireEvent.click(destination)
    fireEvent.click(screen.getByRole('menuitem', { name: t('skills.targetScope.storage') }))
    fireEvent.click(screen.getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(scope.getSnapshot().value?.targetScope).toBe('storage'))
  })

  it.each(['page', 'scope'] as const)('keeps the destination read-only when %s refuses writes', blocked => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: { evolution: true }, revision: 1, writable: blocked !== 'scope', mode: 'host' }, writes)
    render(<SkillsSettings scope={scope} page={{ ...page, writable: blocked !== 'page' }} t={t} />)
    expect(screen.getByRole('button', { name: `${t('skills.targetScope')} ${t('skills.targetScope.user')}` })).toHaveProperty('disabled', true)
    expect(screen.queryByLabelText('Draft output token limit')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('skills.draftGeneration') }))
    expect(screen.getByLabelText('Draft output token limit')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Retry output token limit')).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: t('skills.allowLinkedUpdates') })).toHaveProperty('disabled', true)
    expect(writes).not.toHaveBeenCalled()
  })

  it('shows self-evolution\'s own settings only while it is on, and applies each switch at once', async () => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: {}, revision: 1, writable: true, mode: 'host' }, writes)
    render(<SkillsSettings scope={scope} page={page} t={t} />)
    expect(screen.queryByRole('switch', { name: t('skills.autoBacktest') })).toBeNull()
    expect(screen.queryByRole('switch', { name: t('skills.allowCreate') })).toBeNull()
    expect(screen.queryByRole('switch', { name: t('skills.allowUpdate') })).toBeNull()
    expect(screen.queryByText(t('skills.parameters'))).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: t('skills.evolution') }))
    await waitFor(() => expect(writes).toHaveBeenCalledWith([{ op: 'set', path: ['evolution'], value: true }]))
    expect(await screen.findByRole('switch', { name: t('skills.autoBacktest') })).not.toBeNull()
    expect(screen.getByRole('switch', { name: t('skills.autoAdopt') }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('switch', { name: t('skills.autoAdopt') }))
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith([{ op: 'set', path: ['autoAdopt'], value: true }]))
    expect(screen.getByRole('switch', { name: t('skills.allowCreate') }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: t('skills.allowUpdate') }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('switch', { name: t('skills.allowCreate') }))
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith([{ op: 'set', path: ['allowCreate'], value: false }]))
    expect(screen.getByRole('switch', { name: t('skills.allowUpdate') }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('switch', { name: t('skills.allowUpdate') }))
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith([{ op: 'set', path: ['allowUpdate'], value: false }]))
    expect(screen.getByText(t('skills.parameters'))).not.toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: t('skills.hints') }))
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith([{ op: 'set', path: ['hints'], value: false }]))
    fireEvent.click(screen.getByRole('switch', { name: t('skills.sidebar') }))
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith([{ op: 'set', path: ['sidebar'], value: true }]))
  })

  it.each(['page', 'scope'] as const)('keeps both suggestion switches read-only when %s refuses writes', async blocked => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: { evolution: true, allowCreate: false, allowUpdate: true }, revision: 1, writable: blocked !== 'scope', mode: 'host' }, writes)
    render(<SkillsSettings scope={scope} page={{ ...page, writable: blocked !== 'page' }} t={t} />)
    for (const key of ['allowCreate', 'allowUpdate'] as const) {
      const toggle = screen.getByRole('switch', { name: t(`skills.${key}`) })
      expect(toggle).toHaveProperty('disabled', true)
      fireEvent.click(toggle)
    }
    expect(writes).not.toHaveBeenCalled()
  })

  it('applies the review parameters together and holds back one out of range', async () => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: { evolution: true }, revision: 1, writable: true, mode: 'host' }, writes)
    render(<SkillsSettings scope={scope} page={page} t={t} />)
    fireEvent.click(screen.getByText(t('skills.parameters')))
    fireEvent.change(screen.getByLabelText(t('skills.idleSeconds')), { target: { value: '45' } })
    fireEvent.change(screen.getByLabelText(t('skills.minConfidence')), { target: { value: '2' } })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('skills.invalid', { field: t('skills.minConfidence'), min: 0, max: 1 }))
    expect((screen.getByRole('button', { name: t('options.apply') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(t('skills.minConfidence')), { target: { value: '0.7' } })
    fireEvent.click(screen.getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(writes).toHaveBeenCalledWith([
      { op: 'set', path: ['idleSeconds'], value: 45 },
      { op: 'set', path: ['minConfidence'], value: 0.7 },
    ]))
  })

  it('converges Default Models onto live draft-preference mutations and hides the section when Skills RPC is offline', async () => {
    expect(supportsMemoryComponentSettingsSection(SKILLS_PACKAGE, 'models')).toBe(true)
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: {}, revision: 1, writable: true, mode: 'host' })
    let preferences = {
      draftModel: null as { provider: string; model: string } | null,
      runModel: { provider: 'deepseek', model: 'deepseek-chat' } as { provider: string; model: string } | null,
    }
    const call = vi.fn(async (channel: string, endpoint: string, payload: Record<string, unknown>) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') {
        return {
          ok: true as const,
          value: {
            effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const },
            groups: [
              { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
              { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
            ],
            failures: [],
          },
        }
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'source-management-read') {
        if (payload.operation === 'draft-preferences') return { ok: true as const, value: { revision: 'r1', value: preferences } }
        return { ok: false as const, error: { message: 'unsupported' } }
      }
      if (channel === '/dsh-mnemon-write' && endpoint === 'source-management-mutate') {
        expect(payload.sourceInstanceKey).toBe('skills/default')
        expect(payload.operation).toBe('draft-preference')
        const input = payload.input as { slot: 'draft' | 'run'; model: { provider: string; model: string } | null }
        preferences = {
          ...preferences,
          ...(input.slot === 'draft' ? { draftModel: input.model } : { runModel: input.model }),
        }
        return { ok: true as const, value: { revision: 'r2', value: preferences } }
      }
      return { ok: false as const, error: { message: `unexpected ${channel}/${endpoint}` } }
    })
    const conn = { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle
    const view = render(<SkillsSettings scope={scope} page={{ ...page, sessionId: 'session-1', workspace: { id: 'ws-1' } }} connection={conn} t={t} />)

    const draftTrigger = await screen.findByRole('button', { name: new RegExp(`^${t('skills.draftModel')} `, 'u') })
    expect(draftTrigger.closest('[data-settings-section="models"]')).not.toBeNull()
    expect(draftTrigger.textContent).toContain(t('skills.modelAuto'))

    fireEvent.click(draftTrigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /GPT-5/u }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'source-management-mutate', expect.objectContaining({
      sourceInstanceKey: 'skills/default',
      operation: 'draft-preference',
      input: { slot: 'draft', model: { provider: 'openai', model: 'gpt-5' } },
      sessionId: 'session-1',
      workspaceId: 'ws-1',
    })))

    const runTrigger = screen.getByRole('button', { name: new RegExp(`^${t('skills.runModel')} `, 'u') })
    fireEvent.click(runTrigger)
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${t('skills.modelAuto').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u') }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'source-management-mutate', expect.objectContaining({
      operation: 'draft-preference',
      input: { slot: 'run', model: null },
    })))
    view.unmount()

    const offline = {
      rpc: { call: vi.fn(async () => ({ ok: false as const, error: { message: 'source offline' } })) },
      isLoopback: true,
    } as unknown as ClientConnectionHandle
    render(<SkillsSettings scope={scope} page={page} connection={offline} t={t} />)
    await act(async () => {})
    expect(document.querySelector('[data-settings-section="models"]')).toBeNull()
  })

  it('stages Skill Directories with directoryPicker browse support and unsets cleared overrides', async () => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({
      status: 'ready',
      value: { dshHome: '/initial/.dsh' },
      revision: 1,
      writable: true,
      mode: 'host',
    }, writes)
    const picker = {
      available: () => true,
      pick: vi.fn(async () => '/picked/.agents'),
    }

    render(<SkillsSettings scope={scope} page={page} directoryPicker={picker} t={t} />)
    const dshInput = screen.getByLabelText(t('skills.dshHome')) as HTMLInputElement
    const agentsInput = screen.getByLabelText(t('skills.agentsHome')) as HTMLInputElement
    expect(dshInput.closest('[data-settings-section="directories"]')).not.toBeNull()
    expect(dshInput.value).toBe('/initial/.dsh')
    expect(agentsInput.value).toBe('')

    const browseButtons = within(dshInput.closest('[data-settings-section="directories"]') as HTMLElement)
      .getAllByRole('button', { name: new RegExp(`^${t('storage.chooseDirectory')}`, 'u') })
    expect(browseButtons).toHaveLength(2)
    fireEvent.click(browseButtons[1]!)
    await waitFor(() => expect(agentsInput.value).toBe('/picked/.agents'))
    expect(writes).not.toHaveBeenCalled()

    fireEvent.change(dshInput, { target: { value: '   ' } })
    fireEvent.click(within(dshInput.closest('[data-settings-section="directories"]') as HTMLElement).getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(writes).toHaveBeenCalledWith([
      { op: 'unset', path: ['dshHome'] },
      { op: 'set', path: ['agentsHome'], value: '/picked/.agents' },
    ]))
  })

  it('manages Market Sources registries via Skills source-management RPC', async () => {
    expect(supportsMemoryComponentSettingsSection(SKILLS_PACKAGE, 'market')).toBe(true)
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: {}, revision: 1, writable: true, mode: 'host' })
    let registries = [
      { id: 'builtin-official', label: 'Official Skills', url: 'https://skills.sh', builtin: true, enabled: true, skillCount: 24 },
      { id: 'team-repo', label: 'Team Skills', url: 'https://github.com/acme/skills', builtin: false, enabled: true, skillCount: 5 },
    ]
    const call = vi.fn(async (channel: string, endpoint: string, payload: Record<string, unknown>) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'source-management-read' && payload.operation === 'market') {
        return { ok: true as const, value: { revision: 'r1', value: { registries } } }
      }
      if (channel === '/dsh-mnemon-write' && endpoint === 'source-management-mutate') {
        const input = payload.input as Record<string, unknown>
        if (payload.operation === 'registry-toggle') {
          registries = registries.map(item => item.id === input.id ? { ...item, enabled: Boolean(input.enabled) } : item)
        } else if (payload.operation === 'registry-remove') {
          registries = registries.filter(item => item.id !== input.id)
        } else if (payload.operation === 'registry-add') {
          const loc = String(input.location ?? input.url ?? '')
          registries = [...registries, { id: 'added-repo', label: loc, url: loc, builtin: false, enabled: true, skillCount: 2 }]
        }
        return { ok: true as const, value: { revision: 'r2', value: { registries } } }
      }
      return { ok: false as const, error: { message: 'unsupported' } }
    })
    const conn = { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle

    render(<SkillsSettings scope={scope} page={page} connection={conn} t={t} />)
    const marketToggle = await screen.findByRole('button', { name: t('skills.market') })
    expect(marketToggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(marketToggle)
    expect(marketToggle.getAttribute('aria-expanded')).toBe('true')
    const marketSection = document.querySelector('[data-settings-section="market"]') as HTMLElement
    expect(marketSection).not.toBeNull()
    expect(within(marketSection).getByText('Official Skills')).not.toBeNull()

    // Builtin registry has no remove button; custom registry has one.
    const removePattern = new RegExp(`^${t('skills.marketRemove')}`, 'u')
    expect(within(marketSection).getAllByRole('button', { name: removePattern })).toHaveLength(1)

    fireEvent.click(within(marketSection).getByRole('switch', { name: 'Official Skills' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'source-management-mutate', expect.objectContaining({
      operation: 'registry-toggle',
      input: { id: 'builtin-official', enabled: false },
    })))

    fireEvent.click(within(marketSection).getByRole('button', { name: t('skills.marketRefresh') }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'source-management-mutate', expect.objectContaining({
      operation: 'market-refresh',
      input: {},
    })))

    const urlInput = within(marketSection).getByLabelText(t('skills.marketAddPlaceholder'))
    fireEvent.change(urlInput, { target: { value: 'https://github.com/acme/extra-skills' } })
    fireEvent.click(within(marketSection).getByRole('button', { name: t('skills.marketAdd') }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'source-management-mutate', expect.objectContaining({
      operation: 'registry-add',
      input: { location: 'https://github.com/acme/extra-skills' },
    })))
    expect(await within(marketSection).findAllByText('https://github.com/acme/extra-skills')).not.toHaveLength(0)

    const removeButtons = within(marketSection).getAllByRole('button', { name: removePattern })
    fireEvent.click(removeButtons[0]!)
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'source-management-mutate', expect.objectContaining({
      operation: 'registry-remove',
      input: { id: 'team-repo' },
    })))
    expect(within(marketSection).queryByText('Team Skills')).toBeNull()
  })

  it('resolves the live Skills Source instance from source-management-catalog before reading or mutating', async () => {
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: {}, revision: 1, writable: true, mode: 'host' })
    const liveKey = 'include:dsh-mnemon-source-skills'
    let catalogCalls = 0
    const call = vi.fn(async (channel: string, endpoint: string, payload: Record<string, unknown>) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') {
        return {
          ok: true as const,
          value: {
            effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const },
            groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
            failures: [],
          },
        }
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'source-management-catalog') {
        catalogCalls += 1
        return {
          ok: true as const,
          value: {
            sources: [{
              sourceInstanceKey: liveKey,
              sourceTypeId: 'skills',
              title: 'Skills',
              revision: 'rev-live-1',
              availability: 'ready',
              readOperations: ['draft-preferences', 'market'],
              mutateOperations: ['draft-preference', 'market-refresh'],
            }],
          },
        }
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'source-management-read') {
        if (payload.sourceInstanceKey !== liveKey) {
          return { ok: false as const, error: { message: `Unknown Source instance: ${String(payload.sourceInstanceKey)}` } }
        }
        if (payload.operation === 'draft-preferences') {
          return { ok: true as const, value: { revision: 'rev-live-1', value: { draftModel: null, runModel: null } } }
        }
        if (payload.operation === 'market') {
          return {
            ok: true as const,
            value: {
              revision: 'rev-live-1',
              value: { registries: [{ id: 'builtin-official', label: 'Official Skills', url: 'https://skills.sh', builtin: true, enabled: true, skillCount: 12 }] },
            },
          }
        }
      }
      if (channel === '/dsh-mnemon-write' && endpoint === 'source-management-mutate') {
        expect(payload.sourceInstanceKey).toBe(liveKey)
        expect(payload.expectedRevision).toBe('rev-live-1')
        return {
          ok: true as const,
          value: {
            revision: 'rev-live-2',
            value: { registries: [{ id: 'builtin-official', label: 'Official Skills', url: 'https://skills.sh', builtin: true, enabled: true, skillCount: 12 }] },
          },
        }
      }
      return { ok: false as const, error: { message: `unexpected ${channel}/${endpoint}` } }
    })
    const conn = { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle

    render(<SkillsSettings scope={scope} page={{ ...page, section: 'market' }} connection={conn} t={t} />)

    expect(await screen.findByRole('button', { name: new RegExp(`^${t('skills.draftModel')} `, 'u') })).not.toBeNull()
    const marketToggle = await screen.findByRole('button', { name: t('skills.market') })
    expect(marketToggle.getAttribute('aria-expanded')).toBe('true')
    expect(catalogCalls).toBe(1)

    const marketSection = document.querySelector('[data-settings-section="market"]') as HTMLElement
    expect(within(marketSection).getByText('Official Skills')).not.toBeNull()

    fireEvent.click(within(marketSection).getByRole('button', { name: t('skills.marketRefresh') }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'source-management-mutate', expect.objectContaining({
      sourceInstanceKey: liveKey,
      operation: 'market-refresh',
      expectedRevision: 'rev-live-1',
    })))
  })

  it('orders SkillsSettings in user-logical workflow sequence and preserves disclosure accessible names with badges', async () => {
    const scope = liveSettingsScope<SkillsConfig>({
      status: 'ready',
      value: { evolution: true },
      revision: 1,
      writable: true,
      mode: 'host',
    })
    const liveKey = 'include:dsh-mnemon-source-skills'
    const call = vi.fn(async (channel: string, endpoint: string, payload: Record<string, unknown>) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') {
        return {
          ok: true as const,
          value: {
            effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const },
            groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
            failures: [],
          },
        }
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'source-management-catalog') {
        return {
          ok: true as const,
          value: {
            sources: [{
              sourceInstanceKey: liveKey,
              sourceTypeId: 'skills',
              title: 'Skills',
              revision: 'rev-1',
              availability: 'ready',
              readOperations: ['draft-preferences', 'market'],
              mutateOperations: [],
            }],
          },
        }
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'source-management-read') {
        if (payload.operation === 'draft-preferences') {
          return { ok: true as const, value: { revision: 'rev-1', value: { draftModel: null, runModel: null } } }
        }
        if (payload.operation === 'market') {
          return {
            ok: true as const,
            value: {
              revision: 'rev-1',
              value: {
                registries: [
                  { id: 'builtin-official', label: 'Official Skills', url: 'https://skills.sh', builtin: true, enabled: true, skillCount: 12 },
                  { id: 'team-repo', label: 'Team Skills', url: 'https://example.com/team', builtin: false, enabled: false, skillCount: 4 },
                ],
              },
            },
          }
        }
      }
      return { ok: false as const, error: { message: `unexpected ${channel}/${endpoint}` } }
    })
    const conn = { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle

    const { container } = render(<SkillsSettings scope={scope} page={page} connection={conn} t={t} />)

    const marketToggle = await screen.findByRole('button', { name: t('skills.market') })
    expect(marketToggle.textContent).toContain('1/2')

    const orderedNodes: Element[] = [
      screen.getByRole('switch', { name: t('skills.hints') }),
      screen.getByRole('switch', { name: t('skills.sidebar') }),
      screen.getByRole('button', { name: `${t('skills.targetScope')} ${t('skills.targetScope.user')}` }),
      screen.getByRole('switch', { name: t('skills.allowLinkedUpdates') }),
      screen.getByRole('switch', { name: t('skills.evolution') }),
      screen.getByRole('switch', { name: t('skills.allowCreate') }),
    ]
    for (const section of ['models', 'draft', 'market', 'directories']) {
      const node = container.querySelector(`[data-settings-section="${section}"]`)
      expect(node, `expected [data-settings-section="${section}"]`).not.toBeNull()
      orderedNodes.push(node!)
    }
    for (let index = 0; index < orderedNodes.length - 1; index += 1) {
      expect(orderedNodes[index]!.compareDocumentPosition(orderedNodes[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    }
  })
})

describe('the skills line under a turn', () => {
  function connection(read: () => SkillActivitySnapshot) {
    const call = vi.fn(async (_channel: string, endpoint: string, _payload: { sessionId?: string }) => endpoint === 'skill-activity'
      ? { ok: true as const, value: read() }
      : { ok: false as const, error: { message: 'unexpected' } })
    return { call, handle: { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle }
  }

  it('remembers an empty activity result across A/B/A at the same closing cursor', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [] }))
    const tail = (sessionId: string, seq = 10) => <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={seq} sessionId={sessionId} connection={handle} localeRuntime={localeRuntime} t={t} />
    const view = render(tail('A'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    view.rerender(tail('B'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    const before = call.mock.calls.length
    view.rerender(tail('A'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call).toHaveBeenCalledTimes(before)
    view.rerender(tail('A', 20))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call.mock.calls.length).toBeGreaterThan(before)
  })

  it.each([false, true])('retries temporarily unavailable history on return after settling (previous success=%s)', async succeeded => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let snapshot: SkillActivitySnapshot = { available: succeeded, turns: [], reviews: [] }
    const { call, handle } = connection(() => snapshot)
    const tail = <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId="A" connection={handle} localeRuntime={localeRuntime} t={t} />
    const view = render(tail)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    snapshot = { available: false, turns: [], reviews: [] }
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    const before = call.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(call).toHaveBeenCalledTimes(before)
    view.rerender(<></>)
    snapshot = { available: true, turns: [{ turn: 1, skills: [{ name: 'recovered', by: 'model' }] }], reviews: [] }
    view.rerender(tail)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(await screen.findByRole('button', { name: 'recovered' })).not.toBeNull()
  })

  it('ignores a pending history result from before a skill write while preserving other connections', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [] }))
    const finishes: Array<(value: any) => void> = []
    call.mockImplementation(() => new Promise(resolve => { finishes.push(resolve) }))
    const other = connection(() => ({ available: true, turns: [], reviews: [] }))
    render(<>
      <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId="A" connection={handle} localeRuntime={localeRuntime} t={t} />
      <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId="A" connection={other.handle} localeRuntime={localeRuntime} t={t} />
    </>)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    const otherReads = other.call.mock.calls.length
    act(() => invalidateSkillActivity(handle))
    await act(async () => { finishes[0]!({ ok: true, value: { available: true, turns: [{ turn: 1, skills: [{ name: 'obsolete', by: 'model' }] }], reviews: [] } }) })
    expect(screen.queryByRole('button', { name: 'obsolete' })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(finishes).toHaveLength(2)
    await act(async () => { finishes[1]!({ ok: true, value: { available: true, turns: [{ turn: 1, skills: [{ name: 'latest', by: 'model' }] }], reviews: [] } }) })
    expect(screen.getByRole('button', { name: 'latest' })).not.toBeNull()
    expect(other.call).toHaveBeenCalledTimes(otherReads)
  })

  it('defers the first activity read until idle and cancels it if its conversation leaves first', async () => {
    const idle = new Map<number, IdleRequestCallback>()
    let next = 0
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => { idle.set(++next, callback); return next })
    vi.stubGlobal('cancelIdleCallback', (id: number) => idle.delete(id))
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [] }))
    const tail = (sessionId: string) => <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId={sessionId} connection={handle} localeRuntime={localeRuntime} t={t} />
    const view = render(tail('A'))
    await act(async () => {})
    expect(call).not.toHaveBeenCalled()
    view.rerender(tail('B'))
    expect(idle.size).toBe(1)
    await act(async () => { for (const callback of idle.values()) callback({ didTimeout: false, timeRemaining: () => 20 }) })
    expect(call.mock.calls).toEqual([['/dsh-mnemon-read', 'skill-activity', { sessionId: 'B' }]])
  })

  it('keeps the settling cadence during fast A/B/A switches instead of restarting a read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [] }))
    const tail = (sessionId: string) => <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId={sessionId} connection={handle} localeRuntime={localeRuntime} t={t} />
    const view = render(tail('A'))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    view.rerender(tail('B'))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    view.rerender(tail('A'))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(call.mock.calls.filter(([, , payload]) => payload.sessionId === 'A')).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(call.mock.calls.filter(([, , payload]) => payload.sessionId === 'A')).toHaveLength(2)
  })

  it('refreshes an empty cached result after a component switch or reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const changes = new MnemonChangeSignal()
    let snapshot: SkillActivitySnapshot = { available: false, turns: [], reviews: [] }
    const { handle } = connection(() => snapshot)
    render(<SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId="A" connection={handle} localeRuntime={localeRuntime} t={t} componentChanges={changes} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    snapshot = { available: true, turns: [{ turn: 1, skills: [{ name: 'newly-enabled', by: 'model' }] }], reviews: [] }
    act(() => changes.bump())
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(await screen.findByRole('button', { name: 'newly-enabled' })).not.toBeNull()
  })

  it('reads one snapshot for all newly rendered history tails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [] }))
    render(<>{[1, 2, 3, 4, 5].map(turn => <SkillTurnTail key={turn} turn={{ turn, status: 'closed' }} seq={turn * 10} sessionId="A" connection={handle} localeRuntime={localeRuntime} t={t} />)}</>)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(call).toHaveBeenCalledOnce()
  })

  it('pauses activity reads while the browser document is hidden and resumes pending reviews', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [{ turn: 1, state: 'reviewing', suggestions: [] }] }))
    render(<SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId="A" connection={handle} localeRuntime={localeRuntime} t={t} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call).not.toHaveBeenCalled()
    await act(async () => { visible.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(await screen.findByText(t('skillTail.reviewing'))).not.toBeNull()
    await act(async () => { visible.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
    const before = call.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call).toHaveBeenCalledTimes(before)
    await act(async () => { visible.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call.mock.calls.length).toBeGreaterThan(before)
  })

  it('names the skills a turn used, follows its review, and opens what it left on the Skills page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let snapshot: SkillActivitySnapshot = { available: true, turns: [{ turn: 3, skills: [{ name: 'release-notes', by: 'model' }] }], reviews: [{ turn: 3, state: 'reviewing', suggestions: [] }] }
    const { call, handle } = connection(() => snapshot)
    const opened = vi.fn()
    const stop = subscribeMnemonAnchor('session-a', opened)
    render(<SkillTurnTail turn={{ turn: 3, status: 'closed' }} seq={1} sessionId="session-a" connection={handle} localeRuntime={localeRuntime} t={t} />)
    expect(await screen.findByRole('button', { name: 'release-notes' })).not.toBeNull()
    expect(screen.getByText(t('skillTail.reviewing'))).not.toBeNull()
    expect(call).toHaveBeenCalledWith(expect.any(String), 'skill-activity', { sessionId: 'session-a' })
    snapshot = { ...snapshot, reviews: [{ turn: 3, state: 'suggested', suggestions: [{ id: 's1', skillName: 'release-notes', action: 'update', status: 'pending' }] }] }
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    fireEvent.click(await screen.findByRole('button', { name: t('skillTail.suggested', { count: 1 }) }))
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ page: SKILLS_PAGE, seed: 'suggestion:s1', sessionId: 'session-a' }))
    fireEvent.click(screen.getByRole('button', { name: 'release-notes' }))
    expect(opened).toHaveBeenLastCalledWith(expect.objectContaining({ page: SKILLS_PAGE, seed: 'name:release-notes' }))
    // Once the review has settled, the line stops reading.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    const settled = call.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(call).toHaveBeenCalledTimes(settled)
    stop()
  })

  it('stays out of a turn with nothing to say about skills, and out of an open turn', async () => {
    const quiet = connection(() => ({ available: true, turns: [], reviews: [{ turn: 1, state: 'nothing', suggestions: [] }] }))
    const { container } = render(<SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={1} sessionId="session-b" connection={quiet.handle} localeRuntime={localeRuntime} t={t} />)
    await waitFor(() => expect(quiet.call).toHaveBeenCalled())
    expect(container.textContent).toBe('')
    const open = connection(() => ({ available: true, turns: [], reviews: [] }))
    render(<SkillTurnTail turn={{ turn: 2, status: 'open' }} seq={2} sessionId="session-c" connection={open.handle} localeRuntime={localeRuntime} t={t} />)
    expect(open.call).not.toHaveBeenCalled()
  })
})
