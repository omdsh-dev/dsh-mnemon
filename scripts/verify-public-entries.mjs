import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { localeExport, readPackageLocales } from './package-locales.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const excluded = new Set(['./client', './package.json'])
const privateNames = new Set([
  'MemoryRuntime', 'MemoryContributionRegistry', 'MemoryContributionSnapshot',
  'InstalledMemorySource', 'InstalledMemoryStrategy', 'InstalledMemoryStrategyExtension', 'MemoryGenerationAttachment',
  'MemoryGenerationHost', 'MemoryGenerationLease', 'MemoryCompositionGeneration',
  'CompileMemoryGenerationOptions', 'ComposableMemoryTurnManager', 'provideMemoryRuntime',
  'PrivateMemorySpaceProviderHost', 'MemorySpaceProviderSnapshot', 'MemorySpaceProviderSnapshotEntry',
  'MemoryAdapterFactoryRegistry', 'MemoryProviderAdapterRegistry', 'MemoryProviderCatalog',
])
const publicTypes = new Set()

function verifyDeclarations(filename) {
  if (publicTypes.has(filename)) return
  publicTypes.add(filename)
  const source = readFileSync(filename, 'utf8')
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  function visit(node) {
    if (ts.isIdentifier(node) && privateNames.has(node.text)) {
      throw new Error(`Public declaration exposes private ${node.text}: ${filename}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const dependencies = ts.preProcessFile(source, true, true)
  for (const { fileName } of [...dependencies.importedFiles, ...dependencies.referencedFiles]) {
    if (!fileName.startsWith('.')) continue
    verifyDeclarations(resolve(dirname(filename), fileName.replace(/(?<!\.d)\.[cm]?[jt]sx?$/u, '.d.ts')))
  }
}

const CLIENT_DECLARATION_PACKAGES = new Set(['react', '@deepseek-ai/dsh-client-ui-primitives'])
function verifyClientDeclarations(filename, seen = new Set()) {
  if (seen.has(filename)) return seen
  seen.add(filename)
  const path = relative(root, filename).split('\\').join('/')
  if (/^lib\/types\/src\/(?:host|sdk)\//u.test(path)) throw new Error(`dsh-mnemon/client declarations reach ${path}`)
  const source = readFileSync(filename, 'utf8')
  if (/declare\s+module\s+['"]@deepseek-ai\/cordis['"]/u.test(source)) throw new Error(`dsh-mnemon/client declarations reach a cordis Context augmentation in ${path}`)
  const dependencies = ts.preProcessFile(source, true, true)
  for (const { fileName } of [...dependencies.importedFiles, ...dependencies.referencedFiles, ...dependencies.typeReferenceDirectives]) {
    if (fileName.startsWith('.')) verifyClientDeclarations(resolve(dirname(filename), fileName.replace(/(?<!\.d)\.[cm]?[jt]sx?$/u, '.d.ts')), seen)
    else if (!CLIENT_DECLARATION_PACKAGES.has(fileName)) throw new Error(`dsh-mnemon/client declarations import ${fileName} in ${path}; only ${[...CLIENT_DECLARATION_PACKAGES].join(', ')} may be imported there`)
  }
  return seen
}

let imported = 0
let executables = 0
const clientDeclarations = verifyClientDeclarations(resolve(root, JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).exports['./client'].types))
for (const directory of [root, resolve(root, 'plugins/dsh-mnemon-source-memory-spaces'), resolve(root, 'plugins/dsh-mnemon-strategy-default-three-tier')]) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  for (const executable of Object.values(manifest.bin ?? {})) {
    execFileSync(process.execPath, [resolve(directory, executable), '--help'], { encoding: 'utf8', timeout: 10_000 })
    executables++
  }
  for (const [subpath, descriptor] of Object.entries(manifest.exports)) {
    if (excluded.has(subpath)) continue
    const label = manifest.name + (subpath === '.' ? '' : subpath.slice(1))
    if (subpath === localeExport) {
      readPackageLocales(directory, manifest)
      continue
    }
    if (subpath.startsWith('./presentation/') && typeof descriptor === 'string') {
      const asset = readFileSync(resolve(directory, descriptor), 'utf8')
      if (subpath.endsWith('.json')) JSON.parse(asset)
      else if (!subpath.endsWith('.module.css') || !asset.trim()) throw new Error(`invalid presentation asset ${label}`)
      continue
    }
    if (typeof descriptor !== 'object' || descriptor === null || typeof descriptor.default !== 'string' || typeof descriptor.types !== 'string') {
      throw new Error(`public export ${label} must declare default and types paths`)
    }
    const runtimePath = resolve(directory, descriptor.default)
    const typesPath = resolve(directory, descriptor.types)
    if (!existsSync(runtimePath)) throw new Error(`public export ${label} is missing runtime file ${descriptor.default}`)
    if (!existsSync(typesPath)) throw new Error(`public export ${label} is missing declarations ${descriptor.types}`)
    const module = await import(`${pathToFileURL(runtimePath).href}?verify=${encodeURIComponent(label)}`)
    for (const name of privateNames) if (name in module) throw new Error(`${label} exports private ${name}`)
    if (subpath === './core' && Object.keys(module).sort().join(',') !== 'apply,inject,name,provide') {
      throw new Error('Core entry must expose only the Cordis plugin, not its engine')
    }
    verifyDeclarations(typesPath)
    imported++
  }
}

console.log(`Imported ${imported} Node-compatible entries; verified ${publicTypes.size} public type dependencies, ${clientDeclarations.size} browser-side client declarations and ${executables} executable help entry on ${process.version}.`)
