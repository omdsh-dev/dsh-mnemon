// Exercise only published DSH composition/lifecycle contracts. The synthetic
// packages expose activation counters; actual Mnemon behavior belongs to the
// packed Headless/WebUI checks, not these loader-focused sentinels.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(process.argv[2] ?? root, 'package.json'))
const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
const runtimeRequire = createRequire(installAnchor)
const load = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)
const app = await load('@deepseek-ai/dsh-app-boot')
const temporary = await mkdtemp(join(tmpdir(), 'mnemon-bundle-activation-'))
const profileDir = join(temporary, 'profile')
const patchPath = join(profileDir, 'cordis.patch.yml')
const configPath = join(profileDir, 'cordis.yml')
const selected = ['dsh-mnemon']
const profile = { name: 'fixture', dir: profileDir, patchPath, installAnchor, cwd: temporary, home: temporary,
  startedBundles: selected, overlays: [], telemetryDisabledEnv: '1' }
const state = { active: new Map(), configs: new Map() }
let ctx
try {
  await mkdir(profileDir, { recursive: true })
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const names = ['dsh-mnemon', ...Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemon-'))]
  assert.equal(names.length, 17)
  for (const name of names) {
    const directory = join(profileDir, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', main: './index.js',
      ...(name === 'dsh-mnemon' ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}) }))
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
  await writeFile(join(profileDir, 'node_modules/dsh-mnemon/cordis.patch.yml'), await readFile(join(root, 'cordis.patch.yml')))
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'dsh-mnemon': '0.0.0' }, dsh: { profile: { bundles: selected } } }))
  // The Starter's existing connection scope patch has a real addressable row.
  await writeFile(configPath, '- id: connection\n  name: cordis:group\n  group: true\n  config: []\n')
  const retained = '# Operator comment\n- id: mnemon\n  config:\n    timeoutMs: 4321\n- id: mnemon-strategy-auto-capture\n  disabled: false\n- id: mnemon-source-documents\n  disabled: true\n'
  await writeFile(patchPath, retained)
  const patches = () => app.readProfilePatches === undefined
    ? [...app.loadProfileDirectory('dsh', profileDir, installAnchor).layers.flatMap(layer => layer.patches), ...app.loadOverlayPatches('dsh', patchPath)]
    : app.readProfilePatches('dsh', profile)
  let Manager
  if (process.argv[3] === 'manager') Manager = (await load('@deepseek-ai/dsh-plugin-manager')).default
  const start = async () => {
    ctx = await app.boot('dsh', configPath, patches(), async context => {
      context.provide('bundleFixture', state)
      context.provide('profileContext', profile)
      context.provide('webRuntime', {})
      context.provide('webServer', {})
      // Use the manager's real profile reconciliation; no watcher is needed in
      // this deterministic single-operation fixture.
      if (Manager) {
        context.provide('hmr', { runExclusive: operation => operation() })
        await context.plugin(Manager).await()
      }
    }, pathToFileURL(join(profileDir, 'package.json')).href)
  }
  const stop = async () => { await ctx?.fiber.dispose(); ctx = undefined; assert.equal(state.active.size, 0) }
  const enabledNames = names.filter(name => !['dsh-mnemon-source-documents', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-scoped'].includes(name))
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
  const reload = async () => {
    if (app.reconcileProfilePatches) await app.reconcileProfilePatches(ctx, patches(), 'dsh')
    else { await stop(); await start() }
  }
  await start()
  assertEnabled()
  if (Manager) {
    const manager = ctx.pluginManager
    const components = (await manager.listBundles()).find(bundle => bundle.name === 'dsh-mnemon').rows
    const plugins = await manager.listPlugins()
    // Native groups are lifecycle containers, deliberately absent from the
    // manager's inventory. Strict mode reproduces rc.2's bundle-list mismatch
    // without making that upstream defect an accepted lifecycle contract.
    const groups = new Set([...ctx.loader.entries()].filter(entry => entry.options.group).map(entry => entry.options.id))
    const pluginComponents = components.filter(row => !groups.has(row.rowId))
    assert.equal(pluginComponents.length, 8)
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
  console.log(JSON.stringify({ dsh: JSON.parse(await readFile(installAnchor, 'utf8')).version, packages: names.length,
    components: 8, manager: Boolean(Manager), result: 'passed' }))
} finally {
  await ctx?.fiber.dispose()
  await rm(temporary, { recursive: true, force: true })
}
