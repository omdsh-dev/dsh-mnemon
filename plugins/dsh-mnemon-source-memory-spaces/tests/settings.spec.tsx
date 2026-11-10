// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryComponentConfigurationSnapshot, MemoryComponentHost } from 'dsh-mnemon/client'
import type { MemoryProviderConfigField, MemoryProviderDescriptor } from '../src/contracts.ts'
import { descriptor as openviking } from 'dsh-mnemon-provider-openviking'

// Load the installed Core's actual DSH browser artifact; no repository source alias.
const { artifact } = vi.hoisted(() => ({ artifact: async () => {
  const { createRequire } = await import('node:module')
  const { loadMemoryClientArtifact } = await import('dsh-mnemon/testing')
  return loadMemoryClientArtifact<Record<string, unknown>>(createRequire(import.meta.url).resolve('dsh-mnemon/client'), {
    react: await vi.importActual('react'),
    'react/jsx-runtime': await vi.importActual('react/jsx-runtime'),
    'react-dom': await vi.importActual('react-dom'),
    '@deepseek-ai/dsh-client-ui-primitives': await vi.importActual('@deepseek-ai/dsh-client-ui-primitives'),
  })
} }))
vi.mock('dsh-mnemon/client', artifact)
afterEach(cleanup)

import { MemorySourcePageFrame, translateEn as t, translateZh } from 'dsh-mnemon/client'
import type { DshLocale } from '../src/client/presentation.ts'
import { ProviderField } from '../src/client/provider-field.tsx'
import { MemorySpacesSettings } from '../src/client/settings.tsx'

const field = (input: MemoryProviderConfigField['input'], values: Partial<MemoryProviderConfigField> = {}): MemoryProviderConfigField =>
  ({ key: 'apiKey', label: 'API key', scope: 'service', input, required: true, ...values })

/** A host as dsh-mnemon lends one, over a configuration the test controls. */
function host(value: Record<string, unknown>, operations: Partial<Record<'read' | 'write', (operation: string, input?: unknown) => Promise<unknown>>> = {}, readback?: (next: unknown) => unknown) {
  let snapshot: MemoryComponentConfigurationSnapshot = { status: 'ready', value, revision: 1, writable: true }
  const listeners = new Set<() => void>()
  const set = vi.fn(async (key: string, next: unknown) => {
    snapshot = { ...snapshot, value: { ...snapshot.value, [key]: readback?.(next) ?? next }, revision: (snapshot.revision ?? 0) + 1 }
    for (const listener of listeners) listener()
  })
  const changed = vi.fn()
  const lent: MemoryComponentHost = {
    configuration: { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, set },
    operations: {
      read: operations.read ?? (async operation => { throw new Error('unexpected read ' + operation) }),
      write: operations.write ?? (async operation => { throw new Error('unexpected write ' + operation) }),
    },
    changed,
    retained: new Map(),
  }
  return { lent, set, changed }
}
const settings = (lent: MemoryComponentHost, enabled = true) => <MemorySpacesSettings component={{ packageName: 'dsh-mnemon-source-memory-spaces', label: 'Memory Spaces', enabled }} writable language="en" host={lent} />

