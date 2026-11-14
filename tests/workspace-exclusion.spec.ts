import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { HostAgent } from '../src/host/dsh.ts'
import { WorkspaceMemoryPolicy } from '../src/host/workspace-exclusion.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function paths() {
  const root = mkdtempSync(join(tmpdir(), 'mnemon-exclusion-')); roots.push(root)
  const excluded = join(root, 'excluded'), other = join(root, 'other')
  mkdirSync(excluded); mkdirSync(other)
  return { root, excluded, other }
}
const agent = (id: string, cwd: string, parentSession?: string) => ({ id, session: { header: { cwd, ...(parentSession === undefined ? {} : { origin: 'subagent', parentSession }) } } }) as HostAgent

it('does nothing by default and matches only an existing canonical workspace', () => {
  const { root, excluded, other } = paths()
  let entries: string[] = []
  const policy = new WorkspaceMemoryPolicy(() => entries)
  expect(policy.forWorkspace(excluded)).toEqual({ excluded: false })
  entries = [excluded + '/']
  const alias = join(root, 'alias'); symlinkSync(excluded, alias, 'dir')
  expect(policy.forWorkspace(alias).excluded).toBe(true)
  expect(policy.forWorkspace(other).excluded).toBe(false)
  const nested = join(excluded, 'nested'); mkdirSync(nested)
  expect(policy.forWorkspace(nested).excluded).toBe(false)
  entries = ['~']
  expect(policy.forWorkspace(homedir()).excluded).toBe(true)
})

it('ignores unavailable/invalid paths with bounded diagnostics instead of excluding everything', () => {
  const { root, other } = paths()
  const policy = new WorkspaceMemoryPolicy(() => ['relative', join(root, 'missing'), other])
  expect(policy.forWorkspace(other)).toEqual({ excluded: true, invalidEntries: [0, 1] })
  expect(policy.forWorkspace(join(root, 'missing'))).toEqual({ excluded: false, reason: 'workspace-unavailable', invalidEntries: [0, 1] })
  expect(policy.forWorkspace()).toEqual({ excluded: false, reason: 'workspace-unavailable', invalidEntries: [0, 1] })
})

it('inherits the live parent workspace across a different child cwd and parent disposal', () => {
  const { excluded, other } = paths()
  let entries = [excluded]
  const parent = agent('parent', excluded), child = agent('child', other, 'parent'), grandchild = agent('grandchild', other, 'child')
  const agents = new Map([parent, child, grandchild].map(value => [value.id, value]))
  const policy = new WorkspaceMemoryPolicy(() => entries, { get: id => agents.get(id) })
  expect(policy.forAgent(child).excluded).toBe(true)
  expect(policy.forAgent(grandchild).excluded).toBe(true)
  agents.delete('parent')
  expect(policy.forAgent(child).excluded).toBe(true)
  entries = []
  expect(policy.forAgent(child).excluded).toBe(false)
  entries = [other]
  expect(policy.forAgent(child).excluded).toBe(false)
  expect(policy.forAgent(agent('independent', other)).excluded).toBe(true)
})

it('resolves an unloaded parent from the Host workspace catalog and diagnoses an unknown parent', () => {
  const { excluded, other } = paths()
  const workspace = { id: 'project', title: 'Project', path: excluded, sessionIds: ['parent'] }
  const policy = new WorkspaceMemoryPolicy(() => [excluded], { get: () => undefined }, {
    get: id => id === workspace.id ? workspace : undefined, list: () => [workspace],
  })
  expect(policy.forAgent(agent('resumed-child', other, 'parent'))).toEqual({ excluded: true })
  expect(policy.forAgent(agent('unknown-child', other, 'unknown'))).toEqual({ excluded: false, reason: 'workspace-unavailable' })
})
