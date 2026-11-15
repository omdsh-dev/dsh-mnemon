// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL as NodeURL } from 'node:url'
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { strategy } from './fixture.ts'

configure({ asyncUtilTimeout: 5000 })

const { settingsSupport } = vi.hoisted(() => ({ settingsSupport: vi.fn(() => false) }))
beforeEach(() => settingsSupport.mockReturnValue(false))

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
  // Explicit new-host capability fixture; a generic callback on an old host stays false.
  return { ...client, supportsMemoryComponentSettingsSection: settingsSupport }
})

import * as plugin from '../src/index.ts'
import { inject as clientInject, installSkillsMemoryUI, SkillsSourcePage } from '../src/client.ts'
import { draftWithSkill, installSkillUseBridge, requestSkillUse, SKILL_USE_SLOT, SkillUseBridge } from '../src/client/use-skill.tsx'
import { css, translate } from '../src/client/presentation.ts'
import { skillsPageClient } from '../src/client/api.ts'
import { compareRuns } from '../src/client/evolution-page.tsx'
import type { BacktestRun, CaseResult, EvalCase, ReviewRecordInput, SkillSummary, TrashEntry } from '../src/contracts.ts'

globalThis.ResizeObserver ??= class {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ target, borderBoxSize: [{ inlineSize: 0, blockSize: 0 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

const t = translate('en')
/** An accessible name made of these parts in order, however its markup spaces them. */
const named = (...parts: string[]) => new RegExp(parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s*'), 'u')
let directory: string
let runner: MemoryCompositionRunner
let management: Awaited<ReturnType<MemoryCompositionRunner['managementClient']>>
const skillPath = () => join(directory, 'dsh', 'skills', 'release-notes', 'SKILL.md')
const SKILL = '---\nname: release-notes\ndescription: Write release notes from a changelog.\n---\n\n# Release notes\n\n1. Read CHANGELOG.md\n'

async function mutate(operation: string, input: unknown) {
  const { revision } = await management.read('revision', null)
  return (await management.mutate(operation, JSON.parse(JSON.stringify(input)), { confirmed: true, expectedRevision: revision })).value
}

function review(): ReviewRecordInput {
  const at = new Date().toISOString()
  return {
    review: { at, sessionId: 'session-1', sessionTitle: 'Release v2', trigger: 'automatic', durationMs: 10, outcome: 'suggested', summary: 'The user corrected the grouping.' },
    trajectory: {
      sessionId: 'session-1', sessionTitle: 'Release v2', startedAt: at, endedAt: at,
      stats: { turns: 2, userCharacters: 120, toolCalls: 2, toolFailures: 1, uniqueTools: 1, skills: ['release-notes'] },
      steps: [
        { index: 1, turn: 1, kind: 'user', text: 'Write the v2 release notes' },
        { index: 2, turn: 1, kind: 'skill', text: 'release-notes', skill: { name: 'release-notes', by: 'model' } },
        { index: 3, turn: 1, kind: 'tool', text: 'not a git repository', tool: { name: 'bash', ok: false, input: 'command=git log', error: 'not a git repository' } },
        { index: 4, turn: 2, kind: 'user', text: 'Group them by component from now on' },
      ],
      annotations: [],
    },
    annotations: [{ step: 4, signal: 'correction', note: 'Grouping by component was missing' }],
    suggestions: [{ skillName: 'release-notes', action: 'update', summary: 'Group entries by component', rationale: 'Corrected twice.', confidence: 0.82, signals: ['correction'], steps: [3, 4] }],
    cases: [{ skillName: 'release-notes', title: 'Grouped notes', prompt: 'Write v2 release notes', checks: [{ text: 'Grouped by component', must: true }], steps: [1, 4] }],
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mnemon-skills-client-'))
  mkdirSync(join(directory, 'dsh', 'skills', 'release-notes'), { recursive: true })
  mkdirSync(join(directory, 'workspace'))
  writeFileSync(skillPath(), SKILL)
  runner = new MemoryCompositionRunner()
  await runner.mount(strategy, { instanceId: 'strategy' })
  await runner.mount(plugin, { instanceId: 'skills', config: { dataDir: join(directory, 'data'), dshHome: join(directory, 'dsh'), agentsHome: join(directory, 'agents') } })
  management = await runner.managementClient('source:skills', { storage: 'custom', workspaceId: join(directory, 'workspace') })
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await runner.dispose()
  rmSync(directory, { recursive: true, force: true })
})

function page(navigationInput: { seed: string; nonce: number } = { seed: 'skill:user-dsh:release-notes', nonce: 1 }) {
  return render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable management={management} {...(navigationInput === undefined ? {} : { navigationInput })} />)
}

describe('Skills page', () => {
  it.each([true, false])('keeps a selected directory folded across catalog refreshes (writable=%s, #627)', async writable => {
    const props = { sourceTypeId: 'skills', sourceInstanceKey: 'source:skills', sourceInstances: [], locale: 'en', writable, management }
    const location = { seed: 'skill:user-dsh:release-notes', nonce: 1 }
    const view = render(<SkillsSourcePage {...props} navigationInput={location} refreshKey={0} />)
    await screen.findByRole('heading', { name: 'release-notes' })
    const group = await screen.findByRole('button', { name: new RegExp(t('root.user-dsh'), 'u') })
    fireEvent.click(group)
    expect(group.getAttribute('aria-expanded')).toBe('false')

    writeFileSync(skillPath(), SKILL.replace('Write release notes from a changelog.', 'Updated catalog description.'))
    view.rerender(<SkillsSourcePage {...props} navigationInput={location} refreshKey={1} />)
    await screen.findByText('Updated catalog description.')
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('switch', { name: t('skills.toggle', { name: 'release-notes' }) })).toBeNull()

    // An explicit link still reveals the same selected skill after a user folds its group.
    view.rerender(<SkillsSourcePage {...props} navigationInput={{ ...location, nonce: 2 }} refreshKey={1} />)
    await waitFor(() => expect(group.getAttribute('aria-expanded')).toBe('true'))
    expect(screen.getByRole('switch', { name: t('skills.toggle', { name: 'release-notes' }) })).not.toBeNull()
  })

  it('folds source directories without hiding search results or a direct selection (#617)', async () => {
    page()
    const group = await screen.findByRole('button', { name: new RegExp(t('root.user-dsh'), 'u') })
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(group.textContent).toContain(join(directory, 'dsh', 'skills'))
    fireEvent.click(group)
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('switch', { name: t('skills.toggle', { name: 'release-notes' }) })).toBeNull()
    expect(screen.getByRole('heading', { name: 'release-notes' })).not.toBeNull()
    const search = screen.getByRole('textbox', { name: t('skills.search') })
    fireEvent.change(search, { target: { value: 'release' } })
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('switch', { name: t('skills.toggle', { name: 'release-notes' }) })).not.toBeNull()
    fireEvent.change(search, { target: { value: '' } })
    expect(group.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(group)
    expect(group.getAttribute('aria-expanded')).toBe('true')
  })

  it.each(['skill', 'draft'] as const)('keeps a linked %s readable while disabling writes', async view => {
    const draft = await mutate('draft-record', { skillName: 'release-notes', content: SKILL, notes: '', changes: [], guidance: [] }) as { id: string }
    const entry = join(directory, 'dsh', 'skills', 'release-notes')
    const upstream = join(directory, 'upstream')
    renameSync(entry, upstream)
    symlinkSync(upstream, entry, process.platform === 'win32' ? 'junction' : 'dir')
    page(view === 'draft' ? { seed: `draft:${draft.id}`, nonce: 1 } : undefined)
    await screen.findByText(t('skills.linkedReadOnly'))
    if (view === 'skill') {
      expect((screen.getByRole('button', { name: t('common.edit') }) as HTMLButtonElement).disabled).toBe(true)
      expect((screen.getByRole('switch', { name: t('skills.toggle', { name: 'release-notes' }) }) as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByRole('button', { name: /^release-notes\s/u }).textContent).not.toContain(t('skills.linkedReadOnly'))
      expect(screen.getAllByRole('button', { name: t('skills.use') }).every(button => !(button as HTMLButtonElement).disabled)).toBe(true)
    } else {
      expect((screen.getByRole('button', { name: t('draft.adopt') }) as HTMLButtonElement).disabled).toBe(true)
      expect((screen.getByRole('button', { name: t('draft.discard') }) as HTMLButtonElement).disabled).toBe(false)
    }
    expect(readFileSync(join(upstream, 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('edits the original linked skill only when the Source explicitly allows updates (#611)', async () => {
    const entry = join(directory, 'dsh', 'skills', 'release-notes')
    const upstream = join(directory, 'upstream')
    renameSync(entry, upstream)
    symlinkSync(upstream, entry, process.platform === 'win32' ? 'junction' : 'dir')
    await runner.dispose()
    runner = new MemoryCompositionRunner()
    await runner.mount(strategy, { instanceId: 'strategy' })
    await runner.mount(plugin, { instanceId: 'skills', config: { dataDir: join(directory, 'data'), dshHome: join(directory, 'dsh'), agentsHome: join(directory, 'agents'), allowLinkedUpdates: true } })
    management = await runner.managementClient('source:skills', { storage: 'custom', workspaceId: join(directory, 'workspace') })
    page()
    await screen.findByText(t('skills.linkedWritable'))
    expect(screen.queryByText(t('skills.linked'))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('common.edit') }))
    const content = SKILL + '\n2. Group notes by component.\n'
    fireEvent.change(screen.getByRole('textbox', { name: 'SKILL.md' }), { target: { value: content } })
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))
    await waitFor(() => expect(readFileSync(join(upstream, 'SKILL.md'), 'utf8')).toBe(content))
  })

  it('does not retry a skill file hash conflict as a Source revision conflict', async () => {
    const mutation = vi.spyOn(management, 'mutate').mockRejectedValue(new Error('release-notes changed since it was read; reload it and try again'))
    await expect(skillsPageClient(management).adoptDraft('draft-id')).rejects.toThrow('changed since it was read')
    expect(mutation).toHaveBeenCalledTimes(1)
  })

  it('keeps cancellation unavailable to a read-only page and rejects an unconfirmed write', async () => {
    const draft = await mutate('draft-record', { skillName: 'release-notes', content: SKILL, notes: '', changes: [], guidance: [] }) as { id: string }
    const entry = await mutate('case-save', { skillName: 'release-notes', title: 'Case', prompt: 'Check', checks: [{ text: 'Pass', must: true }], enabled: true }) as { id: string }
    const run = await mutate('run-start', { skillName: 'release-notes', target: { kind: 'draft', draftId: draft.id }, caseIds: [entry.id] }) as { id: string }
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable={false} management={management} navigationInput={{ seed: `draft:${draft.id}`, nonce: 1 }} />)
    expect((await screen.findByRole('button', { name: t('draft.cancelBacktest') }, { timeout: 5_000 }) as HTMLButtonElement).disabled).toBe(true)
    const { revision } = await management.read('revision', null)
    await expect(runner.executeManagement({ sourceInstanceKey: 'source:skills', scope: { storage: 'custom', workspaceId: join(directory, 'workspace') }, mode: 'mutate', operation: 'run-cancel', input: { id: run.id }, confirmed: false, expectedRevision: revision })).rejects.toThrow('confirmation')
    expect((await management.read('run', { id: run.id })).value).toMatchObject({ status: 'running' })
  })

  it('shows automatic adoption reasons and both scores on the retained review draft', async () => {
    const result = await mutate('review-record', review()) as { suggestionIds: string[] }
    const id = result.suggestionIds[0]!
    await mutate('draft-record', { suggestionId: id, skillName: 'release-notes', content: SKILL, notes: '', changes: [], guidance: [] })
    await mutate('auto-adoption-record', { id, stage: 'rewriting', attempt: 1, reason: 'regressed', baselineScore: 1, draftScore: 0.5 })
    await mutate('auto-adoption-record', { id, stage: 'review', attempt: 3, reason: 'regressed', baselineScore: 1, draftScore: 0.5 })
    page({ seed: `suggestion:${id}`, nonce: 1 })
    const panel = await screen.findByRole('region', { name: t('evolution.auto.title') })
    expect(panel.textContent).toContain(t('evolution.auto.stage.review'))
    expect(panel.textContent).toContain('Baseline 100 / draft 50')
    expect(panel.textContent).toContain('Attempt 3')
    fireEvent.click(within(panel).getByRole('button', { name: t('evolution.auto.history') }))
    expect(panel.textContent).toContain('Attempt 1')
    expect(panel.textContent).toContain(t('evolution.auto.reason.regressed'))
    expect(await screen.findByRole('button', { name: t('draft.adopt') })).not.toBeNull()
  })

  it('shows stale-file recovery and regenerates with backtests without overwriting the current file', async () => {
    const draft = await mutate('draft-record', { skillName: 'release-notes', content: SKILL, notes: '', changes: [], guidance: [] }) as { id: string }
    writeFileSync(skillPath(), SKILL + '\nKeep this new instruction.\n')
    const execute = vi.fn(async () => ({ revision: '', value: { started: true } }))
    management = Object.assign(management, { assistance: { operations: ['skill-draft'], execute } })
    page({ seed: `draft:${draft.id}`, nonce: 1 })
    await screen.findByText(t('draft.baseChanged'))
    expect((screen.getByRole('button', { name: t('draft.adopt') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: t('draft.regenerate') }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('skill-draft', expect.objectContaining({ draftId: draft.id, backtest: true }), expect.objectContaining({ confirmed: true })))
    expect(readFileSync(skillPath(), 'utf8')).toContain('Keep this new instruction.')
  })

  it('cancels linked backtests and makes the reviewed draft actionable again', async () => {
    const draft = await mutate('draft-record', { skillName: 'release-notes', content: SKILL, notes: '', changes: [], guidance: [] }) as { id: string }
    const entry = await mutate('case-save', { skillName: 'release-notes', title: 'Case', prompt: 'Check', checks: [{ text: 'Pass', must: true }], enabled: true }) as { id: string }
    const run = await mutate('run-start', { skillName: 'release-notes', target: { kind: 'draft', draftId: draft.id }, caseIds: [entry.id] }) as { id: string }
    page({ seed: `draft:${draft.id}`, nonce: 1 })
    fireEvent.click(await screen.findByRole('button', { name: t('draft.cancelBacktest') }, { timeout: 5_000 }))
    await waitFor(async () => expect((await management.read('run', { id: run.id })).value).toMatchObject({ status: 'interrupted' }))
    await waitFor(() => expect((screen.getByRole('button', { name: t('draft.adopt') }) as HTMLButtonElement).disabled).toBe(false))
    expect(await screen.findByText(t('draft.interrupted'))).not.toBeNull()
  })

  it.each([true, false])('keeps the skill list in place and opens each detail at the top (writable=%s)', async writable => {
    const other = join(directory, 'dsh', 'skills', 'release-checks')
    mkdirSync(other)
    writeFileSync(join(other, 'SKILL.md'), SKILL.replaceAll('release-notes', 'release-checks'))
    const style = document.createElement('style')
    style.textContent = readFileSync(new NodeURL('../presentation/page.module.css', import.meta.url), 'utf8')
      .replace(/\.(sk[A-Za-z0-9]+)/gu, (selector, name: string) => css[name] === undefined ? selector : `.${css[name]}`)
    try {
      const view = render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable={writable} management={management} navigationInput={{ seed: 'skill:user-dsh:release-notes', nonce: 1 }} />)
      // The real filesystem-backed detail can take longer while isolated packages test concurrently.
      await screen.findByRole('heading', { name: 'release-notes', level: 3 }, { timeout: 5_000 })
      document.head.append(style)
      const list = screen.getByRole('complementary')
      const pane = view.container.querySelector<HTMLElement>(`.${css.skPane}`)!
      expect(getComputedStyle(list).overflowY).toBe('auto')
      expect(getComputedStyle(pane).overflowY).toBe('auto')
      list.scrollTop = 240
      pane.scrollTop = 180
      fireEvent.click(within(list).getByRole('button', { name: /^release-checks\s/u }))
      await screen.findByRole('heading', { name: 'release-checks', level: 3 }, { timeout: 5_000 })
      expect(list.scrollTop).toBe(240)
      expect(view.container.querySelector<HTMLElement>(`.${css.skPane}`)!.scrollTop).toBe(0)
      expect((screen.getByRole('button', { name: t('common.edit') }) as HTMLButtonElement).disabled).toBe(!writable)
      expect((screen.getByRole('switch', { name: t('skills.toggle', { name: 'release-checks' }) }) as HTMLButtonElement).disabled).toBe(!writable)
    } finally {
      style.remove()
    }
  })

  it('prioritizes reproducible durable evidence, folds one-off suggestions and opens their links', async () => {
    const one = await mutate('review-record', review()) as unknown as { suggestionIds: string[] }
    for (let window = 0; window < 3; window++) {
      const input = review()
      input.trajectory.sessionId = `repeat-session-${window}`
      input.trajectory.steps = Array.from({ length: 7 }, (_, index) => ({ index: index + 1, turn: index + 1, kind: 'user' as const, text: 'A repeatable procedure.' }))
      input.suggestions = [{ ...input.suggestions[0]!, action: 'create', skillName: 'repeatable-check', steps: [1, 2, 3, 4, 5, 6, 7] }]
      input.cases = []
      await mutate('review-record', input)
    }
    const view = page({ seed: 'evolution:pending', nonce: 1 })
    await screen.findByRole('heading', { name: 'repeatable-check' })
    expect(screen.queryByRole('button', { name: /release-notes/u })).toBeNull()
    expect(screen.getAllByText(/3 evidence windows · 3 sessions · 21 cited steps/u).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'One-off candidates (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: /release-notes/u }))
    await screen.findByRole('heading', { name: 'release-notes' })
    expect(screen.getByRole('button', { name: t('evolution.dismiss') })).toHaveProperty('disabled', false)
    view.unmount()
    page({ seed: `suggestion:${one.suggestionIds[0]}`, nonce: 2 })
    await screen.findByRole('heading', { name: 'release-notes' })
    expect(screen.getByRole('button', { name: 'One-off candidates (1)' }).getAttribute('aria-expanded')).toBe('true')
    expect((await management.read('suggestions', null)).value).toHaveLength(2)
  })

  it.each([true, false])('keeps evolution lists and details independently scrollable (writable=%s)', async writable => {
    for (let index = 1; index <= 10; index++) {
      const input = review()
      input.suggestions = [{ ...input.suggestions[0]!, skillName: `scroll-check-${index}`, action: 'create' }]
      input.cases = []
      await mutate('review-record', input)
    }
    // Apply the actual authored stylesheet to the module's runtime class names.
    // JSDOM checks the scroll ownership; real browser evidence covers geometry.
    const style = document.createElement('style')
    style.textContent = readFileSync(new NodeURL('../presentation/page.module.css', import.meta.url), 'utf8')
      .replace(/\.(sk[A-Za-z0-9]+)/gu, (selector, name: string) => css[name] === undefined ? selector : `.${css[name]}`)
    document.head.append(style)
    try {
      const view = render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable={writable} management={management} navigationInput={{ seed: 'evolution:pending', nonce: 1 }} />)
      fireEvent.click(await screen.findByRole('button', { name: /One-off candidates/u }))
      const eighth = await screen.findByRole('button', { name: /scroll-check-8/u })
      const list = screen.getByRole('complementary')
      const pane = view.container.querySelector<HTMLElement>(`.${css.skPane}`)!
      expect(getComputedStyle(list).overflowY).toBe('auto')
      expect(getComputedStyle(pane).overflowY).toBe('auto')
      list.scrollTop = 420
      pane.scrollTop = 180
      fireEvent.click(eighth)
      await screen.findByRole('heading', { name: 'scroll-check-8' })
      expect(list.scrollTop).toBe(420)
      expect(view.container.querySelector<HTMLElement>(`.${css.skPane}`)!.scrollTop).toBe(0)
      expect((screen.getByRole('button', { name: t('evolution.dismiss') }) as HTMLButtonElement).disabled).toBe(!writable)
    } finally {
      style.remove()
    }
  })

  it('restores a removed skill from the Trash and refreshes its count', async () => {
    const skill = (await management.read('skill', { key: 'user-dsh:release-notes' })).value as unknown as SkillSummary
    await mutate('skill-delete', { key: skill.key, expectedHash: skill.hash })
    page()
    fireEvent.click(await screen.findByRole('tab', { name: /^Trash/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    await screen.findByText('The Trash is empty')
    expect(readFileSync(skillPath(), 'utf8')).toBe(SKILL)
    expect((await management.read('trash-list', null)).value).toEqual([])
  })

  it('asks where to restore a legacy entry and does not choose a user root silently', async () => {
    const trash = join(directory, 'data', 'skills', 'trash')
    mkdirSync(trash, { recursive: true })
    writeFileSync(join(trash, '2026-10-20T09-30-00-000Z-legacy.md'), SKILL.replaceAll('release-notes', 'legacy'))
    page()
    fireEvent.click(await screen.findByRole('tab', { name: /^Trash/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    const dialog = await screen.findByRole('dialog', { name: 'Restore legacy' })
    expect((within(dialog).getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: /Location.*Choose a restore location/u }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'User · .agents' }))
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }))
    await screen.findByText('The Trash is empty')
    expect(readFileSync(join(directory, 'agents', 'skills', 'legacy.md'), 'utf8')).toContain('name: legacy')
  })

  it('requires an explicit replacement choice and keeps the displaced skill recoverable', async () => {
    const skill = (await management.read('skill', { key: 'user-dsh:release-notes' })).value as unknown as SkillSummary
    await mutate('skill-delete', { key: skill.key, expectedHash: skill.hash })
    await mutate('skill-create', { name: 'release-notes', description: 'New version.' })
    page()
    fireEvent.click(await screen.findByRole('tab', { name: /^Trash/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    const dialog = await screen.findByRole('dialog', { name: 'Restore release-notes' })
    expect((within(dialog).getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(await within(dialog).findByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(readFileSync(skillPath(), 'utf8')).toBe(SKILL)
    expect((await management.read('trash-list', null)).value as unknown as TrashEntry[]).toHaveLength(1)
  })

  it('requires the skill name before permanent deletion and rejects unconfirmed RPC mutations', async () => {
    const skill = (await management.read('skill', { key: 'user-dsh:release-notes' })).value as unknown as SkillSummary
    await mutate('skill-delete', { key: skill.key, expectedHash: skill.hash })
    const entries = (await management.read('trash-list', null)).value as unknown as TrashEntry[]
    await expect(management.mutate('trash-purge', { id: entries[0]!.id }, { confirmed: false } as never)).rejects.toThrow(/confirm/iu)
    page()
    fireEvent.click(await screen.findByRole('tab', { name: /^Trash/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete release-notes for good?' })
    expect((within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'release-notes' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await screen.findByText('The Trash is empty')
  })

  it('offers to turn self-evolution on where it is off, and opens its settings', async () => {
    const replace = vi.fn(async () => undefined)
    const onOpenSettings = vi.fn()
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable management={management}
      preferences={{ value: { evolution: false }, writable: true, replace }} onOpenSettings={onOpenSettings} navigationInput={{ seed: 'evolution:pending', nonce: 1 }} />)
    expect(await screen.findByRole('heading', { name: t('evolution.off') })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('evolution.turnOn') }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith({ evolution: true }))
    fireEvent.click(screen.getByRole('button', { name: t('common.settings') }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).toHaveBeenCalledWith()
    // The page itself carries no settings of its own.
    expect(screen.queryByRole('switch', { name: /evolution/iu })).toBeNull()
  })

  it('lists, switches and edits a skill, keeping each change as a version', async () => {
    page({ seed: 'skill:user-dsh:release-notes', nonce: 1 })
    expect(await screen.findByRole('heading', { name: 'release-notes' })).not.toBeNull()
    expect(screen.getByText('Read CHANGELOG.md')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${t('invocation.label')}`, 'u') }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('invocation.slash') }))
    await waitFor(() => expect(readFileSync(skillPath(), 'utf8')).toContain('disable-model-invocation: true'))
    expect(readFileSync(skillPath(), 'utf8')).not.toContain('user-invocable: false')
    expect((await screen.findAllByText(t('invocation.slashShort'))).length).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByRole('button', { name: t('common.edit') }))
    const editor = await screen.findByLabelText('SKILL.md')
    fireEvent.change(editor, { target: { value: (editor as HTMLTextAreaElement).value.replace('1. Read CHANGELOG.md', '1. Read CHANGELOG.md\n2. Group by component') } })
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))
    await waitFor(() => expect(readFileSync(skillPath(), 'utf8')).toContain('2. Group by component'))
    // Versions wait, folded, until asked for.
    expect(screen.queryByText(t('versions.reason.original'))).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: named(t('versions.title'), '3') }))
    expect(await screen.findByText(t('versions.reason.invocation'))).not.toBeNull()
    expect(screen.getByText(t('versions.reason.original'))).not.toBeNull()
  })

  it('pauses busy polling and focus refreshes while its retained panel is hidden', async () => {
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    await mutate('suggestion-status', { id: suggestion!.id, status: 'drafting' })
    const read = vi.spyOn(management, 'read')
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const props = { sourceTypeId: 'skills', sourceInstanceKey: 'source:skills', sourceInstances: [], locale: 'en', writable: true, management, navigationInput: { seed: `suggestion:${suggestion!.id}`, nonce: 1 } }
    const view = render(<SkillsSourcePage {...props} />)
    await screen.findByText(t('evolution.drafting'))
    const polling = intervals.mock.results[intervals.mock.calls.map(([, delay]) => delay).lastIndexOf(3_000)]!.value
    clear.mockClear()
    view.rerender(<SkillsSourcePage {...props} active={false} />)
    expect(clear).toHaveBeenCalledWith(polling)
    const hiddenReads = read.mock.calls.length
    fireEvent.focus(window)
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => {})
    expect(read.mock.calls).toHaveLength(hiddenReads)
    view.rerender(<SkillsSourcePage {...props} active />)
    const before = read.mock.calls.length
    fireEvent.focus(window)
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before))
  })

  it('refreshes stale cards once more when the overview finishes, and again on focus (#448)', async () => {
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    await mutate('suggestion-status', { id: suggestion!.id, status: 'drafting' })
    const oldList = await management.read('suggestions', null)
    const oldDetail = await management.read('suggestion', { id: suggestion!.id })
    const stale = new Set<string>()
    const watched = new Proxy(management, {
      get: (target, key, receiver) => key === 'read'
        ? (operation: string, input: unknown) => {
            if (stale.delete(operation)) return Promise.resolve(operation === 'suggestions' ? oldList : oldDetail)
            return target.read(operation as never, input as never)
          }
        : Reflect.get(target, key, receiver),
    })
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const { unmount } = render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable management={watched} navigationInput={{ seed: `suggestion:${suggestion!.id}`, nonce: 1 }} />)
    await screen.findByText(t('evolution.drafting'))
    await waitFor(() => expect(intervals.mock.calls.some(([, delay]) => delay === 3_000)).toBe(true))
    const poll = intervals.mock.calls.find(([, delay]) => delay === 3_000)![0] as () => void
    await mutate('draft-record', { suggestionId: suggestion!.id, skillName: 'release-notes', content: SKILL + '\n2. Group by component\n', notes: 'Finished in the background', changes: [], guidance: [] })
    // The card requests saw the old ledger; the independent overview sees completion.
    stale.add('suggestions'); stale.add('suggestion')
    act(() => poll())
    await screen.findByText('Finished in the background')
    expect(screen.queryByText(t('evolution.drafting'))).toBeNull()
    // Another writer changes the idle page. Returning to the window refreshes it too.
    await mutate('suggestion-dismiss', { id: suggestion!.id })
    fireEvent.focus(window)
    await waitFor(() => expect(screen.queryByText('Finished in the background')).toBeNull())
    unmount()
    intervals.mockRestore()
  })

  it('shows a suggestion with its evidence folded, then reviews and adopts its draft', async () => {
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    page({ seed: `suggestion:${suggestion!.id}`, nonce: 1 })
    expect(await screen.findByText('Group entries by component', { selector: 'p' })).not.toBeNull()
    expect(screen.getByText('Corrected twice.')).not.toBeNull()
    // Without a task Agent, drafting waits.
    expect((screen.getByRole('button', { name: t('evolution.draft') }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Grouping by component was missing')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${t('evolution.evidence')}`, 'u') }))
    expect(await screen.findByText('Grouping by component was missing')).not.toBeNull()
    expect(screen.getByText('command=git log')).not.toBeNull()
    const next = SKILL.replace('1. Read CHANGELOG.md', '1. Read CHANGELOG.md\n2. Group by component')
    await mutate('draft-record', { suggestionId: suggestion!.id, skillName: 'release-notes', content: next, notes: 'Groups entries by component.', changes: ['Group by component'], guidance: [] })
    cleanup()
    page({ seed: `suggestion:${suggestion!.id}`, nonce: 2 })
    expect(await screen.findByText('Groups entries by component.')).not.toBeNull()
    // The review left a case, not yet run against the draft.
    expect(screen.getByText(t('draft.notTested'))).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('draft.adopt') }))
    await waitFor(() => expect(readFileSync(skillPath(), 'utf8')).toBe(next))
    expect(await screen.findByText(t('draft.adopted', { name: 'release-notes' }))).not.toBeNull()
  })

  it.each([true, false])('shows the original project file in global evolution and fences adoption (writable=%s)', async writable => {
    const path = join(directory, 'workspace', '.dsh', 'skills', 'release-notes', 'SKILL.md')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, SKILL + '\nOriginal project instructions.\n')
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    const next = SKILL + '\n2. Group by component\n'
    await mutate('draft-record', { suggestionId: suggestion!.id, skillName: 'release-notes', content: next, notes: 'Project improvement.', changes: [], guidance: [] })
    management = await runner.managementClient('source:skills', { storage: 'global' })
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable={writable} management={management} navigationInput={{ seed: `suggestion:${suggestion!.id}`, nonce: 1 }} />)
    // Locate these known labels directly: a full-page role query repeatedly
    // recomputes visibility across the installed Host's complete stylesheet.
    const current = (await screen.findByText(t('evolution.currentSkill'))).closest('button')!
    fireEvent.click(current)
    expect(screen.getByText('Original project instructions.', { selector: 'p' })).not.toBeNull()
    expect(screen.queryByText('This skill no longer exists.')).toBeNull()
    // A same-key catalog link here would open a different file in the current scope.
    expect(screen.getByText('release-notes', { selector: 'h3' }).querySelector('button')).toBeNull()
    const adopt = await screen.findByText(t('draft.adopt'), { selector: 'button' }) as HTMLButtonElement
    expect(adopt.disabled).toBe(!writable)
    if (writable) {
      fireEvent.click(adopt)
      await waitFor(() => expect(readFileSync(path, 'utf8')).toBe(next))
      expect(readFileSync(skillPath(), 'utf8')).toBe(SKILL)
    }
  })

  it('explains a legacy draft with no trustworthy origin and keeps it available to copy', async () => {
    const path = join(directory, 'workspace', '.dsh', 'skills', 'release-notes', 'SKILL.md')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, SKILL)
    const draft = await mutate('draft-record', { skillName: 'release-notes', content: SKILL + '\n2. Legacy improvement\n', notes: '', changes: [], guidance: [] }) as { id: string }
    const ledgerPath = join(directory, 'data', 'skills', 'ledger.json')
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    delete ledger.drafts[0].origin
    writeFileSync(ledgerPath, JSON.stringify(ledger))
    page({ seed: `draft:${draft.id}`, nonce: 1 })
    expect(await screen.findByText(/The original workspace was not recorded reliably/u)).not.toBeNull()
    expect((screen.getByText(t('draft.adopt'), { selector: 'button' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Legacy improvement/u)).not.toBeNull()
    expect(readFileSync(path, 'utf8')).toBe(SKILL)
  })

  it('follows a link once, keeping what the reader chose since when the page reloads', async () => {
    await mutate('review-record', review())
    const other = review()
    await mutate('review-record', {
      ...other,
      review: { ...other.review, sessionId: 'session-2' },
      trajectory: { ...other.trajectory, sessionId: 'session-2' },
      suggestions: [{ skillName: 'weekly-digest', action: 'create', summary: 'A weekly digest', confidence: 0.9, signals: ['procedure'], steps: [1, 4] }],
      cases: [],
    })
    const linked = ((await management.read('suggestions', null)).value as Array<{ id: string; skillName: string }>).find(entry => entry.skillName === 'release-notes')!
    let reloads = 0
    const watched = new Proxy(management, {
      get: (target, key, receiver) => key === 'read'
        ? (operation: string, input: unknown) => { if (operation === 'suggestions') reloads += 1; return target.read(operation as never, input as never) }
        : Reflect.get(target, key, receiver),
    })
    const props = { sourceTypeId: 'skills', sourceInstanceKey: 'source:skills', sourceInstances: [], locale: 'en', writable: true, management: watched, navigationInput: { seed: `suggestion:${linked.id}`, nonce: 1 } }
    const { rerender } = render(<SkillsSourcePage {...props} refreshKey={1} />)
    expect(await screen.findByRole('heading', { name: 'release-notes' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /weekly-digest/u }))
    expect(await screen.findByRole('heading', { name: 'weekly-digest' })).not.toBeNull()
    const before = reloads
    rerender(<SkillsSourcePage {...props} refreshKey={2} />)
    await waitFor(() => expect(reloads).toBeGreaterThan(before))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'weekly-digest' })).not.toBeNull())
    expect(screen.queryByRole('heading', { name: 'release-notes' })).toBeNull()
  })

  it('keeps the conversations a review read as 进化\'s evidence, to pin and to follow to its suggestions', async () => {
    const recorded = await mutate('review-record', review()) as { trajectoryId: string }
    page({ seed: `trajectory:${recorded.trajectoryId}`, nonce: 1 })
    expect(await screen.findByRole('heading', { name: 'Release v2' })).not.toBeNull()
    expect(screen.getByRole('tab', { name: named(t('tab.evolution')), selected: true })).not.toBeNull()
    expect(screen.getByRole('tab', { name: t('evolution.evidence'), selected: true })).not.toBeNull()
    expect(screen.getByText('The user corrected the grouping.')).not.toBeNull()
    expect(screen.getByText('Write the v2 release notes')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('records.pin') }))
    await waitFor(async () => expect((await management.read('trajectory', { id: recorded.trajectoryId })).value).toMatchObject({ pinned: true }))
    expect(await screen.findByRole('button', { name: t('records.unpin') })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `${t('records.suggestion', { index: 1 })} ›` }))
    expect(await screen.findByText('Group entries by component', { selector: 'p' })).not.toBeNull()
    expect(screen.getByRole('tab', { name: new RegExp(`^${t('evolution.pending')}`, 'u'), selected: true })).not.toBeNull()
  })

  it('leads from a skill to its tests under 评测, and adds a case by hand beside the ones a review left', async () => {
    await mutate('review-record', review())
    page({ seed: 'name:release-notes', nonce: 1 })
    fireEvent.click(await screen.findByRole('button', { name: named(t('tests.title'), t('tests.count', { count: 1 })) }))
    expect(await screen.findByText('Grouped notes')).not.toBeNull()
    expect(screen.getByRole('tab', { name: t('tab.evals'), selected: true })).not.toBeNull()
    expect(screen.getByText(t('evals.tested'))).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('tests.add') }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(t('tests.caseTitle')), { target: { value: 'Breaking first' } })
    fireEvent.change(within(dialog).getByLabelText(t('tests.prompt')), { target: { value: 'Notes with a breaking change' } })
    fireEvent.change(within(dialog).getByPlaceholderText(t('tests.checkPlaceholder')), { target: { value: 'Breaking change listed first' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: t('tests.requiresVision') }))
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }))
    expect(await screen.findByText('Breaking first')).not.toBeNull()
    expect((await management.read('cases', { skill: 'release-notes' })).value).toHaveLength(2)
    expect((await management.read('cases', { skill: 'release-notes' })).value).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Breaking first', requiresVision: true })]))
    expect(screen.getByText(t('tests.requiresVision'))).not.toBeNull()
  })

  it.each([false, true])('shows image-dependent cases as unmeasured, separately from execution errors (mixed=%s)', async mixed => {
    const vision = await mutate('case-save', { case: { skillName: 'release-notes', title: 'Read a screenshot', prompt: 'Read the number in the image', requiresVision: true, checks: [{ text: 'The number is 7', must: true }] } }) as unknown as EvalCase
    const text = await mutate('case-save', { case: { skillName: 'release-notes', title: 'Text', prompt: 'Write notes', checks: [{ text: 'Has notes', must: true }] } }) as unknown as EvalCase
    const failed = await mutate('case-save', { case: { skillName: 'release-notes', title: 'Broken', prompt: 'Write notes', checks: [{ text: 'Has notes', must: true }] } }) as unknown as EvalCase
    const run = await mutate('run-start', { skillName: 'release-notes', target: { kind: 'current' }, caseIds: mixed ? [vision.id, text.id, failed.id] : [vision.id] }) as unknown as BacktestRun
    await mutate('run-progress', { id: run.id, result: { caseId: vision.id, title: vision.title, verdict: 'error', score: 0, unmeasuredReason: 'requires-vision', checks: [], steps: [], answer: '', error: 'Persisted English explanation' } })
    if (mixed) {
      await mutate('run-progress', { id: run.id, result: { caseId: text.id, title: text.title, verdict: 'pass', score: 1, checks: [], steps: [], answer: 'Notes' } })
      await mutate('run-progress', { id: run.id, result: { caseId: failed.id, title: failed.title, verdict: 'error', score: 0, checks: [], steps: [], answer: '', error: 'Model unavailable' } })
    }
    await mutate('run-finish', { id: run.id, status: 'completed' })
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable={false} management={management} navigationInput={{ seed: 'name:release-notes', nonce: 1 }} />)
    fireEvent.click(await screen.findByRole('button', { name: named(t('tests.title'), t('tests.count', { count: 3 })) }))
    const summary = mixed ? [t('tests.score', { score: '100' }), t('tests.unmeasured', { count: 1 }), t('tests.errors', { count: 1 })].join(' · ') : t('tests.unmeasured', { count: 1 })
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u') }))
    expect(await screen.findByText(t('run.verdict.unmeasured'))).not.toBeNull()
    expect(screen.getByText(t('run.requiresVision'))).not.toBeNull()
    expect(screen.queryByText('Persisted English explanation')).toBeNull()
    expect(screen.queryByText('0')).toBeNull()
    expect((screen.getByRole('button', { name: t('tests.add') }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: t('tests.enabled', { title: vision.title }) }) as HTMLButtonElement).disabled).toBe(true)
    if (mixed) expect(screen.getByText('Model unavailable')).not.toBeNull()
    else expect(screen.queryByText(t('run.verdict.error'))).toBeNull()
  })

  it('marks only the copy DSH loads as waiting for an improvement, not the one it shadows', async () => {
    mkdirSync(join(directory, 'workspace', '.dsh', 'skills', 'release-notes'), { recursive: true })
    writeFileSync(join(directory, 'workspace', '.dsh', 'skills', 'release-notes', 'SKILL.md'), SKILL)
    await mutate('review-record', review())
    const waiting = t('skills.waitingCount', { count: 1 })
    page({ seed: 'skill:user-dsh:release-notes', nonce: 1 })
    expect(await screen.findByText(t('skills.shadowedBy', { key: 'project-dsh:release-notes' }))).not.toBeNull()
    expect(screen.getAllByTitle(waiting)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: named(waiting, t('common.view')) })).toBeNull()
    cleanup()
    page({ seed: 'skill:project-dsh:release-notes', nonce: 2 })
    expect(await screen.findByRole('button', { name: named(waiting, t('common.view')) })).not.toBeNull()
    expect(screen.getAllByTitle(waiting)).toHaveLength(1)
  })

  it('switches a whole skill from its row and uses it in the conversation input', async () => {
    const setDraft = vi.fn()
    const onReturn = vi.fn()
    render(<>
      <SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable management={management} sessionId="session-1" onReturnToConversation={onReturn} navigationInput={{ seed: 'skill:user-dsh:release-notes', nonce: 1 }} />
      <SkillUseBridge sessionId="session-1" inputActions={{ setDraft }} useInput={selector => selector({ draft: 'draft v2 notes' })} />
      <SkillUseBridge sessionId="other-session" inputActions={{ setDraft: () => { throw new Error('wrong composer') } }} />
    </>)
    await screen.findByRole('heading', { name: 'release-notes' })
    fireEvent.click(screen.getAllByRole('button', { name: t('skills.use') })[0]!)
    expect(setDraft).toHaveBeenCalledWith('/release-notes draft v2 notes')
    expect(onReturn).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('switch', { name: t('skills.toggle', { name: 'release-notes' }) }))
    await waitFor(() => expect(readFileSync(skillPath(), 'utf8')).toContain('user-invocable: false'))
    expect(readFileSync(skillPath(), 'utf8')).toContain('disable-model-invocation: true')
    await waitFor(() => expect(screen.queryByRole('button', { name: t('skills.use') })).toBeNull())
    expect(draftWithSkill('/release-notes already', 'release-notes')).toBe('/release-notes already')
    expect(draftWithSkill('  ', 'pdf')).toBe('/pdf ')
  })

  it('keeps the source dialog and catalog installation usable when old Core only offers generic settings navigation', async () => {
    const team = join(directory, 'team')
    mkdirSync(join(team, 'weekly-report'), { recursive: true })
    writeFileSync(join(team, 'weekly-report', 'SKILL.md'), '---\nname: weekly-report\ndescription: Write the weekly report.\n---\n\n# Weekly report\n\n1. Collect merged PRs\n')
    writeFileSync(join(team, 'registry.json'), JSON.stringify({ version: 1, id: 'team', name: { en: 'Team skills', 'zh-CN': '团队技能' }, skills: [
      { name: 'weekly-report', title: { en: 'Weekly report' }, description: { en: 'Writes the weekly report from merged work.' }, category: 'docs-writing', author: 'Team', source: { type: 'path', path: 'weekly-report' } },
    ] }))
    await mutate('registry-toggle', { id: 'official', enabled: false })
    const onOpenSettings = vi.fn()
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable management={management} onOpenSettings={onOpenSettings} />)
    fireEvent.click(await screen.findByRole('tab', { name: t('tab.market') }))
    // skills.sh stays on; the official catalog was switched off.
    fireEvent.click(await screen.findByRole('button', { name: t('market.sources', { count: 1 }) }))
    const sources = await screen.findByRole('dialog')
    expect(onOpenSettings).not.toHaveBeenCalled()
    fireEvent.change(within(sources).getByLabelText(t('sources.addTitle')), { target: { value: join(team, 'registry.json') } })
    expect(within(sources).getByText(`${t('sources.detected.catalog')} · registry.json`)).not.toBeNull()
    fireEvent.click(within(sources).getByRole('button', { name: t('sources.add') }))
    expect(await within(sources).findByText('Team skills')).not.toBeNull()
    expect(within(sources).getByText(`${t('sources.kind.catalog')} · ${t('sources.entries', { count: 1 })}`, { exact: false })).not.toBeNull()
    fireEvent.click(within(sources).getByRole('button', { name: t('sources.done') }))
    fireEvent.click(await screen.findByRole('button', { name: t('market.install') }))
    const detail = await screen.findByRole('dialog')
    expect(await within(detail).findByText('Collect merged PRs')).not.toBeNull()
    expect(within(detail).getByText(t('market.trust'))).not.toBeNull()
    fireEvent.click(within(detail).getByRole('button', { name: t('market.install') }))
    await waitFor(() => expect(readFileSync(join(directory, 'dsh', 'skills', 'weekly-report', 'SKILL.md'), 'utf8')).toContain('Collect merged PRs'))
    expect(await screen.findByText(t('market.installed', { name: 'weekly-report' }))).not.toBeNull()
    expect(await screen.findByText(t('market.state.installed'))).not.toBeNull()
  })

  it('searches skills.sh as the user types, and installs a find from its repository', async () => {
    const document = '---\nname: pdf\ndescription: Work with PDF files.\nlicense: MIT\n---\n\n# PDF\n\nExtract the text first.\n'
    const reply = (status: number, body = '') => ({ ok: status < 400, status, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://skills.sh/api/search?')) return reply(200, JSON.stringify({ skills: [{ id: 'acme/skills/pdf', source: 'acme/skills', skillId: 'pdf', name: 'pdf', installs: 213790 }] }))
      if (url === 'https://skills.sh/api/v1/skills/audit/acme/skills/pdf') return reply(200, JSON.stringify({ audits: [{ provider: 'Trust Hub', status: 'pass', summary: 'Fine' }] }))
      if (url.startsWith('https://api.github.com/repos/acme/skills/git/trees/HEAD')) return reply(200, JSON.stringify({ truncated: false, tree: [{ path: 'skills/pdf/SKILL.md', type: 'blob', size: document.length }] }))
      if (url === 'https://raw.githubusercontent.com/acme/skills/HEAD/skills/pdf/SKILL.md') return reply(200, document)
      return reply(404)
    }))
    try {
      await mutate('registry-toggle', { id: 'official', enabled: false })
      page()
      fireEvent.click(await screen.findByRole('tab', { name: t('tab.market') }))
      fireEvent.change(await screen.findByRole('textbox', { name: t('market.search') }), { target: { value: 'pdf' } })
      expect(await screen.findByText(t('market.indexed', { count: 1 }))).not.toBeNull()
      expect(screen.getByText(t('market.installs', { count: '214K' }))).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: t('market.preview', { name: 'pdf' }) }))
      const detail = await screen.findByRole('dialog')
      expect(await within(detail).findByText('Extract the text first.')).not.toBeNull()
      expect(within(detail).getByText('Work with PDF files.')).not.toBeNull()
      expect(within(detail).getByText('Trust Hub')).not.toBeNull()
      expect(within(detail).getByText('MIT')).not.toBeNull()
      fireEvent.click(within(detail).getByRole('button', { name: t('market.install') }))
      await waitFor(() => expect(readFileSync(join(directory, 'dsh', 'skills', 'pdf', 'SKILL.md'), 'utf8')).toBe(document))
      expect(await screen.findByText(t('market.installed', { name: 'pdf' }))).not.toBeNull()
      expect(await screen.findByText(t('market.state.installed'))).not.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('compares the latest backtest of a draft, not the first one linked to it', async () => {
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    const [entry] = (await management.read('cases', { skill: 'release-notes' })).value as Array<{ id: string; title: string }>
    const next = SKILL.replace('1. Read CHANGELOG.md', '1. Read CHANGELOG.md\n2. Group by component')
    const draft = await mutate('draft-record', { suggestionId: suggestion!.id, skillName: 'release-notes', content: next, notes: 'Groups entries by component.', changes: [], guidance: [] }) as { id: string }
    const backtest = async (target: Record<string, unknown>, verdict: CaseResult['verdict'], score: number) => {
      const run = await mutate('run-start', { skillName: 'release-notes', target, caseIds: [entry!.id] }) as { id: string }
      await mutate('run-progress', { id: run.id, result: { caseId: entry!.id, title: entry!.title, verdict, score, checks: [], steps: [], answer: '' } })
      await mutate('run-finish', { id: run.id, status: 'completed' })
      if (target.kind !== 'draft') await mutate('run-link', { draftId: draft.id, runId: run.id })
    }
    // The first pair could not run the draft; the second one could.
    await backtest({ kind: 'draft', draftId: draft.id }, 'error', 0)
    await backtest({ kind: 'current' }, 'fail', 0.5)
    await backtest({ kind: 'draft', draftId: draft.id }, 'pass', 1)
    await backtest({ kind: 'current' }, 'fail', 0.5)
    page({ seed: `draft:${draft.id}`, nonce: 1 })
    expect(await screen.findByText('+50')).not.toBeNull()
    expect(screen.getByText(`${t('draft.current')} 50 → ${t('draft.candidate')} 100`)).not.toBeNull()
    expect(screen.queryByText(t('draft.excluded', { count: 1 }))).toBeNull()
  })

  it('compares a draft with its baseline only on the cases both could grade', () => {
    const result = (caseId: string, verdict: CaseResult['verdict'], score: number): CaseResult => ({ caseId, title: caseId, verdict, score, checks: [], steps: [], answer: '' })
    const run = (kind: 'draft' | 'current', results: CaseResult[]): BacktestRun => ({ id: kind, skillName: 'release-notes', target: kind === 'draft' ? { kind, hash: 'h', draftId: 'd' } : { kind, hash: 'h', skillKey: 'k' }, status: 'completed', progress: { done: results.length, total: results.length }, caseIds: results.map(entry => entry.caseId), results, startedAt: '2026-10-21T00:00:00.000Z' })
    const baseline = run('current', [result('a', 'fail', 0.5), result('b', 'pass', 1)])
    expect(compareRuns(baseline, run('draft', [result('a', 'pass', 1), result('b', 'error', 0)]))).toEqual({ baseline: 0.5, candidate: 1, excluded: 1 })
    expect(compareRuns(baseline, run('draft', [result('a', 'error', 0), result('b', 'error', 0)]))).toEqual({ excluded: 2 })
    const unmeasured = { ...result('b', 'error', 0), unmeasuredReason: 'requires-vision' as const }
    expect(compareRuns(baseline, run('draft', [result('a', 'pass', 1), unmeasured]))).toEqual({ baseline: 0.5, candidate: 1, excluded: 1 })
    expect(compareRuns(run('current', [result('b', 'pass', 1)]), run('draft', [unmeasured]))).toEqual({ excluded: 1 })
    expect(compareRuns(baseline, { ...run('draft', []), status: 'running' })).toEqual({ excluded: 0 })
  })

  it('words counts in English by number, and leaves Chinese as written', () => {
    expect(t('records.stats', { turns: 1, tools: 1 })).toBe('1 turn · 1 tool call')
    expect(t('records.stats', { turns: 2, tools: 6 })).toBe('2 turns · 6 tool calls')
    expect(t('draft.excluded', { count: 1 })).toBe('1 case could not run and is left out')
    expect(t('market.installs', { count: '13.6K' })).toBe('13.6K installs')
    expect(translate('zh-CN')('records.stats', { turns: 1, tools: 1 })).toBe('1 回合 · 1 次工具调用')
  })

  it('registers one page in the Memory System and releases it', () => {
    const entries: Array<{ id: string }> = []
    const release = installSkillsMemoryUI({ slots: {
      inject: (_name: string, factory: () => () => void) => factory(),
      register: (options: { id: string }) => { entries.push(options); return () => entries.splice(entries.indexOf(options), 1) },
    } } as never)
    expect(entries.map(entry => entry.id)).toEqual(['skills/library'])
    release()
    expect(entries).toEqual([])
  })

  it('joins the composer row only once the conversation declares it', () => {
    const waiting = new Map<string, () => () => void>()
    const entries: Array<{ name: string; id: string }> = []
    const release = installSkillUseBridge({ slots: {
      inject: (name: string, factory: () => () => void) => { waiting.set(name, factory); return () => waiting.delete(name) },
      register: (options: { name: string; id: string }) => { entries.push(options); return () => entries.splice(entries.indexOf(options), 1) },
    } })
    expect(entries).toEqual([])
    const stop = waiting.get(SKILL_USE_SLOT)!()
    expect(entries.map(entry => [entry.name, entry.id])).toEqual([[SKILL_USE_SLOT, 'dsh-mnemon-skills/use']])
    stop()
    release()
    expect(entries).toEqual([])
    expect(waiting.size).toBe(0)
  })

  it('uses ctx.conversation.input directly on DSH 0.2.1+ without registering conversation.input.left, and preserves the 0.2.0-rc.2 fallback', () => {
    expect(clientInject).toEqual(['slots'])
    const strictCordisProxy = new Proxy(
      { slots: { inject: vi.fn(() => () => undefined), register: vi.fn(() => () => undefined) } },
      {
        get(target, prop, receiver) {
          if (prop === 'slots' || prop === 'get') return Reflect.get(target, prop, receiver)
          throw new Error(`cannot get property "${String(prop)}" without inject`)
        },
      },
    )
    const releaseStrict = installSkillUseBridge(strictCordisProxy as never)
    releaseStrict()
    const injectSpy = vi.fn()
    const selectPanel = vi.fn()
    const openSession = vi.fn()
    const startSession = vi.fn()
    const setDraft = vi.fn()
    const focus = vi.fn()
    const scope2 = { kind: 'agent-ctx', sessionId: 'session-2' }
    const binding2 = { sessionId: 'session-2', ctx: scope2 }
    const scopeUnmounted = { kind: 'agent-ctx', sessionId: 'session-unmounted' }
    const bindingUnmounted = { sessionId: 'session-unmounted', ctx: scopeUnmounted }
    const retainedBindings = new Map<string, { sessionId: string; ctx: unknown }>([
      ['session-1', { sessionId: 'session-1', ctx: { kind: 'agent-ctx', sessionId: 'session-1' } }],
    ])
    openSession.mockImplementation((target: string) => {
      if (target === 'session-2') retainedBindings.set('session-2', binding2)
      if (target === 'session-unmounted') retainedBindings.set('session-unmounted', bindingUnmounted)
    })
    const requestDraftInitialization = vi.fn((binding: { sessionId: string; ctx: unknown }, options: { prompt?: string; whenDraftExists?: string }) => {
      if (retainedBindings.get(binding.sessionId) !== binding) {
        throw new Error('conversation.input.requestDraftInitialization requires a retained Session binding')
      }
      expect(options).toEqual({ prompt: '/release-notes ', whenDraftExists: 'replace' })
      return 'applied' as const
    })

    const releaseModern = installSkillUseBridge({
      slots: { inject: injectSpy, register: vi.fn() },
      layout: { selectPanel },
      uiWorkspace: { openSession, startSession },
      sessions: {
        list: {
          getSnapshot: () => ({
            ids: ['session-1', 'session-2'],
            byId: {
              'session-1': { id: 'session-1', retainedBy: { mainView: 1 } },
              'session-2': { id: 'session-2', retainedBy: {} },
            },
          }),
        },
        scope: (id: string) => retainedBindings.get(id)?.ctx,
        binding: (id: string) => retainedBindings.get(id),
      },
      conversation: {
        input: {
          for: actx => {
            const matched = [...retainedBindings.values()].find(candidate => candidate.ctx === actx)
            if (matched === undefined) throw new Error('conversation.input.for requires a retained Session scope')
            if (matched.sessionId === 'session-unmounted') return undefined
            return {
              state: { getSnapshot: () => ({ draft: 'Review probe: keep this unsent draft.' }) },
              setDraft,
              focus,
            }
          },
          requestDraftInitialization,
        },
      },
    })

    expect(injectSpy).not.toHaveBeenCalled()
    // Omitted sessionId resolves the mainView-retained session ('session-1') and preserves its unsent draft.
    expect(requestSkillUse('release-notes')).toBe(true)
    expect(openSession).not.toHaveBeenCalled()
    expect(setDraft).toHaveBeenCalledWith('/release-notes Review probe: keep this unsent draft.')
    expect(selectPanel).toHaveBeenCalledWith(null)
    expect(focus).toHaveBeenCalledTimes(1)

    // Explicit target session switches via uiWorkspace.openSession and updates its retained SessionInput.
    setDraft.mockClear()
    selectPanel.mockClear()
    focus.mockClear()
    expect(requestSkillUse('release-notes', 'session-2')).toBe(true)
    expect(openSession).toHaveBeenCalledWith('session-2')
    expect(selectPanel).toHaveBeenCalledWith(null)
    expect(setDraft).toHaveBeenCalledWith('/release-notes Review probe: keep this unsent draft.')
    expect(focus).toHaveBeenCalledOnce()
    expect(requestDraftInitialization).not.toHaveBeenCalled()

    // Fallback to requestDraftInitialization passes the retained SessionBinding and DraftInitializationOptions.
    expect(requestSkillUse('release-notes', 'session-unmounted')).toBe(true)
    expect(requestDraftInitialization).toHaveBeenCalledWith(
      bindingUnmounted,
      { prompt: '/release-notes ', whenDraftExists: 'replace' },
    )
    releaseModern()

    // Once released (or on DSH 0.2.0-rc.2 without ctx.conversation), SkillUseBridge handles it cleanly.
    const fallbackDraft = vi.fn()
    render(<SkillUseBridge sessionId="legacy-session" inputActions={{ setDraft: fallbackDraft }} useInput={selector => selector({ draft: 'draft body' })} />)
    expect(requestSkillUse('release-notes', 'legacy-session')).toBe(true)
    expect(fallbackDraft).toHaveBeenCalledWith('/release-notes draft body')
  })

  it('caches revision, draft-preferences, and immutable trajectories in skillsPageClient', async () => {
    await mutate('review-record', review())
    const [trajectorySummary] = (await management.read('trajectories', null)).value as Array<{ id: string }>
    const readSpy = vi.spyOn(management, 'read')
    const execute = vi.fn(async () => ({ ...await management.read('revision', null), value: { runId: 'run-1' } }))
    const assisted = Object.assign(Object.create(Object.getPrototypeOf(management) as object) as typeof management, management, {
      assistance: { operations: ['skill-backtest'], execute },
    })
    const client = skillsPageClient(assisted)
    await client.overview()
    readSpy.mockClear()

    // Writes use the cached revision without a pre-write 'revision' RPC.
    await client.createSkill({ name: 'fast-skill', description: 'Created without pre-write revision read.' })
    expect(readSpy.mock.calls.filter(([op]) => op === 'revision')).toHaveLength(0)

    // Backtest reads draft-preferences once and caches it across repeated invocations.
    execute.mockImplementation(async () => ({ revision: assisted.revision, value: { runId: 'run-1' } }))
    readSpy.mockClear()
    await client.backtest({ skillName: 'release-notes', target: { kind: 'current' } })
    await client.backtest({ skillName: 'release-notes', target: { kind: 'current' } })
    expect(readSpy.mock.calls.filter(([op]) => op === 'draft-preferences')).toHaveLength(1)

    // Immutable trajectory reads hit the in-memory LRU cache on repeat reads.
    readSpy.mockClear()
    const first = await client.trajectory(trajectorySummary!.id)
    const second = await client.trajectory(trajectorySummary!.id)
    expect(second).toEqual(first)
    expect(readSpy.mock.calls.filter(([op]) => op === 'trajectory')).toHaveLength(1)
  })

  it('eliminates duplicate overview and cases reads, deduplicates focus+visibilitychange, and debounces RestoreDialog previews', async () => {
    await mutate('review-record', review())
    const readSpy = vi.spyOn(management, 'read')
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable management={management} navigationInput={{ seed: 'evolution:pending', nonce: 1 }} />)
    await screen.findByRole('button', { name: /One-off candidates/u })
    expect(readSpy.mock.calls.filter(([op]) => op === 'overview')).toHaveLength(1)

    // Window focus + visibilitychange within 500ms fires only 1 refresh wave instead of 2.
    readSpy.mockClear()
    act(() => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(readSpy.mock.calls.filter(([op]) => op === 'overview')).toHaveLength(1))

    // EvalsPage shares loaded cases and skill existence with SkillTests (0 skill-specific cases or evidence-pack reads).
    readSpy.mockClear()
    fireEvent.click(screen.getByRole('tab', { name: /^Evals/u }))
    await screen.findByRole('button', { name: t('tests.run') })
    expect(readSpy.mock.calls.filter(([op]) => op === 'cases')).toHaveLength(1)
    expect(readSpy.mock.calls.filter(([op]) => op === 'evidence-pack')).toHaveLength(0)

    // RestoreDialog keeps previous preview path mounted while debouncing keystrokes by 200ms.
    const skill = (await management.read('skill', { key: 'user-dsh:release-notes' })).value as unknown as SkillSummary
    await mutate('skill-delete', { key: skill.key, expectedHash: skill.hash })
    await mutate('skill-create', { name: 'release-notes', description: 'Conflicting skill.' })
    fireEvent.click(screen.getByRole('tab', { name: /^Trash/u }))
    readSpy.mockClear()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    const dialog = await screen.findByRole('dialog', { name: 'Restore release-notes' })
    expect(readSpy.mock.calls.filter(([op]) => op === 'trash-restore-preview')).toHaveLength(1)

    readSpy.mockClear()
    const nameInput = within(dialog).getByLabelText(new RegExp(`^${t('create.name')}`, 'u'))
    fireEvent.change(nameInput, { target: { value: 'release-notes-' } })
    fireEvent.change(nameInput, { target: { value: 'release-notes-a' } })
    fireEvent.change(nameInput, { target: { value: 'release-notes-ab' } })
    // Previous path remains visible without flickering null, and no preview RPC fires before the 200ms debounce window.
    expect(dialog.querySelector('code')).not.toBeNull()
    expect(readSpy.mock.calls.filter(([op]) => op === 'trash-restore-preview')).toHaveLength(0)
    await waitFor(() => expect(readSpy.mock.calls.filter(([op]) => op === 'trash-restore-preview')).toHaveLength(1))
    expect(dialog.querySelector('code')?.textContent).toContain('release-notes-ab')
  })
})