describe('one Provider field, drawn as each place draws it', () => {
  it('shows a saved credential on the configuration page as a mask that what is typed replaces', () => {
    const onChange = vi.fn()
    render(<MemorySourcePageFrame locale="en"><ProviderField field={field('secret')} value="" saved layout="settings" onChange={onChange} /></MemorySourcePageFrame>)
    const input = screen.getByLabelText('API key') as HTMLInputElement
    expect(input.value).toBe('••••••••••••')
    expect(input.type).toBe('password')
    expect(input.placeholder).toBe(t('overview.providerApiKeyOptional'))
    expect(input.required).toBe(false)
    expect(input.autocomplete).toBe('new-password')
    fireEvent.click(screen.getByRole('button', { name: t('config.providerSecretShow') }))
    expect(input.type).toBe('text')
    expect(input.value).toBe(t('config.providerSecretStoredValue'))
    fireEvent.change(input, { target: { value: t('config.providerSecretStoredValue') + 'typed-secret' } })
    expect(onChange).toHaveBeenCalledWith('typed-secret')
  })

  it('leaves a saved credential out of a dialog\'s field, which says it is kept when left empty', () => {
    const onChange = vi.fn()
    render(<MemorySourcePageFrame locale="en"><ProviderField field={field('secret')} value="" saved layout="dialog" onChange={onChange} /></MemorySourcePageFrame>)
    const input = screen.getByLabelText('API key') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.type).toBe('password')
    expect(input.placeholder).toBe(t('overview.providerApiKeyKeep'))
    expect(input.required).toBe(false)
    expect(input.autocomplete).toBe('new-password')
    expect(screen.queryByRole('button', { name: t('config.providerSecretShow') })).toBeNull()
    fireEvent.change(input, { target: { value: 'typed-secret' } })
    expect(onChange).toHaveBeenCalledWith('typed-secret')
  })

  it('asks for a credential where none is saved, and again while a dialog clears a saved one', () => {
    const view = render(<MemorySourcePageFrame locale="en"><ProviderField field={field('secret')} value="" saved={false} layout="dialog" onChange={vi.fn()} /></MemorySourcePageFrame>)
    expect((screen.getByLabelText('API key') as HTMLInputElement).required).toBe(true)
    expect((screen.getByLabelText('API key') as HTMLInputElement).placeholder).toBe(t('overview.providerApiKeyOptional'))
    view.rerender(<MemorySourcePageFrame locale="en"><ProviderField field={field('secret')} value="" saved clearing layout="dialog" onChange={vi.fn()} onClearChange={vi.fn()} /></MemorySourcePageFrame>)
    expect((screen.getByLabelText('API key') as HTMLInputElement).required).toBe(true)
    expect((screen.getByRole('checkbox', { name: t('overview.providerSecretClear') }) as HTMLInputElement).checked).toBe(true)
    view.rerender(<MemorySourcePageFrame locale="en"><ProviderField field={field('secret')} value="" saved={false} layout="settings" onChange={vi.fn()} /></MemorySourcePageFrame>)
    expect((screen.getByLabelText('API key') as HTMLInputElement).required).toBe(true)
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  })

  it('shows what is typed on the configuration page, and offers clearing only where a dialog edits a space', () => {
    const onClearChange = vi.fn()
    const view = render(<MemorySourcePageFrame locale="en"><ProviderField field={field('secret')} value="typed" saved layout="settings" onChange={vi.fn()} /></MemorySourcePageFrame>)
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('config.providerSecretShow') }))
    expect((screen.getByLabelText('API key') as HTMLInputElement).type).toBe('text')
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('typed')
    view.rerender(<MemorySourcePageFrame locale="en"><ProviderField field={field('secret')} value="" saved layout="dialog" onChange={vi.fn()} onClearChange={onClearChange} /></MemorySourcePageFrame>)
    expect(screen.queryByRole('button', { name: t('config.providerSecretShow') })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: t('overview.providerSecretClear') }))
    expect(onClearChange).toHaveBeenCalledWith(true)
  })

  it('draws a switch and a choice the way each place does', () => {
    const choice = field('select', { key: 'mode', label: 'Mode', options: [{ value: 'cloud', label: 'Cloud' }, { value: 'self-hosted', label: 'Self-hosted' }] })
    const view = render(<MemorySourcePageFrame locale="en"><ProviderField field={field('boolean', { key: 'rerank', label: 'Rerank' })} value layout="settings" saved={false} onChange={vi.fn()} />
      <ProviderField field={choice} value="cloud" layout="settings" saved={false} onChange={vi.fn()} /></MemorySourcePageFrame>)
    // The configuration page: the label beside the box, and the choice's own label.
    expect(screen.getByRole('checkbox', { name: 'Rerank' }).closest('label')?.lastChild?.textContent).toBe('Rerank')
    expect(screen.getByText('Mode').closest('label')).toBeNull()
    view.rerender(<MemorySourcePageFrame locale="en"><ProviderField field={field('boolean', { key: 'rerank', label: 'Rerank' })} value layout="dialog" saved={false} onChange={vi.fn()} />
      <ProviderField field={choice} value="cloud" layout="dialog" saved={false} onChange={vi.fn()} /></MemorySourcePageFrame>)
    // A dialog: the label above, the choice's own label kept for assistive technology.
    expect(screen.getByRole('checkbox', { name: 'Rerank' }).closest('label')?.firstChild?.textContent).toBe('Rerank')
    expect(screen.getAllByText('Mode')[0]!.closest('label')).not.toBeNull()
  })
})

