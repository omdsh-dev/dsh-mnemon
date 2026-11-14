import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertReleaseIntentCoverage, assertVersionedReleaseIntent, introducedPackageBaseVersions } from '../scripts/check-release-intent.mjs'
import { localeExport, readPackageLocales } from '../scripts/package-locales.mjs'
import { packageManagerCommand } from '../scripts/package-manager.mjs'
import {
  assertVersionedPublicationChanges,
  createReleasePlan,
  packRelease,
  publicationInputsChanged,
  publishRelease,
  readChangedPaths,
  readReleaseArtifacts,
  readReleasePackages,
  verifyRegistryRelease,
  waitForRegistryArtifact,
  writeReleaseManifest,
} from '../scripts/release.mjs'
import { syncReleaseMetadata } from '../scripts/sync-release-metadata.mjs'
import { checkDocuments, documentLinks, headingIds, withoutFences } from '../scripts/verify-docs.mjs'

describe('documentation checks', () => {
  const directories = []
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
  function fixture(files) {
    const root = mkdtempSync(join(tmpdir(), 'mnemon-docs-test-'))
    directories.push(root)
    for (const [file, text] of Object.entries(files)) { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
    return checkDocuments(root, Object.keys(files))
  }

  it('keeps line numbers while ignoring backtick and tilde fences', () => {
    expect(withoutFences('a\n```md\n[no](missing)\n```\nb\n~~~\nno\n~~~')).toBe('a\n\n\n\nb\n\n\n')
  })
  it('recognizes Unicode, inline code, links and duplicate headings', () => {
    expect([...headingIds('## 设置：`displayMode`\n## A [link](./b.md)\n## A link\n<a id="explicit"></a>')]).toEqual(['设置displaymode', 'a-link', 'a-link-1', 'explicit'])
  })
  it('recognizes centered HTML headings and entities in document order', () => {
    expect([...headingIds('<h1 align="center">Memory &amp; View</h1>\n## Memory & View\n<h2>中文</h2>')]).toEqual(['memory--view', 'memory--view-1', '中文'])
  })
  it('finds linked images, HTML and reference-style targets without inline-code examples', () => {
    expect(documentLinks('[![x](a.png)](b.md)\n<img src="c.png">\n[x]: d.md\n`[no](missing)`').map(link => link.url).sort()).toEqual(['a.png', 'b.md', 'c.png', 'd.md'])
  })
  it('decodes HTML URL entities once and finds autolinks', () => {
    expect(documentLinks('<img src="https://example.test/badge?metric=downloads&amp;lang=zh">\n[x](./a&#32;b.md)\n<https://example.test/guide>').map(link => link.url)).toEqual(expect.arrayContaining(['https://example.test/badge?metric=downloads&lang=zh', './a b.md', 'https://example.test/guide']))
    expect(documentLinks('<a href="?x=&amp;amp;">').map(link => link.url)).toEqual(['?x=&amp;'])
  })
  it('accepts existing images, directories, encoded paths and local anchors', () => {
    const report = fixture({ 'README.md': '# Home\n[a](#home) [b](./a%20b.md#中文) [c](./dir/) ![d](./dir/a.png)', 'a b.md': '# 中文', 'dir/a.png': 'fixture' })
    expect(report.failures).toEqual([])
    expect(report.anchors).toBe(2)
  })
  it('checks the file and fragment independently of rendering query parameters', () => {
    expect(fixture({ 'README.md': '[a](./a.md?plain=1#中文)', 'a.md': '# 中文' }).failures).toEqual([])
  })
  it('reports missing files and anchors rather than treating them as external', () => {
    const report = fixture({ 'README.md': '[a](./absent.md)\n[b](./a.md#old)', 'a.md': '# New' })
    expect(report.failures).toEqual(['README.md:1: missing ./absent.md', 'README.md:2: missing anchor ./a.md#old'])
  })
  it('reports malformed encoding and missing translation files', () => {
    const report = fixture({ 'docs/en/page.md': '[bad](./%ZZ.md)' })
    expect(report.failures).toHaveLength(2)
    expect(report.failures[1]).toContain('docs/zh-CN/page.md')
  })
  it('does not make network availability a local documentation requirement', () => {
    expect(fixture({ 'README.md': '[web](https://example.invalid/x#y) [mail](mailto:a@example.invalid)' }).failures).toEqual([])
  })
  it('checks current repository URLs used in npm READMEs without rewriting historical links', () => {
    const report = fixture({ 'README.md': '[ok](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/a.md#one) [missing](https://github.com/omdsh-dev/dsh-mnemon/tree/main/absent) [history](https://github.com/omdsh-dev/dsh-mnemon/blob/v0.4.0/old.md)', 'docs/a.md': '# One' })
    expect(report.localLinks).toBe(2)
    expect(report.failures).toEqual(['README.md:1: missing https://github.com/omdsh-dev/dsh-mnemon/tree/main/absent'])
  })
  it.each([['README.md', 'en'], ['README.zh-CN.md', 'zh-CN']])('retains the centered %s header, seven badges and localized diagram', (file, language) => {
    const readme = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const header = readme.split('\n## ')[0]
    expect(header).toMatch(/^<h1 align="center">dsh-mnemon<\/h1>/u)
    expect([...header.matchAll(/<p align="center">/gu)]).toHaveLength(6)
    const images = [...header.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gu)].map(match => new URL(match[1].replaceAll('&amp;', '&')))
    const badges = images.filter(url => ['img.shields.io', 'dshfind.com'].includes(url.hostname))
    expect(badges).toHaveLength(7)
    expect(badges.map(url => url.pathname)).toEqual(expect.arrayContaining(['/npm/v/dsh-mnemon', '/npm/dt/dsh-mnemon', '/github/v/release/omdsh-dev/dsh-mnemon', '/github/stars/omdsh-dev/dsh-mnemon', '/badge/License-MIT-yellow.svg']))
    const catalog = badges.filter(url => url.hostname === 'dshfind.com')
    expect(catalog.map(url => url.searchParams.get('lang'))).toEqual([language === 'en' ? 'en' : 'zh', language === 'en' ? 'en' : 'zh'])
    expect(catalog.some(url => url.searchParams.get('metric') === 'downloads')).toBe(true)
    expect(readme).toContain(`/docs/assets/diagrams/${language}/composable-memory.png`)
  })
})

