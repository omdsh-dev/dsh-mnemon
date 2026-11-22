import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { applyBundleFileChanges, MAX_BUNDLE_SNAPSHOT_BYTES, restoreBundleFiles, snapshotBundleFiles, snapshotResourcePreview } from '../src/bundle-files.ts'
import { sha256 } from '../src/catalog.ts'
import { SkillsService } from '../src/service.ts'

let root: string
let home: string
let bundle: string
let skills: SkillsService
const content = '---\nname: review-case\ndescription: Test a bundle.\n---\n\n# Review case\n'
const key = 'user-dsh:review-case'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mnemon-bundle-version-'))
  home = join(root, 'dsh')
  bundle = join(home, 'skills', 'review-case')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'SKILL.md'), content)
  skills = new SkillsService(join(root, 'data'), { dshHome: home, agentsHome: join(root, 'agents') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('keeps the conflict fence for a literal __proto__ supporting file after reopening', async () => {
  const path = join(bundle, '__proto__')
  writeFileSync(path, 'original')
  const draft = await skills.recordDraft(undefined, { skillName: 'review-case', content, notes: '', changes: [], guidance: [],
    files: [{ path: '__proto__', action: 'upsert', content: 'draft' }] })
  writeFileSync(path, 'external edit')
  skills = new SkillsService(join(root, 'data'), { dshHome: home, agentsHome: join(root, 'agents') })
  await expect(skills.adoptDraft(undefined, draft.id)).rejects.toThrow('changed since it was read')
  expect(readFileSync(path, 'utf8')).toBe('external edit')
})

it.skipIf(process.platform === 'win32')('preserves the executable mode of an updated supporting script', () => {
  const path = join(bundle, 'scripts', 'run.sh')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '#!/bin/sh\necho before\n')
  chmodSync(path, 0o755)
  applyBundleFileChanges(bundle, [{ path: 'scripts/run.sh', action: 'upsert', content: '#!/bin/sh\necho after\n' }])
  expect(statSync(path).mode & 0o777).toBe(0o755)
})

it('restores a binary asset deleted by an adopted draft', async () => {
  const path = join(bundle, 'assets', 'template.bin')
  mkdirSync(dirname(path), { recursive: true })
  const originalBytes = Buffer.from([0, 1, 2, 3, 255])
  writeFileSync(path, originalBytes)
  const draft = await skills.recordDraft(undefined, { skillName: 'review-case', content, notes: '', changes: [], guidance: [], files: [{ path: 'assets/template.bin', action: 'delete' }] })
  const adopted = await skills.adoptDraft(undefined, draft.id)
  expect(existsSync(path)).toBe(false)
  const original = skills.versions(key).find(version => version.reason === 'original')!
  await skills.restoreVersion(undefined, { key, versionId: original.id, expectedHash: adopted.skill.hash })
  expect(existsSync(path)).toBe(true)
  expect(readFileSync(path)).toEqual(originalBytes)
})

it('restores an allowed 40 KiB reference after adoption', async () => {
  const path = join(bundle, 'references', 'large.md')
  mkdirSync(dirname(path), { recursive: true })
  const before = 'a'.repeat(40 * 1024)
  writeFileSync(path, before)
  const draft = await skills.recordDraft(undefined, { skillName: 'review-case', content, notes: '', changes: [], guidance: [], files: [{ path: 'references/large.md', action: 'upsert', content: 'b'.repeat(40 * 1024) }] })
  const adopted = await skills.adoptDraft(undefined, draft.id)
  const original = skills.versions(key).find(version => version.reason === 'original')!
  await skills.restoreVersion(undefined, { key, versionId: original.id, expectedHash: adopted.skill.hash })
  expect(sha256(readFileSync(path, 'utf8'))).toBe(sha256(before))
})


it('restores executable permissions and exact bytes through adoption, version restore and rollback', async () => {
  const path = join(bundle, 'scripts', 'run.sh')
  mkdirSync(dirname(path), { recursive: true })
  const before = '#!/bin/sh\necho before\n'
  writeFileSync(path, before)
  chmodSync(path, 0o755)
  const draft = await skills.recordDraft(undefined, { skillName: 'review-case', content, notes: '', changes: [], guidance: [], files: [{ path: 'scripts/run.sh', action: 'upsert', content: '#!/bin/sh\necho after\n' }] })
  const adopted = await skills.adoptDraft(undefined, draft.id)
  const original = skills.versions(key).find(version => version.reason === 'original')!
  await skills.restoreVersion(undefined, { key, versionId: original.id, expectedHash: adopted.skill.hash })
  expect(readFileSync(path, 'utf8')).toBe(before)
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o755)
  const changed = applyBundleFileChanges(bundle, [{ path: 'scripts/run.sh', action: 'delete' }])
  changed.rollback()
  expect(readFileSync(path, 'utf8')).toBe(before)
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o755)
})

