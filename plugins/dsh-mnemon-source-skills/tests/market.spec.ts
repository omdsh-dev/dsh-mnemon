import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readArchive } from '../src/archive.ts'
import { bundledOfficialRegistry, DISCOVERY_SCHEMA, parseRegistry, type Fetcher, type FetchResponse } from '../src/market.ts'
import { SkillsService } from '../src/service.ts'
import { detectSource } from '../src/source-kind.ts'

let root: string
let now: Date
const SKILL = (name: string, extra = '') => `---\nname: ${name}\ndescription: Do ${name}.\n---\n\n# ${name}\n${extra}`

/** A tiny GitHub: one tree and raw files, counted by URL. */
function github(files: Record<string, string>, calls: string[] = []): Fetcher {
  return async url => {
    calls.push(url)
    const tree = /api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\//u.exec(url)
    const body = tree !== null
      ? JSON.stringify({ truncated: false, tree: Object.keys(files).map(path => ({ path, type: 'blob', size: files[path]!.length })) })
      : files[decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//u, ''))]
    if (body === undefined) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    return { ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer }
  }
}

function answer(status: number, body: string | Buffer = ''): FetchResponse {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  return { ok: status >= 200 && status < 300, status, text: async () => bytes.toString('utf8'), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
}

/** A tiny web: each URL answers its body, or the status it is mapped to; anything else is 404. */
function web(pages: Record<string, string | Buffer | number>, calls: string[] = []): Fetcher {
  return async url => {
    calls.push(url)
    const page = pages[url]
    return page === undefined ? answer(404) : typeof page === 'number' ? answer(page) : answer(200, page)
  }
}

/** A POSIX tar of regular files, gzipped, as a site publishes a skill archive. */
function tarGz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = []
  for (const [path, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8')
    const header = Buffer.alloc(512)
    header.write(path, 0, 100, 'utf8')
    header.write('0000644\0', 100, 'ascii')
    header.write('0000000\0', 108, 'ascii')
    header.write('0000000\0', 116, 'ascii')
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
    header.write('00000000000\0', 136, 'ascii')
    header.write('        ', 148, 'ascii')
    header.write('0', 156, 'ascii')
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

/** A zip of files, the first stored and the rest deflated. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  Object.entries(files).forEach(([path, content], index) => {
    const data = Buffer.from(content, 'utf8')
    const packed = index === 0 ? data : deflateRawSync(data)
    const name = Buffer.from(path, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(index === 0 ? 0 : 8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(index === 0 ? 0 : 8, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  })
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const digest = (data: string | Buffer) => 'sha256:' + createHash('sha256').update(data).digest('hex')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mnemon-skills-market-'))
  now = new Date('2026-10-21T08:00:00.000Z')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function service(fetcher: Fetcher): SkillsService {
  return new SkillsService(join(root, 'data'), { dshHome: join(root, 'dsh'), agentsHome: join(root, 'agents') }, () => now, fetcher)
}

describe('skill registries', () => {
  it('ships an official registry whose entries all install from their upstream source', () => {
    const official = bundledOfficialRegistry()
    expect(official.skills.length).toBeGreaterThan(30)
    expect(official.skills.every(entry => entry.source.type === 'github' && typeof entry.description !== 'string')).toBe(true)
    expect(new Set(official.skills.map(entry => entry.name)).size).toBe(official.skills.length)
    const categories = new Set(official.categories!.map(category => category.id))
    expect(official.skills.every(entry => entry.category !== undefined && categories.has(entry.category))).toBe(true)
  })

  it('keeps the entries it can install and drops the rest', () => {
    const { registry, skipped } = parseRegistry({ version: 1, name: 'Team', skills: [
      { name: 'ok-skill', description: 'Fine', source: { type: 'url', url: 'https://example.test/SKILL.md' } },
      { name: 'Bad Name', description: 'x', source: { type: 'url', url: 'https://example.test/a.md' } },
      { name: 'escape', description: 'x', source: { type: 'github', repo: 'a/b', path: '../etc' } },
      { name: 'ok-skill', description: 'duplicate', source: { type: 'url', url: 'https://example.test/b.md' } },
    ] })
    expect(registry.skills.map(entry => entry.name)).toEqual(['ok-skill'])
    expect(skipped).toBe(3)
    expect(() => parseRegistry({ skills: [] })).toThrow('"version": 1')
  })
})

describe('market install', () => {
  it('previews, installs, detects edits and updates a GitHub skill from the official registry', async () => {
    const calls: string[] = []
    const files: Record<string, string> = { 'skills/frontend-design/SKILL.md': SKILL('frontend-design'), 'skills/frontend-design/LICENSE.txt': 'Apache License', 'other/SKILL.md': SKILL('other') }
    const market = service(github(files, calls))
    const view = market.marketView(undefined)
    expect(view.registries[0]).toMatchObject({ id: 'official', builtin: true, enabled: true })
    expect(view.stale).toEqual(['official'])
    expect(view.items.find(item => item.name === 'frontend-design')).toMatchObject({ state: 'available', registryId: 'official' })
    const preview = await market.marketPreview('official', 'frontend-design')
    expect(preview.content).toContain('name: frontend-design')
    expect(preview.files.map(file => file.path).sort()).toEqual(['LICENSE.txt', 'SKILL.md'])
    const installed = await market.installMarket(undefined, { registryId: 'official', name: 'frontend-design' })
    expect(installed).toMatchObject({ updated: false, skill: { key: 'user-dsh:frontend-design' } })
    expect(readFileSync(join(root, 'dsh', 'skills', 'frontend-design', 'LICENSE.txt'), 'utf8')).toBe('Apache License')
    expect(market.marketView(undefined).items.find(item => item.name === 'frontend-design')?.state).toBe('installed')
    expect(market.versions('user-dsh:frontend-design').map(version => version.reason)).toEqual(['install'])

    writeFileSync(join(root, 'dsh', 'skills', 'frontend-design', 'SKILL.md'), SKILL('frontend-design', 'local edit\n'))
    expect(market.marketView(undefined).items.find(item => item.name === 'frontend-design')?.state).toBe('modified')
    await expect(market.installMarket(undefined, { registryId: 'official', name: 'frontend-design' })).rejects.toThrow('edited after it was installed')
    files['skills/frontend-design/SKILL.md'] = SKILL('frontend-design', 'upstream v2\n')
    const updated = await market.installMarket(undefined, { registryId: 'official', name: 'frontend-design', overwrite: true })
    expect(updated.updated).toBe(true)
    expect(readFileSync(join(root, 'dsh', 'skills', 'frontend-design', 'SKILL.md'), 'utf8')).toContain('upstream v2')
    expect(market.store.trashEntries().length).toBe(1)
    expect(market.versions('user-dsh:frontend-design').map(version => version.reason)).toEqual(['install', 'install'])
  })

  it('refuses a skill whose name exists already and one whose SKILL.md names another skill', async () => {
    mkdirSync(join(root, 'dsh', 'skills', 'theme-factory'), { recursive: true })
    writeFileSync(join(root, 'dsh', 'skills', 'theme-factory', 'SKILL.md'), SKILL('theme-factory'))
    const market = service(github({ 'skills/theme-factory/SKILL.md': SKILL('theme-factory'), 'skills/internal-comms/SKILL.md': SKILL('something-else') }))
    expect(market.marketView(undefined).items.find(item => item.name === 'theme-factory')?.state).toBe('conflict')
    await expect(market.installMarket(undefined, { registryId: 'official', name: 'theme-factory' })).rejects.toThrow('did not come from this market entry')
    await expect(market.installMarket(undefined, { registryId: 'official', name: 'internal-comms' })).rejects.toThrow('names "something-else"')
    expect(existsSync(join(root, 'dsh', 'skills', 'internal-comms'))).toBe(false)
  })

  it('adds a local registry by path, installs from a folder beside it, and switches registries', async () => {
    const shared = join(root, 'team')
    mkdirSync(join(shared, 'skills', 'release-notes', 'templates'), { recursive: true })
    writeFileSync(join(shared, 'skills', 'release-notes', 'SKILL.md'), SKILL('release-notes'))
    writeFileSync(join(shared, 'skills', 'release-notes', 'templates', 'note.md'), 'template')
    writeFileSync(join(shared, 'registry.json'), JSON.stringify({ version: 1, id: 'team', name: { en: 'Team', 'zh-CN': '团队' }, skills: [
      { name: 'release-notes', version: '1.0.0', description: { en: 'Release notes', 'zh-CN': '发布说明' }, source: { type: 'path', path: 'skills/release-notes' } },
    ] }))
    const market = service(github({}))
    await expect(market.addRegistry('team/registry.json')).rejects.toThrow('absolute path')
    const added = await market.addRegistry(join(shared, 'registry.json'))
    expect(added).toMatchObject({ id: 'team', builtin: false, enabled: true, entries: 1 })
    await expect(market.addRegistry(join(shared, 'registry.json'))).rejects.toThrow('already added')
    await market.installMarket(undefined, { registryId: 'team', name: 'release-notes', root: 'user-agents' })
    expect(readFileSync(join(root, 'agents', 'skills', 'release-notes', 'templates', 'note.md'), 'utf8')).toBe('template')
    await market.toggleRegistry('official', false)
    expect(market.marketView(undefined).items.map(item => item.name)).toEqual(['release-notes'])
    await expect(market.removeRegistry('official')).rejects.toThrow('switched off, not removed')
    await market.removeRegistry('team')
    expect(market.marketView(undefined).registries.map(registry => [registry.id, registry.kind])).toEqual([['official', 'catalog'], ['skills-sh', 'search']])
  })

  it('keeps the packaged official copy when a refresh fails, and caches a successful one', async () => {
    const market = service(async () => ({ ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }))
    await market.refreshMarket()
    const view = market.marketView(undefined)
    expect(view.items.length).toBe(bundledOfficialRegistry().skills.length)
    expect(view.registries[0]!.error).toBeUndefined()
    const fresh = service(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version: 1, name: 'Official', skills: [{ name: 'only-one', description: 'x', source: { type: 'url', url: 'https://example.test/SKILL.md' } }] }), arrayBuffer: async () => new ArrayBuffer(0) }))
    await fresh.refreshMarket()
    expect(fresh.marketView(undefined)).toMatchObject({ stale: [], items: [{ name: 'only-one' }] })
  })
})

describe('market sources', () => {
  it('tells what a pasted string names before fetching anything', () => {
    expect(detectSource('anthropics/skills')).toEqual({ kind: 'github', location: 'https://github.com/anthropics/skills', label: 'anthropics/skills' })
    expect(detectSource('https://github.com/acme/tools/tree/main/skills/pdf')).toEqual({ kind: 'github', location: 'https://github.com/acme/tools/tree/main/skills/pdf', label: 'acme/tools/skills/pdf' })
    expect(detectSource('https://skills.sh/vercel-labs/agent-skills/web-design')).toMatchObject({ kind: 'github', label: 'vercel-labs/agent-skills' })
    expect(detectSource('developers.cloudflare.com')).toEqual({ kind: 'well-known', location: 'https://developers.cloudflare.com', label: 'developers.cloudflare.com' })
    expect(detectSource('example.com/skills')).toMatchObject({ kind: 'well-known', location: 'https://example.com/skills' })
    expect(detectSource('https://example.com/skills.json')).toMatchObject({ kind: 'json', label: 'skills.json' })
    expect(detectSource('/srv/team/registry.json')).toMatchObject({ kind: 'catalog', label: 'registry.json' })
    for (const text of ['team/registry.json', 'pdf', 'release notes', '', '/srv/team/folder']) expect(detectSource(text)).toBeUndefined()
  })

  it('reads a site\'s Agent Skills index, checks each digest, and unpacks its archives', async () => {
    const page = SKILL('deploy-site')
    const archive = tarGz({ 'SKILL.md': SKILL('agents-sdk'), 'references/api.md': 'API' })
    const calls: string[] = []
    const market = service(web({
      'https://docs.example.com/guide/.well-known/agent-skills/index.json': 404,
      'https://docs.example.com/.well-known/agent-skills/index.json': JSON.stringify({ $schema: DISCOVERY_SCHEMA, skills: [
        { name: 'deploy-site', type: 'skill-md', description: 'Deploy a site.', url: 'deploy-site/SKILL.md', digest: digest(page) },
        { name: 'agents-sdk', type: 'archive', description: 'Build agents.', url: '/.well-known/agent-skills/agents-sdk.tar.gz', digest: digest(archive) },
        { name: 'tampered', type: 'skill-md', description: 'Changed after publishing.', url: 'tampered/SKILL.md', digest: digest('original') },
        { name: 'Bad Name', type: 'skill-md', description: 'x', url: 'x', digest: digest('x') },
        { name: 'no-digest', type: 'skill-md', description: 'x', url: 'x' },
      ] }),
      'https://docs.example.com/.well-known/agent-skills/deploy-site/SKILL.md': page,
      'https://docs.example.com/.well-known/agent-skills/agents-sdk.tar.gz': archive,
      'https://docs.example.com/.well-known/agent-skills/tampered/SKILL.md': SKILL('tampered'),
    }, calls))
    const added = await market.addRegistry('docs.example.com/guide')
    expect(added).toMatchObject({ kind: 'well-known', location: 'https://docs.example.com/guide', entries: 3, name: 'docs.example.com' })
    expect(calls.slice(0, 2)).toEqual(['https://docs.example.com/guide/.well-known/agent-skills/index.json', 'https://docs.example.com/.well-known/agent-skills/index.json'])
    const preview = await market.marketPreview(added.id, 'agents-sdk')
    expect(preview.files.map(file => file.path).sort()).toEqual(['SKILL.md', 'references/api.md'])
    await market.installMarket(undefined, { registryId: added.id, name: 'agents-sdk' })
    expect(readFileSync(join(root, 'dsh', 'skills', 'agents-sdk', 'references', 'api.md'), 'utf8')).toBe('API')
    await market.installMarket(undefined, { registryId: added.id, name: 'deploy-site' })
    expect(readFileSync(join(root, 'dsh', 'skills', 'deploy-site', 'SKILL.md'), 'utf8')).toBe(page)
    await expect(market.installMarket(undefined, { registryId: added.id, name: 'tampered' })).rejects.toThrow('does not match the digest')
    expect(existsSync(join(root, 'dsh', 'skills', 'tampered'))).toBe(false)
    await expect(market.addRegistry('nothing.example.com')).rejects.toThrow('publishes no Agent Skills index')
  })

  it('reads an index from before schema 0.2.0 by its listed files', async () => {
    const market = service(web({
      'https://old.example.com/.well-known/agent-skills/index.json': 404,
      'https://old.example.com/.well-known/skills/index.json': JSON.stringify({ skills: [{ name: 'legacy', description: 'Old style.', files: ['SKILL.md', 'notes/a.md', '../escape.md'] }] }),
      'https://old.example.com/.well-known/skills/legacy/SKILL.md': SKILL('legacy'),
      'https://old.example.com/.well-known/skills/legacy/notes/a.md': 'A',
    }))
    const added = await market.addRegistry('https://old.example.com')
    expect(added).toMatchObject({ kind: 'well-known', entries: 1 })
    await market.installMarket(undefined, { registryId: added.id, name: 'legacy' })
    expect(readFileSync(join(root, 'dsh', 'skills', 'legacy', 'notes', 'a.md'), 'utf8')).toBe('A')
  })

  it('unpacks zip archives and refuses paths that leave the skill', () => {
    const files = readArchive(zip({ 'SKILL.md': SKILL('zipped'), 'scripts/run.py': 'print(1)\n'.repeat(50) }), { files: 10, bytes: 1_000_000 })
    expect(files.map(file => [file.path, file.data.byteLength])).toEqual([['SKILL.md', SKILL('zipped').length], ['scripts/run.py', 450]])
    // A wrapping folder is unwrapped; a path out of the skill is refused.
    expect(readArchive(tarGz({ 'pack/SKILL.md': SKILL('wrapped'), 'pack/a.md': 'a' }), { files: 10, bytes: 1_000_000 }).map(file => file.path)).toEqual(['SKILL.md', 'a.md'])
    expect(() => readArchive(tarGz({ 'SKILL.md': SKILL('x'), '../evil.sh': 'rm' }), { files: 10, bytes: 1_000_000 })).toThrow('outside the skill')
    expect(() => readArchive(tarGz({ 'SKILL.md': 'x'.repeat(2_000) }), { files: 10, bytes: 1_000 })).toThrow('more than 1000 bytes')
    expect(() => readArchive(Buffer.from('not an archive'), { files: 10, bytes: 1_000 })).toThrow('.tar.gz or a .zip')
  })

  it('lists every skill a GitHub repository holds, named after its plugin marketplace', async () => {
    const files: Record<string, string> = {
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'acme-tools', owner: { name: 'Acme' }, description: 'Tools from Acme', plugins: [] }),
      'skills/release-notes/SKILL.md': SKILL('release-notes'),
      'skills/release-notes/template.md': 'T',
      'plugins/review/skills/code-review/SKILL.md': SKILL('code-review'),
      'tests/fixtures/broken/SKILL.md': SKILL('fixture-skill'),
      'node_modules/dep/SKILL.md': SKILL('dependency'),
      'docs/SKILL.md': '# not a skill',
    }
    const market = service(github(files))
    const added = await market.addRegistry('https://github.com/acme/tools')
    expect(added).toMatchObject({ kind: 'github', location: 'https://github.com/acme/tools', name: 'acme-tools · acme/tools', description: 'Tools from Acme', entries: 2 })
    await expect(market.addRegistry('acme/tools')).rejects.toThrow('already added')
    const items = market.marketView(undefined).items.filter(item => item.registryId === added.id)
    expect(items.map(item => [item.name, item.source])).toEqual([
      ['release-notes', { type: 'github', repo: 'acme/tools', path: 'skills/release-notes', ref: 'HEAD' }],
      ['code-review', { type: 'github', repo: 'acme/tools', path: 'plugins/review/skills/code-review', ref: 'HEAD' }],
    ])
    await market.installMarket(undefined, { registryId: added.id, name: 'release-notes' })
    expect(readFileSync(join(root, 'dsh', 'skills', 'release-notes', 'template.md'), 'utf8')).toBe('T')
    // A marketplace file by URL is read as the repository it lives in.
    const other = service(github(files))
    expect(await other.addRegistry('https://raw.githubusercontent.com/acme/tools/main/.claude-plugin/marketplace.json')).toMatchObject({ kind: 'github', location: 'https://github.com/acme/tools/tree/main' })
  })

  it('searches skills.sh, previews a find with its reviews, and installs it whole from its repository', async () => {
    const calls: string[] = []
    const repository = github({ 'skills/pdf/SKILL.md': SKILL('pdf'), 'skills/pdf/fonts/a.ttf': 'font', 'skills/docx/SKILL.md': SKILL('docx') }, calls)
    const fetcher: Fetcher = async (url, init) => {
      if (url.startsWith('https://skills.sh/api/search?')) {
        expect(new URL(url).searchParams.get('q')).toBe('pdf')
        return answer(200, JSON.stringify({ skills: [
          { id: 'acme/skills/pdf', source: 'acme/skills', skillId: 'pdf', name: 'pdf', installs: 213790 },
          { id: 'acme/skills/Weird_Name', source: 'acme/skills', skillId: 'Weird_Name', name: 'Weird Name', installs: 5 },
          { id: '../../etc/passwd', source: 'x', skillId: 'x', name: 'x', installs: 1 },
        ] }))
      }
      if (url === 'https://skills.sh/api/v1/skills/audit/acme/skills/pdf') return answer(200, JSON.stringify({ audits: [{ provider: 'Scanner', status: 'warn', summary: 'Runs scripts' }, { provider: 'Trust Hub', status: 'pass', summary: 'Fine' }] }))
      return repository(url, init)
    }
    const market = service(fetcher)
    const found = await market.searchMarket(undefined, 'pdf')
    expect(found.items).toEqual([expect.objectContaining({ name: 'pdf', registryId: 'skills-sh', installs: 213790, origin: 'acme/skills', state: 'available', source: { type: 'indexed', id: 'acme/skills/pdf' } })])
    const preview = await market.marketPreview('skills-sh', 'acme/skills/pdf')
    expect(preview).toMatchObject({ homepage: 'https://github.com/acme/skills/tree/HEAD/skills/pdf', audits: [{ provider: 'Scanner', status: 'warn' }, { provider: 'Trust Hub', status: 'pass' }] })
    expect(preview.files.map(file => file.path).sort()).toEqual(['SKILL.md', 'fonts/a.ttf'])
    const installed = await market.installMarket(undefined, { registryId: 'skills-sh', name: 'acme/skills/pdf' })
    expect(installed.skill.key).toBe('user-dsh:pdf')
    expect(readFileSync(join(root, 'dsh', 'skills', 'pdf', 'fonts', 'a.ttf'), 'utf8')).toBe('font')
    expect((await market.searchMarket(undefined, 'pdf')).items[0]!.state).toBe('installed')
    // The preview and the install read the repository's tree once.
    expect(calls.filter(url => url.includes('/git/trees/'))).toHaveLength(1)
    expect((await market.searchMarket(undefined, 'p')).items).toEqual([])
    await market.toggleRegistry('skills-sh', false)
    expect((await market.searchMarket(undefined, 'pdf')).items).toEqual([])
    await expect(market.removeRegistry('skills-sh')).rejects.toThrow('switched off, not removed')
  })

  it('previews from the skills.sh copy while GitHub declines, and says why it cannot install yet', async () => {
    const market = service(web({
      'https://api.github.com/repos/acme/skills/git/trees/HEAD?recursive=1': 403,
      'https://skills.sh/api/download/acme/skills/pdf': JSON.stringify({ hash: 'h', files: [{ path: 'SKILL.md', contents: SKILL('pdf') }, { path: 'reference.md', contents: 'R' }] }),
    }))
    const preview = await market.marketPreview('skills-sh', 'acme/skills/pdf')
    expect(preview).toMatchObject({ partial: true, audits: [], homepage: 'https://skills.sh/acme/skills/pdf' })
    expect(preview.files.map(file => file.path)).toEqual(['SKILL.md', 'reference.md'])
    await expect(market.installMarket(undefined, { registryId: 'skills-sh', name: 'acme/skills/pdf' })).rejects.toThrow('GITHUB_TOKEN')
    const failed = service(web({ 'https://skills.sh/api/search?q=pdf&limit=30': 429 }))
    expect(await failed.searchMarket(undefined, 'pdf')).toMatchObject({ items: [], error: 'skills.sh is busy; try again in a moment' })
  })

  it('defaults GitHub catalog entries without ref to HEAD, allows up to 4 MiB skill documents, and aborts oversized streams early', async () => {
    const calls: string[] = []
    const largeDoc = SKILL('large-doc', 'x'.repeat(2_500_000))
    const registryPath = join(root, 'custom-registry.json')
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      id: 'custom',
      name: 'Custom',
      skills: [
        { name: 'head-skill', description: 'Default branch HEAD.', source: { type: 'github', repo: 'acme/trunk-repo', path: 'skills/head-skill' } },
        { name: 'large-doc', description: '3 MiB SKILL.md.', source: { type: 'url', url: 'https://example.test/large/SKILL.md' } },
        { name: 'oversized-header', description: 'Too big Content-Length.', source: { type: 'url', url: 'https://example.test/huge/SKILL.md' } },
        { name: 'oversized-stream', description: 'Too big stream.', source: { type: 'url', url: 'https://example.test/stream/SKILL.md' } },
      ],
    }))
    let textCalled = false
    let streamChunksRead = 0
    const fetcher: Fetcher = async url => {
      calls.push(url)
      if (url === 'https://api.github.com/repos/acme/trunk-repo/git/trees/HEAD?recursive=1') {
        return answer(200, JSON.stringify({ truncated: false, tree: [{ path: 'skills/head-skill/SKILL.md', type: 'blob', size: 64 }] }))
      }
      if (url === 'https://raw.githubusercontent.com/acme/trunk-repo/HEAD/skills/head-skill/SKILL.md') {
        return answer(200, SKILL('head-skill'))
      }
      if (url === 'https://example.test/large/SKILL.md') {
        return answer(200, largeDoc)
      }
      if (url === 'https://example.test/huge/SKILL.md') {
        return {
          ok: true,
          status: 200,
          headers: { get: name => name.toLowerCase() === 'content-length' ? String(5 * 1024 * 1024) : null },
          text: async () => { textCalled = true; return '' },
          arrayBuffer: async () => { textCalled = true; return new ArrayBuffer(0) },
        }
      }
      if (url === 'https://example.test/stream/SKILL.md') {
        const chunk = new Uint8Array(1024 * 1024)
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            streamChunksRead += 1
            if (streamChunksRead > 100) controller.close()
            else controller.enqueue(chunk)
          },
        })
        return {
          ok: true,
          status: 200,
          body,
          text: async () => '',
          arrayBuffer: async () => new ArrayBuffer(0),
        }
      }
      return answer(404)
    }
    const market = service(fetcher)
    let rev = market.revision(undefined)
    await market.addRegistry(registryPath)
    expect(market.revision(undefined)).not.toBe(rev)
    rev = market.revision(undefined)

    const preview = await market.marketPreview('custom', 'head-skill')
    expect(preview.content).toContain('name: head-skill')
    await market.installMarket(undefined, { registryId: 'custom', name: 'head-skill' })
    expect(calls.every(url => !url.includes('/main/'))).toBe(true)

    const largePreview = await market.marketPreview('custom', 'large-doc')
    expect(largePreview.content.length).toBe(largeDoc.length)

    await expect(market.marketPreview('custom', 'oversized-header')).rejects.toThrow('larger than 4194304 bytes')
    expect(textCalled).toBe(false)

    await expect(market.marketPreview('custom', 'oversized-stream')).rejects.toThrow('larger than 4194304 bytes')
    expect(streamChunksRead).toBeLessThanOrEqual(6)

    rev = market.revision(undefined)
    await market.toggleRegistry('custom', false)
    expect(market.revision(undefined)).not.toBe(rev)
  })
})
