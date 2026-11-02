import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { resolveConfig } from '../src/host/config.ts'
import { MnemonPackManager } from '../src/host/pack.ts'
import { createStorageRoot } from '../src/host/storage-root.ts'
import { MnemonGitSync, gitEnvironment, remoteIssueOf } from '../src/host/git-sync.ts'
import type { MnemonGitHubAuth } from '../src/host/github-auth.ts'
import { MnemonMachineStore, defaultMachineLabel } from '../src/host/machine-identity.ts'
import { runProcess, type ProcessRunner } from '../src/host/process.ts'
import { sourceFixture } from './fixtures/sources.ts'
import { sqlite as nodeSqlite, writeSpace } from '../plugins/dsh-mnemon-source-memory-spaces/tests/memory-space-db.ts'

const directories: string[] = []
const releases: Array<() => Promise<void>> = []
const now = () => new Date('2026-08-14T12:00:00.000Z')

/**
 * Git takes the repository location from the environment, and the harness shell
 * shims export `GIT_DIR` for their own PATH bookkeeping, so every Git process
 * this suite starts runs with those variables removed.
 */
async function git(args: string[], cwd?: string): Promise<string> {
  const result = await runProcess('git', args, { timeoutMs: 60_000, env: gitEnvironment(), ...(cwd === undefined ? {} : { cwd }), label: 'git' })
  if (result.exitCode !== 0) throw new Error('git ' + args.join(' ') + ': ' + result.stderr)
  return result.stdout
}

const available = await git(['--version']).then(() => true, () => false)

function temporary(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-' + label + '-'))
  directories.push(directory)
  return directory
}

/**
 * A clock that advances on every read. A real machine re-stamps the manifest on
 * every export, so a repeated push always carries a new `exportedAt`; a pinned
 * clock hides that, which is how a repeat once slipped through as a new commit.
 */
function tickingClock(): { now: () => Date; reads: () => number } {
  let elapsed = 0
  return {
    now: () => new Date(Date.parse('2026-08-14T12:00:00.000Z') + (elapsed += 1_000)),
    reads: () => elapsed,
  }
}

/** The entries one data directory holds right now. */
function entriesOf(root: string): string[] {
  const path = join(root, 'runtime', 'memories.json')
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: { content: string }[] }).entries.map(entry => entry.content)
}

/**
 * The identity a data directory carries. A profile that never switched sync on
 * mints none, and asking for one here would hide exactly that: a machine identity
 * that only exists because the test wanted to read it.
 */
function identityOf(root: string): { id: string; label: string } {
  return new MnemonMachineStore({ effectiveDataDir: () => root }).read()
}

/** One machine: a storage root, its pack manager and the sync channel over it. */
async function machine(label: string, repository?: string, clock: () => Date = now, run?: ProcessRunner) {
  const root = temporary(label)
  const workspace = temporary(label + '-workspace')
  // Git sync is opt-in, so the suite switches it on exactly where the product does.
  const config = resolveConfig({ storageScope: 'custom', dataDir: root, cliPath: '/fake/mnemon', syncEnabled: true })
  const runner = createStorageRoot(config)
  const sources = await sourceFixture({ dataDir: root, workspace })
  releases.push(sources.dispose)
  const packs = new MnemonPackManager(runner, config, undefined, clock)
  const sync = new MnemonGitSync(runner, config, packs, run, clock)
  if (repository !== undefined) sync.configure({ repoUrl: repository })
  return { root, workspace, runner, config, packs, sync, sources }
}

/** One Memory Space as Mnemon writes it, so the payload carries a `mnemon.db`. */
function seedSpace(root: string): void {
  const data = join(root, 'data')
  mkdirSync(join(data, 'default'), { recursive: true })
  writeSpace(join(data, 'default', 'mnemon.db'), { insights: [{ id: 'i-1', content: 'The gateway routes by model family' }] })
  const at = '2026-10-05T08:37:12.218Z'
  writeFileSync(join(data, '.dsh-memory-bodies.json'), JSON.stringify({ version: 1, bodies: [{ id: 'default', name: 'Default', description: '', active: true, createdAt: at, updatedAt: at }] }, null, 2) + '\n')
}