it('keeps complete versions beyond model preview count and byte limits, including after a cold reopen', async () => {
  mkdirSync(join(bundle, 'assets'), { recursive: true })
  for (let n = 0; n < 45; n++) writeFileSync(join(bundle, 'assets', `${n}.txt`), 'old-' + n)
  writeFileSync(join(bundle, '__proto__'), 'literal file name')
  const binary = Buffer.alloc(2 * 1024 * 1024, 255)
  writeFileSync(join(bundle, 'assets', 'large.bin'), binary)
  const draft = await skills.recordDraft(undefined, { skillName: 'review-case', content, notes: '', changes: [], guidance: [], files: [{ path: 'assets/0.txt', action: 'upsert', content: 'new' }] })
  const adopted = await skills.adoptDraft(undefined, draft.id)
  const original = skills.versions(key).find(version => version.reason === 'original')!
  const preview = skills.targetContent(undefined, 'review-case', { kind: 'version', versionId: original.id }).resources ?? []
  expect(preview.length).toBeLessThanOrEqual(40)
  expect(preview.some(file => file.path === 'assets/large.bin')).toBe(false)
  expect(preview.every(file => file.content.startsWith('old-') || file.path === '__proto__')).toBe(true)
  writeFileSync(join(bundle, 'assets', '44.txt'), 'later')
  rmSync(join(bundle, 'assets', 'large.bin'))
  rmSync(join(bundle, '__proto__'))
  skills = new SkillsService(join(root, 'data'), { dshHome: home, agentsHome: join(root, 'agents') })
  await skills.restoreVersion(undefined, { key, versionId: original.id, expectedHash: adopted.skill.hash })
  expect(readFileSync(join(bundle, 'assets', '44.txt'), 'utf8')).toBe('old-44')
  expect(readFileSync(join(bundle, '__proto__'), 'utf8')).toBe('literal file name')
  expect(readFileSync(join(bundle, 'assets', 'large.bin')).equals(binary)).toBe(true)
})

it('rejects a bundle that cannot be backed up before changing any file', async () => {
  mkdirSync(join(bundle, 'assets'), { recursive: true })
  writeFileSync(join(bundle, 'assets', 'big.bin'), Buffer.alloc(MAX_BUNDLE_SNAPSHOT_BYTES + 1))
  const draft = await skills.recordDraft(undefined, { skillName: 'review-case', content: content + 'New instructions.\n', notes: '', changes: [], guidance: [], files: [{ path: 'assets/new.txt', action: 'upsert', content: 'new' }] })
  await expect(skills.adoptDraft(undefined, draft.id)).rejects.toThrow('backup exceeds')
  expect(readFileSync(join(bundle, 'SKILL.md'), 'utf8')).toBe(content)
  expect(existsSync(join(bundle, 'assets', 'new.txt'))).toBe(false)
})

