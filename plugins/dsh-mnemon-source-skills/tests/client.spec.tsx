// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
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

import * as plugin from '../src/index.ts'
import { installSkillsMemoryUI, SkillsSourcePage } from '../src/client.ts'
import { draftWithSkill, installSkillUseBridge, SKILL_USE_SLOT, SkillUseBridge } from '../src/client/use-skill.tsx'
import { translate } from '../src/client/presentation.ts'
import { compareRuns } from '../src/client/evolution-page.tsx'
import type { BacktestRun, CaseResult, EvalCase, ReviewRecordInput, SkillSummary, TrashEntry } from '../src/contracts.ts'

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
    fireEvent.click(await screen.findByRole('button', { name: 'Delete for good' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete release-notes for good?' })
    expect((within(dialog).getByRole('button', { name: 'Delete for good' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'release-notes' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete for good' }))
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
    expect(await screen.findByText(t('invocation.slashShort'))).not.toBeNull()
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

  it('installs a skill from a catalog added by path, without the network', async () => {
    const team = join(directory, 'team')
    mkdirSync(join(team, 'weekly-report'), { recursive: true })
    writeFileSync(join(team, 'weekly-report', 'SKILL.md'), '---\nname: weekly-report\ndescription: Write the weekly report.\n---\n\n# Weekly report\n\n1. Collect merged PRs\n')
    writeFileSync(join(team, 'registry.json'), JSON.stringify({ version: 1, id: 'team', name: { en: 'Team skills', 'zh-CN': '团队技能' }, skills: [
      { name: 'weekly-report', title: { en: 'Weekly report' }, description: { en: 'Writes the weekly report from merged work.' }, category: 'docs-writing', author: 'Team', source: { type: 'path', path: 'weekly-report' } },
    ] }))
    await mutate('registry-toggle', { id: 'official', enabled: false })
    page()
    fireEvent.click(await screen.findByRole('tab', { name: t('tab.market') }))
    // skills.sh stays on; the official catalog was switched off.
    fireEvent.click(await screen.findByRole('button', { name: t('market.sources', { count: 1 }) }))
    const sources = await screen.findByRole('dialog')
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
})
