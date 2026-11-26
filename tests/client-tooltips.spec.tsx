// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionHandle } from '../src/host/dsh.ts'
import type { Config } from '../src/host/config.ts'
import { MnemonActionSeat } from '../src/client/action-seat.ts'
import { MnemonDialog } from '../src/client/MnemonDialog.tsx'
import { MnemonTooltip } from '../src/client/tooltip.tsx'
import { MnemonTurnTail } from '../src/client/MnemonTurnTail.tsx'
import { MnemonWorkbench } from '../src/client/MnemonWorkbench.tsx'
import { SkillTurnTail } from '../src/client/SkillTurnTail.tsx'
import { ComponentChips, SettingsGear } from '../src/client/CompositionBoard.tsx'
import { PageSpinner, SectionSpinner } from '../src/client/page-kit.tsx'
import { translateEn } from '../src/client/locales.ts'
import { ProviderField } from '../plugins/dsh-mnemon-source-memory-spaces/src/client/provider-field.tsx'
import { MemoryGraph } from '../plugins/dsh-mnemon-source-memory-spaces/src/client/memory-graph.tsx'
import { MemoryGraph3D } from '../plugins/dsh-mnemon-source-memory-spaces/src/client/memory-graph-3d.tsx'
import { MoreMenu } from '../plugins/dsh-mnemon-source-skills/src/client/shared.tsx'
import { settingsScope } from './helpers/settings-scope.ts'

const resizeObservers = new Set<{ target: Element; notify: () => void }>()

globalThis.ResizeObserver = class {
  private readonly entries: Array<{ target: Element; notify: () => void }> = []
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    const entry = {
      target,
      notify: () => {
        this.callback([{ target, borderBoxSize: [{ inlineSize: 0, blockSize: 0 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
      },
    }
    this.entries.push(entry)
    resizeObservers.add(entry)
    entry.notify()
  }
  unobserve(target: Element): void {
    for (const entry of this.entries) {
      if (entry.target === target) resizeObservers.delete(entry)
    }
  }
  disconnect(): void {
    for (const entry of this.entries) resizeObservers.delete(entry)
    this.entries.length = 0
  }
} as unknown as typeof ResizeObserver

afterEach(() => {
  cleanup()
  resizeObservers.clear()
  vi.restoreAllMocks()
})

function setOverflow(element: Element, overflow: { scrollWidth: number; clientWidth: number; scrollHeight?: number; clientHeight?: number }): void {
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: overflow.scrollWidth })
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: overflow.clientWidth })
  if (overflow.scrollHeight !== undefined) Object.defineProperty(element, 'scrollHeight', { configurable: true, value: overflow.scrollHeight })
  if (overflow.clientHeight !== undefined) Object.defineProperty(element, 'clientHeight', { configurable: true, value: overflow.clientHeight })
}

function triggerResize(element: Element): void {
  act(() => {
    for (const entry of resizeObservers) {
      if (entry.target === element) entry.notify()
    }
  })
}

function createLocaleRuntime() {
  const snapshot = { active: 'en', locales: [], revision: 0 }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  }
}