it('retains a recoverable pre-change version when the skill already has text-only history', async () => {
  await skills.saveSkill(undefined, { key, content: content + 'Edited.\n', expectedHash: sha256(content) })
  mkdirSync(join(bundle, 'assets'), { recursive: true })
  const bytes = Buffer.from([0, 255, 18])
  writeFileSync(join(bundle, 'assets', 'old.bin'), bytes)
  const draft = await skills.recordDraft(undefined, { skillName: 'review-case', content, notes: '', changes: [], guidance: [], files: [{ path: 'assets/old.bin', action: 'delete' }] })
  const adopted = await skills.adoptDraft(undefined, draft.id)
  const backup = skills.versions(key).find(version => version.reason === 'edit' && version.bundleSnapshot)!
  expect(backup).toBeDefined()
  await skills.restoreVersion(undefined, { key, versionId: backup.id, expectedHash: adopted.skill.hash })
  expect(readFileSync(join(bundle, 'assets', 'old.bin'))).toEqual(bytes)
})

it('refuses missing or damaged byte snapshots without partially restoring the skill', async () => {
  const draft = await skills.recordDraft(undefined, { skillName: 'review-case', content, notes: '', changes: [], guidance: [], files: [{ path: 'refs.txt', action: 'upsert', content: 'new' }] })
  const adopted = await skills.adoptDraft(undefined, draft.id)
  const original = skills.versions(key).find(version => version.reason === 'original')!
  const versionDirectory = join(skills.store.directory, 'versions', readdirSync(join(skills.store.directory, 'versions'))[0]!)
  const snapshot = join(versionDirectory, original.id + '.bundle.json')
  writeFileSync(snapshot, '{"version":1,"complete":true,"files":{"refs.txt":{"base64":"!invalid!","mode":384}}}')
  await expect(skills.restoreVersion(undefined, { key, versionId: original.id, expectedHash: adopted.skill.hash })).rejects.toThrow('Invalid supporting-file')
  rmSync(snapshot)
  await expect(skills.restoreVersion(undefined, { key, versionId: original.id, expectedHash: adopted.skill.hash })).rejects.toThrow('snapshot is missing')
  expect(readFileSync(join(bundle, 'refs.txt'), 'utf8')).toBe('new')
})


it('loads legacy text-only snapshots without deleting files omitted from their preview', async () => {
  writeFileSync(join(bundle, 'keep.bin'), Buffer.from([0, 1, 255]))
  writeFileSync(join(bundle, 'script.sh'), '#!/bin/sh\necho old\n')
  chmodSync(join(bundle, 'script.sh'), 0o755)
  const draft = await skills.recordDraft(undefined, { skillName: 'review-case', content, notes: '', changes: [], guidance: [], files: [{ path: 'script.sh', action: 'upsert', content: '#!/bin/sh\necho new\n' }] })
  const adopted = await skills.adoptDraft(undefined, draft.id)
  const ledger = skills.store.ledger()
  const original = ledger.versions.find(version => version.reason === 'original')!
  const directory = join(skills.store.directory, 'versions', readdirSync(join(skills.store.directory, 'versions'))[0]!)
  rmSync(join(directory, original.id + '.bundle.json'))
  delete original.bundleSnapshot
  skills.store.saveLedger(ledger)
  writeFileSync(join(directory, original.id + '.files.json'), JSON.stringify({ 'script.sh': '#!/bin/sh\necho legacy\n' }))
  await skills.restoreVersion(undefined, { key, versionId: original.id, expectedHash: adopted.skill.hash })
  expect(readFileSync(join(bundle, 'script.sh'), 'utf8')).toContain('echo legacy')
  expect(readFileSync(join(bundle, 'keep.bin'))).toEqual(Buffer.from([0, 1, 255]))
  if (process.platform !== 'win32') expect(statSync(join(bundle, 'script.sh')).mode & 0o777).toBe(0o755)
})

