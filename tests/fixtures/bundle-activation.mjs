// Exercise only published DSH composition/lifecycle contracts. The synthetic
// packages expose activation counters; actual Mnemon behavior belongs to the
// packed Headless/WebUI checks, not these loader-focused sentinels.
import assert from 'node:assert/strict'
import ts from 'typescript'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDshHostRequire } from '../../scripts/dsh-host-packages.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(process.argv[2] ?? root, 'package.json'))
const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
const dsh = JSON.parse(await readFile(installAnchor, 'utf8')).version
const [major, minor, patch] = dsh.split(/[.-]/u).map(Number)
// From 0.2.1 the plugin manager recomputes package routes after each enable.
const recomputesRoutes = major > 0 || minor > 2 || (minor === 2 && patch >= 1)
const runtimeRequire = createDshHostRequire(installAnchor)
const load = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)
const app = await load('@deepseek-ai/dsh-app-boot')
const temporary = await mkdtemp(join(tmpdir(), 'mnemon-bundle-activation-'))
const profileDir = join(temporary, 'profile')
const patchPath = join(profileDir, 'cordis.patch.yml')
const configPath = join(profileDir, 'cordis.yml')
const settings = process.argv[3] === 'settings'
const isolated = process.argv.includes('--isolated')
const otherBundle = process.argv.includes('--other-bundle')
const selected = isolated ? (otherBundle ? ['fixture-other'] : []) : ['dsh-mnemon']
const modules = isolated ? join(temporary, 'profiles/.generations/starter/node_modules') : join(profileDir, 'node_modules')
const profile = { name: 'fixture', dir: profileDir, patchPath, installAnchor, cwd: temporary, home: temporary,
  startedBundles: selected, overlays: [], telemetryDisabledEnv: '1' }
