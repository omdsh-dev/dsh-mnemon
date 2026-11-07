import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReviewRecordInput } from '../src/contracts.ts'
import { setFrontmatterKey, withInvocation } from '../src/frontmatter.ts'
import { SkillsService } from '../src/service.ts'
import type { LedgerFile } from '../src/store.ts'

let root: string
let home: string
let agents: string
let workspace: string
let data: string
let now: Date

function skill(name: string, description = `Use ${name}.`, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\n1. Step one\n`
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function service(): SkillsService {
  return new SkillsService(data, { dshHome: home, agentsHome: agents }, () => now)
}

function review(overrides: Partial<ReviewRecordInput> = {}): ReviewRecordInput {
  return {
    review: { at: now.toISOString(), sessionId: 'session-1', sessionTitle: 'Release notes', trigger: 'automatic', durationMs: 1200, outcome: 'suggested', summary: 'The user corrected the format twice.' },
    trajectory: {
      sessionId: 'session-1', sessionTitle: 'Release notes', startedAt: now.toISOString(), endedAt: now.toISOString(),
      stats: { turns: 3, userCharacters: 400, toolCalls: 4, toolFailures: 1, uniqueTools: 2, skills: ['release-notes'] },
      steps: [
        { index: 1, turn: 1, kind: 'user', text: 'Write release notes from the changelog' },
        { index: 2, turn: 1, kind: 'skill', text: 'release-notes', skill: { name: 'release-notes', by: 'model' } },
        { index: 3, turn: 1, kind: 'tool', text: 'git log failed', tool: { name: 'bash', ok: false, input: 'git log --oneline', error: 'not a git repository' } },
        { index: 4, turn: 2, kind: 'user', text: 'No, group them by component from now on' },
        { index: 5, turn: 2, kind: 'assistant', text: 'Grouped by component.' },
      ],
      annotations: [],
    },
    annotations: [{ step: 4, signal: 'correction', note: 'Grouping by component was missing' }, { step: 99, signal: 'directive', note: 'out of range' }],
    suggestions: [{ skillName: 'release-notes', action: 'update', summary: 'Group entries by component', rationale: 'The user corrected it.', confidence: 0.8, signals: ['correction', 'directive'], steps: [3, 4] }],
    cases: [{ skillName: 'release-notes', title: 'Group by component', prompt: 'Write release notes for v2 from this changelog', checks: [{ text: 'Entries are grouped by component', must: true }, { text: 'Breaking changes come first', must: false }], steps: [1, 4] }],
    ...overrides,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mnemon-skills-'))
  home = join(root, 'dsh')
  agents = join(root, 'agents')
  workspace = join(root, 'project', 'packages', 'app')
  data = join(root, 'data')
  mkdirSync(join(root, 'project', '.git'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  now = new Date('2026-10-21T08:00:00.000Z')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('skill catalog', () => {
  it('reads the four roots with DSH rules and marks the skill DSH loads', () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    write(join(home, 'skills', 'flat-skill.md'), skill('flat-skill'))
    write(join(home, 'skills', '.system', 'SKILL.md'), skill('system-skill'))
    write(join(home, 'skills', 'broken', 'SKILL.md'), '# no frontmatter\n')
    write(join(root, 'project', '.dsh', 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Project override.'))
    write(join(agents, 'skills', 'Bad_Name', 'SKILL.md'), skill('Bad_Name'))
    write(join(home, 'skills', 'release-notes', 'templates', 'note.md'), 'x')
    const catalog = service().catalogView(workspace)
    expect(catalog.projectRoot).toBe(join(root, 'project'))
    expect(catalog.skills.map(entry => entry.key)).toEqual(['user-dsh:flat-skill', 'project-dsh:release-notes', 'user-dsh:release-notes'])
    expect(catalog.skills.find(entry => entry.key === 'user-dsh:release-notes')?.shadowedBy).toBe('project-dsh:release-notes')
    expect(catalog.skills.find(entry => entry.key === 'user-dsh:release-notes')?.resources).toEqual(['templates/note.md'])
    expect(catalog.skills.find(entry => entry.key === 'user-dsh:flat-skill')?.layout).toBe('flat')
    expect(catalog.problems.map(problem => problem.reason)).toEqual(['missing YAML frontmatter', 'invalid skill name "Bad_Name"'])
    expect(service().catalogView(undefined).roots.map(entry => entry.kind)).toEqual(['user-dsh', 'user-agents'])
  })

  it('switches a skill with DSH frontmatter keys and keeps every other byte', () => {
    const raw = skill('pdf', 'Make PDFs.', 'version: 1.0.0\n')
    const off = withInvocation(raw, { modelInvocable: false, userInvocable: false })
    expect(off).toBe('---\nname: pdf\ndescription: Make PDFs.\nversion: 1.0.0\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n# pdf\n\n1. Step one\n')
    expect(withInvocation(off, { modelInvocable: true, userInvocable: true })).toBe(raw)
    expect(setFrontmatterKey(off, 'user-invocable', 'true')).toContain('user-invocable: true\n---')
  })
})

describe('skill writes', () => {
  it('fences on the file hash and keeps the original and each edit as versions', async () => {
    const path = join(home, 'skills', 'pdf', 'SKILL.md')
    write(path, skill('pdf'))
    const store = service()
    const before = store.skill(workspace, 'user-dsh:pdf')
    await expect(store.saveSkill(workspace, { key: 'user-dsh:pdf', content: skill('pdf', 'Edited.'), expectedHash: 'stale' })).rejects.toThrow(/changed since it was read/)
    await expect(store.saveSkill(workspace, { key: 'user-dsh:pdf', content: skill('other'), expectedHash: before.hash })).rejects.toThrow(/names "other"/)
    const saved = await store.saveSkill(workspace, { key: 'user-dsh:pdf', content: skill('pdf', 'Edited.'), expectedHash: before.hash })
    expect(saved.description).toBe('Edited.')
    const versions = store.versions('user-dsh:pdf')
    expect(versions.map(version => version.reason)).toEqual(['edit', 'original'])
    const toggled = await store.setInvocation(workspace, { key: 'user-dsh:pdf', modelInvocable: false, userInvocable: true, expectedHash: saved.hash })
    expect(toggled.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    expect(readFileSync(path, 'utf8')).toContain('disable-model-invocation: true')
    const original = store.versions('user-dsh:pdf').find(version => version.reason === 'original')!
    const restored = await store.restoreVersion(workspace, { key: 'user-dsh:pdf', versionId: original.id, expectedHash: toggled.hash })
    expect(readFileSync(path, 'utf8')).toBe(skill('pdf'))
    expect(restored.description).toBe('Use pdf.')
  })

  it('creates in the chosen root and moves a deleted skill to the trash', async () => {
    const store = service()
    const created = await store.createSkill(workspace, { name: 'deploy-check', description: 'Check a deploy.', root: 'project-dsh' })
    expect(created.path).toBe(join(root, 'project', '.dsh', 'skills', 'deploy-check', 'SKILL.md'))
    await expect(store.createSkill(workspace, { name: 'deploy-check', description: 'Again.', root: 'project-dsh' })).rejects.toThrow(/already exists/)
    await expect(store.createSkill(workspace, { name: 'Deploy Check', description: 'x' })).rejects.toThrow(/lowercase/)
    const { trashedTo } = await store.deleteSkill(workspace, { key: created.key, expectedHash: created.hash })
    expect(existsSync(created.path)).toBe(false)
    expect(readFileSync(join(trashedTo, 'SKILL.md'), 'utf8')).toContain('name: deploy-check')
    expect(store.catalogView(workspace).skills).toEqual([])
  })
})

describe('review admission', () => {
  it.each([
    { allowCreate: true, allowUpdate: true },
    { allowCreate: true, allowUpdate: false },
    { allowCreate: false, allowUpdate: true },
    { allowCreate: false, allowUpdate: false },
  ])('enforces actual suggestion and case types with %j', async policy => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    const input = review()
    const result = await store.recordReview(workspace, review({
      policy,
      suggestions: [
        // Calling an existing skill a creation must not bypass the update switch.
        { ...input.suggestions[0]!, action: 'create' },
        { ...input.suggestions[0]!, action: 'create', skillName: 'incident-triage' },
      ],
      cases: [input.cases[0]!, { ...input.cases[0]!, skillName: 'incident-triage' }],
    }))
    const count = Number(policy.allowCreate) + Number(policy.allowUpdate)
    expect(result).toMatchObject({ inserted: count, updated: 0, casesAdded: count })
    expect(store.suggestions().map(entry => entry.action).sort()).toEqual([
      ...(policy.allowCreate ? ['create'] : []), ...(policy.allowUpdate ? ['update'] : []),
    ])
    expect(store.cases('release-notes')).toHaveLength(Number(policy.allowUpdate))
    expect(store.cases('incident-triage')).toHaveLength(Number(policy.allowCreate))
    expect(store.trajectory(result.trajectoryId!).outcome).toBe(count === 0 ? 'nothing' : 'suggested')
  })

  it('leaves an existing suggestion unchanged when its type is disabled', async () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const before = store.suggestions()
    now = new Date(now.getTime() + 1_000)
    const result = await store.recordReview(workspace, review({ policy: { allowUpdate: false } }))
    expect(result).toMatchObject({ inserted: 0, updated: 0, casesAdded: 0, suggestionIds: [] })
    expect(store.suggestions()).toEqual(before)
  })

  it.each(['allowCreate', 'allowUpdate'])('rejects malformed %s before writing review data', async key => {
    const store = service()
    await expect(store.recordReview(workspace, review({ policy: { [key]: 'false' } as never }))).rejects.toThrow('must be a boolean')
    expect(store.overview(workspace).counts).toMatchObject({ trajectories: 0, pending: 0, cases: 0 })
  })

  it('records the trajectory, links evidence, and adds proposed cases once', async () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    const result = await store.recordReview(workspace, review())
    expect(result).toMatchObject({ inserted: 1, updated: 0, casesAdded: 1 })
    const [suggestion] = store.suggestions()
    expect(suggestion).toMatchObject({ skillName: 'release-notes', action: 'update', status: 'pending', confidence: 0.8, signals: ['correction', 'directive'], skillKey: 'user-dsh:release-notes' })
    expect(suggestion!.evidence).toEqual([{ trajectoryId: result.trajectoryId, steps: [3, 4] }])
    const trajectory = store.trajectory(result.trajectoryId!)
    expect(trajectory.annotations).toEqual([{ step: 4, signal: 'correction', note: 'Grouping by component was missing', suggestionIds: [suggestion!.id] }])
    expect(trajectory).toMatchObject({ outcome: 'suggested', signals: ['correction'], suggestionIds: [suggestion!.id] })
    expect(store.cases('release-notes')[0]).toMatchObject({ title: 'Group by component', origin: { kind: 'review', trajectoryId: result.trajectoryId, steps: [1, 4], suggestionId: suggestion!.id } })

    now = new Date(now.getTime() + 60_000)
    const again = await store.recordReview(workspace, review({ suggestions: [{ ...review().suggestions[0]!, confidence: 0.7, summary: 'Lower' }] }))
    expect(again).toMatchObject({ inserted: 0, updated: 0, casesAdded: 0 })
    expect(again.skipped.map(entry => entry.reason)).toEqual(['duplicate_lower_confidence', 'similar_case'])
    expect(store.suggestions()[0]!.evidence).toHaveLength(2)
    expect(store.overview(workspace).counts).toMatchObject({ skills: 1, pending: 1, trajectories: 2, cases: 1 })
  })

  it('drops weak, uncited and recently dismissed proposals and keeps the session within its limit', async () => {
    const store = service()
    // The Host passes its admission settings with each review; out-of-range values fall back.
    const result = await store.recordReview(workspace, review({
      policy: { maxPendingPerSession: 2, minConfidence: 2 },
      cases: [],
      suggestions: [
        { skillName: 'Weak One', action: 'create', summary: 'Weak', confidence: 0.3, signals: [], steps: [1] },
        { skillName: 'uncited', action: 'create', summary: 'No steps', confidence: 0.9, signals: [], steps: [42] },
        { skillName: 'missing', action: 'update', summary: 'Unknown', confidence: 0.9, signals: [], steps: [1] },
        { skillName: 'Alpha Flow', action: 'create', summary: 'A', confidence: 0.7, signals: ['procedure'], steps: [1] },
        { skillName: 'beta-flow', action: 'create', summary: 'B', confidence: 0.9, signals: ['procedure'], steps: [1] },
        { skillName: 'gamma-flow', action: 'create', summary: 'C', confidence: 0.8, signals: ['procedure'], steps: [1] },
      ],
    }))
    expect(result.skipped.map(entry => entry.reason)).toEqual(['no_evidence', 'unknown_skill', 'low_confidence'])
    expect(store.suggestions(['pending']).map(entry => entry.skillName)).toEqual(['gamma-flow', 'beta-flow'])
    expect(store.suggestions(['expired']).map(entry => entry.skillName)).toEqual(['alpha-flow'])
    const beta = store.suggestions(['pending']).find(entry => entry.skillName === 'beta-flow')!
    await store.dismissSuggestion(beta.id)
    const blocked = await store.recordReview(workspace, review({ cases: [], suggestions: [{ skillName: 'beta-flow', action: 'create', summary: 'B again', confidence: 0.95, signals: [], steps: [1] }] }))
    expect(blocked.skipped.map(entry => entry.reason)).toEqual(['recently_dismissed'])
    now = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000)
    expect(store.suggestions(['pending'])).toEqual([])
  })
})

describe('evolution drafts and backtests', () => {
  it('keeps a project improvement bound to its origin across scopes and restarts', async () => {
    const path = join(root, 'project', '.dsh', 'skills', 'release-notes', 'SKILL.md')
    const other = join(root, 'other-project')
    const otherPath = join(other, '.dsh', 'skills', 'release-notes', 'SKILL.md')
    write(path, skill('release-notes', 'Original project.'))
    write(otherPath, skill('release-notes', 'Other project.'))
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'User copy.'))
    const store = service()
    await store.recordReview(workspace, review())
    const suggestion = store.suggestions()[0]!
    for (const scope of [undefined, other, workspace]) {
      const reopened = service()
      expect(reopened.suggestion(scope, suggestion.id).skill?.path).toBe(path)
      expect(reopened.evidencePack(scope, { suggestionId: suggestion.id }).skill?.content).toBe(skill('release-notes', 'Original project.'))
    }
    const next = skill('release-notes', 'Improved original.')
    const draft = await service().recordDraft(other, { suggestionId: suggestion.id, skillName: 'release-notes', content: next, notes: '', changes: [], guidance: [] })
    expect(service().draft(undefined, draft.id).base?.path).toBe(path)
    expect(service().targetContent(other, 'release-notes', { kind: 'current', draftId: draft.id }).content).toBe(skill('release-notes', 'Original project.'))
    expect((await service().adoptDraft(other, draft.id)).skill.path).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe(next)
    expect(readFileSync(otherPath, 'utf8')).toBe(skill('release-notes', 'Other project.'))
  })

  it('does not merge suggestions or supersede manual drafts for same-name project files', async () => {
    const first = join(root, 'project', '.dsh', 'skills', 'release-notes', 'SKILL.md')
    const other = join(root, 'other-project')
    write(first, skill('release-notes'))
    write(join(other, '.dsh', 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    await store.recordReview(other, review())
    expect(store.suggestions()).toHaveLength(2)
    const input = { skillName: 'release-notes', content: skill('release-notes', 'Draft.'), notes: '', changes: [], guidance: [] }
    const one = await store.recordDraft(workspace, input)
    const two = await store.recordDraft(other, input)
    expect(service().draft(undefined, one.id).draft.status).toBe('ready')
    expect(service().draft(undefined, two.id).base?.path).not.toBe(first)
    expect(store.evidencePack(workspace, { skill: 'release-notes' }).drafts.map(draft => draft.id)).toEqual([one.id])
  })

  it('keeps a user suggestion on its exact root when a project or higher-priority copy appears', async () => {
    const path = join(agents, 'skills', 'release-notes', 'SKILL.md')
    write(path, skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const suggestion = store.suggestions()[0]!
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'DSH copy.'))
    write(join(root, 'project', '.dsh', 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Project copy.'))
    expect(store.suggestion(workspace, suggestion.id).skill?.path).toBe(path)
    const draft = await store.recordDraft(workspace, { suggestionId: suggestion.id, skillName: 'release-notes', content: skill('release-notes', 'Improved.'), notes: '', changes: [], guidance: [] })
    expect((await store.adoptDraft(workspace, draft.id)).skill.path).toBe(path)
  })

  it('does not turn a removed or moved original into a creation or another same-name update', async () => {
    const path = join(root, 'project', '.dsh', 'skills', 'release-notes', 'SKILL.md')
    write(path, skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const suggestion = store.suggestions()[0]!
    const input = { suggestionId: suggestion.id, skillName: 'release-notes', content: skill('release-notes', 'Improved.'), notes: '', changes: [], guidance: [] }
    const draft = await store.recordDraft(workspace, input)
    rmSync(path)
    write(join(root, 'project', '.dsh', 'skills', 'moved.md'), skill('release-notes'))
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    expect(store.suggestion(workspace, suggestion.id)).toMatchObject({ resolution: 'missing', hashCurrent: false })
    expect(store.suggestion(workspace, suggestion.id).skill).toBeUndefined()
    expect(store.draft(workspace, draft.id).base).toBeUndefined()
    expect(() => store.evidencePack(workspace, { suggestionId: suggestion.id })).toThrow(/deleted|moved/i)
    await expect(store.recordDraft(workspace, input)).rejects.toThrow(/deleted|moved/i)
    await expect(store.adoptDraft(workspace, draft.id)).rejects.toThrow(/deleted|moved/i)
  })

  it('recovers a legacy project suggestion and its draft from the exact review trajectory', async () => {
    const path = join(root, 'project', '.dsh', 'skills', 'release-notes', 'SKILL.md')
    const other = join(root, 'other-project')
    write(path, skill('release-notes'))
    write(join(other, '.dsh', 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    const input = review()
    await store.recordReview(workspace, { ...input, trajectory: { ...input.trajectory, workspace } })
    const suggestion = store.suggestions()[0]!
    const draft = await store.recordDraft(workspace, { suggestionId: suggestion.id, skillName: 'release-notes', content: skill('release-notes', 'Improved.'), notes: '', changes: [], guidance: [] })
    const ledger = store.store.ledger()
    delete ledger.suggestions[0]!.origin
    delete ledger.drafts[0]!.origin
    store.store.saveLedger(ledger)
    expect(service().suggestion(undefined, suggestion.id).skill?.path).toBe(path)
    expect(service().draft(other, draft.id).base?.path).toBe(path)
    expect((await service().adoptDraft(other, draft.id)).skill.path).toBe(path)
  })

  it('does not infer a missing legacy origin from same-name files or matching hashes', async () => {
    const path = join(root, 'project', '.dsh', 'skills', 'release-notes', 'SKILL.md')
    write(path, skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const suggestion = store.suggestions()[0]!
    const draft = await store.recordDraft(workspace, { suggestionId: suggestion.id, skillName: 'release-notes', content: skill('release-notes', 'Improved.'), notes: '', changes: [], guidance: [] })
    const ledger = store.store.ledger()
    delete ledger.suggestions[0]!.origin
    delete ledger.drafts[0]!.origin
    store.store.saveLedger(ledger)
    expect(service().suggestion(workspace, suggestion.id)).toMatchObject({ resolution: 'origin-unavailable', hashCurrent: false })
    expect(service().draft(workspace, draft.id)).toMatchObject({ resolution: 'origin-unavailable' })
    await expect(service().adoptDraft(workspace, draft.id)).rejects.toThrow(/original workspace.*recorded/i)
    expect(readFileSync(path, 'utf8')).toBe(skill('release-notes'))
  })

  it.each([true, false])('uses the exact legacy review origin and refuses mixed evidence without it (reviewId=%s)', async keepsReviewId => {
    const other = join(root, 'other-project')
    write(join(root, 'project', '.dsh', 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const path = join(other, '.dsh', 'skills', 'release-notes', 'SKILL.md')
    write(path, skill('release-notes'))
    const store = service()
    const input = review()
    await store.recordReview(workspace, { ...input, trajectory: { ...input.trajectory, workspace } })
    await store.recordReview(other, { ...input, trajectory: { ...input.trajectory, workspace: other } })
    const ledger = store.store.ledger()
    const [latest, earlier] = ledger.suggestions
    latest!.evidence.push(...earlier!.evidence)
    delete latest!.origin
    if (!keepsReviewId) delete latest!.reviewId
    store.store.saveLedger(ledger)
    const view = service().suggestion(workspace, latest!.id)
    if (keepsReviewId) expect(view.skill?.path).toBe(path)
    else expect(view.resolution).toBe('origin-unavailable')
  })

  it('keeps a manual redraft on the original file from another workspace', async () => {
    const path = join(root, 'project', '.dsh', 'skills', 'release-notes', 'SKILL.md')
    const other = join(root, 'other-project')
    write(path, skill('release-notes', 'Original.'))
    write(join(other, '.dsh', 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Other.'))
    const store = service()
    const input = { skillName: 'release-notes', content: skill('release-notes', 'First draft.'), notes: '', changes: [], guidance: [] }
    const first = await store.recordDraft(workspace, input)
    expect(store.evidencePack(other, { draftId: first.id }).skill?.path).toBe(path)
    const second = await store.recordDraft(other, { ...input, draftId: first.id, content: skill('release-notes', 'Second draft.') })
    expect(store.draft(undefined, second.id).base?.path).toBe(path)
    expect(store.draft(undefined, first.id).draft.status).toBe('discarded')
  })

  it.each([null, { path: 'relative/SKILL.md', workspace: '/project' }, { path: '/project/SKILL.md', workspace: 'relative' }])('rejects damaged persisted origin %j without reading the selected copy', async origin => {
    const path = join(root, 'project', '.dsh', 'skills', 'release-notes', 'SKILL.md')
    write(path, skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const suggestion = store.suggestions()[0]!
    const ledger = store.store.ledger()
    Object.assign(ledger.suggestions[0]!, { origin })
    store.store.saveLedger(ledger)
    expect(store.suggestion(workspace, suggestion.id).resolution).toBe('origin-unavailable')
    expect(() => store.evidencePack(workspace, { suggestionId: suggestion.id })).toThrow(/original workspace.*recorded/i)
    expect(readFileSync(path, 'utf8')).toBe(skill('release-notes'))
  })

  it('adopts an update draft under the base hash and records an evolution version', async () => {
    const path = join(home, 'skills', 'release-notes', 'SKILL.md')
    write(path, skill('release-notes'))
    const store = service()
    const { trajectoryId } = await store.recordReview(workspace, review())
    const suggestion = store.suggestions()[0]!
    await store.suggestionStatus({ id: suggestion.id, status: 'drafting' })
    const pack = store.evidencePack(workspace, { suggestionId: suggestion.id })
    expect(pack.excerpts[0]).toMatchObject({ trajectoryId, sessionTitle: 'Release notes' })
    expect(pack.excerpts[0]!.steps.map(step => step.index)).toEqual([2, 3, 4, 5])
    expect(pack.skill?.content).toBe(skill('release-notes'))
    await expect(store.recordDraft(workspace, { suggestionId: suggestion.id, skillName: 'release-notes', content: '# no frontmatter', notes: '', changes: [], guidance: [] })).rejects.toThrow(/would not load/)
    const next = skill('release-notes', 'Use release-notes; group by component.')
    const draft = await store.recordDraft(workspace, { suggestionId: suggestion.id, skillName: 'release-notes', content: next, notes: 'Groups by component.', changes: ['Group by component'], guidance: [] })
    expect(store.suggestion(workspace, suggestion.id)).toMatchObject({ suggestion: { status: 'review', draftId: draft.id }, hashCurrent: true })
    expect(store.draft(workspace, draft.id).base?.content).toBe(skill('release-notes'))
    const adopted = await store.adoptDraft(workspace, draft.id)
    expect(readFileSync(path, 'utf8')).toBe(next)
    expect(adopted.version).toMatchObject({ reason: 'evolution', draftId: draft.id, suggestionId: suggestion.id })
    expect(store.suggestions()[0]!.status).toBe('adopted')
    expect(store.versions('user-dsh:release-notes').map(version => version.reason)).toEqual(['evolution', 'original'])
  })

  it('refuses a stale update draft and creates a new skill from a create draft', async () => {
    const path = join(home, 'skills', 'release-notes', 'SKILL.md')
    write(path, skill('release-notes'))
    const store = service()
    const draft = await store.recordDraft(workspace, { skillName: 'release-notes', content: skill('release-notes', 'v2'), notes: '', changes: [], guidance: [] })
    write(path, skill('release-notes', 'edited by hand'))
    await expect(store.adoptDraft(workspace, draft.id)).rejects.toThrow(/changed since it was read/)
    const created = await store.recordDraft(workspace, { skillName: 'weekly-report', content: skill('weekly-report'), notes: 'New', changes: [], guidance: [], targetRoot: 'user-agents' })
    expect(created).toMatchObject({ action: 'create', targetRoot: 'user-agents' })
    const result = await store.adoptDraft(workspace, created.id)
    expect(result.skill.key).toBe('user-agents:weekly-report')
    expect(readdirSync(join(agents, 'skills'))).toEqual(['weekly-report'])
  })

  it.each([
    { targetRoot: 'project-dsh', root: undefined },
    { targetRoot: 'project-agents', root: undefined },
    { targetRoot: 'user-dsh', root: 'project-dsh' },
    { targetRoot: 'user-dsh', root: 'project-agents' },
  ] as const)('does not recreate a removed project at adoption: %j', async choice => {
    const store = service()
    const draft = await store.recordDraft(workspace, {
      skillName: 'weekly-report', content: skill('weekly-report'), notes: 'New', changes: [], guidance: [], targetRoot: choice.targetRoot,
    })
    const project = join(root, 'project')
    rmSync(project, { recursive: true })
    await expect(store.adoptDraft(workspace, draft.id, choice.root === undefined ? {} : { root: choice.root })).rejects.toThrow(/project.*unavailable/i)
    expect(existsSync(project)).toBe(false)
    expect(store.draft(workspace, draft.id).draft.status).toBe('ready')
    // A deliberate user-root override remains available after that refusal.
    const adopted = await store.adoptDraft(workspace, draft.id, { root: 'user-agents' })
    expect(adopted.skill.key).toBe('user-agents:weekly-report')
    expect(readFileSync(join(agents, 'skills', 'weekly-report', 'SKILL.md'), 'utf8')).toBe(skill('weekly-report'))
    expect(existsSync(project)).toBe(false)
  })

  it('scores a run from its case results', async () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const second = await store.saveCase({ skillName: 'release-notes', title: 'Breaking first', prompt: 'Notes with a breaking change', checks: [{ text: 'Breaking change first', must: false }] })
    expect(second.checks[0]!.must).toBe(true)
    const cases = store.cases('release-notes')
    const { target } = store.targetContent(workspace, 'release-notes', { kind: 'current' })
    const run = await store.startRun({ skillName: 'release-notes', target, caseIds: cases.map(entry => entry.id) })
    expect(run.progress).toEqual({ done: 0, total: 2 })
    await store.progressRun({ id: run.id, result: { caseId: cases[0]!.id, title: cases[0]!.title, verdict: 'pass', score: 1, checks: [], steps: ['a'], answer: 'ok' } })
    await store.progressRun({ id: run.id, result: { caseId: cases[1]!.id, title: cases[1]!.title, verdict: 'fail', score: 0.5, checks: [], steps: [], answer: 'no' } })
    const finished = await store.finishRun({ id: run.id, status: 'completed' })
    expect(finished).toMatchObject({ status: 'completed', passRate: 0.5, score: 0.75, progress: { done: 2, total: 2 } })
    expect(store.catalogView(workspace).stats['release-notes']).toMatchObject({ open: 1, cases: 2, lastPassRate: 0.5, lastScore: 0.75 })
  })

  it('flags a regression only when the live version scores below its own last backtest', async () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const [entry] = store.cases('release-notes')
    const draft = await store.recordDraft(workspace, { skillName: 'release-notes', content: skill('release-notes', 'Use release-notes, grouped.'), notes: 'Grouped.', changes: [], guidance: [] })
    const backtest = async (target: Parameters<SkillsService['startRun']>[0]['target'], score: number) => {
      now = new Date(now.getTime() + 1000)
      const run = await store.startRun({ skillName: 'release-notes', target, caseIds: [entry!.id] })
      await store.progressRun({ id: run.id, result: { caseId: entry!.id, title: entry!.title, verdict: score === 1 ? 'pass' : 'fail', score, checks: [], steps: [], answer: '' } })
      await store.finishRun({ id: run.id, status: 'completed' })
    }
    const { target: current } = store.targetContent(workspace, 'release-notes', { kind: 'current' })
    const regressions = () => store.overview(workspace).attention.filter(item => item.kind === 'regression').map(item => item.title)
    await backtest(current, 0.8)
    await backtest({ kind: 'draft', hash: 'h', draftId: draft.id }, 1)
    await backtest(current, 0.75)
    // A draft scoring higher than the live version is not a regression of the live version.
    expect(regressions()).toEqual([])
    await backtest(current, 0.5)
    expect(regressions()).toEqual(['75 → 50'])
  })
})

describe('model picks', () => {
  it('keeps the current draft linked when an older draft is deleted', async () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const suggestion = store.suggestions()[0]!
    const input = { suggestionId: suggestion.id, skillName: 'release-notes', content: skill('release-notes', 'Grouped.'), notes: '', changes: [], guidance: [] }
    const old = await store.recordDraft(workspace, input)
    const current = await store.recordDraft(workspace, input)

    await store.deleteDraft(old.id)
    expect(store.suggestion(workspace, suggestion.id).suggestion).toMatchObject({ status: 'review', draftId: current.id })
    expect(store.draft(workspace, current.id).draft.status).toBe('ready')

    await store.deleteDraft(current.id)
    const waiting = store.suggestion(workspace, suggestion.id).suggestion
    expect(waiting.status).toBe('pending')
    expect(waiting).not.toHaveProperty('draftId')
  })

  it('stores a global draft pick, a per-suggestion pick and a per-skill backtest pick, and clears each', async () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const suggestion = store.suggestions()[0]!
    expect(store.draftPreferences()).toEqual({ suggestionModels: {}, skillRunModels: {} })
    const route = { provider: 'buddy', model: 'deepseek-v4.1-flash' }
    expect(await store.setDraftPreference({ model: route })).toMatchObject({ model: route })
    expect(await store.setDraftPreference({ suggestionId: suggestion.id, model: route })).toMatchObject({ suggestionModels: { [suggestion.id]: route } })
    expect(await store.setDraftPreference({ slot: 'run', model: route })).toMatchObject({ runModel: route })
    expect(await store.setDraftPreference({ slot: 'run', skillName: 'release-notes', model: route })).toMatchObject({ skillRunModels: { 'release-notes': route } })
    // The picks survive a fresh service over the same directory: they are stored, not held in memory.
    expect(service().draftPreferences()).toMatchObject({ model: route, runModel: route, suggestionModels: { [suggestion.id]: route }, skillRunModels: { 'release-notes': route } })
    expect(await store.setDraftPreference({ model: null })).not.toHaveProperty('model')
    expect(await store.setDraftPreference({ suggestionId: suggestion.id, model: null })).toMatchObject({ suggestionModels: {} })
    expect(await store.setDraftPreference({ slot: 'run', model: null })).not.toHaveProperty('runModel')
    expect(await store.setDraftPreference({ slot: 'run', skillName: 'release-notes', model: null })).toMatchObject({ skillRunModels: {} })
    // A picker change is not ledger work: the revision an open page holds stays valid.
    expect(store.draftPreferences()).toEqual({ suggestionModels: {}, skillRunModels: {} })
  })

  it('deletes a suggestion with its draft and its pick, and refuses one a write still holds', async () => {
    // A write claimed now is not an orphan of the previous Host: the clock has to
    // sit after this process started, as it does in a real run.
    now = new Date()
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const suggestion = store.suggestions()[0]!
    const route = { provider: 'trae', model: 'deepseek-v4.1-flash' }
    await store.setDraftPreference({ suggestionId: suggestion.id, model: route })
    await store.suggestionStatus({ id: suggestion.id, status: 'drafting' })
    await expect(store.deleteSuggestion(suggestion.id)).rejects.toThrow(/a draft is being written/)
    await store.suggestionStatus({ id: suggestion.id, status: 'pending' })
    const draft = await store.recordDraft(workspace, { suggestionId: suggestion.id, skillName: 'release-notes', content: skill('release-notes', 'Grouped.'), notes: '', changes: [], guidance: [] })
    expect(await store.deleteSuggestion(suggestion.id)).toEqual({ deleted: suggestion.id })
    expect(store.suggestions().map(entry => entry.id)).toEqual([])
    expect(() => store.draft(workspace, draft.id)).toThrow()
    expect(store.draftPreferences().suggestionModels).toEqual({})
  })

  it('removes deleted suggestion links and counts from every review and trajectory without deleting evidence', async () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    const input = review()
    input.suggestions.push({ ...input.suggestions[0]!, skillName: 'release-checks', action: 'create' })
    await store.recordReview(workspace, input)
    await store.recordReview(workspace, input)
    const [removed, kept] = store.suggestions()
    expect(removed).toBeDefined()
    expect(kept).toBeDefined()
    const before = store.trajectories().map(entry => store.trajectory(entry.id))
    const cases = store.cases()
    for (const id of [removed!.id, kept!.id]) {
      await store.deleteSuggestion(id)
      const ids = id === removed!.id ? [kept!.id] : []
      // Check persisted index cleanup as well as the public read paths.
      const ledger = JSON.parse(readFileSync(join(data, 'skills', 'ledger.json'), 'utf8')) as LedgerFile
      for (const review of [...ledger.reviews, ...store.reviews()]) {
        expect(review.suggestions).toBe(ids.length)
        expect(review.suggestionIds).toEqual(ids.length === 0 ? undefined : ids)
      }
      expect(ledger.trajectories.map(entry => entry.suggestionIds)).toEqual([ids, ids])
      for (const [index, entry] of store.trajectories().entries()) {
        expect(entry.suggestionIds).toEqual(ids)
        const detail = store.trajectory(entry.id)
        expect(detail.suggestionIds).toEqual(ids)
        expect(detail.annotations.every(annotation => (annotation.suggestionIds ?? []).every(link => ids.includes(link)))).toBe(true)
        expect(detail.steps).toEqual(before[index]!.steps)
        expect(detail.annotations.map(({ suggestionIds: _, ...annotation }) => annotation)).toEqual(before[index]!.annotations.map(({ suggestionIds: _, ...annotation }) => annotation))
      }
      expect(store.cases()).toEqual(cases)
    }
  })

  it('filters legacy dangling links on read without changing the revision or writing files', async () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    const result = await store.recordReview(workspace, review())
    const live = result.suggestionIds[0]!
    const trajectoryId = result.trajectoryId!
    const ledgerPath = join(data, 'skills', 'ledger.json')
    const trajectoryPath = join(data, 'skills', 'trajectories', result.trajectoryId + '.json')
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as LedgerFile
    ledger.reviews[0]!.suggestionIds = [live, 'deleted-legacy']
    ledger.reviews[0]!.suggestions = 2
    ledger.trajectories[0]!.suggestionIds = [live, 'deleted-legacy']
    const trajectory = store.trajectory(trajectoryId)
    trajectory.suggestionIds = [live, 'deleted-legacy']
    trajectory.annotations[0]!.suggestionIds = ['deleted-legacy']
    writeFileSync(ledgerPath, JSON.stringify(ledger))
    writeFileSync(trajectoryPath, JSON.stringify(trajectory))
    const originalLedger = readFileSync(ledgerPath, 'utf8')
    const originalTrajectory = readFileSync(trajectoryPath, 'utf8')
    const revision = store.revision(workspace)
    expect(store.reviews()[0]).toMatchObject({ suggestions: 1, suggestionIds: [live] })
    expect(store.trajectories()[0]!.suggestionIds).toEqual([live])
    expect(store.suggestion(workspace, live).trajectories[0]!.suggestionIds).toEqual([live])
    expect(store.trajectory(trajectoryId).suggestionIds).toEqual([live])
    expect(store.trajectory(trajectoryId).annotations[0]!.suggestionIds).toBeUndefined()
    expect(store.evidencePack(workspace, { suggestionId: live }).excerpts[0]!.annotations[0]!.suggestionIds).toBeUndefined()
    expect(store.revision(workspace)).toBe(revision)
    expect(readFileSync(ledgerPath, 'utf8')).toBe(originalLedger)
    expect(readFileSync(trajectoryPath, 'utf8')).toBe(originalTrajectory)
    // The next ordinary locked write persists the normalized index.
    await store.pinTrajectory(trajectoryId, true)
    const saved = JSON.parse(readFileSync(ledgerPath, 'utf8')) as LedgerFile
    expect(saved.reviews[0]).toMatchObject({ suggestions: 1, suggestionIds: [live] })
    expect(saved.trajectories[0]!.suggestionIds).toEqual([live])
  })

  it('preserves evidence-only review counts and legacy reviews with no suggestion links', async () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const input = review()
    input.suggestions[0]!.confidence = 0.75
    await store.recordReview(workspace, input)
    expect(store.reviews()[0]).toMatchObject({ suggestions: 0, suggestionIds: [store.suggestions()[0]!.id] })
    const ledgerPath = join(data, 'skills', 'ledger.json')
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as LedgerFile
    delete ledger.reviews[1]!.suggestionIds
    writeFileSync(ledgerPath, JSON.stringify(ledger))
    expect(store.reviews()[1]).toMatchObject({ suggestions: 1 })
    await store.deleteSuggestion(store.suggestions()[0]!.id)
    expect(store.reviews().map(entry => entry.suggestions)).toEqual([0, 1])
  })

  it('puts a suggestion whose draft write died with the previous Host back to pending', async () => {
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes'))
    const store = service()
    await store.recordReview(workspace, review())
    const suggestion = store.suggestions()[0]!
    await store.suggestionStatus({ id: suggestion.id, status: 'drafting' })
    // The write was claimed before this Host started, so nothing is writing it now.
    const ledger = JSON.parse(readFileSync(join(data, 'skills', 'ledger.json'), 'utf8')) as { suggestions: Array<{ id: string; updatedAt: string }> }
    ledger.suggestions.find(entry => entry.id === suggestion.id)!.updatedAt = '2001-01-01T00:00:00.000Z'
    writeFileSync(join(data, 'skills', 'ledger.json'), JSON.stringify(ledger))
    expect(store.suggestions(['drafting'])).toHaveLength(0)
    expect(store.suggestion(workspace, suggestion.id).suggestion).toMatchObject({ status: 'pending', lastError: /the host restarted while this draft was being written/u })
    // And it is a suggestion the page can act on again: dismiss works where it refused before.
    await store.dismissSuggestion(suggestion.id)
    expect(store.suggestion(workspace, suggestion.id).suggestion.status).toBe('dismissed')
  })
})


describe('draft and backtest recovery', () => {
  it('reports a changed original before adoption and regenerates from its current hash', async () => {
    const path = join(home, 'skills', 'release-notes', 'SKILL.md')
    write(path, skill('release-notes'))
    const store = service()
    const input = { skillName: 'release-notes', content: skill('release-notes', 'Candidate.'), notes: '', changes: [], guidance: [] }
    const draft = await store.recordDraft(workspace, input)
    write(path, skill('release-notes', 'New current file.'))
    expect(store.draft(workspace, draft.id).conflict).toBe('base-changed')
    await expect(store.adoptDraft(workspace, draft.id)).rejects.toThrow('changed since it was read')
    await store.updateDraft({ id: draft.id, content: input.content })
    expect(store.draft(workspace, draft.id).conflict).toBe('base-changed')
    const current = store.evidencePack(workspace, { draftId: draft.id }).skill!
    await expect(store.recordDraft(workspace, { ...input, draftId: draft.id, expectedBaseHash: draft.baseHash! })).rejects.toThrow('changed while')
    const next = await store.recordDraft(workspace, { ...input, draftId: draft.id, expectedBaseHash: current.hash })
    expect(store.draft(workspace, next.id).conflict).toBeUndefined()
    await store.adoptDraft(workspace, next.id)
    expect(readFileSync(path, 'utf8')).toBe(input.content)
  })

  it('shows a newly existing target and converts a regenerated creation into an update', async () => {
    const store = service()
    const input = { skillName: 'release-notes', content: skill('release-notes'), notes: '', changes: [], guidance: [] }
    const draft = await store.recordDraft(workspace, input)
    write(join(home, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Installed elsewhere.'))
    expect(store.draft(workspace, draft.id).conflict).toBe('target-exists')
    await expect(store.recordDraft(workspace, { ...input, expectedBaseHash: null })).rejects.toThrow('changed while')
    const pack = store.evidencePack(workspace, { draftId: draft.id })
    const next = await store.recordDraft(workspace, { ...input, draftId: draft.id, expectedBaseHash: pack.skill!.hash })
    expect(next.action).toBe('update')
    expect(next.baseHash).toBe(pack.skill!.hash)
  })

  it('persists stale runs, preserves recent runs, and rejects late progress and settlement', async () => {
    const store = service()
    const entry = await store.saveCase({ skillName: 'release-notes', title: 'Case', prompt: 'Test', enabled: true, checks: [{ text: 'Pass', must: true }] })
    const old = await store.startRun({ skillName: 'release-notes', target: { kind: 'none' }, caseIds: [entry.id] })
    now = new Date(now.getTime() + 46 * 60_000)
    const fresh = await store.startRun({ skillName: 'release-notes', target: { kind: 'none' }, caseIds: [entry.id] })
    expect(await store.reclaimStaleRuns()).toEqual({ reclaimed: 1 })
    expect(service().store.evals().runs.find(run => run.id === old.id)).toMatchObject({ status: 'interrupted', finishedAt: now.toISOString() })
    expect(store.run(fresh.id).status).toBe('running')
    expect((await store.finishRun({ id: old.id, status: 'completed' })).status).toBe('interrupted')
    await expect(store.progressRun({ id: old.id, result: { caseId: entry.id, title: 'Case', verdict: 'pass', score: 1, checks: [], steps: [], answer: '' } })).rejects.toThrow('not running')
    expect(await store.reclaimStaleRuns()).toEqual({ reclaimed: 0 })
  })
})