it('restores historical snapshots that contain generated dependencies without changing the installed dependencies', () => {
  mkdirSync(join(bundle, 'Node_Modules'))
  const dependency = join(bundle, 'Node_Modules', 'copy.js')
  writeFileSync(dependency, 'current dependency')
  writeFileSync(join(bundle, 'venv'), 'ordinary supporting file')
  const captured = snapshotBundleFiles(bundle)
  expect(Object.keys(captured.files)).toEqual(['venv'])
  const original = {
    ...captured,
    files: {
      'Node_Modules/copy.js': { base64: Buffer.from('old dependency').toString('base64'), mode: 0o600 },
      venv: { base64: Buffer.from('original supporting file').toString('base64'), mode: 0o600 },
    },
  }
  expect(snapshotResourcePreview(original)).toEqual([{ path: 'venv', content: 'original supporting file' }])
  const restored = restoreBundleFiles(bundle, original, captured)
  expect(readFileSync(dependency, 'utf8')).toBe('current dependency')
  expect(readFileSync(join(bundle, 'venv'), 'utf8')).toBe('original supporting file')
  expect(Object.keys(restored.snapshot.files)).toEqual(['venv'])
})

it('skips dependency and cache directories during backup, preview, and restore without blocking adoption (#717)', async () => {
  mkdirSync(join(bundle, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(bundle, 'scripts', '__pycache__'), { recursive: true })
  mkdirSync(join(bundle, 'venv', 'lib'), { recursive: true })
  writeFileSync(join(bundle, 'node_modules', 'pkg', 'huge.bin'), Buffer.alloc(MAX_BUNDLE_SNAPSHOT_BYTES + 1))
  writeFileSync(join(bundle, 'scripts', '__pycache__', 'helper.pyc'), Buffer.from([1, 2, 3, 4]))
  writeFileSync(join(bundle, 'venv', 'lib', 'site.py'), 'cached = True\n')
  mkdirSync(join(bundle, 'references'), { recursive: true })
  writeFileSync(join(bundle, 'references', 'guide.md'), 'before\n')

  const draft = await skills.recordDraft(undefined, {
    skillName: 'review-case',
    content: content + 'Updated.\n',
    notes: '',
    changes: [],
    guidance: [],
    files: [{ path: 'references/guide.md', action: 'upsert', content: 'after\n' }],
  })
  const adopted = await skills.adoptDraft(undefined, draft.id)
  expect(readFileSync(join(bundle, 'references', 'guide.md'), 'utf8')).toBe('after\n')
  expect(existsSync(join(bundle, 'node_modules', 'pkg', 'huge.bin'))).toBe(true)

  const original = skills.versions(key).find(version => version.reason === 'original')!
  await skills.restoreVersion(undefined, { key, versionId: original.id, expectedHash: adopted.skill.hash })
  expect(readFileSync(join(bundle, 'references', 'guide.md'), 'utf8')).toBe('before\n')
  expect(existsSync(join(bundle, 'node_modules', 'pkg', 'huge.bin'))).toBe(true)
  expect(readFileSync(join(bundle, 'scripts', '__pycache__', 'helper.pyc'))).toEqual(Buffer.from([1, 2, 3, 4]))
  expect(readFileSync(join(bundle, 'venv', 'lib', 'site.py'), 'utf8')).toBe('cached = True\n')

  await expect(skills.recordDraft(undefined, {
    skillName: 'review-case',
    content,
    notes: '',
    changes: [],
    guidance: [],
    files: [{ path: 'node_modules/pkg/index.js', action: 'upsert', content: 'x' }],
  })).rejects.toThrow('invalid segment in supporting file path')
})

it('reports the overflowing limit and largest top-level directory when editable files exceed backup bounds (#717)', async () => {
  mkdirSync(join(bundle, 'assets'), { recursive: true })
  writeFileSync(join(bundle, 'assets', 'big.bin'), Buffer.alloc(MAX_BUNDLE_SNAPSHOT_BYTES + 1))
  const draft = await skills.recordDraft(undefined, {
    skillName: 'review-case',
    content: content + 'More.\n',
    notes: '',
    changes: [],
    guidance: [],
    files: [{ path: 'assets/note.txt', action: 'upsert', content: 'note' }],
  })
  await expect(skills.adoptDraft(undefined, draft.id)).rejects.toThrow(/over 16 MiB at assets\/big\.bin; largest: assets\//u)
})