const state = { active: new Map(), configs: new Map() }
let ctx
try {
  await mkdir(profileDir, { recursive: true })
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const names = ['dsh-mnemon', ...Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemon-'))]
  assert.equal(names.length, 19)
  for (const name of names) {
    const directory = join(modules, name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', main: './index.js',
      ...(name === 'dsh-mnemon' ? { dependencies: manifest.dependencies, exports: { '.': './index.js', './starter': './starter.js', './bundle': './bundle.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}) }))
    await writeFile(join(directory, 'index.js'), `
export const name = ${JSON.stringify(name)}
export const inject = ${JSON.stringify(name === 'dsh-mnemon' || name.startsWith('dsh-mnemon-provider-') ? [] : ['mnemonMemory'])}
export async function apply(ctx, config) {
  const state = ctx.root.bundleFixture
  ctx.effect(() => {
    state.active.set(name, (state.active.get(name) ?? 0) + 1)
    return () => { const count = state.active.get(name) - 1; if (count) state.active.set(name, count); else state.active.delete(name) }
  })
  state.configs.set(name, config)
  if (name === 'dsh-mnemon') ctx.provide('mnemonMemory', {})
  if (name === 'dsh-mnemon-source-memory-spaces') for (const provider of config.providers) await ctx.plugin(await import(provider.use)).await()
}
`)
  }
  for (const filename of ['bundle.ts', 'starter.ts', 'starter-resolution.ts']) {
    let source = await readFile(join(root, 'src', filename), 'utf8')
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/dsh-app-boot']) {
      source = source.replaceAll(`'${name}'`, JSON.stringify(pathToFileURL(runtimeRequire.resolve(name)).href))
    }
    source = source.replace('../package.json', './package.json').replace('./starter-resolution.ts', './starter-resolution.js')
    await writeFile(join(modules, 'dsh-mnemon', filename.replace('.ts', '.js')), ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }))
  }
  if (otherBundle) {
    const other = join(modules, 'fixture-other')
    const leaf = join(modules, 'fixture-leaf')
    await mkdir(other, { recursive: true }); await mkdir(leaf, { recursive: true })
    await writeFile(join(other, 'package.json'), JSON.stringify({ name: 'fixture-other', version: '1.0.0', dependencies: { 'fixture-leaf': '1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(other, 'cordis.patch.yml'), '- insert:\n    - id: fixture-leaf\n      name: fixture-leaf\n')
    await writeFile(join(leaf, 'package.json'), JSON.stringify({ name: 'fixture-leaf', version: '1.0.0', type: 'module', main: './index.js' }))
    await writeFile(join(leaf, 'index.js'), 'export function apply(ctx) { ctx.provide("otherFixture", {}) }')
  }
  if (isolated) {
    await mkdir(join(profileDir, 'node_modules'), { recursive: true })
    await symlink(join(modules, 'dsh-mnemon'), join(profileDir, 'node_modules/dsh-mnemon'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  if (otherBundle) await symlink(join(modules, 'fixture-other'), join(profileDir, 'node_modules/fixture-other'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(profileDir, 'node_modules/dsh-mnemon/cordis.patch.yml'), await readFile(join(root, 'cordis.patch.yml')))
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'dsh-mnemon': '0.0.0', ...(otherBundle ? { 'fixture-other': '1.0.0' } : {}) }, dsh: { profile: { bundles: selected } } }))
  // Keep the profile's Connection container independent from the Starter.
  await writeFile(configPath, '- id: connection\n  name: cordis:group\n  group: true\n  config: []\n')
  const retained = '# Operator comment\n- id: mnemon\n  config:\n    timeoutMs: 4321\n- id: mnemon-strategy-auto-capture\n  disabled: false\n- id: mnemon-source-documents\n  disabled: true\n'
  await writeFile(patchPath, retained)
  const patches = () => app.readProfilePatches('dsh', profile)
  const flatten = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])])
  if (settings) {
    // Reproduce the reported manual installation: the selected bundle already inserts these IDs.
    const shipped = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    await writeFile(patchPath, shipped + retained)
    const duplicated = flatten(app.composeEntries([patches()]))
    for (const id of ['mnemon-bundle', 'mnemon']) assert.equal(duplicated.filter(row => row.id === id).length, 2)
    assert.notEqual(duplicated.find(row => row.id === 'mnemon').config.timeoutMs, 4321,
      'The config editor sees the first duplicate while the override updates the other one')
    // The documented recovery preserves overrides and uses the automatically loaded bundle once.
    await writeFile(patchPath, '- id: mnemon-bundle\n  name: dsh-mnemon/bundle\n  disabled: false\n' + retained)
  }
  const ConfigEditor = settings ? (await load('@deepseek-ai/dsh-config-editor')).default : undefined
  let Manager
  if (process.argv[3] === 'manager') Manager = (await load('@deepseek-ai/dsh-plugin-manager')).default
  const start = async () => {
    ctx = await app.boot('dsh', configPath, patches(), async context => {
      if (isolated) {
        const loaded = app.loadProfileDirectory('dsh', profileDir, installAnchor)
        await context.plugin(app.PluginPackages, { resolution: await app.createRuntimeResolution({ installAnchor, profile: loaded, home: temporary }) }).await()
      }
      context.provide('bundleFixture', state)
      context.provide('profileContext', profile)
      context.provide('webRuntime', {})
      context.provide('webServer', {})
      if (ConfigEditor) await context.plugin(ConfigEditor).await()
      // Use the manager's real profile reconciliation; no watcher is needed in
      // this deterministic single-operation fixture.
      if (Manager) {
        context.provide('hmr', {
          runExclusive: operation => operation(),
          // DSH 0.2.1's manager applies a change through HMR, which recomposes the profile; with no changed
          // module to replace, that is app-boot's recomposition. DSH 0.2.0's manager recomposes itself.
          reconcileProfile: async requiredIds => ({ pending: [], ...await app.recomposeProfile(ctx, patches(), 'dsh', { requiredIds }) }),
        })
        await context.plugin(Manager).await()
      }
    }, pathToFileURL(join(profileDir, 'package.json')).href)
  }
  const stop = async () => { await ctx?.fiber.dispose(); ctx = undefined; assert.equal(state.active.size, 0) }
  // The general main Strategy ships off until it is selected.
  const enabledNames = names.filter(name => !['dsh-mnemon-source-documents', 'dsh-mnemon-strategy-general', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-scoped'].includes(name))
  const assertActive = expected => {
    assert.deepEqual([...state.active].sort(), expected.map(name => [name, 1]).sort())
    assert.equal([...ctx.loader.entries()].filter(entry => entry.options.id === 'mnemon-bundle').length, 1)
  }
  const assertEnabled = () => {
    assertActive(enabledNames)
    assert.equal(state.configs.get('dsh-mnemon').timeoutMs, 4321)
  }
  const assertRetained = async () => {
    const saved = await readFile(patchPath, 'utf8')
    assert(saved.includes('# Operator comment'))
    assert(saved.includes('timeoutMs: 4321'))
  }
  const reload = () => app.reconcileProfilePatches(ctx, patches(), 'dsh')
  await start()
  if (isolated) {
    assert.equal(state.active.size, 0)
    let previousPackage
    const parentUrl = pathToFileURL(join(profileDir, 'package.json')).href
    if (otherBundle) {
      previousPackage = ctx.pluginPackages.packageOf('fixture-leaf', parentUrl)
      assert(previousPackage)
      assert(ctx.get('otherFixture'))
      assert.equal((await ctx.pluginManager.setBundleEnabled('fixture-other', false)).application, 'applied')
      assert.equal(ctx.get('otherFixture'), undefined)
    }
    const result = await ctx.pluginManager.setBundleEnabled('dsh-mnemon', true)
    assert.equal(result.application, 'applied', JSON.stringify(result))
    if (otherBundle) {
      // A host that recomputes the routes from the selected bundles can drop a
      // stopped bundle's route until it is enabled again. It must never point
      // anywhere else, then or afterwards.
      const retained = ctx.pluginPackages.packageOf('fixture-leaf', parentUrl)?.dir
      if (retained !== undefined || !recomputesRoutes) assert.equal(retained, previousPackage.dir)
      assert.equal((await ctx.pluginManager.setBundleEnabled('fixture-other', true)).application, 'applied')
      assert(ctx.get('otherFixture'))
      assert.equal(ctx.pluginPackages.packageOf('fixture-leaf', parentUrl)?.dir, previousPackage.dir)
    }
  }
  assertEnabled()
  if (settings) {
    const core = [...ctx.loader.entries()].find(entry => entry.options.id === 'mnemon')
    await ctx.configEditor.edit(core, current => ({ ...current, skills: { evolution: true } }))
    assert.equal(state.configs.get('dsh-mnemon').skills.evolution, true)
    const rows = flatten(app.composeEntries([patches()]))
    for (const id of ['mnemon-bundle', 'mnemon']) assert.equal(rows.filter(row => row.id === id).length, 1)
    assert.equal(rows.find(row => row.id === 'mnemon').config.skills.evolution, true)
    await stop(); await start()
    assertEnabled()
    assert.equal(state.configs.get('dsh-mnemon').skills.evolution, true)
    console.log('Config editor saved and reloaded Skills evolution with unique bundle/core IDs (#470).')
  }
  if (Manager) {
    const manager = ctx.pluginManager
    const components = (await manager.listBundles()).find(bundle => bundle.name === 'dsh-mnemon').rows
    const plugins = await manager.listPlugins()
    // Native groups are lifecycle containers, deliberately absent from the
    // manager's inventory. Strict mode reproduces DSH 0.2.0's bundle-list mismatch
    // without making that upstream defect an accepted lifecycle contract.
    const groups = new Set([...ctx.loader.entries()].filter(entry => entry.options.group).map(entry => entry.options.id))
    const pluginComponents = components.filter(row => !groups.has(row.rowId))
    assert.equal(pluginComponents.length, 10)
    assert(pluginComponents.every(row => plugins.some(plugin => plugin.entryId === row.entryId)))
    if (process.argv.includes('--check-declared-rows')) {
      assert.deepEqual(components.filter(row => !plugins.some(plugin => plugin.entryId === row.entryId)), [],
        'Every advertised bundle component must be addressable by the published manager')
    }
    const core = plugins.find(entry => entry.moduleName === 'dsh-mnemon')
    assert.equal(core.patchId, 'mnemon')
    for (const name of ['dsh-mnemon-source-runtime', 'dsh-mnemon-source-memory-spaces', 'dsh-mnemon-strategy-auto-capture']) {
      const component = plugins.find(entry => entry.moduleName === name)
      const children = name === 'dsh-mnemon-source-memory-spaces' ? names.filter(item => item.startsWith('dsh-mnemon-provider-')) : []
      assert.equal((await manager.setPluginEnabled(component.entryId, false)).application, 'applied')
      assertActive(enabledNames.filter(item => item !== name && !children.includes(item)))
      assert.equal((await manager.setPluginEnabled(component.entryId, true)).application, 'applied')
      assertEnabled()
    }
    for (const enabled of [false, true, false]) {
      const result = await manager.setPluginEnabled(core.entryId, enabled)
      assert.equal(result.application, 'applied', JSON.stringify(result))
      if (enabled) assertEnabled()
      else assert.equal(state.active.size, 0, 'Disabling mnemon must stop every Source, Strategy and private Provider')
      await assertRetained()
    }
    const runtime = plugins.find(entry => entry.moduleName === 'dsh-mnemon-source-runtime')
    assert.equal((await manager.setPluginEnabled(runtime.entryId, true)).application, 'overridden')
    assert.equal(state.active.size, 0, 'An independent Source toggle cannot bypass the disabled core')
    await stop(); await start()
    assert.equal(state.active.size, 0, 'The disabled core must survive restart')
    const restartedCore = (await ctx.pluginManager.listPlugins()).find(entry => entry.moduleName === 'dsh-mnemon')
    assert.equal((await ctx.pluginManager.setPluginEnabled(restartedCore.entryId, true)).application, 'applied')
    assertEnabled()
    await stop(); await start(); assertEnabled()
    for (const enabled of [false, true, false]) {
      assert.equal((await ctx.pluginManager.setBundleEnabled('dsh-mnemon', enabled)).application, 'applied')
      if (enabled) assertEnabled()
      else assert.equal(state.active.size, 0)
      await assertRetained()
    }
    await stop(); await start()
    assert.equal(state.active.size, 0, 'The deselected bundle must survive restart')
    assert.equal((await ctx.pluginManager.setBundleEnabled('dsh-mnemon', true)).application, 'applied')
    assertEnabled()
    await stop(); await start(); assertEnabled()
  }
  for (const disabled of ['true', '!!js "true"', '!!js "false"', 'false']) {
    await writeFile(patchPath, retained.replace('- id: mnemon\n', `- id: mnemon\n  disabled: ${disabled}\n`))
    await reload()
    const check = () => disabled.includes('true') ? assertActive([]) : assertEnabled()
    check()
    await stop(); await start(); check()
  }
  await stop()
  // The published schema collector walks only native Group/Include identities.
  // It reports the Starter's group as an unrecognized carrier and skips its
  // children, as it does for DSH's own agent presets; nothing else may fail.
  const loaded = app.loadProfileDirectory('dsh', profileDir, installAnchor)
  const schema = (await app.generateConfigSchema(loaded, [...loaded.layers.map(layer => layer.patches), loaded.patches], installAnchor))['x-cordis']
  const bundle = schema.entries.find(entry => entry.id === 'mnemon-bundle')
  assert.equal(bundle?.name, 'dsh-mnemon/bundle')
  assert.deepEqual(schema.diagnostics.filter(item => item.level === 'error'), [{ level: 'error', path: bundle.path,
    message: 'unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection' }])
  console.log(JSON.stringify({ dsh, packages: names.length,
    components: 9, manager: Boolean(Manager), result: 'passed' }))
} finally {
  await ctx?.fiber.dispose()
  await rm(temporary, { recursive: true, force: true })
}
