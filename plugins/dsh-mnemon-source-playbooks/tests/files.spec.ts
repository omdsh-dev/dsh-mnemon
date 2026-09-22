import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { archiveSkillFile, createSkillFile, listSkillFiles, readSkillFile, saveSkillFile } from '../src/files.ts'
describe('configured skill files', () => {
  it('lists and edits bounded Markdown, rejects stale edits and paths outside roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mnemon-skills-')),
      skills = join(root, 'skills'),
      file = join(skills, 'SKILL.md'),
      outside = join(root, 'outside.md')
    await mkdir(skills)
    await writeFile(file, '# Original')
    await writeFile(outside, 'private')
    await symlink(outside, join(skills, 'escape.md'))
    expect((await listSkillFiles([skills])).some((path) => path.endsWith('SKILL.md'))).toBe(true)
    const before = await readSkillFile([skills], file)
    await saveSkillFile([skills], file, '# Reviewed', before.digest)
    await expect(saveSkillFile([skills], file, '# Stale', before.digest)).rejects.toThrow(/changed/)
    await expect(readSkillFile([skills], outside)).rejects.toThrow()
    await expect(readSkillFile([skills], join(skills, 'escape.md'))).rejects.toThrow()
    expect((await readSkillFile([skills], file)).content).toBe('# Reviewed')
  })
})

it('creates a complete skill without overwriting and removes it with a recoverable copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mnemon-skill-manage-'))
  const roots = await import('node:fs/promises').then(async fs => [await fs.realpath(root)])
  const created = await createSkillFile(roots, roots[0]!, 'release-check', '# Release check\nVerify the published version.')
  expect(await listSkillFiles(roots)).toContain(created.path)
  await expect(createSkillFile(roots, roots[0]!, 'release-check', 'Replacement')).rejects.toThrow()
  await expect(createSkillFile(roots, roots[0]!, '../escape', 'Outside')).rejects.toThrow(/lowercase/)
  await expect(createSkillFile(roots, dirname(root), 'escape', 'Outside')).rejects.toThrow(/registered/)
  await expect(archiveSkillFile(roots, created.path, 'stale')).rejects.toThrow(/changed/)
  const archived = await archiveSkillFile(roots, created.path, created.digest)
  expect(await listSkillFiles(roots)).not.toContain(created.path)
  expect(await readFile(archived.archivedPath, 'utf8')).toBe(created.content)
  await expect(readSkillFile(roots, created.path)).rejects.toThrow()
})

it('allows only one concurrent create for a skill directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mnemon-skill-create-race-'))
  const canonical = await import('node:fs/promises').then(fs => fs.realpath(root))
  const results = await Promise.allSettled(['First', 'Second'].map(content => createSkillFile([canonical], canonical, 'release-check', content)))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(['First', 'Second']).toContain((await readSkillFile([canonical], join(canonical, 'release-check', 'SKILL.md'))).content)
})

it('allows only one concurrent save from the same observed file version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mnemon-skill-race-')),
    file = join(root, 'SKILL.md')
  await writeFile(file, 'Original')
  const before = await readSkillFile([root], file)
  const results = await Promise.allSettled([
    saveSkillFile([root], file, 'First edit', before.digest),
    saveSkillFile([root], file, 'Second edit', before.digest),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
})