describe('published DSH locale metadata', () => {
  const temporary = []
  afterEach(() => {
    for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function fixture({ exports = { [localeExport]: localeExport }, locales = { 'en.json': { meta: {} } } } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-package-locales-'))
    temporary.push(directory)
    const manifest = { name: 'mnemon-locale-fixture', type: 'module', exports }
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
    mkdirSync(join(directory, 'locale'))
    for (const [filename, dictionary] of Object.entries(locales)) {
      writeFileSync(join(directory, 'locale', filename), JSON.stringify(dictionary))
    }
    return { directory, manifest, read: () => readPackageLocales(directory, manifest) }
  }

  it('resolves concrete locale resources while allowing the English manifest fallback', () => {
    const english = { meta: {} }
    const chinese = { meta: { title: '三级记忆', description: '召回与写入' } }
    const packageFixture = fixture({ locales: { 'zh.json': chinese, 'en.json': english } })
    expect(packageFixture.read()).toEqual([
      { path: 'locale/en.json', dictionary: english },
      { path: 'locale/zh.json', dictionary: chinese },
    ])
  })

  it('allows ordinary dictionaries without metadata and packages without locale exports', () => {
    expect(fixture({ locales: { 'en.json': { greeting: 'Hello' } } }).read()).toEqual([
      { path: 'locale/en.json', dictionary: { greeting: 'Hello' } },
    ])
    expect(fixture({ exports: {} }).read()).toEqual([])
  })

  it('rejects a locale export mapped outside its declared resource directory', () => {
    const packageFixture = fixture({ exports: { [localeExport]: './assets/*.json' } })
    expect(packageFixture.read).toThrow('Locale exports must resolve inside ./locale/')
  })

  it('rejects a concrete export that overrides the wildcard with a different resource', () => {
    const packageFixture = fixture({ exports: {
      [localeExport]: localeExport,
      './locale/en.json': './other-en.json',
    } })
    writeFileSync(join(packageFixture.directory, 'other-en.json'), '{"meta":{}}')
    expect(packageFixture.read).toThrow("locale/en.json must resolve to the package's own resource")
  })

  it('rejects a locale set that DSH cannot discover because en.json is absent', () => {
    const packageFixture = fixture({ locales: { 'zh.json': { meta: { title: '三级记忆' } } } })
    expect(packageFixture.read).toThrow('DSH metadata requires locale/en.json')
  })

  it('rejects directories masquerading as locale files and malformed locale names', () => {
    const directoryFixture = fixture()
    mkdirSync(join(directoryFixture.directory, 'locale/zh.json'))
    expect(directoryFixture.read).toThrow('Invalid locale resource: zh.json')
    const nameFixture = fixture({ locales: { 'en.json': {}, 'zh_CN.json': {} } })
    expect(nameFixture.read).toThrow('Invalid locale resource: zh_CN.json')
  })

  it('rejects malformed JSON instead of silently using the manifest fallback', () => {
    const packageFixture = fixture()
    writeFileSync(join(packageFixture.directory, 'locale/en.json'), '{"meta":')
    expect(packageFixture.read).toThrow(SyntaxError)
  })

  it.each([null, [], 'translation', 42])('rejects a non-object dictionary: %j', dictionary => {
    expect(fixture({ locales: { 'en.json': dictionary } }).read).toThrow('locale/en.json must contain an object')
  })

  it.each([null, [], 'translation', 42])('rejects a non-object meta field: %j', meta => {
    expect(fixture({ locales: { 'en.json': { meta } } }).read).toThrow('locale/en.json: meta must be an object')
  })

  it.each([
    ['title', ''], ['title', '   '], ['title', 42], ['title', null],
    ['description', ''], ['description', '\n\t'], ['description', false], ['description', {}],
  ])('rejects an unusable meta.%s value: %j', (field, value) => {
    const packageFixture = fixture({ locales: { 'en.json': { meta: { [field]: value } } } })
    expect(packageFixture.read).toThrow(`locale/en.json: meta.${field} must be a non-empty string`)
  })
})

describe('package manager command', () => {
  it('runs a JavaScript package manager entry through Node', () => {
    for (const entry of [
      '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs',
      '/opt/corepack/dist/pnpm.js',
      'C:\\Program Files\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs',
    ]) {
      expect(packageManagerCommand({ npm_execpath: entry })).toEqual({ command: process.execPath, args: [entry] })
    }
  })

  it('runs a standalone package manager executable directly', () => {
    for (const entry of [
      '/home/user/.local/share/pnpm/pnpm',
      '/home/user/.local/bin/pnpm',
      'C:\\tools\\pnpm\\pnpm.exe',
    ]) {
      expect(packageManagerCommand({ npm_execpath: entry })).toEqual({ command: entry, args: [] })
    }
  })

  it('requires the package manager environment', () => {
    expect(() => packageManagerCommand({})).toThrow('Run this check through the package manager')
    expect(() => packageManagerCommand({ npm_execpath: '' })).toThrow('Run this check through the package manager')
  })
})

describe('independent package versioning', () => {
  const execute = promisify(execFile)
  const require = createRequire(import.meta.url)
  const changesetBin = require.resolve('@changesets/cli/bin.js')
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))

  async function json(path, value) {
    await writeFile(path, JSON.stringify(value, null, 2) + '\n')
  }

  function published(name, version, extra = {}) {
    return { name, version, publishConfig: { access: 'public', tag: 'latest' }, ...extra }
  }

  it('bumps one changed plugin and the exact aggregate without republishing compatible peers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mnemon-changesets-'))
    const sourceName = 'dsh-mnemon-source-memory-spaces'
    const changedName = 'dsh-mnemon-provider-changed'
    const unchangedName = 'dsh-mnemon-provider-unchanged'
    try {
      await mkdir(join(directory, '.changeset'), { recursive: true })
      await mkdir(join(directory, 'plugins', sourceName), { recursive: true })
      await mkdir(join(directory, 'plugins', changedName), { recursive: true })
      await mkdir(join(directory, 'plugins', unchangedName), { recursive: true })
      await writeFile(join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - .\n  - plugins/*\n')
      await writeFile(join(directory, '.changeset/config.json'), await readFile(join(repositoryRoot, '.changeset/config.json'), 'utf8'))
      await writeFile(join(directory, '.changeset/one-plugin.md'), `---\n"${changedName}": patch\n---\n\nFix one Provider.\n`)
      await json(join(directory, 'package.json'), published('dsh-mnemon', '0.5.1', {
        dependencies: { [sourceName]: '0.5.1', [changedName]: '0.5.1', [unchangedName]: '0.5.1' },
      }))
      await json(join(directory, 'plugins', sourceName, 'package.json'), published(sourceName, '0.5.1', {
        peerDependencies: { 'dsh-mnemon': '^0.5.0' },
        devDependencies: { 'dsh-mnemon': '^0.5.0', [changedName]: '^0.5.0', [unchangedName]: '^0.5.0' },
      }))
      await json(join(directory, 'plugins', changedName, 'package.json'), published(changedName, '0.5.1', {
        peerDependencies: { [sourceName]: '^0.5.0' },
        devDependencies: { [sourceName]: '^0.5.0' },
      }))
      await json(join(directory, 'plugins', unchangedName, 'package.json'), published(unchangedName, '0.5.1', {
        peerDependencies: { [sourceName]: '^0.5.0' },
        devDependencies: { [sourceName]: '^0.5.0' },
      }))

      await execute(process.execPath, [changesetBin, 'version'], { cwd: directory })

      const starter = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      const source = JSON.parse(await readFile(join(directory, 'plugins', sourceName, 'package.json'), 'utf8'))
      const changed = JSON.parse(await readFile(join(directory, 'plugins', changedName, 'package.json'), 'utf8'))
      const unchanged = JSON.parse(await readFile(join(directory, 'plugins', unchangedName, 'package.json'), 'utf8'))
      expect(starter.version).toBe('0.5.2')
      expect(starter.dependencies).toEqual({ [sourceName]: '0.5.1', [changedName]: '0.5.2', [unchangedName]: '0.5.1' })
      expect(changed.version).toBe('0.5.2')
      expect(source).toMatchObject({
        version: '0.5.1',
        peerDependencies: { 'dsh-mnemon': '^0.5.0' },
        devDependencies: { 'dsh-mnemon': '^0.5.0', [changedName]: '^0.5.0', [unchangedName]: '^0.5.0' },
      })
      expect(unchanged).toMatchObject({
        version: '0.5.1',
        peerDependencies: { [sourceName]: '^0.5.0' },
        devDependencies: { [sourceName]: '^0.5.0' },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts a release PR that consumed its changesets and rejects incomplete version coverage', () => {
    const pluginName = 'dsh-mnemon-source-example'
    const packages = [
      {
        directory: `/fixture/plugins/${pluginName}`,
        manifest: published(pluginName, '0.5.2', { peerDependencies: { 'dsh-mnemon': '^0.5.1' } }),
      },
      {
        directory: '/fixture',
        manifest: published('dsh-mnemon', '0.5.2', { dependencies: { [pluginName]: '0.5.2' } }),
      },
    ]
    const plan = createReleasePlan(packages, { baseVersions: new Map([
      ['dsh-mnemon', '0.5.1'],
      [pluginName, '0.5.1'],
    ]) })
    const paths = ['package.json', `plugins/${pluginName}/package.json`]

    expect(() => assertVersionedReleaseIntent(plan, paths, { ignoredPackageJson: new Set() }, [])).not.toThrow()
    expect(() => assertVersionedReleaseIntent(plan, paths, { ignoredPackageJson: new Set() }, ['pending.md']))
      .toThrow(/still contains pending changesets/u)

    const incompletePackages = packages.map(item => item.manifest.name === pluginName
      ? { ...item, manifest: { ...item.manifest, version: '0.5.1' } }
      : { ...item, manifest: { ...item.manifest, dependencies: { [pluginName]: '0.5.1' } } })
    const incompletePlan = createReleasePlan(incompletePackages, { baseVersions: new Map([
      ['dsh-mnemon', '0.5.1'],
      [pluginName, '0.5.1'],
    ]) })
    expect(() => assertVersionedReleaseIntent(incompletePlan, paths, { ignoredPackageJson: new Set() }, []))
      .toThrow(/without a version bump: dsh-mnemon-source-example/u)
  })

  it('asks an introduced package for a release intent without turning the change into a release', () => {
    const introduced = 'dsh-mnemon-strategy-example'
    const packages = [
      {
        directory: `/fixture/plugins/${introduced}`,
        manifest: published(introduced, '0.5.0', { peerDependencies: { 'dsh-mnemon': '^0.5.1' } }),
      },
      {
        directory: '/fixture',
        manifest: published('dsh-mnemon', '0.5.1', { dependencies: { [introduced]: '0.5.0' } }),
      },
    ]
    const baseVersions = new Map([['dsh-mnemon', '0.5.1']])
    expect(() => createReleasePlan(packages, { baseVersions })).toThrow(/Starter version must advance/u)

    const plan = createReleasePlan(packages, { baseVersions: introducedPackageBaseVersions(packages, baseVersions) })
    expect(plan.releasePackages).toEqual([])
    const changed = publicationInputsChanged(plan, ['package.json', `plugins/${introduced}/package.json`, `plugins/${introduced}/src/index.ts`])
    expect([...changed].sort()).toEqual(['dsh-mnemon', introduced])
    expect(() => assertReleaseIntentCoverage(changed, [{ name: 'dsh-mnemon', type: 'patch' }])).toThrow(introduced)
    expect(() => assertReleaseIntentCoverage(changed, [{ name: 'dsh-mnemon', type: 'patch' }, { name: introduced, type: 'patch' }])).not.toThrow()
  })
})

describe('selective, channel-safe official release and metadata sync', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const revision = '1'.repeat(40)
  const baseRevision = '2'.repeat(40)

  function tag(version) {
    return version.match(/-(alpha|beta|rc)\./)?.[1] ?? 'latest'
  }

  function item(directory, name, version, extra = {}) {
    return { directory, manifest: { name, version, publishConfig: { access: 'public', tag: tag(version) }, ...extra } }
  }

  function fixture({
    starterVersion = '0.5.2',
    sourceVersion = '0.5.0',
    providerVersion = '0.5.1',
    secondProviderVersion,
  } = {}) {
    const source = item('/source', 'dsh-mnemon-source-memory-spaces', sourceVersion, {
      peerDependencies: { 'dsh-mnemon': '^0.5.0' },
    })
    const providers = [item('/provider', 'dsh-mnemon-provider-example', providerVersion, {
      peerDependencies: { 'dsh-mnemon-source-memory-spaces': '^0.5.0' },
    })]
    if (secondProviderVersion !== undefined) providers.push(item('/provider-two', 'dsh-mnemon-provider-second', secondProviderVersion, {
      peerDependencies: { 'dsh-mnemon-source-memory-spaces': '^0.5.0' },
    }))
    const dependencies = Object.fromEntries([source, ...providers].map(packageItem => [packageItem.manifest.name, packageItem.manifest.version]))
    const starter = item('/starter', 'dsh-mnemon', starterVersion, { dependencies })
    return [starter, source, ...providers]
  }

  function previousVersions(packages, overrides = {}) {
    return new Map(packages.map(packageItem => [packageItem.manifest.name,
      overrides[packageItem.manifest.name] ?? packageItem.manifest.version]))
  }

  function artifactFor(packageItem) {
    return {
      name: packageItem.manifest.name,
      version: packageItem.manifest.version,
      filename: join('/artifacts', `${packageItem.manifest.name}-${packageItem.manifest.version}.tgz`),
      integrity: `sha512-${packageItem.manifest.name}-${packageItem.manifest.version}`,
    }
  }

  it('validates every real package without requiring one shared version', async () => {
    const packages = await readReleasePackages(root)
    const plan = createReleasePlan(packages)
    expect(plan.composition).toHaveLength(19)
    expect(plan.distTag).toBe('latest')
    expect(plan.composition.at(-1).manifest.name).toBe('dsh-mnemon')
    for (const { directory, manifest } of packages.filter(packageItem => packageItem.manifest.name.startsWith('dsh-mnemon-provider-'))) {
      const source = await readFile(join(directory, 'src/index.ts'), 'utf8')
      expect(source).toContain(`version: '${manifest.version}'`)
    }
  })

  it('selects one changed plugin plus the aggregate Starter and reuses unchanged versions', () => {
    const packages = fixture()
    const baseVersions = previousVersions(packages, {
      'dsh-mnemon': '0.5.1',
      'dsh-mnemon-provider-example': '0.5.0',
    })
    const plan = createReleasePlan(packages, { baseVersions })
    expect(plan.composition.map(packageItem => `${packageItem.manifest.name}@${packageItem.manifest.version}`)).toEqual([
      'dsh-mnemon-provider-example@0.5.1',
      'dsh-mnemon-source-memory-spaces@0.5.0',
      'dsh-mnemon@0.5.2',
    ])
    expect(plan.releasePackages.map(packageItem => packageItem.manifest.name)).toEqual([
      'dsh-mnemon-provider-example',
      'dsh-mnemon',
    ])
  })

  it('requires the Starter snapshot to advance with a plugin and rejects incompatible internal ranges', () => {
    const packages = fixture({ starterVersion: '0.5.1' })
    const baseVersions = previousVersions(packages, { 'dsh-mnemon-provider-example': '0.5.0' })
    expect(() => createReleasePlan(packages, { baseVersions })).toThrow('Starter version must advance')

    const exactPeer = fixture()
    exactPeer[1].manifest.peerDependencies['dsh-mnemon'] = '0.5.2'
    expect(() => createReleasePlan(exactPeer)).toThrow('must declare a compatible range')

    const stalePeer = fixture()
    stalePeer[2].manifest.peerDependencies['dsh-mnemon-source-memory-spaces'] = '^0.4.0'
    expect(() => createReleasePlan(stalePeer)).toThrow('does not accept')

    const stalePin = fixture()
    stalePin[0].manifest.dependencies['dsh-mnemon-provider-example'] = '0.5.0'
    expect(() => createReleasePlan(stalePin)).toThrow('pin the tested plugin version')
  })

  it.each([
    ['0.5.2', 'latest', false],
    ['0.5.2-beta.1', 'beta', true],
    ['0.5.2-rc.1', 'rc', true],
  ])('selects the explicit Starter channel for %s', (version, channel, prerelease) => {
    const packages = fixture({ starterVersion: version, providerVersion: version })
    expect(createReleasePlan(packages, { tag: `v${version}`, prerelease }).distTag).toBe(channel)
  })

  it('rejects tag, prerelease, package channel and version regressions before packing', () => {
    expect(() => createReleasePlan(fixture(), { tag: 'v0.4.0' })).toThrow('Release tag')
    expect(() => createReleasePlan(fixture({ starterVersion: '0.5.2-rc.1', providerVersion: '0.5.2-rc.1' }), { prerelease: false })).toThrow('prerelease flag')
    const wrongChannel = fixture()
    wrongChannel[2].manifest.publishConfig.tag = 'beta'
    expect(() => createReleasePlan(wrongChannel)).toThrow('publishConfig.tag')
    const packages = fixture()
    expect(() => createReleasePlan(packages, { baseVersions: previousVersions(packages, { 'dsh-mnemon': '0.5.3' }) })).toThrow('version must advance')
  })

  it('orders changed dependencies before dependents while leaving unrelated plugins in one layer', () => {
    const packages = fixture({ sourceVersion: '0.5.1', secondProviderVersion: '0.5.1' })
    const plan = createReleasePlan(packages, { baseVersions: previousVersions(packages, {
      'dsh-mnemon': '0.5.1',
      'dsh-mnemon-source-memory-spaces': '0.5.0',
      'dsh-mnemon-provider-example': '0.5.0',
      'dsh-mnemon-provider-second': '0.5.0',
    }) })
    expect(plan.pluginLayers.map(layer => layer.map(packageItem => packageItem.manifest.name))).toEqual([
      ['dsh-mnemon-source-memory-spaces'],
      ['dsh-mnemon-provider-example', 'dsh-mnemon-provider-second'],
    ])
    expect(plan.releasePackages.at(-1).manifest.name).toBe('dsh-mnemon')
  })

  it('requires every changed publication input to have an advanced package version', () => {
    const packages = fixture()
    const plan = createReleasePlan(packages, { baseVersions: previousVersions(packages, {
      'dsh-mnemon': '0.5.1',
      'dsh-mnemon-provider-example': '0.5.0',
    }) })
    expect(publicationInputsChanged(plan, [
      'plugins/dsh-mnemon-provider-example/src/index.ts',
      'plugins/dsh-mnemon-source-memory-spaces/tests/source.spec.ts',
      '.github/workflows/ci.yml',
      'src/index.ts',
    ])).toEqual(new Set(['dsh-mnemon-provider-example', 'dsh-mnemon']))
    expect(publicationInputsChanged(plan, ['bin/repair-legacy-session.mjs'])).toEqual(new Set(['dsh-mnemon']))
    expect(() => assertVersionedPublicationChanges(plan, ['plugins/dsh-mnemon-source-memory-spaces/src/source.ts']))
      .toThrow('dsh-mnemon-source-memory-spaces')
    expect(() => assertVersionedPublicationChanges(plan, ['plugins/dsh-mnemon-source-memory-spaces/tests/source.spec.ts']))
      .not.toThrow()
    expect(() => assertVersionedPublicationChanges(plan, ['plugins/dsh-mnemon-source-memory-spaces/package.json'], {
      ignoredPackageJson: new Set(['dsh-mnemon-source-memory-spaces']),
    })).not.toThrow()
  })

  it('includes deleted files when discovering changed publication inputs', async () => {
    const run = vi.fn(async args => args[0] === 'diff' ? 'src/removed.ts\n' : '')
    await expect(readChangedPaths(baseRevision, revision, run)).resolves.toEqual(['src/removed.ts'])
    expect(run.mock.calls.at(-1)[0]).toEqual([
      'diff', '--name-only', '--diff-filter=ACMRD', baseRevision, revision, '--',
    ])
  })

  it('requires release intent and a Starter version bump for locale-only changes', () => {
    const packages = fixture()
    const plan = createReleasePlan(packages, { baseVersions: previousVersions(packages) })
    const paths = ['locale/zh.json']
    const changed = publicationInputsChanged(plan, paths)
    expect(changed).toEqual(new Set(['dsh-mnemon']))
    expect(() => assertReleaseIntentCoverage(changed, [])).toThrow('dsh-mnemon')
    expect(() => assertVersionedPublicationChanges(plan, paths)).toThrow('dsh-mnemon')
    const release = createReleasePlan(packages, { baseVersions: previousVersions(packages, { 'dsh-mnemon': '0.5.1' }) })
    expect(() => assertVersionedPublicationChanges(release, paths)).not.toThrow()
  })

  it('requires a changeset for every package with changed publication inputs', () => {
    const changed = new Set(['dsh-mnemon', 'dsh-mnemon-provider-example'])
    expect(() => assertReleaseIntentCoverage(changed, [{ name: 'dsh-mnemon', type: 'patch' }]))
      .toThrow('dsh-mnemon-provider-example')
    expect(() => assertReleaseIntentCoverage(changed, [
      { name: 'dsh-mnemon', type: 'patch' },
      { name: 'dsh-mnemon-provider-example', type: 'patch' },
    ])).not.toThrow()
  })

  it('packs only selected versions and freezes the full mixed-version composition', async () => {
    const packages = fixture()
    const plan = createReleasePlan(packages, { baseVersions: previousVersions(packages, {
      'dsh-mnemon': '0.5.1',
      'dsh-mnemon-provider-example': '0.5.0',
    }) })
    const destination = await mkdtemp(join(tmpdir(), 'mnemon-release-test-'))
    const calls = []
    const run = vi.fn(async (args, cwd) => {
      calls.push([args, cwd])
      const packageItem = plan.releasePackages.find(candidate => candidate.directory === cwd)
      const filename = `${packageItem.manifest.name}-${packageItem.manifest.version}.tgz`
      await writeFile(join(destination, filename), `${packageItem.manifest.name}@${packageItem.manifest.version}`)
      return JSON.stringify([{
        name: packageItem.manifest.name,
        version: packageItem.manifest.version,
        filename,
        files: [{ path: 'LICENSE' }],
      }])
    })
    try {
      const artifacts = await packRelease(plan, destination, run)
      expect(calls.map(([, cwd]) => cwd)).toEqual(['/provider', '/starter'])
      expect(artifacts.map(artifact => `${artifact.name}@${artifact.version}`)).toEqual([
        'dsh-mnemon-provider-example@0.5.1',
        'dsh-mnemon@0.5.2',
      ])
      const manifest = await writeReleaseManifest(plan, artifacts, destination, { revision, baseRevision })
      expect(manifest.schemaVersion).toBe(2)
      expect(manifest.composition).toEqual([
        { name: 'dsh-mnemon-provider-example', version: '0.5.1' },
        { name: 'dsh-mnemon-source-memory-spaces', version: '0.5.0' },
        { name: 'dsh-mnemon', version: '0.5.2' },
      ])
      await expect(readReleaseArtifacts(plan, destination, { revision, baseRevision })).resolves.toHaveLength(2)
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('submits independent plugins concurrently, waits for their cohort and never includes the Starter', async () => {
    const packages = fixture({ secondProviderVersion: '0.5.1' })
    const plan = createReleasePlan(packages, { baseVersions: previousVersions(packages, {
      'dsh-mnemon': '0.5.1',
      'dsh-mnemon-provider-example': '0.5.0',
      'dsh-mnemon-provider-second': '0.5.0',
    }) })
    const artifacts = plan.releasePackages.map(artifactFor)
    const published = new Set()
    let active = 0
    let maximumActive = 0
    const run = vi.fn(async args => {
      if (args[0] !== 'publish') return ''
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      const artifact = artifacts.find(candidate => candidate.filename === args[1])
      published.add(artifact.name)
      active -= 1
      return ''
    })
    const inspect = vi.fn(async (name, version) => published.has(name)
      ? { version, integrity: artifacts.find(artifact => artifact.name === name).integrity }
      : null)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await publishRelease(plan, artifacts, run, { scope: 'plugins', inspect, provenance: false, concurrency: 2 })
    } finally {
      log.mockRestore()
    }
    expect(maximumActive).toBe(2)
    expect(published).toEqual(new Set(['dsh-mnemon-provider-example', 'dsh-mnemon-provider-second']))
    expect(run.mock.calls.flatMap(([args]) => args).join(' ')).not.toContain('/artifacts/dsh-mnemon-0.5.2.tgz')
  })

  it('resumes only when an existing selected artifact matches the frozen bytes', async () => {
    const packages = fixture()
    const plan = createReleasePlan(packages, { baseVersions: previousVersions(packages, {
      'dsh-mnemon': '0.5.1',
      'dsh-mnemon-provider-example': '0.5.0',
    }) })
    const artifacts = plan.releasePackages.map(artifactFor)
    const run = vi.fn(async () => '')
    const inspect = vi.fn(async (name, version) => ({ version, integrity: artifacts.find(artifact => artifact.name === name).integrity }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try { await publishRelease(plan, artifacts, run, { inspect, provenance: false }) } finally { log.mockRestore() }
    expect(run).not.toHaveBeenCalled()
    await expect(publishRelease(plan, artifacts, run, {
      inspect: async (name, version) => ({ name, version, integrity: 'sha512-different' }),
      provenance: false,
    })).rejects.toThrow('different Registry artifact')
  })

  it('allows Registry metadata to become readable after the old twelve-attempt window', async () => {
    const expected = { name: 'dsh-mnemon-provider-example', version: '0.5.1', integrity: 'sha512-example' }
    const inspect = vi.fn(async () => inspect.mock.calls.length < 14 ? null : {
      version: expected.version,
      integrity: expected.integrity,
    })
    await expect(waitForRegistryArtifact(expected, 'https://registry.example.test', vi.fn(), inspect, 30, 0)).resolves.toEqual({
      version: expected.version,
      integrity: expected.integrity,
    })
    expect(inspect).toHaveBeenCalledTimes(14)
  })

  it('installs the frozen Starter and verifies every mixed-version Registry package', async () => {
    const packages = fixture()
    const plan = createReleasePlan(packages, { baseVersions: previousVersions(packages, {
      'dsh-mnemon': '0.5.1',
      'dsh-mnemon-provider-example': '0.5.0',
    }) })
    const artifacts = plan.releasePackages.map(artifactFor)
    const run = vi.fn(async (args, directory) => {
      expect(args[0]).toBe('install')
      for (const packageItem of plan.composition) {
        const packageDirectory = join(directory, 'node_modules', packageItem.manifest.name)
        await mkdir(packageDirectory, { recursive: true })
        await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
          name: packageItem.manifest.name,
          version: packageItem.manifest.version,
        }))
      }
      return ''
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await verifyRegistryRelease(plan, artifacts, run, {
        scope: 'plugins',
        inspect: async (name, version) => ({
          version,
          integrity: artifacts.find(artifact => artifact.name === name)?.integrity ?? `registry-${name}`,
        }),
      })
    } finally {
      log.mockRestore()
    }
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0]).toContain(`file:${artifacts.find(artifact => artifact.name === 'dsh-mnemon').filename}`)
  })

  it('keeps the workflow frozen, selective, dependency-ordered and Starter-last', async () => {
    const workflow = await readFile(join(root, '.github/workflows/publish.yml'), 'utf8')
    expect(workflow).toContain('RELEASE_BASE_REVISION')
    expect(workflow).toContain('node scripts/release.mjs --publish-plugins')
    expect(workflow).toContain('node scripts/release.mjs --verify-plugins')
    expect(workflow).toContain('node scripts/release.mjs --publish-starter')
    expect(workflow.indexOf('--publish-plugins')).toBeLessThan(workflow.indexOf('--publish-starter'))
    expect(workflow.indexOf('--publish-starter')).toBeLessThan(workflow.indexOf('gh release create'))
    expect(workflow).not.toContain('seventeen-artifact')
    expect(workflow).not.toContain('sixteen plugins serially')
  })

  it('upgrades from the same earlier release in verification and in publication', async () => {
    const workflow = await readFile(join(root, '.github/workflows/publish.yml'), 'utf8')
    const verifier = await readFile(join(root, 'scripts/verify-plugin-artifacts.mjs'), 'utf8')
    const published = /--upgrade-from dsh-mnemon@(\d+\.\d+\.\d+)/u.exec(workflow)?.[1]
    const verified = /const upgradeBase = '(\d+\.\d+\.\d+)'/u.exec(verifier)?.[1]
    expect(verified).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(published).toBe(verified)
  })

  it('updates exact aggregate/fixture pins and generated provider versions without narrowing workspace ranges', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mnemon-release-sync-'))
    const providerName = 'dsh-mnemon-provider-example'
    const providerDirectory = join(directory, 'plugins', providerName)
    try {
      await mkdir(join(providerDirectory, 'src'), { recursive: true })
      await mkdir(join(directory, 'scripts/fixtures/plugin-consumer'), { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({
        name: 'dsh-mnemon', version: '0.5.3', dependencies: { [providerName]: '0.5.1' }, publishConfig: { access: 'public', tag: 'latest' },
      }, null, 2) + '\n')
      await writeFile(join(providerDirectory, 'package.json'), JSON.stringify({
        name: providerName,
        version: '0.5.2',
        peerDependencies: { 'dsh-mnemon': '^0.5.0' },
        devDependencies: { 'dsh-mnemon': '^0.5.0' },
        publishConfig: { access: 'public', tag: 'latest' },
      }, null, 2) + '\n')
      await writeFile(join(providerDirectory, 'src/index.ts'), `export const value = { packageName: '${providerName}', version: '0.5.1' }\n`)
      await writeFile(join(directory, 'scripts/fixtures/plugin-consumer/package.json'), JSON.stringify({
        name: 'consumer', private: true, dependencies: { 'dsh-mnemon': '0.5.1', [providerName]: '0.5.1' },
      }, null, 2) + '\n')

      await syncReleaseMetadata(directory)

      const starter = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      const provider = JSON.parse(await readFile(join(providerDirectory, 'package.json'), 'utf8'))
      const consumer = JSON.parse(await readFile(join(directory, 'scripts/fixtures/plugin-consumer/package.json'), 'utf8'))
      expect(starter.dependencies[providerName]).toBe('0.5.2')
      expect(provider.peerDependencies['dsh-mnemon']).toBe('^0.5.0')
      expect(provider.devDependencies['dsh-mnemon']).toBe('^0.5.0')
      expect(await readFile(join(providerDirectory, 'src/index.ts'), 'utf8')).toContain("version: '0.5.2'")
      expect(consumer.dependencies).toEqual({ 'dsh-mnemon': '0.5.3', [providerName]: '0.5.2' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('advisory issue template checks', () => {
  const workflow = readFileSync(new URL('../.github/workflows/issue-template-enforcer.yml', import.meta.url), 'utf8')
  const script = workflow.match(/^          script: \|\n((?: {12}.*\n|\n)*)/m)?.[1]
  if (!script) throw new Error('Issue template workflow must contain an inline script')
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const runWorkflow = new AsyncFunction('context', 'github', script.replace(/^ {12}/gm, ''))

  const baseSections = [
    ['提交前查重 / Duplicate check', '- [x] I searched open and closed issues.'],
    ['涉及区域 / Affected area', '运行时记忆 / Runtime Memory'],
    ['Issue 类型 / Issue type', 'Bug 报告 / Bug report'],
    ['摘要 / Summary', 'Archiving fails after runtime memory reaches its capacity.'],
    ['预期结果 / Expected outcome', 'Archive the entries and complete the write.'],
    ['详情或复现步骤 / Details or reproduction steps', 'Fill runtime memory and add another entry. The write fails.'],
    ['环境信息 / Environment', 'macOS, Node.js 24, two active Memory Spaces.'],
  ]
  const body = sections => sections.map(([heading, value]) => `### ${heading}\n\n${value}`).join('\n\n')
  const bugBody = body(baseSections)
  const questionBody = bugBody.replace('Bug 报告 / Bug report', '问题 / Question')
  const issue = (overrides = {}) => ({ number: 235, state: 'open', body: bugBody, labels: [{ name: 'bug' }], ...overrides })
  const missingLabel = () => issue({ labels: [] })
  const incomplete = () => issue({ body: bugBody.replace(baseSections[6][1], '_No response_') })
  const marker = '<!-- dsh-mnemon:issue-template-check -->'
  const botComment = commentBody => ({ id: 123, body: commentBody, user: { login: 'github-actions[bot]', type: 'Bot' } })
  const checks = []

  afterEach(() => {
    for (const check of checks.splice(0)) {
      expect(check.update, 'template checks must never change issue state').not.toHaveBeenCalled()
    }
  })

  function harness(eventIssue, { snapshots = [eventIssue], comments = [], action = 'opened' } = {}) {
    let reads = 0
    const get = vi.fn(async () => {
      const snapshot = snapshots[Math.min(reads++, snapshots.length - 1)]
      if (snapshot instanceof Error) throw snapshot
      return { data: structuredClone(snapshot) }
    })
    const update = vi.fn(async () => ({ data: {} }))
    const addLabels = vi.fn(async () => ({ data: [{ name: 'bug' }] }))
    const createComment = vi.fn(async () => ({ data: {} }))
    const updateComment = vi.fn(async () => ({ data: {} }))
    const listComments = vi.fn(async () => ({ data: comments }))
    const paginate = vi.fn(async (method, params) => (await method(params)).data)
    const context = { repo: { owner: 'omdsh-dev', repo: 'dsh-mnemon' }, payload: { issue: eventIssue, action } }
    const check = {
      get, update, addLabels, createComment, updateComment, listComments, paginate,
      run: () => runWorkflow(context, { paginate, rest: { issues: { get, update, addLabels, createComment, updateComment, listComments } } }),
    }
    checks.push(check)
    return check
  }

  it('accepts a report without separate evidence, smoke tests, code references or a patch', async () => {
    const check = harness(issue())
    await check.run()
    expect(check.createComment).not.toHaveBeenCalled()
    expect(check.addLabels).not.toHaveBeenCalled()
  })

  it.each([
    ['JSON logs (#210)', '```json\n{"code":"CONTEXT_WINDOW_EXCEEDED","n_prompt_tokens":145508,"n_ctx":98304}\n```'],
    ['plain-text errors (#217)', 'Error: Multiple memory entries contain "X"; use a unique substring.'],
    ['short errors', 'Error: X'],
    ['other code block languages', '```typescript\nthrow new Error("Failed to archive")\n```'],
  ])('accepts %s as supporting information', async (_name, evidence) => {
    const check = harness(issue({ body: body([...baseSections, ['Bug 证据 / Bug evidence', evidence]]) }))
    await check.run()
    expect(check.createComment).not.toHaveBeenCalled()
  })

  it('accepts evidence in the reproduction steps without repeating it in another section (#211)', async () => {
    const reproduction = baseSections.map(([heading, value]) => [heading, heading === '详情或复现步骤 / Details or reproduction steps'
      ? value + '\n\n```text\naoci_overview: 6, glob: 1, read: 1; overview body_bytes: 112388\n```' : value])
    const check = harness(issue({ body: body(reproduction) }))
    await check.run()
    expect(check.createComment).not.toHaveBeenCalled()
  })

  it('adds the bug label for a report submitted without label permissions', async () => {
    const check = harness(issue({ labels: [{ name: 'help wanted' }] }))
    await check.run()
    expect(check.addLabels).toHaveBeenCalledExactlyOnceWith({
      owner: 'omdsh-dev', repo: 'dsh-mnemon', issue_number: 235, labels: ['bug'],
    })
    expect(check.createComment).not.toHaveBeenCalled()
  })

  it.each(['before the job starts', 'during the job'])('uses a bug label added %s (#235)', async timing => {
    const check = harness(missingLabel(), { snapshots: timing === 'during the job' ? [missingLabel(), issue()] : [issue()] })
    await check.run()
    expect(check.addLabels).not.toHaveBeenCalled()
    expect(check.createComment).not.toHaveBeenCalled()
  })

  it('uses the latest report type when the author changes a bug to a question', async () => {
    const check = harness(missingLabel(), { snapshots: [missingLabel(), issue({ body: questionBody, labels: [] })] })
    await check.run()
    expect(check.addLabels).not.toHaveBeenCalled()
    expect(check.createComment).not.toHaveBeenCalled()
  })

  it('accepts required information filled in while comments are being loaded', async () => {
    const check = harness(incomplete(), { snapshots: [incomplete(), issue()] })
    await check.run()
    expect(check.createComment).not.toHaveBeenCalled()
  })

  it('rechecks required information after adding the bug label', async () => {
    const missing = { ...incomplete(), labels: [] }
    const check = harness(missing, { snapshots: [missing, missing, issue()] })
    await check.run()
    expect(check.addLabels).toHaveBeenCalledTimes(1)
    expect(check.createComment).not.toHaveBeenCalled()
  })

  it.each(['before the job starts', 'during the job', 'while adding the label'])('skips an issue closed %s', async timing => {
    const missing = { ...incomplete(), labels: [] }
    const closed = { ...missing, state: 'closed' }
    const snapshots = timing === 'before the job starts' ? [closed]
      : timing === 'during the job' ? [missing, closed] : [missing, missing, closed]
    const check = harness(missing, { snapshots })
    await check.run()
    expect(check.createComment).not.toHaveBeenCalled()
    expect(check.updateComment).not.toHaveBeenCalled()
    if (timing !== 'while adding the label') expect(check.addLabels).not.toHaveBeenCalled()
  })

  it.each(['opened', 'reopened', 'edited'])('requests missing information without closing an %s issue', async action => {
    const check = harness(incomplete(), { action })
    await check.run()
    expect(check.createComment).toHaveBeenCalledTimes(1)
    const comment = check.createComment.mock.calls[0][0].body
    expect(comment).toContain('环境信息 / Environment')
    expect(comment).toContain('The issue remains open')
    expect(comment).toContain(marker)
  })

  it('requests duplicate-search confirmation without closing the report', async () => {
    const check = harness(issue({ body: bugBody.replace('- [x]', '- [ ]') }))
    await check.run()
    expect(check.createComment.mock.calls[0][0].body).toContain('confirm that you searched')
  })

  it('handles an empty API-created report without assuming it is a bug', async () => {
    const check = harness(issue({ body: null, labels: [] }))
    await check.run()
    expect(check.addLabels).not.toHaveBeenCalled()
    expect(check.createComment.mock.calls[0][0].body).toContain('摘要 / Summary')
  })

  it('updates its existing reminder instead of posting another one', async () => {
    const check = harness(incomplete(), { comments: [botComment(marker + '\nOld reminder')] })
    await check.run()
    expect(check.createComment).not.toHaveBeenCalled()
    expect(check.updateComment).toHaveBeenCalledExactlyOnceWith({
      owner: 'omdsh-dev', repo: 'dsh-mnemon', comment_id: 123, body: expect.stringContaining('环境信息 / Environment'),
    })
  })

  it('marks its reminder resolved after the author supplies the missing information', async () => {
    const check = harness(issue(), { comments: [botComment(marker + '\nOld reminder')], action: 'edited' })
    await check.run()
    expect(check.createComment).not.toHaveBeenCalled()
    expect(check.updateComment.mock.calls[0][0].body).toContain('Required report information is present')
  })

  it('leaves an unchanged reminder alone when an issue is reopened again', async () => {
    const first = harness(incomplete())
    await first.run()
    const comment = botComment(first.createComment.mock.calls[0][0].body)
    const next = harness(incomplete(), { comments: [comment], action: 'reopened' })
    await next.run()
    expect(next.createComment).not.toHaveBeenCalled()
    expect(next.updateComment).not.toHaveBeenCalled()
  })

  it.each([
    { login: 'reporter', type: 'User' },
    { login: 'other-automation[bot]', type: 'Bot' },
  ])('does not edit a marker copied by $login', async user => {
    const check = harness(incomplete(), { comments: [{ ...botComment(marker), user }] })
    await check.run()
    expect(check.updateComment).not.toHaveBeenCalled()
    expect(check.createComment).toHaveBeenCalledTimes(1)
  })

  it.each(['initial read', 'latest read'])('makes no changes when the %s fails', async timing => {
    const failure = new Error('GitHub is unavailable')
    const check = harness(incomplete(), { snapshots: timing === 'initial read' ? [failure] : [incomplete(), failure] })
    await expect(check.run()).rejects.toThrow('GitHub is unavailable')
    expect(check.addLabels).not.toHaveBeenCalled()
    expect(check.createComment).not.toHaveBeenCalled()
    expect(check.updateComment).not.toHaveBeenCalled()
  })

  it('does not post duplicate advice when comment lookup fails', async () => {
    const check = harness(incomplete())
    check.listComments.mockRejectedValueOnce(new Error('Comment lookup failed'))
    await expect(check.run()).rejects.toThrow('Comment lookup failed')
    expect(check.createComment).not.toHaveBeenCalled()
    expect(check.updateComment).not.toHaveBeenCalled()
  })

  it('reports label API failures without closing or blaming the reporter', async () => {
    const check = harness(missingLabel())
    check.addLabels.mockRejectedValueOnce(new Error('Label request failed'))
    await expect(check.run()).rejects.toThrow('Label request failed')
    expect(check.createComment).not.toHaveBeenCalled()
  })

  it.each([undefined, issue({ pull_request: {} })])('ignores events without a regular issue', async eventIssue => {
    const check = harness(eventIssue)
    await check.run()
    expect(check.get).not.toHaveBeenCalled()
    expect(check.addLabels).not.toHaveBeenCalled()
    expect(check.createComment).not.toHaveBeenCalled()
  })
})
