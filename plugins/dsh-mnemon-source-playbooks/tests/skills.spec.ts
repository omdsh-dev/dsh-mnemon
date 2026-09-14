import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundleDigest, inspectSkillBundle, materializeSkillBundle, parseSkillBundle, verifySkillFiles, type SkillBundle } from '../src/skill-bundle.ts'
import { SkillStore, type SkillBasis } from '../src/skill-store.ts'
import { SkillEngine } from '../src/skill-engine.ts'
import { runBoundedProcess } from 'dsh-mnemon/source-sdk'

const directories: string[] = []
const scope = { storage: 'custom' as const, workspaceId: '/project-a', sessionId: 'session-a' }
const basis: SkillBasis = { id: 'proof-a', digest: 'evidence-v1', kind: 'manual', title: 'Repeated totals', content: 'Sum numeric rows and reject invalid input.', signals: 2, scope: 'project' }
const bundle = (code = 'console.log(2 + 3)'): SkillBundle => ({ name: 'numeric-summary', description: 'Summarize numeric rows.', files: [{ path: 'SKILL.md', content: '---\nname: numeric-summary\ndescription: Summarize numeric rows.\n---\nRun scripts/summary.mjs to compute the total.\n' }, { path: 'scripts/summary.mjs', content: code }], checks: [{ label: 'Checks output', command: 'node scripts/summary.mjs' }] })
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'mnemon-skill-lifecycle-')); directories.push(directory); return new SkillStore(directory) }
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('native skill bundles', () => {
  it('requires canonical paths, bounded text, unique files and valid native metadata', () => {
    for (const path of ['../outside.mjs', '/absolute.mjs', 'scripts/../outside.mjs', 'scripts\\outside.mjs', '.private/x.mjs', 'scripts//x.mjs']) expect(() => parseSkillBundle({ ...bundle(), files: [...bundle().files, { path, content: 'x' }] })).toThrow()
    expect(() => parseSkillBundle({ ...bundle(), files: [...bundle().files, { path: 'skill.md', content: 'duplicate' }] })).toThrow('unique')
    expect(() => parseSkillBundle({ ...bundle(), files: [{ path: 'scripts/tool.mjs', content: '' }] })).toThrow('SKILL.md')
    expect(inspectSkillBundle(parseSkillBundle(bundle())).errors).toEqual([])
    const mismatch = bundle(); mismatch.files[0]!.content = mismatch.files[0]!.content.replace('name: numeric-summary', 'name: wrong-name')
    expect(inspectSkillBundle(parseSkillBundle(mismatch)).errors.join()).toContain('match')
    expect(inspectSkillBundle(parseSkillBundle({ ...bundle(), checks: [] })).errors.join()).toContain('check')
    const missing = bundle(); missing.files[0]!.content += 'Also use references/missing.md.'
    expect(inspectSkillBundle(parseSkillBundle(missing)).errors.join()).toContain('Missing referenced resource')
  })
  it('materializes complete versions atomically and refuses altered resources or symlinks', async () => {
    const skills = await fixture(), value = parseSkillBundle(bundle()), root = await materializeSkillBundle(skills.resourceRoot, value)
    expect(root.endsWith(bundleDigest(value))).toBe(true)
    expect(await readFile(join(root, 'scripts/summary.mjs'), 'utf8')).toContain('2 + 3')
    await writeFile(join(root, 'scripts/summary.mjs'), 'changed externally')
    await expect(materializeSkillBundle(skills.resourceRoot, value)).rejects.toThrow('changed outside')
    await rm(join(root, 'scripts/summary.mjs')); await symlink('/etc/hosts', join(root, 'scripts/summary.mjs'))
    await expect(verifySkillFiles(root, value)).rejects.toThrow('symbolic')
  })
})