describe('model pickers', () => {
  /** The management client with a model directory, as a Host that offers one reports it. */
  function withModels(base: typeof management): typeof management {
    return Object.assign(Object.create(Object.getPrototypeOf(base) as object) as typeof management, base, {
      models: () => Promise.resolve({
        effective: { provider: 'buddy', model: 'deepseek-v4.1-flash', source: 'fixed' as const },
        groups: [
          { id: 'buddy', name: 'CodeBuddy (腾讯)', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }] },
          { id: 'trae', name: 'TRAE (字节)', models: [{ id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017' }] },
        ],
        failures: [],
      }),
    })
  }

  /** The contextual per-item model picker, by the label the toolbar shows. */
  const picker = (label: string) => screen.getByRole('button', { name: named(label) }) as HTMLButtonElement

  it.each(['skill', 'global', 'default'] as const)('uses the %s backtest model for both sides of a draft comparison', async selection => {
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    const global = { provider: 'buddy', model: 'deepseek-v4.1-flash' }
    const override = { provider: 'trae', model: 'deepseek-v4.1-flash-1017' }
    if (selection !== 'default') await mutate('draft-preference', { slot: 'run', model: global })
    if (selection === 'skill') await mutate('draft-preference', { slot: 'run', skillName: 'release-notes', model: override })
    const draft = await mutate('draft-record', { suggestionId: suggestion!.id, skillName: 'release-notes', content: SKILL, notes: 'Draft to compare', changes: [], guidance: [] }) as { id: string }
    const execute = vi.fn(async (_operation: string, input: unknown) => {
      const { skillName, target } = input as { skillName: string; target: unknown }
      const cases = (await management.read('cases', { skill: skillName })).value as Array<{ id: string }>
      const run = await mutate('run-start', { skillName, target, caseIds: cases.map(entry => entry.id) }) as { id: string }
      return { ...await management.read('revision', null), value: { runId: run.id } }
    })
    const assisted = Object.assign(withModels(management), { assistance: { operations: ['skill-backtest'], execute } })
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable management={assisted} navigationInput={{ seed: `suggestion:${suggestion!.id}`, nonce: 1 }} />)
    fireEvent.click(await screen.findByRole('button', { name: t('draft.runBacktest') }))
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    const route = selection === 'skill' ? override : selection === 'global' ? global : {}
    expect(execute.mock.calls.map(([, input]) => input)).toEqual([
      { skillName: 'release-notes', target: { kind: 'draft', draftId: draft.id }, ...route },
      { skillName: 'release-notes', target: { kind: 'current', draftId: draft.id }, ...route },
    ])
  })

  it.each(['suggestion', 'global', 'default'] as const)('uses the %s model when redrafting a suggestion', async selection => {
    settingsSupport.mockReturnValue(true)
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    const global = { provider: 'buddy', model: 'deepseek-v4.1-flash' }
    const override = { provider: 'trae', model: 'deepseek-v4.1-flash-1017' }
    if (selection !== 'default') await mutate('draft-preference', { model: global })
    if (selection === 'suggestion') await mutate('draft-preference', { suggestionId: suggestion!.id, model: override })
    const draft = await mutate('draft-record', { suggestionId: suggestion!.id, skillName: 'release-notes', content: SKILL, notes: 'Draft to revise', changes: [], guidance: [] }) as { id: string }
    const execute = vi.fn(async () => ({ ...await management.read('revision', null), value: { started: true } }))
    const assisted = Object.assign(withModels(management), { assistance: { operations: ['skill-draft'], execute } })
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable onOpenSettings={() => {}} management={assisted} navigationInput={{ seed: `suggestion:${suggestion!.id}`, nonce: 1 }} />)
    await screen.findByText('Draft to revise')
    expect(screen.queryByRole('button', { name: named(t('evolution.model')) })).toBeNull()
    await waitFor(() => expect(picker(t('evolution.modelCard')).disabled).toBe(false))
    if (selection === 'suggestion') await waitFor(() => expect(picker(t('evolution.modelCard')).textContent).toContain('DeepSeek-V4.1-Flash-1017'))
    if (selection === 'global') {
      await waitFor(() => expect(picker(t('evolution.modelCard')).textContent).toContain(t('evolution.modelAuto')))
      await waitFor(() => expect(picker(t('evolution.modelCard')).textContent).toContain('DeepSeek-V4.1-Flash'))
    }
    if (selection === 'default') {
      await waitFor(() => expect(picker(t('evolution.modelCard')).textContent).toContain(t('evolution.modelAuto')))
      await waitFor(() => expect(picker(t('evolution.modelCard')).textContent).toContain('deepseek-v4.1-flash'))
    }
    fireEvent.click(screen.getByRole('button', { name: t('common.more') }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('draft.redraft') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('draft.redraftNote') }), { target: { value: 'Keep the component headings' } })
    fireEvent.click(screen.getByRole('button', { name: t('draft.redraftStart') }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('skill-draft', {
      suggestionId: suggestion!.id, draftId: draft.id, guidance: 'Keep the component headings',
      ...(selection === 'suggestion' ? override : selection === 'global' ? global : {}),
    }, expect.objectContaining({ confirmed: true })))
  })

  it.each(['legacy-core', 'no-navigation', 'read-only'] as const)('preserves global and per-item model controls with %s', async mode => {
    settingsSupport.mockReturnValue(mode === 'no-navigation')
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    const global = { provider: 'buddy', model: 'deepseek-v4.1-flash' }
    const override = { provider: 'trae', model: 'deepseek-v4.1-flash-1017' }
    await mutate('draft-preference', { model: global })
    await mutate('draft-preference', { slot: 'run', model: global })
    await mutate('draft-preference', { suggestionId: suggestion!.id, model: override })
    await mutate('draft-preference', { skillName: 'release-notes', slot: 'run', model: override })
    const onOpenSettings = vi.fn()
    const props = { sourceTypeId: 'skills', sourceInstanceKey: 'source:skills', sourceInstances: [], locale: 'en', writable: mode !== 'read-only', management: withModels(management), ...(mode === 'no-navigation' ? {} : { onOpenSettings }) }
    const view = render(<SkillsSourcePage {...props} navigationInput={{ seed: `suggestion:${suggestion!.id}`, nonce: 1 }} />)
    for (const [index, label] of [t('evolution.model'), t('tests.model')].entries()) {
      if (index === 1) view.rerender(<SkillsSourcePage {...props} navigationInput={{ seed: 'evals:release-notes', nonce: 2 }} />)
      await waitFor(() => expect(picker(label).textContent).toContain('DeepSeek-V4.1-Flash'))
      expect(picker(label).disabled).toBe(mode === 'read-only')
      expect(screen.queryByRole('button', { name: t('common.settings') })).toBeNull()
      if (mode !== 'read-only') {
        fireEvent.click(picker(label))
        fireEvent.click(await screen.findByRole('menuitem', { name: named('DeepSeek-V4.1-Flash-1017', 'TRAE (字节)') }))
        await waitFor(async () => expect((await management.read('draft-preferences', null)).value).toMatchObject({ [index === 0 ? 'model' : 'runModel']: override }))
      }
    }
    expect(onOpenSettings).not.toHaveBeenCalled()
    expect((await management.read('draft-preferences', null)).value).toMatchObject({
      model: mode === 'read-only' ? global : override,
      runModel: mode === 'read-only' ? global : override,
      suggestionModels: { [suggestion!.id]: override },
      skillRunModels: { 'release-notes': override },
    })
  })

  it('offers only the contextual item picker on 进化, shows the active global default in Follow default, and stores per-suggestion overrides', async () => {
    settingsSupport.mockReturnValue(true)
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    await mutate('draft-preference', { model: { provider: 'buddy', model: 'deepseek-v4.1-flash' } })
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable onOpenSettings={() => {}} management={withModels(management)} navigationInput={{ seed: `suggestion:${suggestion!.id}`, nonce: 1 }} />)
    await waitFor(() => expect(picker(t('evolution.modelCard')).disabled).toBe(false))
    expect(screen.queryByRole('button', { name: named(t('evolution.model')) })).toBeNull()
    // Follow-default reflects the configured global draft model until overridden for this card.
    await waitFor(() => expect(picker(t('evolution.modelCard')).textContent).toContain(t('evolution.modelAuto')))
    await waitFor(() => expect(picker(t('evolution.modelCard')).textContent).toContain('DeepSeek-V4.1-Flash'))
    // A card's own pick writes only that card's entry while preserving the global default.
    fireEvent.click(picker(t('evolution.modelCard')))
    fireEvent.click(await screen.findByRole('menuitem', { name: named('DeepSeek-V4.1-Flash-1017', 'TRAE (字节)') }))
    await waitFor(async () => expect((await management.read('draft-preferences', null)).value).toMatchObject({
      model: { provider: 'buddy', model: 'deepseek-v4.1-flash' },
      suggestionModels: { [suggestion!.id]: { provider: 'trae', model: 'deepseek-v4.1-flash-1017' } },
    }))
  })

  it('renders the item picker before the directory arrives, showing follow-default and staying disabled until ready', async () => {
    settingsSupport.mockReturnValue(true)
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    const pending: { release: (value: never) => void } = { release: () => {} }
    const slow = Object.assign(Object.create(Object.getPrototypeOf(management) as object), management, {
      models: () => new Promise<never>(resolve => { pending.release = resolve as (value: never) => void }),
    }) as typeof management
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable onOpenSettings={() => {}} management={slow} navigationInput={{ seed: `suggestion:${suggestion!.id}`, nonce: 1 }} />)
    // The toolbar holds its place while the directory is in flight, showing Follow default + hint.
    await waitFor(() => expect(picker(t('evolution.modelCard')).textContent).toContain(t('evolution.modelAuto')))
    expect(screen.queryByRole('button', { name: named(t('evolution.model')) })).toBeNull()
    expect(picker(t('evolution.modelCard')).textContent).toContain(t('evolution.modelAutoHint'))
    expect(picker(t('evolution.modelCard')).disabled).toBe(true)
    pending.release({ effective: { provider: 'buddy', model: 'deepseek-v4.1-flash' }, groups: [], failures: [] } as never)
    // Once the directory answers, the item picker enables and shows the Agent's active model in Follow default.
    await waitFor(() => expect(picker(t('evolution.modelCard')).disabled).toBe(false))
    expect(picker(t('evolution.modelCard')).textContent).toContain('deepseek-v4.1-flash')
  })

  it('uses the global runModel or per-skill override on 评测 without rendering a duplicate global picker', async () => {
    settingsSupport.mockReturnValue(true)
    await mutate('review-record', review())
    const global = { provider: 'buddy', model: 'deepseek-v4.1-flash' }
    const override = { provider: 'trae', model: 'deepseek-v4.1-flash-1017' }
    await mutate('draft-preference', { slot: 'run', model: global })
    const execute = vi.fn(async () => ({ ...await management.read('revision', null), value: { runId: 'run-1' } }))
    const assisted = Object.assign(withModels(management), { assistance: { operations: ['skill-backtest'], execute } })
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable onOpenSettings={() => {}} management={assisted} navigationInput={{ seed: 'evals:release-notes', nonce: 1 }} />)
    await waitFor(() => expect(picker(t('tests.modelCard')).disabled).toBe(false))
    expect(screen.queryByRole('button', { name: named(t('tests.model')) })).toBeNull()
    await waitFor(() => expect(picker(t('tests.modelCard')).textContent).toContain(t('tests.modelAuto')))
    await waitFor(() => expect(picker(t('tests.modelCard')).textContent).toContain('DeepSeek-V4.1-Flash'))

    fireEvent.click(await screen.findByRole('button', { name: t('tests.run') }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('skill-backtest', {
      skillName: 'release-notes', target: { kind: 'current' }, ...global,
    }, expect.objectContaining({ confirmed: true })))

    execute.mockClear()
    fireEvent.click(picker(t('tests.modelCard')))
    fireEvent.click(await screen.findByRole('menuitem', { name: named('DeepSeek-V4.1-Flash-1017', 'TRAE (字节)') }))
    await waitFor(async () => expect((await management.read('draft-preferences', null)).value).toMatchObject({
      runModel: global,
      skillRunModels: { 'release-notes': override },
    }))
    fireEvent.click(screen.getByRole('button', { name: t('tests.run') }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('skill-backtest', {
      skillName: 'release-notes', target: { kind: 'current' }, ...override,
    }, expect.objectContaining({ confirmed: true })))
  })

  it('deep-links model settings from 进化 and 评测 and market source settings from 市场 when onOpenSettings is provided', async () => {
    settingsSupport.mockReturnValue(true)
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    const onOpenSettings = vi.fn()
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable management={withModels(management)} onOpenSettings={onOpenSettings} navigationInput={{ seed: `suggestion:${suggestion!.id}`, nonce: 1 }} />)
    await screen.findByRole('heading', { name: 'release-notes' })
    fireEvent.click(screen.getByRole('button', { name: t('common.settings') }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).toHaveBeenLastCalledWith('models')

    fireEvent.click(screen.getByRole('tab', { name: /^Evals/u }))
    await screen.findByRole('button', { name: named(t('tests.modelCard')) })
    fireEvent.click(screen.getByRole('button', { name: t('common.settings') }))
    expect(onOpenSettings).toHaveBeenCalledTimes(2)
    expect(onOpenSettings).toHaveBeenLastCalledWith('models')

    fireEvent.click(screen.getByRole('tab', { name: t('tab.market') }))
    fireEvent.click(await screen.findByRole('button', { name: /^Sources ·/u }))
    expect(onOpenSettings).toHaveBeenCalledTimes(3)
    expect(onOpenSettings).toHaveBeenLastCalledWith('market')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('deletes a suggestion from its card, and a draft from its own, after a confirmation', async () => {
    await mutate('review-record', review())
    const [suggestion] = (await management.read('suggestions', null)).value as Array<{ id: string }>
    page({ seed: `suggestion:${suggestion!.id}`, nonce: 1 })
    fireEvent.click(await screen.findByRole('button', { name: t('common.delete') }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(t('evolution.deleteTitle'))).not.toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.delete') }))
    expect(await screen.findByText(t('evolution.deleted'))).not.toBeNull()
    expect((await management.read('suggestions', null)).value).toEqual([])
    fireEvent.click(screen.getByRole('tab', { name: t('evolution.evidence') }))
    await screen.findByText('Group them by component from now on')
    expect(screen.queryByRole('button', { name: /Suggestion 1/u })).toBeNull()
    expect(screen.queryByText(t('records.suggested', { count: 1 }))).toBeNull()
  })

  it.each([{ writable: true, locale: 'en' }, { writable: false, locale: 'zh' }] as const)('ends loading with a localized notice when a suggestion is deleted after the list loads ($locale, writable=$writable)', async ({ writable, locale }) => {
    await mutate('review-record', review())
    const oldList = await management.read('suggestions', null)
    const [suggestion] = oldList.value as Array<{ id: string }>
    await mutate('suggestion-delete', { id: suggestion!.id })
    const watched = new Proxy(management, {
      get: (target, key, receiver) => key === 'read'
        ? (operation: string, input: unknown) => operation === 'suggestions' ? Promise.resolve(oldList) : target.read(operation as never, input as never)
        : Reflect.get(target, key, receiver),
    })
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale={locale} writable={writable} management={watched} navigationInput={{ seed: `suggestion:${suggestion!.id}`, nonce: 1 }} />)
    await screen.findByText(locale === 'zh' ? '该建议已删除' : 'This suggestion has been deleted')
    expect(screen.queryByText(translate(locale)('common.loading'))).toBeNull()
    expect(screen.queryByText(/suggestion not found/u)).toBeNull()
    expect(screen.queryByRole('button', { name: t('evolution.draft') })).toBeNull()
  })

  it('keeps other suggestion read failures visible and lets the user retry', async () => {
    await mutate('review-record', review())
    let reject = true
    const watched = new Proxy(management, {
      get: (target, key, receiver) => key === 'read'
        ? (operation: string, input: unknown) => operation === 'suggestion' && reject ? Promise.reject(new Error('read access denied')) : target.read(operation as never, input as never)
        : Reflect.get(target, key, receiver),
    })
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable management={watched} navigationInput={{ seed: 'evolution:pending', nonce: 1 }} />)
    fireEvent.click(await screen.findByRole('button', { name: /One-off candidates/u }))
    fireEvent.click(await screen.findByRole('button', { name: /release-notes/u }))
    await screen.findByText('Could not load this suggestion')
    expect(screen.getByText('read access denied')).not.toBeNull()
    expect(screen.queryByText(t('common.loading'))).toBeNull()
    reject = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('heading', { name: 'release-notes' })
  })

  it('supports roving tabindex keyboard navigation on the Skills tablist and keeps Evolution split shell stable across filters', async () => {
    await mutate('review-record', review())
    render(<SkillsSourcePage sourceTypeId="skills" sourceInstanceKey="source:skills" sourceInstances={[]} locale="en" writable management={management} />)
    const [tablist] = await screen.findAllByRole('tablist')
    fireEvent.keyDown(tablist!, { key: 'Home' })
    expect(within(tablist!).getAllByRole('tab').map(tab => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1'])
    fireEvent.keyDown(tablist!, { key: 'ArrowRight' })
    expect(within(tablist!).getAllByRole('tab').map(tab => tab.getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1', '-1'])
    await waitFor(() => expect(document.querySelector('aside')).not.toBeNull())
    const asideBefore = document.querySelector('aside')
    const splitClassBefore = asideBefore!.parentElement?.className
    fireEvent.click(await screen.findByRole('tab', { name: t('evolution.evidence') }))
    await screen.findByText('Group them by component from now on')
    const asideAfter = document.querySelector('aside')
    expect(asideAfter?.parentElement?.className).toBe(splitClassBefore)
  })

  it('never displays stale skill actions or overwrites another skill while switching skills with an in-flight detail read', async () => {
    const projectFile = join(directory, 'workspace', '.dsh', 'skills', 'release-notes', 'SKILL.md')
    const userFile = skillPath()
    mkdirSync(join(directory, 'workspace', '.dsh', 'skills', 'release-notes'), { recursive: true })
    writeFileSync(projectFile, '---\nname: release-notes\ndescription: Project release notes\n---\nProject-only body.\n')
    writeFileSync(userFile, '---\nname: release-notes\ndescription: User release notes\n---\nUser-only body.\n')

    let resolveUserSkill: (() => void) | undefined
    const delayed = new Proxy(management, {
      get: (target, prop, receiver) => {
        if (prop !== 'read') return Reflect.get(target, prop, receiver)
        return async (operation: string, input: unknown) => {
          const key = (input as { key?: string } | null)?.key
          if (operation === 'skill' && key === 'user-dsh:release-notes' && resolveUserSkill === undefined) {
            await new Promise<void>(resolve => { resolveUserSkill = resolve })
          }
          return target.read(operation as never, input as never)
        }
      },
    })

    render(
      <SkillsSourcePage
        sourceTypeId="skills"
        sourceInstanceKey="source:skills"
        sourceInstances={[]}
        locale="en"
        writable
        management={delayed}
        navigationInput={{ seed: 'skill:project-dsh:release-notes', nonce: 1 }}
      />,
    )
    await screen.findByText('Project-only body.')

    const userRow = screen.getAllByRole('button', { name: /release-notes/u })
      .find(button => button.textContent?.includes('User release notes'))
    expect(userRow).toBeDefined()
    fireEvent.click(userRow!)

    // While user-dsh:release-notes is still loading, project-dsh:release-notes detail and Edit action must not remain interactive.
    expect(screen.queryByText('Project-only body.')).toBeNull()
    expect(screen.queryByRole('button', { name: t('common.edit') })).toBeNull()

    resolveUserSkill?.()
    await screen.findByText('User-only body.')
    expect(readFileSync(userFile, 'utf8')).toContain('User-only body.')
  })

  it('does not adopt the previous draft while a newly selected suggestion or standalone draft is loading', async () => {
    const alphaFile = join(directory, 'dsh', 'skills', 'review-alpha', 'SKILL.md')
    const betaFile = join(directory, 'dsh', 'skills', 'review-beta', 'SKILL.md')
    mkdirSync(join(directory, 'dsh', 'skills', 'review-alpha'), { recursive: true })
    mkdirSync(join(directory, 'dsh', 'skills', 'review-beta'), { recursive: true })
    const originalAlpha = '---\nname: review-alpha\ndescription: Review fixture.\n---\n\nOriginal review-alpha\n'
    const originalBeta = '---\nname: review-beta\ndescription: Review fixture.\n---\n\nOriginal review-beta\n'
    const changedAlpha = '---\nname: review-alpha\ndescription: Review fixture.\n---\n\nChanged ALPHA\n'
    const changedBeta = '---\nname: review-beta\ndescription: Review fixture.\n---\n\nChanged BETA\n'
    writeFileSync(alphaFile, originalAlpha)
    writeFileSync(betaFile, originalBeta)

    const baseReview = review()
    await mutate('review-record', {
      ...baseReview,
      suggestions: [
        { skillName: 'review-alpha', action: 'update', summary: 'Refine alpha', rationale: 'Alpha note.', confidence: 0.85, signals: ['correction'], steps: [3, 4] },
        { skillName: 'review-beta', action: 'update', summary: 'Refine beta', rationale: 'Beta note.', confidence: 0.84, signals: ['correction'], steps: [3, 4] },
      ],
      cases: [],
    })
    const suggestions = (await management.read('suggestions', null)).value as Array<{ id: string; skillName: string }>
    const alphaSuggestion = suggestions.find(item => item.skillName === 'review-alpha')!
    const betaSuggestion = suggestions.find(item => item.skillName === 'review-beta')!
    const alphaDraft = await mutate('draft-record', {
      suggestionId: alphaSuggestion.id,
      skillName: 'review-alpha',
      content: changedAlpha,
      notes: 'Alpha draft.',
      changes: [],
      guidance: [],
    }) as { id: string }
    const betaDraft = await mutate('draft-record', {
      suggestionId: betaSuggestion.id,
      skillName: 'review-beta',
      content: changedBeta,
      notes: 'Beta draft.',
      changes: [],
      guidance: [],
    }) as { id: string }

    let resolveBetaDraft: (() => void) | undefined
    const mutations: Array<{ op: string; input: unknown }> = []
    const delayed = new Proxy(management, {
      get: (target, prop, receiver) => {
        if (prop === 'read') {
          return async (operation: string, input: unknown) => {
            const id = (input as { id?: string } | null)?.id
            if (operation === 'draft' && id === betaDraft.id && resolveBetaDraft === undefined) {
              await new Promise<void>(resolve => { resolveBetaDraft = resolve })
            }
            return target.read(operation as never, input as never)
          }
        }
        if (prop === 'mutate') {
          return async (operation: string, input: unknown, options: unknown) => {
            mutations.push({ op: operation, input })
            return target.mutate(operation as never, input as never, options as never)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    render(
      <SkillsSourcePage
        sourceTypeId="skills"
        sourceInstanceKey="source:skills"
        sourceInstances={[]}
        locale="en"
        writable
        management={delayed}
        navigationInput={{ seed: `suggestion:${alphaSuggestion.id}`, nonce: 1 }}
      />,
    )
    await screen.findByRole('heading', { name: 'review-alpha' })
    expect(await screen.findByRole('button', { name: t('draft.adopt') })).not.toBeNull()

    const betaItem = screen.getAllByRole('button', { name: /review-beta/u })[0]!
    fireEvent.click(betaItem)
    await screen.findByRole('heading', { name: 'review-beta' })

    // While betaDraft is still loading, alphaDraft's Adopt button must NOT remain mounted or clickable.
    expect(screen.queryByRole('button', { name: t('draft.adopt') })).toBeNull()
    expect(readFileSync(alphaFile, 'utf8')).toBe(originalAlpha)

    resolveBetaDraft?.()
    const adoptBeta = await screen.findByRole('button', { name: t('draft.adopt') })
    fireEvent.click(adoptBeta)

    await waitFor(() => expect(readFileSync(betaFile, 'utf8')).toBe(changedBeta))
    expect(readFileSync(alphaFile, 'utf8')).toBe(originalAlpha)
    expect(mutations.filter(entry => entry.op === 'draft-adopt')).toEqual([
      { op: 'draft-adopt', input: { id: betaDraft.id } },
    ])
  })

  it('does not adopt the previous standalone draft while a newly selected standalone draft is loading', async () => {
    const mutations: Array<{ op: string; input: unknown }> = []
    const standaloneAlphaFile = join(directory, 'dsh', 'skills', 'standalone-alpha', 'SKILL.md')
    const standaloneBetaFile = join(directory, 'dsh', 'skills', 'standalone-beta', 'SKILL.md')
    mkdirSync(join(directory, 'dsh', 'skills', 'standalone-alpha'), { recursive: true })
    mkdirSync(join(directory, 'dsh', 'skills', 'standalone-beta'), { recursive: true })
    const originalStandaloneAlpha = '---\nname: standalone-alpha\ndescription: Standalone fixture.\n---\n\nOriginal standalone-alpha\n'
    const originalStandaloneBeta = '---\nname: standalone-beta\ndescription: Standalone fixture.\n---\n\nOriginal standalone-beta\n'
    const changedStandaloneAlpha = '---\nname: standalone-alpha\ndescription: Standalone fixture.\n---\n\nChanged STANDALONE ALPHA\n'
    const changedStandaloneBeta = '---\nname: standalone-beta\ndescription: Standalone fixture.\n---\n\nChanged STANDALONE BETA\n'
    writeFileSync(standaloneAlphaFile, originalStandaloneAlpha)
    writeFileSync(standaloneBetaFile, originalStandaloneBeta)
    const standaloneAlpha = await mutate('draft-record', {
      skillName: 'standalone-alpha',
      content: changedStandaloneAlpha,
      notes: 'Standalone alpha draft.',
      changes: [],
      guidance: [],
    }) as { id: string }
    const standaloneBeta = await mutate('draft-record', {
      skillName: 'standalone-beta',
      content: changedStandaloneBeta,
      notes: 'Standalone beta draft.',
      changes: [],
      guidance: [],
    }) as { id: string }

    let delayBetaDraft = false
    let resolveStandaloneBeta: (() => void) | undefined
    const delayedStandalone = new Proxy(management, {
      get: (target, prop, receiver) => {
        if (prop === 'read') {
          return async (operation: string, input: unknown) => {
            const id = (input as { id?: string } | null)?.id
            if (delayBetaDraft && operation === 'draft' && id === standaloneBeta.id && resolveStandaloneBeta === undefined) {
              await new Promise<void>(resolve => { resolveStandaloneBeta = resolve })
            }
            return target.read(operation as never, input as never)
          }
        }
        if (prop === 'mutate') {
          return async (operation: string, input: unknown, options: unknown) => {
            mutations.push({ op: operation, input })
            return target.mutate(operation as never, input as never, options as never)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    const view = render(
      <SkillsSourcePage
        sourceTypeId="skills"
        sourceInstanceKey="source:skills"
        sourceInstances={[]}
        locale="en"
        writable
        management={delayedStandalone}
        navigationInput={{ seed: `draft:${standaloneAlpha.id}`, nonce: 1 }}
        refreshKey={0}
      />,
    )
    await screen.findByRole('heading', { name: 'standalone-alpha' })
    expect(await screen.findByRole('button', { name: t('draft.adopt') })).not.toBeNull()

    const standaloneBetaRow = screen.getAllByRole('button', { name: /standalone-beta/u })[0]!
    // Bump refreshKey to clear the draft promise cache while delaying standaloneBeta's detail read,
    // and switch to standalone-beta synchronously: standaloneAlpha's Adopt button must unmount immediately.
    delayBetaDraft = true
    view.rerender(
      <SkillsSourcePage
        sourceTypeId="skills"
        sourceInstanceKey="source:skills"
        sourceInstances={[]}
        locale="en"
        writable
        management={delayedStandalone}
        navigationInput={{ seed: `draft:${standaloneAlpha.id}`, nonce: 1 }}
        refreshKey={1}
      />,
    )
    fireEvent.click(standaloneBetaRow)
    expect(screen.getByRole('heading', { name: 'standalone-beta' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: t('draft.adopt') })).toBeNull()

    resolveStandaloneBeta?.()
    fireEvent.click(await screen.findByRole('button', { name: t('draft.adopt') }))
    await waitFor(() => expect(readFileSync(standaloneBetaFile, 'utf8')).toBe(changedStandaloneBeta))
    expect(readFileSync(standaloneAlphaFile, 'utf8')).toBe(originalStandaloneAlpha)
    expect(mutations.filter(entry => entry.op === 'draft-adopt')).toEqual([
      { op: 'draft-adopt', input: { id: standaloneBeta.id } },
    ])
  })
})