function createMinimalStatusConnection(): ClientConnectionHandle {
  const call = vi.fn(async (_service: string, endpoint: string) => {
    if (endpoint === 'status') {
      return {
        ok: true as const,
        value: {
          healthy: true,
          commandFound: true,
          version: '0.2.14',
          dshMnemonVersion: '0.5.55',
          writeEnabled: true,
          lifecycleEnabled: true,
          memoryBodies: [],
          providerServices: [],
          storage: { activeKind: 'global', scopes: [] },
        },
      }
    }
    if (endpoint === 'sources') return { ok: true as const, value: { sources: [] } }
    return { ok: true as const, value: {} }
  })
  return { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle
}

describe('DSH Tooltip adoption across Mnemon Web UI', () => {
  it('shows MnemonTooltip on hover and keyboard focus and only when clipped if requested', () => {
    const { rerender } = render(
      <MnemonTooltip label="Full truncated value" onlyWhenClipped>
        <span data-testid="clipped-text">Full truncated value</span>
      </MnemonTooltip>,
    )
    const text = screen.getByTestId('clipped-text')
    expect(text.getAttribute('title')).toBeNull()
    setOverflow(text, { scrollWidth: 80, clientWidth: 80 })
    triggerResize(text)
    fireEvent.mouseEnter(text)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseLeave(text)

    setOverflow(text, { scrollWidth: 240, clientWidth: 80 })
    triggerResize(text)
    fireEvent.mouseEnter(text)
    const bubble = screen.getByRole('tooltip')
    expect(bubble.textContent).toBe('Full truncated value')
    expect(bubble.getAttribute('data-portal')).toBe('true')
    fireEvent.mouseLeave(text)
    expect(screen.queryByRole('tooltip')).toBeNull()

    rerender(
      <MnemonTooltip label="Action hint">
        <button type="button" aria-label="Action hint">Go</button>
      </MnemonTooltip>,
    )
    const button = screen.getByRole('button', { name: 'Action hint' })
    fireEvent.keyDown(window, { key: 'Tab' })
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip').textContent).toBe('Action hint')
    fireEvent.click(button)
    expect(screen.queryByRole('tooltip')).toBeNull()

    rerender(
      <MnemonTooltip label="Suppressed hint" disabled>
        <button type="button" aria-label="Suppressed hint">Locked</button>
      </MnemonTooltip>,
    )
    const suppressed = screen.getByRole('button', { name: 'Suppressed hint' })
    fireEvent.mouseEnter(suppressed)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseLeave(suppressed)

    rerender(
      <MnemonTooltip label="   ">
        <button type="button" aria-label="Blank hint">Blank</button>
      </MnemonTooltip>,
    )
    const blank = screen.getByRole('button', { name: 'Blank hint' })
    fireEvent.mouseEnter(blank)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('checks current overflow on the first hover and focus after the text bounds change', () => {
    const onFocus = vi.fn()
    render(
      <MnemonTooltip label="Full name" onlyWhenClipped clippedSelector="[data-label]">
        <button type="button" aria-describedby="existing-help" onFocus={onFocus}>
          <span data-label data-testid="text">Full name</span>
        </button>
      </MnemonTooltip>,
    )
    const button = screen.getByRole('button', { name: 'Full name' })
    const text = screen.getByTestId('text')
    setOverflow(text, { scrollWidth: 240, clientWidth: 80 })
    fireEvent.mouseEnter(button)
    expect(screen.getByRole('tooltip').textContent).toBe('Full name')
    fireEvent.mouseLeave(button)

    setOverflow(text, { scrollWidth: 80, clientWidth: 80 })
    fireEvent.keyDown(window, { key: 'Tab' })
    fireEvent.focus(button)
    expect(onFocus).toHaveBeenCalledOnce()
    expect(button.getAttribute('aria-describedby')).toBe('existing-help')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('uses DSH Tooltip instead of native title on MnemonWorkbench header actions', async () => {
    const connection = createMinimalStatusConnection()
    const scope = settingsScope<Config>({ status: 'ready', value: {}, writable: true, mode: 'host' })
    const configuration = new MnemonActionSeat()
    configuration.provide(vi.fn())
    render(
      <MnemonWorkbench
        connection={connection}
        settingsScope={scope}
        sessionId="session-1"
        locale="en"
        t={translateEn}
        configuration={configuration}
      />,
    )
    const refresh = await screen.findByRole('button', { name: translateEn('common.refresh') })
    const configure = screen.getByRole('button', { name: translateEn('header.configure') })
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false))
    expect(refresh.getAttribute('title')).toBeNull()
    expect(configure.getAttribute('title')).toBeNull()

    fireEvent.mouseEnter(refresh)
    expect(screen.getByRole('tooltip').textContent).toBe(translateEn('common.refresh'))
    fireEvent.mouseLeave(refresh)

    fireEvent.keyDown(window, { key: 'Tab' })
    fireEvent.focus(configure)
    expect(screen.getByRole('tooltip').textContent).toBe(translateEn('header.configure'))
    fireEvent.blur(configure)
  })

  it('uses portaled DSH Tooltip on MnemonDialog close button without native title', () => {
    render(
      <MnemonDialog title="Details" closeLabel="Close" onClose={vi.fn()}>
        <p>Body</p>
      </MnemonDialog>,
    )
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(close)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toBe('Close')
    expect(tooltip.getAttribute('data-portal')).toBe('true')
    fireEvent.mouseLeave(close)
  })

  it('uses DSH Tooltip on CompositionBoard gear, chips, and page spinners', () => {
    render(
      <div>
        <SettingsGear label="Configure strategy" onOpen={vi.fn()} />
        <ComponentChips chips={[
          { key: 'a', name: 'Memory Spaces', on: true, title: 'Required by capture', open: vi.fn() },
          { key: 'b', name: 'Runtime', on: false, title: 'Optional layer', open: undefined },
        ]} />
        <PageSpinner label="Rechecking status" />
        <SectionSpinner label="Loading results" />
      </div>,
    )
    const gear = screen.getByRole('button', { name: 'Configure strategy' })
    expect(gear.getAttribute('title')).toBeNull()
    fireEvent.keyDown(window, { key: 'Tab' })
    fireEvent.focus(gear)
    expect(screen.getByRole('tooltip').textContent).toBe('Configure strategy')
    fireEvent.blur(gear)

    const linkButton = screen.getByRole('button', { name: 'Memory Spaces' })
    expect(linkButton.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(linkButton)
    expect(screen.getByRole('tooltip').textContent).toBe('Required by capture')
    fireEvent.mouseLeave(linkButton)

    const staticChip = screen.getByText('Runtime')
    expect(staticChip.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(staticChip)
    expect(screen.getByRole('tooltip').textContent).toBe('Optional layer')
    fireEvent.mouseLeave(staticChip)

    const spinner = screen.getByRole('status', { name: 'Rechecking status' })
    expect(spinner.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(spinner)
    expect(screen.getByRole('tooltip').textContent).toBe('Rechecking status')
    fireEvent.mouseLeave(spinner)
  })

  it('uses clipped DSH Tooltip on MnemonTurnTail items and DSH Tooltip on SkillTurnTail controls', async () => {
    const rpcCall = vi.fn(async (_service: string, endpoint: string) => {
      if (endpoint === 'turn-activities') {
        return {
          ok: true as const,
          value: {
            cursor: 4,
            activities: [{
              turn: 1,
              count: 1,
              names: ['mnemon_recall'],
              recalls: 1,
              writes: 0,
              documentSearches: 0,
              inspections: 0,
              failures: 0,
              retrieved: [{
                callId: 'c1',
                toolName: 'mnemon_recall',
                operationId: 'recall',
                sourceTypeId: 'memory-spaces',
                items: [{ id: 'm1', title: 'Lumen', excerpt: 'Long recalled memory sentence clipped in narrow turn bar' }],
              }],
            }],
          },
        }
      }
      return {
        ok: true as const,
        value: {
          available: true,
          turns: [{ turn: 1, skills: [{ name: 'release-check', by: 'model' }] }],
          reviews: [{ turn: 1, state: 'error', error: 'Subagent timed out', suggestions: [] }],
        },
      }
    })
    const connection = { rpc: { call: rpcCall }, isLoopback: true } as unknown as ClientConnectionHandle
    const localeRuntime = createLocaleRuntime()

    render(
      <div>
        <MnemonTurnTail turn={{ turn: 1, status: 'closed' }} seq={4} openFile={vi.fn()} sessionId="s1" connection={connection} localeRuntime={localeRuntime} t={translateEn} />
        <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={4} sessionId="s1" connection={connection} localeRuntime={localeRuntime} t={translateEn} />
      </div>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /Turn memory/u }))
    const itemText = await screen.findByText('Long recalled memory sentence clipped in narrow turn bar')
    const itemButton = itemText.closest('button')!
    expect(itemButton.getAttribute('title')).toBeNull()

    setOverflow(itemText, { scrollWidth: 100, clientWidth: 100 })
    triggerResize(itemText)
    fireEvent.mouseEnter(itemButton)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseLeave(itemButton)

    setOverflow(itemText, { scrollWidth: 320, clientWidth: 100 })
    triggerResize(itemText)
    fireEvent.mouseEnter(itemButton)
    expect(screen.getByRole('tooltip').textContent).toBe('Long recalled memory sentence clipped in narrow turn bar')
    fireEvent.mouseLeave(itemButton)

    const skillButton = await screen.findByRole('button', { name: 'release-check' })
    expect(skillButton.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(skillButton)
    expect(screen.getByRole('tooltip').textContent).toBe(translateEn('skillTail.openSkill', { name: 'release-check' }))
    fireEvent.mouseLeave(skillButton)

    const failed = screen.getByText(translateEn('skillTail.failed'))
    expect(failed.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(failed)
    expect(screen.getByRole('tooltip').textContent).toBe('Subagent timed out')
    fireEvent.mouseLeave(failed)
  })

  it('uses DSH Tooltip on ProviderField secret toggle, graph controls, and Skills MoreMenu', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const graph = {
      generatedAt: '2026-11-25T00:00:00Z',
      nodes: [{ id: 'n1', kind: 'memory' as const, content: 'Fact 1', category: 'decision', importance: 3, color: '#4f7cff' }],
      edges: [],
      sources: [],
    }
    render(
      <div>
        <ProviderField
          field={{ key: 'apiKey', label: 'API Key', input: 'secret', required: false, scope: 'service' }}
          value="secret-value"
          saved={false}
          layout="settings"
          onChange={vi.fn()}
        />
        <MemoryGraph graph={graph} onSelect={vi.fn()} quiet={false} onQuietChange={vi.fn()} />
        <MemoryGraph3D graph={graph} onSelect={vi.fn()} quiet={false} onQuietChange={vi.fn()} />
        <MoreMenu label="More actions" items={[{ id: 'edit', label: 'Edit' }]} onSelect={vi.fn()} />
      </div>,
    )

    const secretButton = screen.getByRole('button', { name: /显示凭证|Show credential/u })
    expect(secretButton.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(secretButton)
    expect(screen.getByRole('tooltip').textContent).toBe(secretButton.getAttribute('aria-label'))
    fireEvent.mouseLeave(secretButton)

    const zoomIn = screen.getByRole('button', { name: /放大|Zoom in/u })
    expect(zoomIn.getAttribute('title')).toBeNull()
    fireEvent.keyDown(window, { key: 'Tab' })
    fireEvent.focus(zoomIn)
    expect(screen.getByRole('tooltip').textContent).toBe(zoomIn.getAttribute('aria-label'))
    fireEvent.blur(zoomIn)

    const moreButton = screen.getByRole('button', { name: 'More actions' })
    expect(moreButton.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(moreButton)
    expect(screen.getByRole('tooltip').textContent).toBe('More actions')
    fireEvent.click(moreButton)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
