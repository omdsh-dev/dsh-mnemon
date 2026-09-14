import type { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'
import { SkillCatalog } from '../src/skill-catalog.ts'
import { SkillStore } from '../src/skill-store.ts'

const directories: string[] = []
const scope = { storage: 'custom' as const, workspaceId: '/project-a', sessionId: 'session-a' }
const metadata = '---\nname: response-check\ndescription: Check response fixtures.\nuser-invocable: false\n---\nRead references/usage.md before checking.\n'
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemon-native-catalog-'))); directories.push(root)
  const directory = join(root, 'native'), skills = new SkillStore(join(root, 'private'))
  await mkdir(join(directory, 'references'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), metadata)
  await writeFile(join(directory, 'references/usage.md'), 'Preserve the original response.')
  const agent = { id: 'active-view' }, changed = vi.fn()
  const get = vi.fn(async () => {
    const text = await readFile(join(directory, 'SKILL.md'), 'utf8'), frontmatter = parseDocument(/^---\n([\s\S]*?)\n---/.exec(text)![1]!)
    return { name: 'response-check', description: 'Check response fixtures.', content: text, provider: 'filesystem', source: 'custom', invocation: { modelInvocable: !frontmatter.get('disable-model-invocation'), userInvocable: false }, path: join(directory, 'SKILL.md'), resourceBase: { kind: 'directory', path: directory } }
  })
  const ctx = { agents: { get: vi.fn(() => agent) }, skills: { get, list: vi.fn(async () => [await get()]) } } as unknown as Context
  return { root, directory, skills, ctx, get, agent, changed, catalog: new SkillCatalog(ctx, skills, 'mnemon-skills', [], undefined, changed) }
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('native skill catalog', () => {
  it('uses the current agent view and fences native edits against changed resource contents', async () => {
    const { catalog, directory, get, agent } = await fixture()
    const before = await catalog.read(scope, 'response-check')
    expect(get).toHaveBeenCalledWith('response-check', { cwd: scope.workspaceId, scope: agent })
    expect(before.editable).toBe(true)
    await catalog.edit(scope, before.name, before.digest, 'references/usage.md', 'Check status before parsing JSON.')
    expect(await readFile(join(directory, 'references/usage.md'), 'utf8')).toBe('Check status before parsing JSON.')
    await expect(catalog.edit(scope, before.name, before.digest, 'references/usage.md', 'Stale edit')).rejects.toThrow('Refresh')
    const current = await catalog.read(scope, before.name)
    await expect(catalog.edit(scope, before.name, current.digest, 'SKILL.md', metadata.replace('response-check', 'renamed'))).rejects.toThrow('retain valid name')
    await expect(catalog.edit(scope, before.name, current.digest, 'outside.md', 'New file')).rejects.toThrow('existing text resource')
  })
  it('toggles native model invocation without discarding user invocation metadata or resources', async () => {
    const { catalog, directory, changed } = await fixture()
    let before = await catalog.read(scope, 'response-check')
    await catalog.toggle(scope, before.name, before.digest)
    before = await catalog.read(scope, before.name)
    expect(before.enabled).toBe(false)
    expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toContain('user-invocable: false')
    await catalog.toggle(scope, before.name, before.digest)
    expect((await catalog.read(scope, before.name)).enabled).toBe(true)
    expect(await readFile(join(directory, 'references/usage.md'), 'utf8')).toBe('Preserve the original response.')
    expect(changed).toHaveBeenCalledTimes(2)
  })
  it('keeps project resources read-only and does not read siblings of standalone Markdown skills', async () => {
    const { catalog, get, directory } = await fixture()
    const original = await get()
    get.mockResolvedValueOnce({ ...original, source: 'project-dsh' })
    expect((await catalog.read(scope, original.name)).editable).toBe(false)
    get.mockResolvedValueOnce({ ...original, path: join(directory, 'response-check.md'), resourceBase: undefined } as unknown as typeof original)
    const standalone = await catalog.read(scope, original.name)
    expect(standalone).toMatchObject({ editable: false, directory: null, files: [] })
    expect(standalone.content).toBe(original.content)
  })
  it('canonicalizes configured roots and disconnects managed directories without deleting files', async () => {
    const { catalog, root, directory, skills, ctx } = await fixture()
    await catalog.updateRoot(directory, false, (await skills.store.read()).revision)
    expect(await catalog.roots()).toContain(directory)
    await expect(catalog.updateRoot(join(directory, 'references'), false, (await skills.store.read()).revision)).rejects.toThrow('overlap')
    await catalog.updateRoot(directory, true, (await skills.store.read()).revision)
    expect(await catalog.roots()).toEqual([])
    expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toBe(metadata)
    const alias = join(root, 'configured-alias'); await symlink(directory, alias)
    const configured = new SkillCatalog(ctx, skills, 'mnemon-skills', [alias])
    expect(await configured.configuredDirectories()).toEqual([directory])
    await expect(configured.updateRoot(directory, true, (await skills.store.read()).revision)).rejects.toThrow('configured by the plugin')
  })
})
