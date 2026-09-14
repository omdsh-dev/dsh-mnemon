import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import { allowedDirectories, digest, json, newRecord, reviseRecord } from 'dsh-mnemon/source-sdk'
import { basename, dirname, join, sep } from 'node:path'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { parseDocument } from 'yaml'
import type { DshWorkspaceAdapter } from 'dsh-mnemon-workspace-kit/dsh'
import { readSkillBundleDirectory, skillPath } from './skill-bundle.ts'
import { saveSkillFile } from './files.ts'
import { SkillStore } from './skill-store.ts'

export class SkillCatalog {
  constructor(readonly ctx: Context, readonly skills: SkillStore, readonly providerName: string, readonly configuredRoots: string[], readonly adapter?: DshWorkspaceAdapter, readonly changed?: () => void) {}
  async lookup(scope: MemoryOperationScope, signal?: AbortSignal): Promise<SkillViewOptions> {
    const agent = scope.sessionId ? this.ctx.agents.get(SessionId(scope.sessionId)) : undefined
    let view = agent
    if (!view && this.ctx.agentPresets?.standingKeyFor) {
      let preset: string | undefined
      if (scope.sessionId && this.adapter) {
        const observation = await this.adapter.observe(scope.sessionId, scope, signal)
        try { preset = observation.header.agentPreset } finally { observation[Symbol.dispose]() }
      }
      view = await this.ctx.agentPresets.standingKeyFor(preset) as typeof agent
    }
    return { ...(scope.workspaceId ? { cwd: scope.workspaceId } : {}), ...(view ? { scope: view } : {}), ...(signal ? { signal } : {}) }
  }
  async roots(signal?: AbortSignal): Promise<string[]> {
    const snapshot = await this.skills.store.read(signal), settings = snapshot.records.find(record => record.kind === 'skill-directories')
    return allowedDirectories([...this.configuredRoots, ...(Array.isArray(settings?.data.roots) ? settings.data.roots.filter((value): value is string => typeof value === 'string') : [])])
  }
  configuredDirectories(): Promise<string[]> { return allowedDirectories(this.configuredRoots) }
  async updateRoot(path: string, remove: boolean, expected: string, signal?: AbortSignal): Promise<void> {
    const canonical = (await allowedDirectories([path]))[0]
    if (!canonical) throw new Error('Choose an existing readable skill directory')
    if ((await this.configuredDirectories()).includes(canonical)) throw new Error('This directory is configured by the plugin; edit its plugin configuration to remove it')
    const current = await this.roots(signal)
    if (!remove && current.some(root => canonical === root || canonical.startsWith(root + sep) || root.startsWith(canonical + sep))) throw new Error('Skill directories must not overlap or repeat')
    await this.skills.store.change(expected, records => {
      let settings = records.find(record => record.kind === 'skill-directories')
      if (!settings) { settings = newRecord('skill-directories', 'Additional skill directories', '', 'global', { storage: 'custom' }, { roots: [] }); records.push(settings) }
      const roots = settings.data.roots as string[]
      if (remove && !roots.includes(canonical)) throw new Error('This directory is not managed here')
      if (roots.length >= 24 && !remove) throw new Error('At most 24 additional skill directories are supported')
      reviseRecord(settings, remove ? 'remove-directory' : 'add-directory'); settings.data.roots = remove ? roots.filter(root => root !== canonical) : [...roots, canonical]
    }, signal)
    this.changed?.()
  }
  async list(scope: MemoryOperationScope, signal?: AbortSignal) {
    const entries = await this.ctx.skills.list(await this.lookup(scope, signal))
    return entries.slice(0, 500).map(skill => ({ name: skill.name, description: skill.description, provider: skill.provider, source: skill.source, enabled: skill.invocation.modelInvocable, userInvocable: skill.invocation.userInvocable, resourceBase: skill.resourceBase ?? null, managed: skill.provider === this.providerName, protected: skill.source.startsWith('project') || skill.source === 'bundled' }))
  }
  async read(scope: MemoryOperationScope, name: string, signal?: AbortSignal) {
    const skill = await this.ctx.skills.get(name, await this.lookup(scope, signal))
    if (!skill) throw new Error('The skill is not present in this session and workspace')
    // A standalone Markdown file does not grant access to all of its siblings.
    const directory = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : skill.path && basename(skill.path) === 'SKILL.md' ? dirname(skill.path) : undefined
    const files = directory ? await readSkillBundleDirectory(directory, signal) : []
    return { name: skill.name, description: skill.description, content: skill.content, provider: skill.provider, source: skill.source, enabled: skill.invocation.modelInvocable, directory: directory ?? null, files,
      editable: !!directory && !directory.startsWith(this.skills.resourceRoot + sep) && ['custom', 'user-dsh', 'user-agents'].includes(skill.source), digest: digest([skill.name, skill.description, files.length ? files : skill.content]) }
  }
  async edit(scope: MemoryOperationScope, name: string, expectedDigest: string, path: string, content: string, signal?: AbortSignal) {
    const before = await this.read(scope, name, signal)
    if (!before.editable || !before.directory || before.digest !== expectedDigest) throw new Error('Refresh an editable native skill before saving; managed versions use the review workflow')
    skillPath(path)
    const file = before.files.find(file => file.path === path)
    if (!file) throw new Error('Choose an existing text resource from this skill')
    const directory = await realpath(before.directory), target = await realpath(join(directory, path))
    if (!target.startsWith(directory + sep) || !(await lstat(target)).isFile()) throw new Error('The file is outside this native skill')
    if (path === 'SKILL.md') {
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content), parsed = match ? parseDocument(match[1]!) : undefined
      if (!parsed || parsed.errors.length || parsed.get('name') !== before.name || typeof parsed.get('description') !== 'string') throw new Error('Native skill edits must retain valid name and description metadata')
    }
    await saveSkillFile([directory], target, content, digest(file.content), signal, true)
    this.changed?.()
    return { path: target, content, digest: digest(await readFile(target, 'utf8')) }
  }
  async toggle(scope: MemoryOperationScope, name: string, expectedDigest: string, signal?: AbortSignal): Promise<void> {
    const before = await this.read(scope, name, signal), file = before.files.find(file => file.path === 'SKILL.md')
    if (!file || !before.editable || before.digest !== expectedDigest) throw new Error('Refresh an editable native skill before changing its enabled state')
    const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))([\s\S]*)$/.exec(file.content)
    if (!match) throw new Error('The native skill lacks valid frontmatter')
    const metadata = parseDocument(match[2]!)
    if (metadata.errors.length) throw new Error('The native skill metadata is invalid')
    if (before.enabled) metadata.set('disable-model-invocation', true)
    else metadata.delete('disable-model-invocation')
    await this.edit(scope, name, expectedDigest, 'SKILL.md', '---\n' + metadata.toString() + '---\n' + match[4], signal)
  }
}