describe('Memory Spaces\' own settings', () => {
  it('saves a Provider\'s service through what dsh-mnemon lends, and tells the Memory System', async () => {
    const provider: MemoryProviderDescriptor = openviking
    const write = vi.fn(async (_operation: string, input?: unknown) => ({ providerId: 'openviking', enabled: true, configured: true, settings: (input as { settings: Record<string, string> }).settings, configuredSecrets: ['apiKey'] }))
    const read = vi.fn(async (operation: string) => operation === 'provider-services'
      ? { providers: [provider], items: [{ providerId: 'openviking', enabled: true, configured: true, settings: { endpoint: 'http://127.0.0.1:1933', account: 'default' }, configuredSecrets: ['apiKey'] }], generatedAt: '2026-10-17T00:00:00.000Z' }
      : { commandFound: true })
    const { lent, changed } = host({ storageScope: 'global' }, { read, write })
    render(settings(lent))
    const card = await screen.findByRole('group', { name: `OpenViking ${t('config.providerServiceTitle')}` })
    await waitFor(() => expect((within(card).getAllByRole('button')[0] as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(card).getAllByRole('button')[0]!)
    const apiKey = within(card).getByLabelText('API Key') as HTMLInputElement
    expect(apiKey.value).toBe('••••••••••••')
    fireEvent.click(within(card).getByRole('button', { name: t('config.saveProviderService') }))
    // The mask is not a value: saving leaves the saved credential as it is.
    await waitFor(() => expect(write).toHaveBeenCalledWith('provider-service-update', { providerId: 'openviking', settings: { endpoint: 'http://127.0.0.1:1933', account: 'default' }, enabled: true }))
    expect(await within(card).findByText(t('config.providerServiceSaved'))).toBeTruthy()
    expect(changed).toHaveBeenCalledOnce()
  })

  it('applies DSH management of the embedding through the key it owns', async () => {
    const { lent, set } = host({ storageScope: 'global' }, { read: async operation => operation === 'provider-services' ? { providers: [], items: [], generatedAt: 'now' } : { commandFound: true } })
    render(settings(lent))
    fireEvent.click(screen.getByRole('switch', { name: t('config.embeddingManaged') }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('embedding', { enabled: true, endpoint: 'http://localhost:11434', model: 'nomic-embed-text', protocol: 'auto', apiKey: '' }))
    expect(await screen.findByRole('textbox', { name: t('config.embeddingEndpoint') })).toBeTruthy()
  })

  it('reads no Provider while Memory Spaces is off', () => {
    const read = vi.fn()
    render(settings(host({}, { read }).lent, false))
    expect(screen.getByText(t('spaces.offNote'))).toBeTruthy()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('translating as dsh-mnemon drew these settings, through DSH\'s language chain', () => {
  const locales = [{ id: 'en' }, { id: 'zh', fallback: 'en' }, { id: 'ja', fallback: 'en' }]
  /** DSH's language service over dsh-mnemon's own zh and en copy, with a `ja` pack that may translate some keys. */
  function dsh(active: string, pack: Record<string, string> = {}): DshLocale {
    const own = active === 'zh' ? translateZh : t
    return {
      // DSH walks the chain in the namespace, then shows the key itself.
      bind: () => (key, params) => (active === 'ja' ? pack[key] : undefined) ?? (own(key, params) as string | undefined) ?? key,
      getSnapshot: () => ({ active, locales }),
      subscribe: () => () => {},
    }
  }
  const read = async (operation: string) => operation === 'provider-services' ? { providers: [], items: [], generatedAt: 'now' } : { commandFound: true }
  const settings = (locale: DshLocale, language: string, enabled = true) =>
    render(<MemorySpacesSettings component={{ packageName: 'dsh-mnemon-source-memory-spaces', label: 'Memory Spaces', enabled }} writable language={language} host={host({}, { read }).lent} locale={locale} />)

  it('reads English for a language pack that falls back to English, as dsh-mnemon drew them', () => {
    settings(dsh('ja'), 'ja')
    expect(screen.getByRole('heading', { name: t('config.providersTitle') })).toBeTruthy()
  })

  it('takes what a language pack translates in dsh-mnemon\'s namespace', () => {
    settings(dsh('ja', { 'config.providersTitle': 'メモリプロバイダー' }), 'ja')
    expect(screen.getByRole('heading', { name: 'メモリプロバイダー' })).toBeTruthy()
  })

  it('answers from its own copy in Chinese and English', () => {
    settings(dsh('zh'), 'zh')
    expect(screen.getByRole('heading', { name: translateZh('config.providersTitle') })).toBeTruthy()
    cleanup()
    settings(dsh('en'), 'en', false)
    expect(screen.getByText(t('spaces.offNote'))).toBeTruthy()
  })
})

describe('registering its own settings', () => {
  const slots = () => {
    const registered: Array<{ name: string; key?: string; id?: string }> = []
    return { registered, slots: {
      inject: (_name: string, setup: () => () => void) => setup(),
      register: (options: { name: string; key?: string; id?: string }) => { registered.push(options); return () => {} },
    } }
  }

  it('registers them beside its pages where dsh-mnemon yields the ones it keeps', async () => {
    const { apply } = await import('../src/client/ui.tsx')
    const { registered, slots: ctxSlots } = slots()
    apply({ slots: ctxSlots, locale: { bind: () => t } } as never)
    expect(registered.filter(options => options.name === 'mnemon.component.settings')).toEqual([{ name: 'mnemon.component.settings', key: 'dsh-mnemon-source-memory-spaces' }])
  })

  it('registers none where dsh-mnemon 0.5.31 or earlier draws them itself', async () => {
    // The CommonJS bundle reads an export that dsh-mnemon lacks as undefined.
    vi.doMock('dsh-mnemon/client', async () => ({ ...await artifact(), MNEMON_COMPONENT_FALLBACK_PRIORITY: undefined }))
    vi.resetModules()
    try {
      const { apply } = await import('../src/client/ui.tsx')
      const { registered, slots: ctxSlots } = slots()
      apply({ slots: ctxSlots, locale: { bind: () => t } } as never)
      expect(registered.filter(options => options.name === 'mnemon.component.settings')).toEqual([])
      expect(registered.filter(options => options.name === 'mnemon.source.page')).toHaveLength(5)
    } finally {
      vi.doMock('dsh-mnemon/client', artifact)
      vi.resetModules()
    }
  })
})


describe('write-only embedding credentials', () => {
  const saved = { enabled: true, endpoint: 'https://embedding.example.test/v1', model: 'fixture', protocol: 'openai', apiKey: '', apiKeyStorage: 'credentials', apiKeyConfigured: true }
  it('clears a typed key after saving and never uses a stored-key mask as the replacement', async () => {
    const { lent, set } = host({ embedding: saved }, {}, () => saved)
    render(settings(lent))
    const keyInput = screen.getByRole('textbox', { name: t('config.embeddingEndpoint') })
    expect(keyInput).toBeTruthy()
    const password = screen.getByLabelText(t('config.embeddingApiKey')) as HTMLInputElement
    expect(password.value).toBe('')
    fireEvent.change(password, { target: { value: 'fixture-ui-key' } })
    fireEvent.click(screen.getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(password.value).toBe(''))
    expect(set).toHaveBeenCalledWith('embedding', expect.objectContaining({ apiKey: 'fixture-ui-key', apiKeyEnv: '' }))
    expect(screen.getByText('A DSH credential reference is saved; the key is never returned to this page.')).toBeTruthy()
  })

  it('sends a variable name without a key, rejects invalid names, and provides explicit reference removal', async () => {
    const { lent, set } = host({ embedding: saved }, {}, () => ({ ...saved, apiKeyStorage: 'none', apiKeyConfigured: false }))
    render(settings(lent))
    fireEvent.change(screen.getByLabelText('API key environment variable (optional)'), { target: { value: 'INVALID NAME' } })
    expect((screen.getByRole('button', { name: t('options.apply') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('API key environment variable (optional)'), { target: { value: 'FIXTURE_EMBED_KEY' } })
    fireEvent.click(screen.getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('embedding', expect.objectContaining({ apiKey: '', apiKeyEnv: 'FIXTURE_EMBED_KEY' })))
    fireEvent.click(screen.getByRole('checkbox', { name: "Remove this connection's key and environment variable references" }))
    fireEvent.click(screen.getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('embedding', expect.objectContaining({ apiKey: '', apiKeyEnv: '', clearApiKey: true })))
  })

  it('migrates the Host-retained legacy key without sending it to the editor or back over the wire', async () => {
    const { lent, set } = host({ embedding: { ...saved, apiKeyStorage: 'legacy' } }, {}, () => saved)
    render(settings(lent))
    expect((screen.getByLabelText(t('config.embeddingApiKey')) as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Move the existing plaintext key to DSH credentials' }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('embedding', expect.objectContaining({ apiKey: '' })))
    expect(screen.queryByRole('button', { name: 'Move the existing plaintext key to DSH credentials' })).toBeNull()
  })

  it('keeps an older Starter connection usable without accepting new plaintext secrets', async () => {
    const { lent, set } = host({ embedding: { enabled: true, endpoint: saved.endpoint, model: 'fixture', apiKey: 'legacy-fixture' } })
    render(settings(lent))
    const password = screen.getByLabelText(t('config.embeddingApiKey')) as HTMLInputElement
    expect(password.value).toBe('')
    expect(password.disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: t('config.embeddingManaged') }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('embedding', expect.objectContaining({ enabled: false, apiKey: 'legacy-fixture' })))
  })
})