describe('review, validation, native publication and feedback', () => {
  it('keeps generated code pending, validates actual execution and invalidates results after edits', async () => {
    const skills = await fixture(), candidate = await skills.propose(scope, { title: 'Numeric summary', bundle: bundle(), reason: 'Repeated numeric task', basis })
    const current = () => skills.snapshot(scope)
    expect(candidate.state).toBe('pending')
    await expect(skills.publish(scope, candidate.id, candidate.version, (await current()).revision)).rejects.toThrow('Run all declared checks')
    const engine = new SkillEngine(skills, { async validate(_scope, directory, check, signal) {
      const result = await runBoundedProcess(process.execPath, ['scripts/summary.mjs'], { cwd: directory, signal, timeoutMs: 5000, maxBytes: 1000 })
      return { label: check.label, command: check.command, status: result.code === 0 ? 'passed' : 'failed', exitCode: result.code, output: result.stdout + result.stderr }
    } })
    await engine.queue(scope, { kind: 'validate', skill: candidate }, (await current()).revision)
    await engine.idle()
    let state = await current(), checked = state.records.find(record => record.id === candidate.id)!
    expect(checked.data.validation).toMatchObject({ digest: checked.data.contentDigest, status: 'passed' })
    expect(state.records.find(record => record.kind === 'skill-run')?.data.results).toEqual([expect.objectContaining({ exitCode: 0, output: '5\n' })])
    checked = await skills.update(scope, checked.id, checked.version, bundle('throw new Error("regression")'), checked.title, state.revision)
    expect(checked.data.validation).toBeUndefined()
    await expect(skills.publish(scope, checked.id, checked.version, (await current()).revision)).rejects.toThrow('Run all declared checks')
    await engine.queue(scope, { kind: 'validate', skill: checked }, (await current()).revision); await engine.idle()
    state = await current(); checked = state.records.find(record => record.id === candidate.id)!
    expect(checked.data.validation).toMatchObject({ status: 'failed' })
    await expect(skills.publish(scope, checked.id, checked.version, state.revision)).rejects.toThrow('Run all declared checks')
    await engine.dispose()
  })
  it('publishes instructions without fake tests, checks scope and preserves original versions through feedback and restoration', async () => {
    const skills = await fixture(), advisory = bundle(); advisory.files = [advisory.files[0]!]; advisory.files[0]!.content = advisory.files[0]!.content.replace('Run scripts/summary.mjs to compute the total.', 'Read each numeric row and verify the units before summing.'); advisory.checks = []
    let candidate = await skills.propose(scope, { title: 'Numeric review', bundle: advisory, reason: 'Reusable method', basis })
    await expect(skills.publish({ ...scope, workspaceId: '/project-b' }, candidate.id, 1, (await skills.store.read()).revision)).rejects.toThrow('outside')
    let active = await skills.publish(scope, candidate.id, 1, (await skills.store.read()).revision)
    const originalText = await readFile(join(String(active.data.directory), 'SKILL.md'), 'utf8')
    const feedback = await skills.feedback(scope, active.id, active.version, 'incorrect', 'Empty rows must be ignored.', (await skills.store.read()).revision)
    expect(feedback.data).toMatchObject({ contentDigest: active.data.contentDigest, verifiedByHuman: true, concern: true })
    const revised = structuredClone(advisory); revised.files[0]!.content += '\nIgnore empty rows.\n'
    candidate = await skills.propose(scope, { title: 'Numeric review', bundle: revised, reason: 'Handle empty rows', basis: { ...basis, id: 'feedback:' + active.id }, baseId: active.id })
    expect((await skills.snapshot(scope)).records.find(record => record.id === active.id)?.state).toBe('active')
    const disabled = await skills.changeState(scope, active.id, active.version, 'toggle', (await skills.store.read()).revision)
    await expect(skills.publish(scope, candidate.id, 1, (await skills.store.read()).revision)).rejects.toThrow('disabled')
    await skills.changeState(scope, disabled.id, disabled.version, 'toggle', (await skills.store.read()).revision)
    active = await skills.publish(scope, candidate.id, 1, (await skills.store.read()).revision)
    expect((await skills.snapshot(scope)).records.find(record => record.id === feedback.id)?.data.resolvedBy).toBe(active.id)
    const old = (await skills.snapshot(scope)).records.find(record => record.kind === 'skill-version' && record.state === 'archived')!
    expect(await readFile(join(String(old.data.directory), 'SKILL.md'), 'utf8')).toBe(originalText)
    const restored = await skills.restore(scope, old.id, old.version, (await skills.store.read()).revision)
    expect(restored.state).toBe('pending'); expect(restored.data.baseId).toBe(active.id)
    expect((await skills.snapshot(scope)).records.find(record => record.id === active.id)?.state).toBe('active')
  })
  it('does not accept an altered validation copy or treat a cancelled check as passing', async () => {
    const skills = await fixture(), candidate = await skills.propose(scope, { title: 'Validate integrity', bundle: bundle(), reason: 'Check exact contents', basis })
    const engine = new SkillEngine(skills, { async validate(_scope, directory, check) { await writeFile(join(directory, 'scripts/summary.mjs'), 'modified'); return { ...check, status: 'passed', exitCode: 0, output: 'ok' } } })
    await engine.queue(scope, { kind: 'validate', skill: candidate }, (await skills.store.read()).revision); await engine.idle()
    expect((await skills.snapshot(scope)).records.find(record => record.id === candidate.id)?.data.validation).toBeUndefined()
    expect((await skills.snapshot(scope)).records.find(record => record.kind === 'skill-run')?.data).toMatchObject({ status: 'failed', error: expect.stringContaining('changed outside') })
    await engine.dispose()
    const activity = vi.fn()
    const wait = new SkillEngine(skills, { activity, validate: async (_scope, _directory, _check, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }) })
    const run = await wait.queue(scope, { kind: 'validate', skill: candidate }, (await skills.store.read()).revision)
    await wait.cancel(run.id, scope)
    expect((await skills.snapshot(scope)).records.find(record => record.id === run.id)?.data.status).toBe('cancelled')
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'skill-validated', artifactId: candidate.id, artifactDigest: candidate.data.contentDigest, status: 'cancelled', level: 'warning', verifiedByHuman: false }))
    await wait.dispose()
  })
  it('bounds duplicate candidates and leaves generation failures reviewable', async () => {
    const skills = await fixture(), engine = new SkillEngine(skills, { async generate() { return JSON.stringify({ title: 'Generated skill', reason: 'Reusable task', bundle: bundle() }) } })
    await engine.queue(scope, { kind: 'generate', basis, instruction: '' }, (await skills.store.read()).revision); await engine.idle()
    expect((await skills.snapshot(scope)).records.filter(record => record.kind === 'skill-version').map(record => record.state)).toEqual(['pending'])
    await skills.propose(scope, { title: 'Same generated skill', reason: 'Same evidence', bundle: bundle(), basis })
    expect((await skills.snapshot(scope)).records.filter(record => record.kind === 'skill-version')).toHaveLength(1)
    await expect(skills.propose(scope, { title: 'Conflicting draft', reason: 'Different code', bundle: bundle('console.log(9)'), basis })).rejects.toThrow('pending candidate')
    await engine.dispose()
  })
  it('rejects malformed model output without saving partial candidates or touching the native original', async () => {
    const skills = await fixture(), original = bundle(), engine = new SkillEngine(skills, { async generate() { return JSON.stringify({ title: 'Revision', reason: 'Review native skill', bundle: original }) + ' trailing text' } })
    await engine.queue(scope, { kind: 'generate', basis, native: original, instruction: 'Refine the native instructions' }, (await skills.store.read()).revision)
    await engine.idle()
    const state = await skills.snapshot(scope)
    expect(state.records.filter(record => record.kind === 'skill-version' || record.kind === 'skill-origin')).toEqual([])
    expect(state.records.find(record => record.kind === 'skill-run')?.data).toMatchObject({ status: 'failed', error: expect.stringContaining('no candidate was saved') })
    await engine.dispose()
  })
  it('retains the original native name when editing a reviewed import', async () => {
    const skills = await fixture(), original = bundle()
    const candidate = await skills.propose(scope, { title: 'Native revision', reason: 'Preserve existing skill identity', bundle: original, basis, nativeOriginal: original })
    const renamed = { ...original, name: 'renamed-skill', files: original.files.map(file => ({ ...file, content: file.content.replace('name: numeric-summary', 'name: renamed-skill') })) }
    await expect(skills.update(scope, candidate.id, candidate.version, renamed, candidate.title, (await skills.store.read()).revision)).rejects.toThrow('retain the skill name')
  })
})