/** Run with these environment variables set, or removed where the value is undefined. */
async function withEnvironment(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** A process id no system hands out, as a Host that stopped long ago left it. */
const GONE_PID = 2 ** 22 + 12_345

/**
 * Run with the Git identity of a machine that has one configured. Git reads the same
 * variables whether it commits or reports the identity it would use, and the suite
 * sanitizes only the location variables, so these reach every child process.
 */
async function withGitIdentity(name: string, email: string, run: () => Promise<void>): Promise<void> {
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
  const saved = keys.map(key => process.env[key])
  for (const key of keys) process.env[key] = key === 'GIT_AUTHOR_NAME' || key === 'GIT_COMMITTER_NAME' ? name : email
  try {
    await run()
  } finally {
    keys.forEach((key, index) => {
      const value = saved[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    })
  }
}

interface DocumentEntry { id: string; title: string; status: string; revision: number; relativePath: string; archiveSummary?: string }

/** The Project Documents a storage root holds, as its index lists them. */
function documentsOf(root: string): DocumentEntry[] {
  return (JSON.parse(readFileSync(join(root, 'documents', 'index.json'), 'utf8')) as { documents: DocumentEntry[] }).documents
}

/** One document's Markdown as a storage root holds it. */
function textOf(root: string, id: string): string {
  return readFileSync(join(root, documentsOf(root).find(document => document.id === id)!.relativePath), 'utf8')
}

/** What a storage root last agreed on with its branch, as an older dsh-mnemon never records. */
function agreementOf(root: string): string {
  return join(root, 'state', 'sync', 'base.json')
}

/** Edit one document as its Source would, after reading what changed underneath it. */
async function editDocument(machine: { sources: { documents: { read: (operation: string) => Promise<unknown>; mutate: (operation: string, input: never, options: { confirmed: true }) => Promise<unknown> } } }, id: string, content: string): Promise<void> {
  await machine.sources.documents.read('snapshot')
  await machine.sources.documents.mutate('mutate', { action: 'update', id, content } as never, { confirmed: true })
}

async function repository(label: string): Promise<string> {
  const directory = join(temporary(label), 'sync.git')
  await git(['init', '--bare', '--quiet', directory])
  return directory
}

/** A synthetic global config; no author or config from the test runner participates. */
async function withGitConfiguration(run: (global: string) => Promise<void>): Promise<void> {
  const global = join(temporary('sync-author-config'), 'gitconfig')
  writeFileSync(global, '')
  await withEnvironment({
    GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    EMAIL: undefined, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined,
  }, async () => run(global))
}

/** A real remote policy: every new commit must carry the approved synthetic author. */
function requireCorporateAuthor(origin: string): void {
  writeFileSync(join(origin, 'hooks', 'pre-receive'), `#!/bin/sh
while read old new ref; do
  if test "$old" = 0000000000000000000000000000000000000000; then
    commits=$(git rev-list "$new")
  else
    commits=$(git rev-list "$old..$new")
  fi
  for commit in $commits; do
    author=$(git show -s --format='%an <%ae>' "$commit")
    if test "$author" != 'Corporate User <employee@company.example>'; then
      echo "Commit author rejected by policy: $author" >&2
      exit 1
    fi
  done
done
`, { mode: 0o700 })
}

afterEach(async () => {
  for (const release of releases.splice(0)) await release()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// Every case drives real Git processes against a real bare repository.
describe.skipIf(!available)('Mnemon Git sync', { timeout: 90_000 }, () => {
  it('converges overflowing MEMORY unions without turning archival into deletion (#468)', async () => {
    const origin = await repository('overflow-remote')
    const left = await machine('overflow-left', origin)
    const right = await machine('overflow-right', origin)
    const shared = 'shared-' + 's'.repeat(3993)
    const low = 'local-' + 'l'.repeat(3994)
    const critical = 'remote-' + 'r'.repeat(3993)
    await left.sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: shared, importance: 'normal' }, { confirmed: true })
    await left.sync.push()
    await right.sync.pull()
    await right.sources.runtime.read('snapshot')
    await left.sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: low, importance: 'low' }, { confirmed: true })
    await right.sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: critical, importance: 'critical' }, { confirmed: true })
    await right.sync.push()
    const result = await left.sync.push()
    expect(result.merged?.runtime).toMatchObject({ added: 1, held: 0, archived: 1 })
    expect(entriesOf(left.root)).toEqual([shared, critical])
    expect(left.packs.tombstones().tombstones).toEqual([])
    const archive = join(left.root, 'runtime', 'archived', 'import-overflow')
    expect(JSON.parse(readFileSync(join(archive, readdirSync(archive)[0]!), 'utf8')).entries[0].content).toBe(low)
    await right.sync.push()
    expect(entriesOf(right.root)).toEqual(entriesOf(left.root))
    await left.sync.push() // Records this publisher's existing machine identity.
    expect((await left.sync.push()).committed).toBe(false)
    expect(readdirSync(archive)).toHaveLength(1)
    await left.sources.runtime.read('snapshot')
    await left.sources.runtime.mutate('mutate', { action: 'remove', target: 'memory', oldText: shared }, { confirmed: true })
    await left.sync.push()
    expect(left.packs.tombstones().tombstones).toHaveLength(1)
  })

  it('reports Git, the configuration and the remote before anything is pushed', async () => {
    const origin = await repository('sync-status-remote')
    const machineA = await machine('sync-status', origin)
    const status = await machineA.sync.status()
    expect(status.git).toMatchObject({ available: true })
    expect(status.configured).toBe(true)
    expect(status.remote).toEqual({ reachable: true, branchExists: false })
    expect(status.config.hasToken).toBe(false)
    expect(JSON.stringify(status)).not.toContain('ghp_')
    expect((await machineA.sync.status()).lastCommit).toBeUndefined()
  })

  it('refuses every direction while no repository is configured', async () => {
    const machineA = await machine('sync-unconfigured')
    await expect(machineA.sync.push()).rejects.toThrow('no sync repository is configured')
    await expect(machineA.sync.preview()).rejects.toThrow('no sync repository is configured')
    await expect(machineA.sync.pull()).rejects.toThrow('no sync repository is configured')
    await expect(machineA.sync.status()).resolves.toMatchObject({ configured: false, remote: { reachable: false, branchExists: false } })
  })

  it('publishes the full pack as readable files on the configured branch', async () => {
    const origin = await repository('sync-push-remote')
    const machineA = await machine('sync-push', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })

    const pushed = await machineA.sync.push({ message: 'Sync memory' })
    expect(pushed).toMatchObject({ branch: 'mnemon-sync', subdir: 'mnemon/', committed: true, pushed: true, message: 'Sync memory' })
    expect(pushed.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(pushed.summary.map(entry => entry.component)).toEqual(['runtime', 'documents', 'memory-spaces'])
    expect(await git(['show', 'mnemon-sync:mnemon/manifest.json'], origin)).toContain('"mnemonpack"')
    expect(await git(['show', 'mnemon-sync:mnemon/payload/runtime/USER.md'], origin)).toContain('Prefer concise answers')
    expect(await git(['show', 'mnemon-sync:mnemon/checksums.json'], origin)).toContain('"sha256"')

    // The mirror is a disposable work tree, never the storage root.
    expect(existsSync(join(machineA.root, '.git'))).toBe(false)
    expect(existsSync(join(machineA.root, 'state', 'sync', 'git', '.git'))).toBe(true)
    expect(await git(['status', '--porcelain'], join(machineA.root, 'state', 'sync', 'git'))).toBe('')
  })

  it('commits under the identity of this machine when the author is blank', async () => {
    // A blank author leaves the commit to the identity Git resolves on its own, and a
    // machine without one cannot commit at all. CI configures none, so the case brings
    // its own instead of reading whatever machine happens to run the suite.
    await withGitIdentity('Test Machine', 'machine@localhost', async () => {
      const identity = (await git(['var', 'GIT_AUTHOR_IDENT'])).trim()
      const expected = identity.slice(0, identity.indexOf('>') + 1)
      expect(expected).toContain('machine@localhost')
      const origin = await repository('sync-author-remote')
      const machineA = await machine('sync-author', origin)
      const cleared = await machineA.sync.configure({ authorName: '', authorEmail: '' })
      expect(cleared).toMatchObject({ authorName: '', authorEmail: '', branch: 'mnemon-sync', subdir: 'mnemon/' })

      const pushed = await machineA.sync.push({ message: 'Sync without an author' })
      expect(pushed).toMatchObject({ committed: true, pushed: true })
      expect(await git(['log', '-1', '--format=%an <%ae>', 'mnemon-sync'], origin)).toBe(expected + '\n')
    })
  })

  it.each(['fresh', 'saved default'] as const)('uses configured Git identity for %s settings on an author-validating remote (#539)', async (kind) => {
    await withGitConfiguration(async (global) => {
      await git(['config', '--file', global, 'user.name', 'Corporate User'])
      await git(['config', '--file', global, 'user.email', 'employee@company.example'])
      const origin = await repository('sync-author-policy-remote')
      requireCorporateAuthor(origin)
      const machineA = await machine('sync-author-policy', origin)
      if (kind === 'saved default') {
        // v0.5.38 wrote this pair even when the user only supplied a repository.
        const path = machineA.sync.settings().path()
        const saved = JSON.parse(readFileSync(path, 'utf8'))
        writeFileSync(path, JSON.stringify({ ...saved, authorName: 'dsh-mnemon sync', authorEmail: 'mnemon@localhost' }))
      }
      const pushed = await machineA.sync.push({ message: 'Approved identity' })
      expect(pushed, pushed.reason).toMatchObject({ committed: true, pushed: true })
      expect(await git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'mnemon-sync'], origin))
        .toBe('Corporate User <employee@company.example>|Corporate User <employee@company.example>\n')
    })
  })

  it.each(['local', 'include', 'conditional include', 'worktree'] as const)('resolves the sync mirror identity through Git %s configuration (#539)', async (kind) => {
    await withGitConfiguration(async (global) => {
      await git(['config', '--file', global, 'user.name', 'Global User'])
      await git(['config', '--file', global, 'user.email', 'global@example.com'])
      const origin = await repository('sync-author-scope-remote')
      const machineA = await machine('sync-author-scope', origin)
      const mirror = machineA.sync.settings().mirror()
      await git(['init', '--quiet', mirror])
      await git(['config', 'mnemon.origin', origin], mirror)
      if (kind === 'include' || kind === 'conditional include') {
        const included = join(mirror, '.git', 'identity.config')
        await git(['config', '--file', included, 'user.name', 'Mirror User'])
        await git(['config', '--file', included, 'user.email', 'mirror@example.com'])
        if (kind === 'include') await git(['config', 'include.path', 'identity.config'], mirror)
        else {
          const gitdir = (await git(['rev-parse', '--absolute-git-dir'], mirror)).trim()
          await git(['config', '--file', global, 'includeIf.gitdir:' + gitdir + '.path', included])
        }
      } else {
        if (kind === 'worktree') await git(['config', 'extensions.worktreeConfig', 'true'], mirror)
        const scope = kind === 'worktree' ? '--worktree' : '--local'
        await git(['config', scope, 'user.name', 'Mirror User'], mirror)
        await git(['config', scope, 'user.email', 'mirror@example.com'], mirror)
      }
      expect(await machineA.sync.push({ message: 'Mirror identity' })).toMatchObject({ pushed: true })
      expect(await git(['log', '-1', '--format=%an <%ae>', 'mnemon-sync'], origin)).toBe('Mirror User <mirror@example.com>\n')
    })
  })

  it('keeps explicit sync author fields ahead of Git configuration and inherited author variables (#539)', async () => {
    await withGitConfiguration(async (global) => {
      await git(['config', '--file', global, 'user.name', 'Global User'])
      await git(['config', '--file', global, 'user.email', 'global@example.com'])
      await withGitIdentity('Environment User', 'environment@example.com', async () => {
        const origin = await repository('sync-author-explicit-remote')
        const machineA = await machine('sync-author-explicit', origin)
        // One field matching the old default is still part of an explicit custom pair.
        await machineA.sync.configure({ authorName: 'dsh-mnemon sync', authorEmail: 'approved@example.com' })
        expect(await machineA.sync.push({ message: 'Explicit identity' })).toMatchObject({ pushed: true })
        expect(await git(['log', '-1', '--format=%an <%ae>', 'mnemon-sync'], origin)).toBe('dsh-mnemon sync <approved@example.com>\n')
        expect(machineA.sync.settings().read()).toMatchObject({ authorName: 'dsh-mnemon sync', authorEmail: 'approved@example.com' })
      })
    })
  })

  it.each([false, true])('recovers an author-rejected local commit with published history=%s without rewriting remote history (#539)', async (published) => {
    await withGitConfiguration(async (global) => {
      const origin = await repository('sync-author-recovery-remote')
      const machineA = await machine('sync-author-recovery', origin)
      let original: string | undefined
      if (published) {
        await machineA.sync.configure({ authorName: 'Corporate User', authorEmail: 'employee@company.example' })
        original = (await machineA.sync.push({ message: 'Published history' })).commit
        await machineA.sync.configure({ authorName: 'dsh-mnemon sync', authorEmail: 'mnemon@localhost' })
      }
      requireCorporateAuthor(origin)
      await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Keep this pending memory', importance: 'normal' }, { confirmed: true })
      const rejected = await machineA.sync.push({ message: 'Pending memory' })
      expect(rejected).toMatchObject({ committed: true, pushed: false })
      expect(rejected.reason).toContain('Commit author rejected by policy: dsh-mnemon sync <mnemon@localhost>')
      expect(rejected.reason).not.toContain('no token')
      expect(rejected.reason).toContain('Sync > Advanced')
      await git(['config', '--file', global, 'user.name', 'Corporate User'])
      await git(['config', '--file', global, 'user.email', 'employee@company.example'])
      const recovered = await machineA.sync.push({ message: 'Recovered memory' })
      expect(recovered, recovered.reason).toMatchObject({ committed: true, pushed: true })
      expect(await git(['show', 'mnemon-sync:mnemon/payload/runtime/USER.md'], origin)).toContain('Keep this pending memory')
      expect((await git(['rev-list', '--count', 'mnemon-sync'], origin)).trim()).toBe(published ? '2' : '1')
      if (original !== undefined) expect((await git(['rev-parse', 'mnemon-sync^'], origin)).trim()).toBe(original)
    })
  })

  it('records the channel on the manifest without breaking the Mnemon Pack reader', async () => {
    const origin = await repository('sync-manifest-remote')
    const machineA = await machine('sync-manifest', origin)
    await machineA.sync.push({ message: 'First' })
    const manifest = JSON.parse(await git(['show', 'mnemon-sync:mnemon/manifest.json'], origin))
    expect(manifest).toMatchObject({ format: 'mnemonpack', version: 1, scope: 'full', sync: { channel: 'git', branch: 'mnemon-sync', subdir: 'mnemon/' } })
    expect(manifest.sync.pushedAt).toBe('2026-08-14T12:00:00.000Z')
    expect(manifest.components).toEqual(['runtime', 'documents', 'memory-spaces'])
  })

  it('does not commit a second time when the payload has not changed', async () => {
    const origin = await repository('sync-idempotent-remote')
    const clock = tickingClock()
    const machineA = await machine('sync-idempotent', origin, clock.now)
    const first = await machineA.sync.push({ message: 'First' })
    const published = await git(['show', 'mnemon-sync:mnemon/manifest.json'], origin)
    const readsBeforeSecond = clock.reads()
    const second = await machineA.sync.push({ message: 'Second' })
    expect(first).toMatchObject({ committed: true, pushed: true })
    expect(second).toMatchObject({ committed: false, pushed: false, commit: first.commit, reason: 'the branch already holds this payload' })
    expect((await git(['rev-list', '--count', 'mnemon-sync'], origin)).trim()).toBe('1')
    // The second export really carried a later exportedAt and pushedAt; only
    // those two fields differ, and a timestamp alone is not a payload change.
    expect(clock.reads()).toBeGreaterThan(readsBeforeSecond)
    expect(await git(['show', 'mnemon-sync:mnemon/manifest.json'], origin)).toBe(published)
    expect(await git(['status', '--porcelain'], join(machineA.root, 'state', 'sync', 'git'))).toBe('')
  })

  it('does not commit a second time when this machine really holds an entry', async () => {
    // The first export stamps every entry this machine wrote with its origin, and a stamp taken
    // from the export clock would rewrite the payload on the next run. The entry is what makes
    // that path reachable, so the empty-root case above cannot catch it.
    const origin = await repository('sync-idempotent-entry-remote')
    const clock = tickingClock()
    const machineA = await machine('sync-idempotent-entry', origin, clock.now)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })
    const first = await machineA.sync.push({ message: 'First' })
    const published = await git(['show', 'mnemon-sync:mnemon/payload/runtime/memories.json'], origin)
    const second = await machineA.sync.push({ message: 'Second' })

    expect(first).toMatchObject({ committed: true, pushed: true })
    expect(published).toContain('Prefer concise answers')
    expect(second).toMatchObject({ committed: false, pushed: false, commit: first.commit, reason: 'the branch already holds this payload' })
    expect((await git(['rev-list', '--count', 'mnemon-sync'], origin)).trim()).toBe('1')
    expect(await git(['show', 'mnemon-sync:mnemon/payload/runtime/memories.json'], origin)).toBe(published)
  })

  it('pulls the branch into a second machine as the second machine would', async () => {
    const origin = await repository('sync-pull-remote')
    const machineA = await machine('sync-pull-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefers table output', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish' })

    const machineB = await machine('sync-pull-b', origin)
    const preview = await machineB.sync.preview()
    expect(preview).toMatchObject({ branch: 'mnemon-sync', subdir: 'mnemon/', pushedAt: '2026-08-14T12:00:00.000Z' })
    expect(preview.manifest.scope).toBe('full')
    expect(preview.components.map(entry => entry.component)).toEqual(['runtime', 'documents', 'memory-spaces'])
    // The published profile differs from the empty one this machine holds.
    expect(preview.components.find(entry => entry.component === 'runtime')).toMatchObject({ changed: true, items: 1 })
    expect(preview.files.changed).toBeGreaterThan(0)
    expect(preview.expandedBytes).toBeGreaterThan(0)

    const pulled = await machineB.sync.pull({ mode: 'merge' })
    expect(pulled).toMatchObject({ imported: true, mode: 'merge', components: ['runtime', 'documents', 'memory-spaces'] })
    expect(readFileSync(join(machineB.root, 'runtime', 'USER.md'), 'utf8')).toContain('Prefers table output')

    // The pulled payload is the same pack the ZIP path would have produced.
    const exported = await machineB.packs.exportPack('full')
    expect(unzipSync(Buffer.from(exported.base64, 'base64'))['payload/runtime/USER.md']).toBeDefined()
  })

  it('reports what differs without importing anything on preview', async () => {
    const origin = await repository('sync-preview-remote')
    const machineA = await machine('sync-preview-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Published profile', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish' })

    const machineB = await machine('sync-preview-b', origin)
    await machineB.sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'Local only note', importance: 'normal' }, { confirmed: true })
    const preview = await machineB.sync.preview()
    expect(preview.files.total).toBeGreaterThan(0)
    expect(preview.files.changed).toBeGreaterThan(0)
    expect(preview.components.find(entry => entry.component === 'runtime')?.changed).toBe(true)
    // A preview never touches the local payload.
    expect(readFileSync(join(machineB.root, 'runtime', 'USER.md'), 'utf8')).not.toContain('Published profile')
  })

  it('lists the branch history as backups, each named by the manifest it carries', async () => {
    const origin = await repository('sync-backups-remote')
    const machineA = await machine('sync-backups-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })
    const first = await machineA.sync.push({ message: 'Publish from A' })

    // A branch that holds nothing is an empty history, not a failure.
    const emptyOrigin = await repository('sync-backups-empty-remote')
    const empty = await machine('sync-backups-empty', emptyOrigin)
    expect(await empty.sync.backups()).toMatchObject({ branch: 'mnemon-sync', subdir: 'mnemon/', commits: [], truncated: false })

    const machineB = await machine('sync-backups-b', origin)
    await machineB.sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'Table output note', importance: 'normal' }, { confirmed: true })
    const second = await machineB.sync.push({ message: 'Publish from B' })

    const identityA = identityOf(machineA.root)
    const identityB = identityOf(machineB.root)
    const history = await machineB.sync.backups()
    expect(history.repoUrl).toBe(origin)
    expect(history.truncated).toBe(false)
    expect(history.commits.map(entry => entry.commit)).toEqual([second.commit, first.commit])
    // The newest commit is the one this machine just wrote; the older one is A's.
    expect(history.commits[0]).toMatchObject({ message: 'Publish from B', machine: { id: identityB.id, label: identityB.label } })
    expect(history.commits[1]).toMatchObject({ message: 'Publish from A', machine: { id: identityA.id, label: identityA.label } })
    expect(history.commits[1]!.components.map(entry => entry.component)).toEqual(['runtime', 'documents', 'memory-spaces'])
    expect(history.commits[1]!.components.find(entry => entry.component === 'runtime')).toMatchObject({ items: 1 })
    expect(history.commits[1]!.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)

    // The history is a window, and the window says when it was cut short.
    const one = await machineB.sync.backups({ limit: 1 })
    expect(one.commits).toHaveLength(1)
    expect(one.truncated).toBe(true)
    expect((await machineB.sync.backups({ limit: 0 })).commits).toHaveLength(1)

    // Reading the history moves neither the branch nor the reader's payload. The
    // reader is a third machine that has never pushed, so nothing has folded into it.
    const tip = (await git(['rev-parse', 'mnemon-sync'], origin)).trim()
    const reader = await machine('sync-backups-reader', origin)
    await reader.sync.backups()
    expect((await git(['rev-parse', 'mnemon-sync'], origin)).trim()).toBe(tip)
    const held = join(reader.root, 'runtime', 'USER.md')
    expect(existsSync(held) ? readFileSync(held, 'utf8') : '').not.toContain('Prefer concise answers')
  })

  it('reports which memories are only here and which are only on the branch', async () => {
    const origin = await repository('sync-diff-remote')
    const machineA = await machine('sync-diff-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish from A' })

    const machineB = await machine('sync-diff-b', origin)
    await machineB.sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'Local only note', importance: 'critical' }, { confirmed: true })
    const identityA = identityOf(machineA.root)
    const identityB = identityOf(machineB.root)

    const apart = await machineB.sync.diff()
    expect(apart).toMatchObject({ repoUrl: origin, branch: 'mnemon-sync', subdir: 'mnemon/', shared: 0, truncated: false })
    expect(apart.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(apart.local).toMatchObject({ entries: 1, machine: { id: identityB.id } })
    expect(apart.remote).toMatchObject({ entries: 1, machine: { id: identityA.id, label: identityA.label } })
    expect(apart.localOnly.map(entry => entry.content)).toEqual(['Local only note'])
    expect(apart.localOnly[0]).toMatchObject({ target: 'memory', importance: 'critical' })
    expect(apart.remoteOnly.map(entry => entry.content)).toEqual(['Prefer concise answers'])
    expect(apart.remoteOnly[0]!.origin).toMatchObject({ machine: identityA.id, label: identityA.label })
    expect(apart.remoteTombstones).toEqual([])
    // Two texts about different subjects are two memories, not one subject written twice.
    expect(apart.conflicts).toEqual([])
    // Reading a difference never imports anything.
    expect(readFileSync(join(machineB.root, 'runtime', 'USER.md'), 'utf8')).not.toContain('Prefer concise answers')

    // Importing the branch does not change the branch: it still holds A's entry alone,
    // while this machine now holds both.
    await machineB.sync.pull({ mode: 'merge' })
    const imported = await machineB.sync.diff()
    expect(imported, 'after pull').toMatchObject({ shared: 1, localOnly: [{ content: 'Local only note' }], remoteOnly: [] })
    expect(imported.local.entries).toBe(2)
    expect(imported.remote.entries).toBe(1)

    // Publishing is what makes the branch hold both machines' memories.
    await machineB.sync.push({ message: 'Publish from B' })
    const merged = await machineB.sync.diff()
    expect(merged, 'after push').toMatchObject({ shared: 2, localOnly: [], remoteOnly: [] })
    expect(merged.local.entries).toBe(2)
    expect(merged.remote.entries).toBe(2)

    // Without a repository there is no difference to read, and it says so.
    const loose = await machine('sync-diff-unconfigured')
    await expect(loose.sync.diff()).rejects.toThrow('no sync repository is configured')
    await expect(loose.sync.backups()).rejects.toThrow('no sync repository is configured')
  })

  it('finds the subjects both sides wrote differently and leaves the rest alone', async () => {
    const origin = await repository('sync-conflict-remote')
    const machineA = await machine('sync-conflict-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers in every reply', importance: 'normal' }, { confirmed: true })
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'Deploy on Fridays', importance: 'critical' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish from A' })

    const identityA = identityOf(machineA.root)

    const machineB = await machine('sync-conflict-b', origin)
    // The same preference, written another way, plus a memory only this side holds.
    await machineB.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers for all replies', importance: 'normal' }, { confirmed: true })
    await machineB.sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'Local only note', importance: 'critical' }, { confirmed: true })

    const apart = await machineB.sync.diff()
    // One subject is stated twice, so keeping both would record one answer twice.
    expect(apart.conflicts).toHaveLength(1)
    const conflict = apart.conflicts[0]!
    expect(conflict.target).toBe('user')
    expect(conflict.local).toMatchObject({ target: 'user', content: 'Prefer concise answers for all replies' })
    expect(conflict.remote).toMatchObject({ target: 'user', content: 'Prefer concise answers in every reply' })
    // The branch's side carries the stamp of the machine that published it.
    expect(conflict.remote.origin).toMatchObject({ machine: identityA.id, label: identityA.label })
    // Alike enough to be the same subject, and not the same text: this is exactly the
    // pair a person has to decide about, so it is also what the difference sorts on.
    expect(conflict.similarity).toBeGreaterThanOrEqual(0.6)
    expect(conflict.similarity).toBeLessThan(1)
    // A conflict is found among the entries that only one side holds: the pair above is
    // reported as a conflict, and the two memories about other subjects stay additions,
    // which is exactly the distinction the panel draws.
    expect(apart.localOnly.map(entry => entry.content)).toEqual(['Prefer concise answers for all replies', 'Local only note'])
    expect(apart.remoteOnly.map(entry => entry.content)).toEqual(['Prefer concise answers in every reply', 'Deploy on Fridays'])
    expect(apart.conflicts.map(entry => entry.local.content)).toEqual(['Prefer concise answers for all replies'])
    expect(apart.shared).toBe(0)
    expect(apart.truncated).toBe(false)
    // Reporting a conflict reads both sides and moves neither.
    expect(entriesOf(machineB.root)).not.toContain('Prefer concise answers in every reply')
    expect(entriesOf(machineA.root)).not.toContain('Prefer concise answers for all replies')
  })

  it('counts only the removals this machine has not applied yet', async () => {
    // The Source stamps an entry with the real clock, and a deletion only hides an entry
    // written no later than it. A clock ahead of the fixture's writes is what makes the
    // deletion a deletion instead of a re-publication.
    const ahead = () => new Date('2030-01-01T00:00:00.000Z')
    const origin = await repository('sync-diff-removal-remote')
    const machineA = await machine('sync-diff-removal-a', origin, ahead)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish from A' })

    const machineB = await machine('sync-diff-removal-b', origin, ahead)
    await machineB.sync.pull({ mode: 'merge' })

    // A deletes what it published, so the branch carries a removal as well as its entries.
    // Publishing is what records the deletion: the branch still holds the entry, so a push
    // that folded it in first would restore it and report no removal at all.
    await machineA.sources.runtime.mutate('mutate', { action: 'remove', target: 'user', oldText: 'Prefer concise answers' }, { confirmed: true })
    const removal = await machineA.sync.push({ message: 'Delete on A' })
    expect(removal.committed, 'the deletion is a new commit').toBe(true)
    expect(removal.merged?.tombstones).toBe(0)
    expect(entriesOf(machineA.root)).toEqual([])

    // B has not read that commit: the removal is one this machine has not applied.
    const unread = await machineB.sync.diff()
    expect(unread.remoteTombstones.map(tombstone => tombstone.target)).toEqual(['user'])
    expect(unread.remote.entries).toBe(0)

    // Reading the branch applies the removal. Tombstones only ever grow, so the branch
    // still carries it; what changes is that this machine now holds it too, and a removal
    // both sides hold is not something left to reconcile.
    await machineB.sync.pull({ mode: 'merge' })
    const applied = await machineB.sync.diff()
    expect(applied.remoteTombstones).toEqual([])
    expect(applied.local.entries).toBe(0)
    expect(applied.remote.entries).toBe(0)
  })

  it('fails hard and imports nothing when a payload file does not match its checksum', async () => {
    const origin = await repository('sync-tamper-remote')
    const machineA = await machine('sync-tamper-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Published profile', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish' })

    const clone = join(temporary('sync-tamper-clone'), 'work')
    await git(['clone', '--quiet', '--branch', 'mnemon-sync', origin, clone])
    const profile = join(clone, 'mnemon', 'payload', 'runtime', 'USER.md')
    writeFileSync(profile, readFileSync(profile, 'utf8') + '\nTampered\n')
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-am', 'Tamper'], clone)
    await git(['push', '--quiet', 'origin', 'mnemon-sync'], clone)

    const machineB = await machine('sync-tamper-b', origin)
    await expect(machineB.sync.preview()).rejects.toThrow('failed its checksum: payload/runtime/USER.md')
    await expect(machineB.sync.pull({ mode: 'merge' })).rejects.toThrow('failed its checksum: payload/runtime/USER.md')
    // The remote payload never reaches the local payload: the fixture's own
    // profile survives and the published entry is absent.
    expect(readFileSync(join(machineB.root, 'runtime', 'USER.md'), 'utf8')).not.toContain('Published profile')
    expect(readFileSync(join(machineB.root, 'runtime', 'memories.json'), 'utf8')).not.toContain('Published profile')
  })

  /**
   * The state the reported store was left in: one document's digest carries a stray character.
   * A first push is the dangerous one, because the import check that guards every later push
   * has nothing to read yet, so the bad payload would go straight to the branch and lock the
   * channel behind it.
   */
  it('refuses a first push whose document digest is not a sha256', async () => {
    const origin = await repository('sync-index-shape-remote')
    const machineA = await machine('sync-index-shape', origin)
    await machineA.sources.documents.mutate('mutate', { action: 'create', title: 'Hermes image generation', content: '# Hermes\n\nDirect upstream call.' }, { confirmed: true })
    const indexPath = join(machineA.root, 'documents', 'index.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { documents: Array<{ contentHash: string }> }
    index.documents[0]!.contentHash += '6'
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`)

    await expect(machineA.sync.push({ message: 'First push' })).rejects.toThrow('Documents index records a content hash that is not a sha256 digest')
    // The branch is where the damage would have landed, and nothing reached it.
    expect((await git(['branch', '--list', 'mnemon-sync'], origin)).trim()).toBe('')
    expect(await git(['status', '--porcelain'], join(machineA.root, 'state', 'sync', 'git'))).toBe('')
  })

  /**
   * Sixty-four lowercase hex characters, so the shape check reads it as a digest and only a
   * comparison against the body can tell that it is not this document's.
   */
  it('refuses a first push whose document digest does not match its body', async () => {
    const origin = await repository('sync-index-value-remote')
    const machineA = await machine('sync-index-value', origin)
    await machineA.sources.documents.mutate('mutate', { action: 'create', title: 'Hermes image generation', content: '# Hermes\n\nDirect upstream call.' }, { confirmed: true })
    const indexPath = join(machineA.root, 'documents', 'index.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { documents: Array<{ contentHash: string }> }
    index.documents[0]!.contentHash = '0'.repeat(64)
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`)

    await expect(machineA.sync.push({ message: 'First push' })).rejects.toThrow('Documents payload content hash does not match')
    expect((await git(['branch', '--list', 'mnemon-sync'], origin)).trim()).toBe('')
    expect(await git(['status', '--porcelain'], join(machineA.root, 'state', 'sync', 'git'))).toBe('')
  })

  it.skipIf(nodeSqlite === undefined)('reads the payload the branch holds, not files the mirror does not track (#396)', async () => {
    const origin = await repository('sync-untracked-remote')
    const machineA = await machine('sync-untracked', origin)
    seedSpace(machineA.root)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Published profile', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish' })
    const mirror = join(machineA.root, 'state', 'sync', 'git')
    expect(await git(['ls-tree', '-r', '--name-only', 'mnemon-sync'], origin)).toContain('mnemon/payload/data/default/mnemon.db')
    // SQLite leaves -wal and -shm beside a database something opened in place, and Git
    // tracks neither, here ignores them even. A reset keeps such files, so every later sync
    // read them as payload and failed until someone deleted them by hand.
    writeFileSync(join(mirror, '.git', 'info', 'exclude'), '*-shm\n*-wal\n')
    writeFileSync(join(mirror, 'notes.txt'), 'outside the sync directory')
    const stray = [join('mnemon', 'payload', 'data', 'default', 'mnemon.db-shm'), join('mnemon', 'payload', 'data', 'default', 'mnemon.db-wal'),
      join('mnemon', 'payload', 'runtime', 'scratch', 'left-over.json')]
    for (const path of stray) {
      mkdirSync(join(mirror, path, '..'), { recursive: true })
      writeFileSync(join(mirror, path), 'not part of the payload')
    }
    await expect(machineA.sync.preview()).resolves.toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/u) })
    for (const path of stray) expect(existsSync(join(mirror, path))).toBe(false)
    expect(existsSync(join(mirror, 'mnemon', 'payload', 'data', 'default', 'mnemon.db'))).toBe(true)
    for (const path of stray) {
      mkdirSync(join(mirror, path, '..'), { recursive: true })
      writeFileSync(join(mirror, path), 'not part of the payload')
    }
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Second profile entry', importance: 'normal' }, { confirmed: true })
    await expect(machineA.sync.push({ message: 'Publish again' })).resolves.toMatchObject({ committed: true, pushed: true })
    expect(await git(['status', '--porcelain'], mirror)).toBe('?? notes.txt\n')
    const published = await git(['ls-tree', '-r', '--name-only', 'mnemon-sync'], origin)
    expect(published).toContain('mnemon/payload/runtime/USER.md')
    expect(published).not.toMatch(/-shm|-wal|left-over/u)
    expect(await git(['show', 'mnemon-sync:mnemon/payload/runtime/USER.md'], origin)).toContain('Second profile entry')
    // Only the sync directory is brought back to the branch.
    expect(readFileSync(join(mirror, 'notes.txt'), 'utf8')).toBe('outside the sync directory')
  })

  it.skipIf(nodeSqlite === undefined)('publishes payload files the ignore rules on this machine match, and syncs again (#396)', async () => {
    const origin = await repository('sync-ignored-remote')
    const machineA = await machine('sync-ignored-a', origin)
    seedSpace(machineA.root)
    // A global ignore file, as many machines have one, that matches every Memory Space database.
    const home = temporary('sync-ignored-home')
    writeFileSync(join(home, 'ignore'), '*.db\n')
    writeFileSync(join(home, 'gitconfig'), '[core]\n\texcludesFile = ' + join(home, 'ignore') + '\n')
    await withEnvironment({ GIT_CONFIG_GLOBAL: join(home, 'gitconfig') }, async () => {
      await machineA.sync.push({ message: 'Publish' })
      expect(await git(['ls-tree', '-r', '--name-only', 'mnemon-sync'], origin)).toContain('mnemon/payload/data/default/mnemon.db')
      await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Second profile entry', importance: 'normal' }, { confirmed: true })
      await expect(machineA.sync.push({ message: 'Publish again' })).resolves.toMatchObject({ committed: true, pushed: true })
      const machineB = await machine('sync-ignored-b', origin)
      await expect(machineB.sync.pull({ mode: 'merge' })).resolves.toBeDefined()
      expect(existsSync(join(machineB.root, 'data', 'default', 'mnemon.db'))).toBe(true)
    })
  })

  it('reports an empty remote instead of importing an empty payload', async () => {
    const origin = await repository('sync-empty-remote')
    const machineA = await machine('sync-empty', origin)
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '--allow-empty', '-m', 'Unrelated'], await unrelatedCommit(origin))
    await expect(machineA.sync.preview()).rejects.toThrow('holds no Mnemon payload')
    await expect(machineA.sync.pull({ mode: 'merge' })).rejects.toThrow('holds no Mnemon payload')
  })

  it('folds the branch into this machine before publishing, so no machine overwrites another', async () => {
    const origin = await repository('sync-merge-remote')
    const machineA = await machine('sync-merge-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish from A' })

    const machineB = await machine('sync-merge-b', origin)
    await machineB.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefers table output', importance: 'normal' }, { confirmed: true })
    const pushed = await machineB.sync.push({ message: 'Publish from B' })

    expect(pushed.merged).toMatchObject({ components: ['runtime', 'documents', 'memory-spaces'] })
    expect(pushed.merged?.commit).toMatch(/^[0-9a-f]{40}$/u)
    // The merge lands locally first, so the machine that pushes keeps both entries too.
    expect(readFileSync(join(machineB.root, 'runtime', 'USER.md'), 'utf8')).toContain('Prefer concise answers')
    // And the published payload holds both machines' entries, not only the newest push.
    const published = await git(['show', 'mnemon-sync:mnemon/payload/runtime/USER.md'], origin)
    expect(published).toContain('Prefer concise answers')
    expect(published).toContain('Prefers table output')
  })

  it('keeps one Project Document on a machine that edits it between syncs', async () => {
    const origin = await repository('sync-document-solo-remote')
    const machineA = await machine('sync-document-solo', origin)
    await machineA.sources.documents.mutate('mutate', { action: 'create', title: 'Release plan', content: '# Release plan\n\nVersion 1' }, { confirmed: true })
    await machineA.sync.push({ message: 'Version 1' })
    const id = documentsOf(machineA.root)[0]!.id
    for (const version of [2, 3]) {
      await editDocument(machineA, id, '# Release plan\n\nVersion ' + String(version))
      // Every push folds the branch in first, and the branch holds the previous version.
      await machineA.sync.push({ message: 'Version ' + String(version) })
    }
    expect(documentsOf(machineA.root).map(document => [document.title, document.revision])).toEqual([['Release plan', 3]])
    const published = JSON.parse(await git(['show', 'mnemon-sync:mnemon/payload/documents/index.json'], origin)) as { documents: unknown[] }
    expect(published.documents).toHaveLength(1)
  })

  it('brings an edit made on one machine to the same document on the other', async () => {
    const origin = await repository('sync-document-edit-remote')
    const machineA = await machine('sync-document-edit-a', origin)
    await machineA.sources.documents.mutate('mutate', { action: 'create', title: 'Release plan', content: '# Release plan\n\nVersion 1' }, { confirmed: true })
    await machineA.sync.push({ message: 'From A' })
    const machineB = await machine('sync-document-edit-b', origin)
    await machineB.sync.push({ message: 'From B' })
    const id = documentsOf(machineB.root)[0]!.id
    for (const version of [2, 3]) {
      await editDocument(machineA, id, '# Release plan\n\nVersion ' + String(version))
      await machineA.sync.push({ message: 'Version ' + String(version) })
      await machineB.sync.pull()
      // The document B held is the one that changed, not a copy beside it.
      expect(documentsOf(machineB.root).map(document => [document.id, document.revision])).toEqual([[id, version]])
      expect(readFileSync(join(machineB.root, documentsOf(machineB.root)[0]!.relativePath), 'utf8')).toContain('Version ' + String(version))
      await machineB.sync.push({ message: 'B folds in' })
      expect(documentsOf(machineA.root)).toHaveLength(1)
    }
  })

  it('keeps one copy of a document both machines changed since they last agreed, and both end alike', async () => {
    const origin = await repository('sync-document-both-remote')
    const machineA = await machine('sync-document-both-a', origin)
    await machineA.sources.documents.mutate('mutate', { action: 'create', title: 'Release plan', content: '# Release plan\n\nVersion 1' }, { confirmed: true })
    await machineA.sync.push({ message: 'From A' })
    const machineB = await machine('sync-document-both-b', origin)
    await machineB.sync.push({ message: 'From B' })
    const id = documentsOf(machineA.root)[0]!.id
    await editDocument(machineA, id, '# Release plan\n\nA wants a canary first')
    await editDocument(machineB, id, '# Release plan\n\nB wants a staged rollout')
    await machineA.sync.push({ message: 'A edits' })
    await machineB.sync.push({ message: 'B edits' })
    for (let round = 0; round < 2; round += 1) {
      await machineA.sync.push({ message: 'A again' })
      await machineB.sync.push({ message: 'B again' })
    }
    const contents = (root: string) => documentsOf(root).map(document => readFileSync(join(root, document.relativePath), 'utf8').match(/(A wants|B wants)[^\n]*/u)?.[0]).sort()
    // Neither edit is lost: one of them is the document, the other its single copy, on both machines.
    expect(contents(machineA.root)).toEqual(['A wants a canary first', 'B wants a staged rollout'])
    expect(documentsOf(machineA.root).map(document => document.id).sort()).toEqual(documentsOf(machineB.root).map(document => document.id).sort())
    expect(contents(machineB.root)).toEqual(contents(machineA.root))
  })

  describe('Project Documents when a sync does not go as planned', () => {
    const create = (target: Awaited<ReturnType<typeof machine>>, title = 'Release plan') =>
      target.sources.documents.mutate('mutate', { action: 'create', title, content: '# ' + title + '\n\nVersion 1' }, { confirmed: true })

    /** A machine whose pushes Git refuses while `refusing` says so, as a 403 does. */
    function refusal() {
      const state = { refusing: false, always: false }
      const run: ProcessRunner = async (command, args, options) => {
        if (state.refusing && args.includes('push')) {
          if (!state.always) state.refusing = false
          return { stdout: '', stderr: 'fatal: unable to access the remote: The requested URL returned error: 403', exitCode: 128 }
        }
        return runProcess(command, args, options)
      }
      return { state, run }
    }

    /** A takes B's version 2 in, but cannot publish the result. */
    async function unpublishedMerge(label: string) {
      const origin = await repository(label + '-remote')
      const refused = refusal()
      const machineA = await machine(label + '-a', origin, now, refused.run)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine(label + '-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineB, id, '# Release plan\n\nVersion 2 from B')
      await machineB.sync.push({ message: 'B, version 2' })
      refused.state.refusing = true
      const result = await machineA.sync.push({ message: 'A, refused' })
      expect(result.pushed).toBe(false)
      expect(documentsOf(machineA.root).map(document => document.id)).toEqual([id])
      expect(textOf(machineA.root, id)).toContain('Version 2 from B')
      return { machineA, machineB, id }
    }

    const alike = (machines: Array<Awaited<ReturnType<typeof machine>>>, id: string, text: string) => {
      for (const target of machines) {
        expect(documentsOf(target.root).map(document => document.id)).toEqual([id])
        expect(textOf(target.root, id)).toContain(text)
      }
    }

    it('takes the newest version on the retry after another machine published meanwhile', async () => {
      const origin = await repository('sync-document-race-remote')
      let machineB: Awaited<ReturnType<typeof machine>> | undefined
      let id = ''
      let race = false
      const racing: ProcessRunner = async (command, args, options) => {
        if (race && args.includes('push')) {
          race = false
          await editDocument(machineB!, id, '# Release plan\n\nVersion 3 from B')
          await machineB!.sync.push({ message: 'B, during the race' })
        }
        return runProcess(command, args, options)
      }
      const machineA = await machine('sync-document-race-a', origin, now, racing)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      machineB = await machine('sync-document-race-b', origin)
      await machineB.sync.push({ message: 'From B' })
      id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineB, id, '# Release plan\n\nVersion 2 from B')
      await machineB.sync.push({ message: 'B, version 2' })
      race = true
      const result = await machineA.sync.push({ message: 'A, raced' })
      expect(race).toBe(false)
      expect(result.failure).toBeUndefined()
      await machineB.sync.push({ message: 'B again' })
      alike([machineA, machineB], id, 'Version 3 from B')
    })

    it('catches up with the branch after a merge it could not publish', async () => {
      const { machineA, machineB, id } = await unpublishedMerge('sync-document-catch-up')
      await editDocument(machineB, id, '# Release plan\n\nVersion 3 from B')
      await machineB.sync.push({ message: 'B, version 3' })
      await machineA.sync.push({ message: 'A again' })
      await machineB.sync.push({ message: 'B again' })
      alike([machineA, machineB], id, 'Version 3 from B')
    })

    it('adds no copy for an edit made on top of a merge it could not publish', async () => {
      const { machineA, machineB, id } = await unpublishedMerge('sync-document-edit-after')
      await editDocument(machineA, id, '# Release plan\n\nVersion 3 from A, on top of version 2')
      await machineA.sync.push({ message: 'A publishes its edit' })
      await machineB.sync.push({ message: 'B again' })
      alike([machineA, machineB], id, 'Version 3 from A, on top of version 2')
    })

    it('adds no copy on a machine that can read the branch but never publish to it', async () => {
      const origin = await repository('sync-document-read-only-remote')
      const machineB = await machine('sync-document-read-only-b', origin)
      await create(machineB)
      await machineB.sync.push({ message: 'From B' })
      const refused = refusal()
      const machineA = await machine('sync-document-read-only-a', origin, now, refused.run)
      await machineA.sync.push({ message: 'A joins' })
      refused.state.refusing = true
      refused.state.always = true
      const id = documentsOf(machineB.root)[0]!.id
      for (const version of [2, 3, 4]) {
        await editDocument(machineB, id, '# Release plan\n\nVersion ' + String(version))
        await machineB.sync.push({ message: 'B, version ' + String(version) })
        expect((await machineA.sync.push({ message: 'A' })).pushed).toBe(false)
        alike([machineA], id, 'Version ' + String(version))
      }
    })

    it('keeps its own version when the branch is published again from an older history', async () => {
      const origin = await repository('sync-document-recreated-remote')
      const machineA = await machine('sync-document-recreated-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-recreated-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineA, id, '# Release plan\n\nVersion 2, only on A')
      await machineA.sync.push({ message: 'A, version 2' })
      // The branch is deleted, and B, which never saw version 2, publishes again first.
      await git(['update-ref', '-d', 'refs/heads/mnemon-sync'], origin)
      await machineB.sync.push({ message: 'B starts the branch again' })
      await machineA.sync.push({ message: 'A again' })
      expect(textOf(machineA.root, id)).toContain('Version 2, only on A')
      // B's older version is kept beside it, as a merge without an agreement keeps it.
      expect(documentsOf(machineA.root)).toHaveLength(2)
    })

    it('keeps the newer version when the other machine runs a dsh-mnemon that records no agreement', async () => {
      const origin = await repository('sync-document-older-remote')
      const machineA = await machine('sync-document-older-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-older-b', origin)
      // No release up to 0.5.28 used either record in a merge; one before 0.5.28 kept neither.
      const older = async (message: string) => {
        for (const path of [agreementOf(machineB.root), join(machineB.root, 'state', 'sync', 'last-run.json')]) rmSync(path, { force: true })
        await machineB.sync.push({ message })
        for (const path of [agreementOf(machineB.root), join(machineB.root, 'state', 'sync', 'last-run.json')]) rmSync(path, { force: true })
      }
      await older('B joins')
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineA, id, '# Release plan\n\nVersion 2 from A')
      await machineA.sync.push({ message: 'A, version 2' })
      // B keeps version 1 under the same id and version 2 as a copy, and publishes both.
      await older('B, as before this change')
      expect(documentsOf(machineB.root)).toHaveLength(2)
      await machineA.sync.push({ message: 'A again' })
      expect(textOf(machineA.root, id)).toContain('Version 2 from A')
    })

    it('carries an edit made before the first sync after an update from 0.5.28 as an edit (#385)', async () => {
      const origin = await repository('sync-document-upgrade-remote')
      const machineA = await machine('sync-document-upgrade', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'Version 1' })
      // dsh-mnemon 0.5.28 remembered the commit of its last sync, but no agreement.
      rmSync(agreementOf(machineA.root), { force: true })
      expect(existsSync(join(machineA.root, 'state', 'sync', 'last-run.json'))).toBe(true)
      const id = documentsOf(machineA.root)[0]!.id
      for (const version of [2, 3]) await editDocument(machineA, id, '# Release plan\n\nVersion ' + String(version))
      await machineA.sync.push({ message: 'The first sync after the update' })
      expect(documentsOf(machineA.root).map(document => [document.id, document.revision])).toEqual([[id, 3]])
      expect(textOf(machineA.root, id)).toContain('Version 3')
      const published = JSON.parse(await git(['show', 'mnemon-sync:mnemon/payload/documents/index.json'], origin)) as { documents: DocumentEntry[] }
      expect(published.documents.map(document => [document.id, document.revision])).toEqual([[id, 3]])
    })

    it('takes the branch\'s newer version after an update from 0.5.28 whose last run was a merge (#385)', async () => {
      const origin = await repository('sync-document-upgrade-merge-remote')
      const machineA = await machine('sync-document-upgrade-merge-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-upgrade-merge-b', origin)
      await machineB.sync.pull()
      rmSync(agreementOf(machineB.root), { force: true })
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineA, id, '# Release plan\n\nVersion 2 from A')
      await machineA.sync.push({ message: 'A, version 2' })
      await machineB.sync.push({ message: 'B, the first sync after the update' })
      alike([machineA, machineB], id, 'Version 2 from A')
    })

    it('keeps a copy after an update from 0.5.28 when the branch no longer descends from the last sync (#385)', async () => {
      const origin = await repository('sync-document-upgrade-rewritten-remote')
      const machineA = await machine('sync-document-upgrade-rewritten-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-upgrade-rewritten-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineA, id, '# Release plan\n\nVersion 2, only on A')
      rmSync(agreementOf(machineA.root), { force: true })
      // The branch is deleted, and B publishes it again from a history of its own.
      await git(['update-ref', '-d', 'refs/heads/mnemon-sync'], origin)
      await machineB.sync.push({ message: 'B starts the branch again' })
      await machineA.sync.push({ message: 'A again' })
      expect(textOf(machineA.root, id)).toContain('Version 2, only on A')
      // Without a common history to agree on, B's version is kept beside A's, as before.
      expect(documentsOf(machineA.root)).toHaveLength(2)
    })

    const branchTexts = async (origin: string, subdir = 'mnemon/') => {
      const index = JSON.parse(await git(['show', 'mnemon-sync:' + subdir + 'payload/documents/index.json'], origin)) as { documents: DocumentEntry[] }
      return Promise.all(index.documents.map(document => git(['show', 'mnemon-sync:' + subdir + 'payload/' + document.relativePath], origin)))
    }
    const texts = (target: Awaited<ReturnType<typeof machine>>) => documentsOf(target.root).map(document => textOf(target.root, document.id))

    it('keeps the version a runtime-only merge on 0.5.28 never took in (#385)', async () => {
      const origin = await repository('sync-document-upgrade-runtime-remote')
      const machineA = await machine('sync-document-upgrade-runtime-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-upgrade-runtime-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineA, id, '# Release plan\n\nVersion 2 from A')
      await machineA.sync.push({ message: 'A, version 2' })
      // A merge of runtime memory only is a run 0.5.28 recorded all the same, though no document came in.
      await machineB.sync.pull({ components: ['runtime'] })
      rmSync(agreementOf(machineB.root), { force: true })
      await machineB.sync.push({ message: 'B, the first sync after the update' })
      expect(texts(machineB).some(text => text.includes('Version 2 from A'))).toBe(true)
      expect((await branchTexts(origin)).some(text => text.includes('Version 2 from A'))).toBe(true)
    })

    it('takes no agreement from the last sync of another directory (#385)', async () => {
      const origin = await repository('sync-document-upgrade-subdir-remote')
      const machineA = await machine('sync-document-upgrade-subdir-a', origin)
      await machineA.sync.configure({ subdir: 'team/' })
      await create(machineA)
      await machineA.sync.push({ message: 'A in team/' })
      const machineB = await machine('sync-document-upgrade-subdir-b', origin)
      await machineB.sync.configure({ subdir: 'team/' })
      await machineB.sync.push({ message: 'B in team/' })
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineB, id, '# Release plan\n\nVersion 2 from B')
      await machineB.sync.push({ message: 'B, version 2 in team/' })
      // A, on 0.5.28, syncs another directory of the branch, edits, comes back and updates.
      await machineA.sync.configure({ subdir: 'mnemon/' })
      await machineA.sync.push({ message: 'A in mnemon/' })
      rmSync(agreementOf(machineA.root), { force: true })
      await editDocument(machineA, id, '# Release plan\n\nA, first edit')
      await editDocument(machineA, id, '# Release plan\n\nA, second edit')
      await machineA.sync.configure({ subdir: 'team/' })
      await machineA.sync.push({ message: 'A back in team/' })
      await machineB.sync.push({ message: 'B again' })
      // B's version 2 is never lost: without an agreement for team/, it is kept as a copy.
      for (const held of [texts(machineA), texts(machineB), await branchTexts(origin, 'team/')]) expect(held.some(text => text.includes('Version 2 from B'))).toBe(true)
      expect(texts(machineA).some(text => text.includes('A, second edit'))).toBe(true)
    })

    it('agrees on the documents of a last run where the branch already held the payload (#385)', async () => {
      const origin = await repository('sync-document-upgrade-held-remote')
      const machineA = await machine('sync-document-upgrade-held', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'Version 1' })
      expect((await machineA.sync.push({ message: 'Nothing new' })).committed).toBe(false)
      rmSync(agreementOf(machineA.root), { force: true })
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineA, id, '# Release plan\n\nVersion 2')
      await machineA.sync.push({ message: 'A again' })
      expect(documentsOf(machineA.root).map(document => [document.id, document.revision])).toEqual([[id, 2]])
    })

    it('keeps copies when the last run\'s commit holds no documents to agree on (#385)', async () => {
      const origin = await repository('sync-document-upgrade-empty-remote')
      // The branch starts with a commit of its own, which holds no Mnemon payload.
      await unrelatedCommit(origin)
      const empty = (await git(['rev-parse', 'mnemon-sync'], origin)).trim()
      const machineA = await machine('sync-document-upgrade-empty', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'Version 1' })
      rmSync(agreementOf(machineA.root), { force: true })
      const lastRun = join(machineA.root, 'state', 'sync', 'last-run.json')
      writeFileSync(lastRun, JSON.stringify({ ...JSON.parse(readFileSync(lastRun, 'utf8')) as Record<string, unknown>, commit: empty }))
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineA, id, '# Release plan\n\nVersion 2')
      await expect(machineA.sync.push({ message: 'A again' })).resolves.toMatchObject({ pushed: true })
      // An ancestor without a Documents index is no agreement: a copy is kept, as before.
      expect(documentsOf(machineA.root)).toHaveLength(2)
    })

    it('keeps a rename and an archive made on one machine when the other changed the text', async () => {
      const origin = await repository('sync-document-metadata-remote')
      const machineA = await machine('sync-document-metadata-a', origin)
      await create(machineA, 'Plan')
      await create(machineA, 'Notes')
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-metadata-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const [plan, notes] = documentsOf(machineA.root)
      await machineA.sources.documents.read('snapshot')
      await machineA.sources.documents.mutate('mutate', { action: 'update', id: plan!.id, title: 'Plan, renamed on A' } as never, { confirmed: true })
      await machineA.sources.documents.read('snapshot')
      await machineA.sources.documents.mutate('archive', { id: notes!.id, summary: 'Archived on A' } as never, { confirmed: true })
      await editDocument(machineB, plan!.id, '# Plan\n\nVersion 2 from B')
      await editDocument(machineB, notes!.id, '# Notes\n\nVersion 2 from B')
      await machineB.sync.push({ message: 'B edits both' })
      await machineA.sync.push({ message: 'A again' })
      const byId = new Map(documentsOf(machineA.root).map(document => [document.id, document]))
      expect(byId.get(plan!.id)?.title).toBe('Plan, renamed on A')
      expect(byId.get(notes!.id)).toMatchObject({ status: 'archived', archiveSummary: 'Archived on A' })
      // B's two texts are kept beside them.
      expect(byId.size).toBe(4)
    })

    it('brings a title changed on one machine to the other', async () => {
      const origin = await repository('sync-document-title-remote')
      const machineA = await machine('sync-document-title-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-title-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const id = documentsOf(machineA.root)[0]!.id
      await machineA.sources.documents.read('snapshot')
      await machineA.sources.documents.mutate('mutate', { action: 'update', id, title: 'Release plan, renamed on A' } as never, { confirmed: true })
      await machineA.sync.push({ message: 'A renames it' })
      await machineB.sync.push({ message: 'B again' })
      expect(documentsOf(machineB.root).map(document => [document.id, document.title])).toEqual([[id, 'Release plan, renamed on A']])
    })

    it('agrees with the branch after Merge here only, so an edit published later adds no copy', async () => {
      const origin = await repository('sync-document-pull-remote')
      const machineA = await machine('sync-document-pull-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-pull-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineA, id, '# Release plan\n\nVersion 2 from A')
      await machineA.sync.push({ message: 'A, version 2' })
      await machineB.sync.pull()
      await editDocument(machineB, id, '# Release plan\n\nVersion 3 from B, after the merge')
      await machineB.sync.push({ message: 'B publishes' })
      await machineA.sync.push({ message: 'A again' })
      alike([machineA, machineB], id, 'Version 3 from B, after the merge')
    })

    it('leaves the agreement as it was when a merge takes runtime memory only', async () => {
      const origin = await repository('sync-document-runtime-remote')
      const machineA = await machine('sync-document-runtime-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-runtime-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const agreed = readFileSync(agreementOf(machineB.root), 'utf8')
      await editDocument(machineA, documentsOf(machineA.root)[0]!.id, '# Release plan\n\nVersion 2 from A')
      await machineA.sync.push({ message: 'A, version 2' })
      await machineB.sync.pull({ components: ['runtime'] })
      expect(readFileSync(agreementOf(machineB.root), 'utf8')).toBe(agreed)
    })

    it('starts without an agreement it cannot read, and keeps one through a disconnect', async () => {
      const origin = await repository('sync-document-unreadable-remote')
      const machineA = await machine('sync-document-unreadable-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      writeFileSync(agreementOf(machineA.root), 'not an agreement')
      expect((await machineA.sync.push({ message: 'A again' })).failure).toBeUndefined()
      const id = documentsOf(machineA.root)[0]!.id
      expect(JSON.parse(readFileSync(agreementOf(machineA.root), 'utf8'))).toMatchObject({ version: 1, documents: { [id]: expect.any(String) } })
      // Disconnected, edited, connected to the same repository again: the edit travels, with no copy.
      await machineA.sync.configure({ repoUrl: null })
      await editDocument(machineA, id, '# Release plan\n\nVersion 2, edited while disconnected')
      await machineA.sync.configure({ repoUrl: origin })
      await machineA.sync.push({ message: 'A reconnected' })
      alike([machineA], id, 'Version 2, edited while disconnected')
    })

    it('keeps both versions when two machines changed a document at different revisions, and both end alike', async () => {
      const origin = await repository('sync-document-revisions-remote')
      const machineA = await machine('sync-document-revisions-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-revisions-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const id = documentsOf(machineA.root)[0]!.id
      await editDocument(machineA, id, '# Release plan\n\nA, first edit')
      await editDocument(machineA, id, '# Release plan\n\nA, second edit')
      await editDocument(machineB, id, '# Release plan\n\nB, one edit')
      for (const round of [1, 2]) {
        await machineA.sync.push({ message: 'A, round ' + String(round) })
        await machineB.sync.push({ message: 'B, round ' + String(round) })
      }
      const texts = (target: Awaited<ReturnType<typeof machine>>) => documentsOf(target.root).map(document => textOf(target.root, document.id).match(/(A, second edit|B, one edit)/u)?.[0]).sort()
      expect(texts(machineA)).toEqual(['A, second edit', 'B, one edit'])
      expect(texts(machineB)).toEqual(texts(machineA))
      expect(documentsOf(machineB.root).map(document => document.id).sort()).toEqual(documentsOf(machineA.root).map(document => document.id).sort())
    })

    it('keeps an archive and a rename two machines made to the same text', async () => {
      const origin = await repository('sync-document-both-meta-remote')
      const machineA = await machine('sync-document-both-meta-a', origin)
      await create(machineA, 'Plan')
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-both-meta-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const id = documentsOf(machineA.root)[0]!.id
      await machineA.sources.documents.read('snapshot')
      await machineA.sources.documents.mutate('archive', { id, summary: 'Archived on A' } as never, { confirmed: true })
      await machineB.sources.documents.read('snapshot')
      await machineB.sources.documents.mutate('mutate', { action: 'update', id, title: 'Plan, renamed on B' } as never, { confirmed: true })
      for (const round of [1, 2]) {
        await machineA.sync.push({ message: 'A, round ' + String(round) })
        await machineB.sync.push({ message: 'B, round ' + String(round) })
      }
      for (const target of [machineA, machineB]) {
        const states = documentsOf(target.root).map(document => [document.title, document.status, document.archiveSummary ?? ''].join(' | ')).sort()
        expect(states).toEqual(['Plan | archived | Archived on A', 'Plan, renamed on B | active | '])
      }
    })

    it('brings an archive made on one machine to the other', async () => {
      const origin = await repository('sync-document-archive-remote')
      const machineA = await machine('sync-document-archive-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const machineB = await machine('sync-document-archive-b', origin)
      await machineB.sync.push({ message: 'From B' })
      const id = documentsOf(machineA.root)[0]!.id
      await machineA.sources.documents.read('snapshot')
      await machineA.sources.documents.mutate('archive', { id, summary: 'Shipped' } as never, { confirmed: true })
      await machineA.sync.push({ message: 'A archives it' })
      await machineB.sync.push({ message: 'B again' })
      expect(documentsOf(machineB.root).map(document => [document.id, document.status, document.archiveSummary])).toEqual([[id, 'archived', 'Shipped']])
    })

    it('never uses what it agreed on with another branch', async () => {
      const origin = await repository('sync-document-branch-remote')
      const machineA = await machine('sync-document-branch-a', origin)
      await create(machineA)
      await machineA.sync.push({ message: 'From A' })
      const id = documentsOf(machineA.root)[0]!.id
      await machineA.sync.configure({ branch: 'mnemon-sync-other' })
      await machineA.sync.push({ message: 'A on another branch' })
      await editDocument(machineA, id, '# Release plan\n\nVersion 2')
      await machineA.sync.configure({ branch: 'mnemon-sync' })
      await machineA.sync.push({ message: 'A back on the first branch' })
      // The first sync back has no agreement for this branch, so the branch's version is kept beside the edit.
      expect(textOf(machineA.root, id)).toContain('Version 2')
      expect(documentsOf(machineA.root)).toHaveLength(2)
    })
  })

  it('reports the identity of this machine on every status', async () => {
    const machineA = await machine('sync-machine-identity')
    const status = await machineA.sync.status()
    const stored = JSON.parse(readFileSync(join(machineA.root, 'state', 'machine.json'), 'utf8')) as { version: number; id: string; label: string; createdAt: string }

    expect(stored.version).toBe(1)
    expect(status.machine).toEqual({ id: stored.id, label: stored.label, createdAt: stored.createdAt })
    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(stored.label.length).toBeGreaterThan(0)
  })

  it('publishes the name a person gives this machine, and goes back to the host name', async () => {
    const origin = await repository('sync-machine-name-remote')
    const machineA = await machine('sync-machine-name-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'Named machine note', importance: 'normal' }, { confirmed: true })

    // The name is kept with the identity; the channel settings stay as they were.
    expect((await machineA.sync.configure({ machineLabel: 'Studio' })).repoUrl).toBe(origin)
    const status = await machineA.sync.status()
    expect(status.machine?.label).toBe('Studio')
    expect(status.machineLabel).toEqual({ source: 'custom', hostname: defaultMachineLabel() })
    const first = await machineA.sync.push({ message: 'Publish as Studio' })
    expect((await machineA.sync.backups()).commits[0]).toMatchObject({ commit: first.commit, machine: { label: 'Studio' } })

    // A refused name changes nothing else the same request carried.
    await expect(machineA.sync.configure({ branch: 'elsewhere', machineLabel: 'two\nlines' })).rejects.toThrow(/machine name/u)
    const unchanged = await machineA.sync.status()
    expect(unchanged.config.branch).toBe('mnemon-sync')
    expect(unchanged.machine?.label).toBe('Studio')

    // Back to the host name: the next sync records the new name in a version of its own.
    await machineA.sync.configure({ machineLabel: null })
    expect((await machineA.sync.status()).machineLabel?.source).toBe('hostname')
    const second = await machineA.sync.push({ message: 'Publish under the host name' })
    expect(second.committed).toBe(true)
    expect((await machineA.sync.backups()).commits[0]).toMatchObject({ commit: second.commit, machine: { label: defaultMachineLabel() } })
  })

  it('drives Git with an environment that cannot relocate the repository', async () => {
    // The harness shims export GIT_DIR for their own PATH bookkeeping; Git reads
    // the same variable as the repository location, so a push launched from such
    // a shell would fail with "fatal: Invalid path" before writing anything.
    const sanitized = gitEnvironment({
      PATH: 'C:\\Windows',
      GIT_DIR: 'C:\\tools\\git\\cmd',
      git_work_tree: 'C:\\elsewhere',
      GIT_INDEX_FILE: 'C:\\tmp\\index',
      SystemRoot: 'C:\\Windows',
    })
    expect(sanitized).toEqual({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })

    const origin = await repository('sync-environment-remote')
    const machineA = await machine('sync-environment', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Survives a polluted environment', importance: 'normal' }, { confirmed: true })
    const pushed = await machineA.sync.push({ message: 'Sanitized environment' })
    expect(pushed).toMatchObject({ committed: true, pushed: true })
    expect(await git(['show', 'mnemon-sync:mnemon/payload/runtime/USER.md'], origin)).toContain('Survives a polluted environment')
  })

  it('never waits on a prompt a person would have to answer', () => {
    // No terminal is watched on the Host: a missing credential has to fail, not hang a push.
    expect(gitEnvironment({ PATH: '/bin', GIT_TERMINAL_PROMPT: '1' })).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
    // Nor does it change how Git reads the paths it is given.
    expect(gitEnvironment({ PATH: '/bin', GIT_LITERAL_PATHSPECS: '1', GIT_ICASE_PATHSPECS: '1' })).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
  })

  it('offers the GitHub sign-in to github.com and to no other host', async () => {
    const calls: string[][] = []
    const run: ProcessRunner = async (_command, args) => {
      calls.push([...args])
      return args.includes('--version') ? { stdout: 'git version 2.50.0\n', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 }
    }
    const root = temporary('sync-grant')
    const config = resolveConfig({ storageScope: 'custom', dataDir: root, cliPath: '/fake/mnemon', syncEnabled: true })
    const runner = createStorageRoot(config)
    const sync = new MnemonGitSync(runner, config, new MnemonPackManager(runner, config), run)
    sync.useGitHubAuth({ grant: async () => ({ version: 1, accessToken: 'gho_test', login: 'octocat', savedAt: now().toISOString() }) } as unknown as MnemonGitHubAuth)
    const handedToken = () => calls.filter(args => args.includes('ls-remote')).map(args => args.some(arg => arg.startsWith('credential.helper=store')))

    await sync.configure({ repoUrl: 'https://git.example.com/team/memory.git' })
    expect((await sync.status()).config.credentialSource).toBe('none')
    expect(handedToken()).toEqual([false])

    calls.length = 0
    await sync.configure({ repoUrl: 'https://github.com/octocat/memory.git' })
    expect((await sync.status()).config.credentialSource).toBe('github')
    expect(handedToken()).toEqual([true])
  })

  it('refuses a payload directory that a symbolic link in the mirror leads out of it', async () => {
    const origin = await repository('sync-link-remote')
    // The branch exists, so the mirror is brought to its tip rather than started afresh,
    // which would clear everything the branch does not hold, the link included.
    await (await machine('sync-link-other', origin)).sync.push({ message: 'Existing branch' })
    const machineA = await machine('sync-link', origin)
    await machineA.sync.configure({ subdir: 'nested/mnemon/' })
    const outside = temporary('sync-link-outside')
    writeFileSync(join(outside, 'canary.txt'), 'outside the mirror\n')
    // A mirror of this very repository, with a link where a payload parent should be.
    const mirror = join(machineA.root, 'state', 'sync', 'git')
    mkdirSync(mirror, { recursive: true })
    await git(['init', '--quiet', mirror])
    await git(['config', 'mnemon.origin', origin], mirror)
    symlinkSync(outside, join(mirror, 'nested'))

    await expect(machineA.sync.push({ message: 'Through a link' })).rejects.toThrow('crosses a symbolic link')
    expect(readFileSync(join(outside, 'canary.txt'), 'utf8')).toBe('outside the mirror\n')
    expect(readdirSync(outside)).toEqual(['canary.txt'])

    // A mirror that names no repository, as an older build left it, is rebuilt rather
    // than trusted, and the link goes with it without following it.
    await git(['config', '--unset', 'mnemon.origin'], mirror)
    await expect(machineA.sync.push({ message: 'Into a rebuilt mirror' })).resolves.toMatchObject({ pushed: true })
    expect(lstatSync(join(mirror, 'nested')).isSymbolicLink()).toBe(false)
    expect(readdirSync(outside)).toEqual(['canary.txt'])
  })

  it('checks a symbolic link a branch holds out as a plain file', async () => {
    const origin = await repository('sync-branch-link-remote')
    const outside = temporary('sync-branch-link-outside')
    writeFileSync(join(outside, 'canary.txt'), 'outside the mirror\n')
    // Someone with write access to the branch commits a link where the payload's parent goes.
    const author = temporary('sync-branch-link-author')
    await git(['init', '--quiet', '--initial-branch=mnemon-sync', author])
    symlinkSync(outside, join(author, 'nested'))
    await git(['add', 'nested'], author)
    await git(['-c', 'user.name=Writer', '-c', 'user.email=writer@example.com', 'commit', '--quiet', '-m', 'Link'], author)
    await git(['push', '--quiet', origin, 'mnemon-sync'], author)

    const machineA = await machine('sync-branch-link', origin)
    await machineA.sync.configure({ subdir: 'nested/mnemon/' })
    await expect(machineA.sync.push({ message: 'Into the branch link' })).rejects.toThrow()
    expect(lstatSync(join(machineA.root, 'state', 'sync', 'git', 'nested')).isSymbolicLink()).toBe(false)
    expect(readdirSync(outside)).toEqual(['canary.txt'])
  })

  it('collects the loose objects each push writes into one pack', async () => {
    const origin = await repository('sync-compaction-remote')
    const machineA = await machine('sync-compaction', origin)
    const mirror = join(machineA.root, 'state', 'sync', 'git')
    const loose = async (): Promise<number> => Number(/^count:s*(d+)$/mu.exec(await git(['count-objects', '-v'], mirror))?.[1] ?? '0')

    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'First memory', importance: 'normal' }, { confirmed: true })
    const first = await machineA.sync.push({ message: 'First' })
    // Every push writes a whole new payload, so the mirror starts out holding loose
    // objects: without a repack the mirror keeps a full copy of every generation.
    expect(first.compaction?.loose).toBeGreaterThan(0)
    expect(await loose()).toBe(0)
    expect(first.compaction?.packed).toBeGreaterThan(0)
    expect(first.compaction?.warning).toBeUndefined()
    // The pack holds the whole history, so it is not smaller than the one loose
    // generation it replaced; what the figures state is that nothing is loose and
    // that a clone fetches the pack, not the objects the push wrote.
    expect(first.compaction!.packedBytes).toBeGreaterThan(0)

    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Second memory', importance: 'normal' }, { confirmed: true })
    const second = await machineA.sync.push({ message: 'Second' })
    expect(second.compaction?.loose).toBeGreaterThan(0)
    expect(await loose()).toBe(0)
    // A clone still receives the whole history, so the repack must not have dropped any of it.
    const clone = join(temporary('sync-compaction-clone'), 'clone')
    await git(['clone', '--quiet', '--branch', 'mnemon-sync', origin, clone])
    expect(readFileSync(join(clone, 'mnemon', 'payload', 'runtime', 'USER.md'), 'utf8')).toContain('Second memory')
  })

  it('answers a profile that never switched sync on without touching Git', async () => {
    const origin = await repository('sync-off-remote')
    const switchedOn = await machine('sync-off', origin)
    // Nothing was ever configured on this profile, so even the repository above is
    // absent: what the status reports must be about the switch alone.
    const off = resolveConfig({ storageScope: 'custom', dataDir: switchedOn.root, cliPath: '/fake/mnemon', syncEnabled: false })
    const sync = new MnemonGitSync(switchedOn.runner, off, switchedOn.packs, undefined, now)
    sync.configure({ repoUrl: origin })

    const status = await sync.status()
    // Off is not a failure and not a probe: the saved configuration is answered,
    // and the fields that would only exist because Git ran say so.
    expect(status).toMatchObject({ enabled: false, configured: true, git: { available: false }, remote: { reachable: false, branchExists: false } })
    expect(status.machine).toBeUndefined()
    expect(status.lastCommit).toBeUndefined()
    expect(status.autoBackup).toBeUndefined()
    // A disabled channel leaves no trace on disk: the mirror is what a Git run creates.
    expect(existsSync(join(switchedOn.root, 'state', 'sync', 'git'))).toBe(false)
    // Switching it on is the whole difference: the same root now reports Git and the remote.
    const on = resolveConfig({ storageScope: 'custom', dataDir: switchedOn.root, cliPath: '/fake/mnemon', syncEnabled: true })
    const enabled = await new MnemonGitSync(switchedOn.runner, on, switchedOn.packs, undefined, now).status()
    expect(enabled).toMatchObject({ enabled: true, git: { available: true }, remote: { reachable: true, branchExists: false } })
  })

  it('creates the branch on the first push and honours a nested directory', async () => {
    const origin = await repository('sync-branch-remote')
    const machineA = await machine('sync-branch', origin)
    machineA.sync.configure({ branch: 'memory/user', subdir: '/nested/mnemon' })
    const pushed = await machineA.sync.push({ message: 'Nested' })
    expect(pushed).toMatchObject({ branch: 'memory/user', subdir: 'nested/mnemon/' })
    expect(await git(['show', 'memory/user:nested/mnemon/manifest.json'], origin)).toContain('"mnemonpack"')
    expect((await git(['branch', '--list'], origin)).trim()).toBe('memory/user')
  })

  it('starts a new history in another repository instead of publishing the old one there', async () => {
    const first = await repository('sync-switch-first')
    const second = await repository('sync-switch-second')
    const machineA = await machine('sync-switch', first)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Written for the first repository', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'First repository' })

    await machineA.sync.configure({ repoUrl: second })
    const pushed = await machineA.sync.push({ message: 'Second repository' })
    expect(pushed).toMatchObject({ committed: true, pushed: true })
    // The second repository holds one root commit; the first one's history stays where it was.
    expect((await git(['rev-list', '--count', 'mnemon-sync'], second)).trim()).toBe('1')
    expect((await git(['log', '--format=%s', 'mnemon-sync'], second)).trim()).toBe('Second repository')
  })

  it('starts over when the remote branch was deleted, rather than publishing what it held', async () => {
    const origin = await repository('sync-deleted-remote')
    const machineA = await machine('sync-deleted', origin)
    await machineA.sync.push({ message: 'Before the deletion' })
    await git(['update-ref', '-d', 'refs/heads/mnemon-sync'], origin)

    const pushed = await machineA.sync.push({ message: 'After the deletion' })
    expect(pushed).toMatchObject({ committed: true, pushed: true })
    expect((await git(['log', '--format=%s', 'mnemon-sync'], origin)).trim()).toBe('After the deletion')
  })

  it('folds in a branch that moved during the push and publishes again', async () => {
    const origin = await repository('sync-race-remote')
    const machineB = await machine('sync-race-b', origin)
    await machineB.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'B wrote this first', importance: 'normal' }, { confirmed: true })
    await machineB.sync.push({ message: 'B first' })

    // Machine A's Git pushes only after B published again, as a machine racing it would.
    let raced = false
    const racing: ProcessRunner = async (command, args, options) => {
      if (!raced && args.includes('push')) {
        raced = true
        await machineB.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'B wrote this during the race', importance: 'normal' }, { confirmed: true })
        await machineB.sync.push({ message: 'B during the race' })
      }
      return runProcess(command, args, options)
    }
    const machineA = await machine('sync-race-a', origin, now, racing)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'A wrote this', importance: 'normal' }, { confirmed: true })
    const pushed = await machineA.sync.push({ message: 'A after the race' })

    expect(raced).toBe(true)
    expect(pushed).toMatchObject({ committed: true, pushed: true })
    expect(pushed.failure).toBeUndefined()
    // Both attempts merged one of B's entries, and the answer counts both.
    expect(pushed.merged?.runtime?.added).toBe(2)
    const published = await git(['show', 'mnemon-sync:mnemon/payload/runtime/USER.md'], origin)
    expect(published).toContain('B wrote this during the race')
    expect(published).toContain('A wrote this')
  })

  it('takes over a lock its owner left behind and removes the token files it left', async () => {
    const origin = await repository('sync-stale-remote')
    const machineA = await machine('sync-stale', origin)
    const state = join(machineA.root, 'state')
    // A Host that stopped mid-push: its lock and its one-command credential file remain.
    mkdirSync(join(state, '.sync.lock'), { recursive: true })
    writeFileSync(join(state, '.sync.lock', 'owner.json'), JSON.stringify({ pid: GONE_PID, startedAt: '2026-08-14T11:00:00.000Z' }))
    const stale = join(state, '.credentials.' + String(GONE_PID) + '.1.tmp')
    const live = join(state, '.credentials.' + String(process.pid) + '.99.tmp')
    writeFileSync(stale, 'https://x-access-token:stale@example.com\n')
    writeFileSync(live, 'in use\n')

    await expect(machineA.sync.push({ message: 'After a stale lock' })).resolves.toMatchObject({ pushed: true })
    expect(existsSync(join(state, '.sync.lock'))).toBe(false)
    expect(existsSync(stale)).toBe(false)
    // A file this very process may still be using is left alone.
    expect(existsSync(live)).toBe(true)

    // A lock an older build left without an owner record is taken over once no run could still hold it.
    mkdirSync(join(state, '.sync.lock'))
    const past = new Date(Date.now() - 20 * 60_000)
    utimesSync(join(state, '.sync.lock'), past, past)
    await expect(machineA.sync.push({ message: 'After an ownerless lock' })).resolves.toMatchObject({ committed: false })
  })

  it('names what kept a remote out of reach', async () => {
    const machineA = await machine('sync-missing', join(temporary('sync-missing-parent'), 'absent.git'))
    const status = await machineA.sync.status()
    expect(status.remote).toMatchObject({ reachable: false, issue: 'not-found' })
    await expect(machineA.sync.push({ message: 'Nowhere' })).rejects.toMatchObject({ reason: 'remote-not-found' })
    await expect(machineA.sync.preview()).rejects.toMatchObject({ reason: 'remote-not-found' })
  })

  it('commits under the channel identity on a machine that has none', async () => {
    const empty = join(temporary('sync-no-identity-config'), 'gitconfig')
    writeFileSync(empty, '')
    await withEnvironment({
      GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1', EMAIL: undefined,
      GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined,
    }, async () => {
      const origin = await repository('sync-no-identity-remote')
      const machineA = await machine('sync-no-identity', origin)
      await machineA.sync.configure({ authorName: '', authorEmail: '' })
      const pushed = await machineA.sync.push({ message: 'No identity here' })
      expect(pushed).toMatchObject({ committed: true, pushed: true })
      expect(await git(['log', '-1', '--format=%an <%ae>', 'mnemon-sync'], origin)).toBe('dsh-mnemon sync <mnemon@localhost>\n')
    })
  })

  it('remembers the last sync and forgets it for another repository', async () => {
    const origin = await repository('sync-last-run-remote')
    const machineA = await machine('sync-last-run', origin)
    expect((await machineA.sync.status()).lastRun).toBeUndefined()

    const pushed = await machineA.sync.push({ message: 'Remembered' })
    expect((await machineA.sync.status()).lastRun).toEqual({ at: now().toISOString(), kind: 'sync', commit: pushed.commit, pushed: true })
    await machineA.sync.pull()
    expect((await machineA.sync.status()).lastRun).toMatchObject({ kind: 'merge', commit: pushed.commit, pushed: false, added: 0 })

    await machineA.sync.configure({ repoUrl: await repository('sync-last-run-other') })
    expect((await machineA.sync.status()).lastRun).toBeUndefined()
  })

  it('counts payload files, not the manifest a read stamps anew', async () => {
    const origin = await repository('sync-preview-files-remote')
    const machineA = await machine('sync-preview-files', origin, tickingClock().now)
    await machineA.sync.push({ message: 'Published' })

    const preview = await machineA.sync.preview()
    expect(preview.components.every(component => !component.changed)).toBe(true)
    expect(preview.files).toMatchObject({ changed: 0, added: 0, removed: 0 })
  })

  it('forgets a saved token when the repository moves to another host', async () => {
    const machineA = await machine('sync-token-host')
    expect(await machineA.sync.configure({ repoUrl: 'https://git.example.com/me/memory.git', token: 'token-for-example' })).toMatchObject({ hasToken: true, credentialSource: 'token' })
    // Another repository on the same host keeps it.
    expect(await machineA.sync.configure({ repoUrl: 'https://git.example.com/me/other.git' })).toMatchObject({ hasToken: true })
    // Another host does not receive it.
    expect(await machineA.sync.configure({ repoUrl: 'https://github.com/me/memory.git' })).toMatchObject({ hasToken: false, credentialSource: 'none' })
    expect(readFileSync(join(machineA.root, 'state', 'sync-git.json'), 'utf8')).not.toContain('token-for-example')
    // A token that comes with the move is the one kept.
    expect(await machineA.sync.configure({ repoUrl: 'https://git.example.com/me/memory.git', token: 'token-again' })).toMatchObject({ hasToken: true })
  })

  it('gives the status probe 20 seconds and an operation the full Git timeout', async () => {
    const timeouts: Array<{ command: string; timeoutMs: number }> = []
    const recording: ProcessRunner = async (command, args, options) => {
      const name = ['ls-remote', 'push', 'fetch'].find(candidate => args.includes(candidate))
      if (name !== undefined) timeouts.push({ command: name, timeoutMs: options.timeoutMs })
      return runProcess(command, args, options)
    }
    const origin = await repository('sync-timeout-remote')
    const machineA = await machine('sync-timeout', origin, now, recording)
    await machineA.sync.status()
    expect(timeouts).toEqual([{ command: 'ls-remote', timeoutMs: 20_000 }])
    timeouts.length = 0
    await machineA.sync.push({ message: 'Timed' })
    expect(timeouts.every(entry => entry.timeoutMs === 120_000)).toBe(true)
    expect(timeouts.map(entry => entry.command)).toContain('push')
  })

  it('initializes the mirror without the option Git 2.28 introduced', async () => {
    const calls: string[][] = []
    const recording: ProcessRunner = async (command, args, options) => {
      calls.push([...args])
      return runProcess(command, args, options)
    }
    const origin = await repository('sync-init-remote')
    const machineA = await machine('sync-init', origin, now, recording)
    await machineA.sync.push({ message: 'Initialized' })

    const init = calls.find(args => args.includes('init'))
    expect(init).toBeDefined()
    expect(init?.some(argument => argument.startsWith('--initial-branch'))).toBe(false)
    expect((await git(['branch', '--list'], origin)).trim()).toBe('mnemon-sync')
  })
})

describe('Mnemon Git sync failures', () => {
  it('states the failure kinds Git reports in its own words', () => {
    expect(remoteIssueOf("fatal: '/x.git' does not appear to be a git repository")).toBe('not-found')
    expect(remoteIssueOf("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found")).toBe('not-found')
    expect(remoteIssueOf("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe('auth')
    expect(remoteIssueOf('git@github.com: Permission denied (publickey).')).toBe('auth')
    expect(remoteIssueOf("fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host: example.invalid")).toBe('network')
    expect(remoteIssueOf('git did not respond within 20000ms')).toBe('timeout')
    expect(remoteIssueOf('fatal: something else entirely')).toBe('unknown')
  })
})

/** A branch holding a commit but no Mnemon payload. */
async function unrelatedCommit(origin: string): Promise<string> {
  const work = join(temporary('sync-unrelated'), 'work')
  await git(['clone', '--quiet', origin, work])
  writeFileSync(join(work, 'README.md'), '# Unrelated\n')
  await git(['add', 'README.md'], work)
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'Unrelated'], work)
  await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/mnemon-sync'], work)
  return work
}
