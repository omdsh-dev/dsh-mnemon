import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { memoryPlugin as documents } from 'dsh-mnemon-source-documents'
import { memoryPlugin as spaces } from 'dsh-mnemon-source-memory-spaces'
import { NATIVE_PROVIDER_ID } from 'dsh-mnemon-source-memory-spaces/contracts'
import { memoryPlugin as runtime } from 'dsh-mnemon-source-runtime'
import { memoryPlugin as skills } from 'dsh-mnemon-source-skills'
import { memoryPlugin as capture } from 'dsh-mnemon-strategy-auto-capture'
import { memoryPlugin as threeTier } from 'dsh-mnemon-strategy-default-three-tier'
import { memoryPlugin as general } from 'dsh-mnemon-strategy-general'
import { memoryPlugin as light } from 'dsh-mnemon-strategy-light-context'
import { memoryPlugin as scoped } from 'dsh-mnemon-strategy-scoped'
import { isShipped } from '../src/client/component-copy.ts'
import { STARTER_COMPONENT_ROWS, STARTER_ENHANCEMENT_PACKAGES, STARTER_SELF_REGISTERING_PACKAGES } from '../src/host/starter-components.ts'
import type { MemoryPluginEntryView } from '../src/host/view-protocol.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const pluginNames = readdirSync(join(root, 'plugins')).filter(name => name.startsWith('dsh-mnemon-')).sort()
const coreImports = new Set(['dsh-mnemon/contracts', 'dsh-mnemon/extension-sdk', 'dsh-mnemon/testing', 'dsh-mnemon/client'])
const providerImports = new Set(['dsh-mnemon-source-memory-spaces/provider-sdk', 'dsh-mnemon-source-memory-spaces/testing'])
// Standard-slot extensions follow any main Strategy, so they do not depend on one.
const viewExtensions = new Set(['dsh-mnemon-strategy-auto-capture', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-scoped'])
const threeTierOwner = 'dsh-mnemon-strategy-default-three-tier'
const mainStrategies = [threeTierOwner, 'dsh-mnemon-strategy-general']

function inside(directory: string, path: string): boolean {
  const child = relative(directory, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function imports(path: string): Array<{ specifier: string; typeOnly: boolean }> {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const result: Array<{ specifier: string; typeOnly: boolean }> = []
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly
      result.push({ specifier: node.moduleSpecifier.text, typeOnly })
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      result.push({ specifier: node.arguments[0].text, typeOnly: false })
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      result.push({ specifier: node.argument.literal.text, typeOnly: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function packageName(specifier: string): string {
  return specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

describe('standalone plugin repository boundary', () => {
  it('keeps four Sources, two main Strategies, three optional contributions and nine private Providers explicit', () => {
    expect(pluginNames.filter(name => name.startsWith('dsh-mnemon-source-'))).toEqual([
      'dsh-mnemon-source-documents', 'dsh-mnemon-source-memory-spaces', 'dsh-mnemon-source-runtime', 'dsh-mnemon-source-skills',
    ])
    expect(pluginNames.filter(name => name.startsWith('dsh-mnemon-strategy-'))).toEqual([...viewExtensions, ...mainStrategies].sort())
    expect(pluginNames.filter(name => name.startsWith('dsh-mnemon-provider-'))).toHaveLength(9)
  })

  for (const name of pluginNames) it(`${name} owns its build, tests and declared public dependencies`, () => {
    const directory = join(root, 'plugins', name)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    expect(manifest.name).toBe(name)
    expect(manifest.private).not.toBe(true)
    expect(manifest.exports['.']).toMatchObject({ types: './lib/index.d.ts', default: './lib/index.js' })
    for (const command of ['typecheck', 'test', 'build', 'verify']) expect(manifest.scripts[command]).toBeTruthy()
    for (const file of ['README.md', 'tsconfig.json', 'tsdown.config.ts', 'vitest.config.ts', 'src/index.ts', 'tests']) {
      expect(existsSync(join(directory, file)), `${name}/${file}`).toBe(true)
    }
    const configuration = JSON.parse(readFileSync(join(directory, 'tsconfig.json'), 'utf8'))
    expect(configuration.extends).toBeUndefined()
    expect(configuration.compilerOptions.paths).toBeUndefined()
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies }
    for (const version of Object.values(dependencies)) expect(version).not.toMatch(/^(?:workspace:|file:|link:|\.\.?\/)/u)
    const provider = name.startsWith('dsh-mnemon-provider-')
    expect(manifest.peerDependencies[provider ? 'dsh-mnemon-source-memory-spaces' : 'dsh-mnemon']).toBeTruthy()
    if (provider) expect(manifest.peerDependencies['dsh-mnemon']).toBeUndefined()
    if (viewExtensions.has(name)) {
      expect(manifest.peerDependencies[threeTierOwner]).toBeUndefined()
      expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
      const patch = readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain(`name: ${name}`)
      expect(patch).toContain('disabled: true')
    }

    const files = ['src', 'tests'].flatMap(group => readdirSync(join(directory, group), { recursive: true })
      .filter(path => /\.[cm]?[jt]sx?$/u.test(String(path))).map(path => join(directory, group, String(path))))
    files.push(join(directory, 'tsdown.config.ts'), join(directory, 'vitest.config.ts'))
    const violations: string[] = []
    for (const file of files) {
      for (const { specifier } of imports(file)) {
        if (specifier.startsWith('.')) {
          if (!inside(directory, resolve(dirname(file), specifier))) violations.push(`${relative(root, file)} escapes to ${specifier}`)
          continue
        }
        if (isBuiltin(specifier)) continue
        if (packageName(specifier) === name && Object.hasOwn(manifest.exports, '.' + specifier.slice(name.length))) continue
        if (!Object.hasOwn(dependencies, packageName(specifier))) violations.push(`${relative(root, file)} has undeclared dependency ${specifier}`)
        const testOwner = viewExtensions.has(name) && file.includes(`${sep}tests${sep}`) && specifier === threeTierOwner
        if (specifier.startsWith('dsh-mnemon') && !(provider ? providerImports : coreImports).has(specifier) && !testOwner && !(file.includes(`${sep}tests${sep}`) && /^dsh-mnemon-provider-[a-z0-9-]+$/u.test(specifier))) {
          violations.push(`${relative(root, file)} crosses its public contract: ${specifier}`)
        }
      }
      const isClientSource = file.includes(`${sep}src${sep}client${sep}`) || file.endsWith(`${sep}src${sep}client.ts`)
      const forbiddenHostBinding = isClientSource ? /\.mnemonMemorySpace\b/u : /\.(?:binding|mnemonMemorySpace)\b/u
      if (file.includes(`${sep}src${sep}`) && forbiddenHostBinding.test(readFileSync(file, 'utf8'))) {
        violations.push(`${relative(root, file)} reaches into a Host business binding`)
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps the Strategy-owned SDK independent of its runtime policy and every Source implementation', () => {
    const entry = join(root, 'plugins', threeTierOwner, 'src/extension-sdk.ts')
    expect(imports(entry).map(item => item.specifier).sort()).toEqual(['dsh-mnemon/contracts', 'dsh-mnemon/extension-sdk'])
  })

  it('keeps the pure Core import closure independent of Sources, Providers, clients and the default bundle', () => {
    const pending = [join(root, 'src/core/plugin.ts')]
    const visited = new Set<string>()
    const allowed = ['src/core', 'src/sdk'].map(directory => join(root, directory))
    const violations: string[] = []
    while (pending.length > 0) {
      const file = pending.pop()!
      if (visited.has(file)) continue
      visited.add(file)
      if (!allowed.some(directory => inside(directory, file)) && !inside(join(root, 'src/core'), file)) {
        violations.push(relative(root, file))
      }
      for (const { specifier, typeOnly } of imports(file)) {
        if (typeOnly) continue
        if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier))
        else if (specifier.startsWith('dsh-mnemon') || specifier === 'react') violations.push(`${relative(root, file)}: ${specifier}`)
      }
    }
    expect(visited.size).toBeGreaterThan(3)
    expect(violations).toEqual([])
  })

  it('keeps component implementations out of the Starter client bundle', () => {
    // The client build bundles every import except React and the DSH primitives
    // (tsdown.config.ts), so a component package may reach it only as presentation
    // assets or types. Runtime settings also read the Source's public capacity
    // constants (no implementation), so the browser and Host use the same limits.
    // The implementation exception is what the Starter still draws of Memory
    // Spaces, taken through one module from Memory Spaces' own public client entry:
    // its settings, as a fallback for a version that registers none, the Status
    // page's Provider marks and the Mnemon Native Provider's id. The package size
    // ceiling no longer guards this.
    const gateway = join(root, 'src/client/memory-spaces-client.ts')
    const runtimeSettings = join(root, 'src/client/component-settings.tsx')
    const pending = [join(root, 'src/client/index.ts')]
    const visited = new Set<string>()
    const violations: string[] = []
    while (pending.length > 0) {
      const file = pending.pop()!
      if (visited.has(file)) continue
      visited.add(file)
      for (const { specifier, typeOnly } of imports(file)) {
        if (typeOnly) continue
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier)
          if (inside(join(root, 'plugins'), target)) violations.push(`${relative(root, file)}: ${specifier}`)
          else if (/\.tsx?$/.test(target)) pending.push(target)
        } else if (/^dsh-mnemon-(?:source|provider|strategy)-/.test(specifier) && !/^dsh-mnemon-source-[^/]+\/presentation\//.test(specifier)
          && !(file === gateway && specifier === 'dsh-mnemon-source-memory-spaces/client')
          && !(file === runtimeSettings && specifier === 'dsh-mnemon-source-runtime/contracts')) {
          violations.push(`${relative(root, file)}: ${specifier}`)
        }
      }
    }
    expect(visited.size).toBeGreaterThan(30)
    expect(violations).toEqual([])
    expect(visited.has(gateway)).toBe(true)
    expect(imports(gateway)).toEqual([{ specifier: 'dsh-mnemon-source-memory-spaces/client', typeOnly: false }])
    const runtimeImport = ts.createSourceFile(runtimeSettings, readFileSync(runtimeSettings, 'utf8'), ts.ScriptTarget.Latest, true).statements
      .find(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'dsh-mnemon-source-runtime/contracts') as ts.ImportDeclaration
    const bindings = runtimeImport.importClause?.namedBindings
    expect(bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements.map(element => element.name.text).sort() : [])
      .toEqual(['RUNTIME_MEMORY_LIMITS', 'RUNTIME_MEMORY_LIMIT_MAX_BYTES'])
  })

  for (const [entry, allowed] of [
    ['src/sdk/index.ts', ['src/sdk', 'src/core/contracts', 'src/core/definitions.ts']],
    ['plugins/dsh-mnemon-source-memory-spaces/src/provider-sdk.ts', [
      'plugins/dsh-mnemon-source-memory-spaces/src/provider-sdk.ts',
      'plugins/dsh-mnemon-source-memory-spaces/src/contracts.ts',
      ...['adapter', 'definitions', 'http', 'process'].map(name => `plugins/dsh-mnemon-source-memory-spaces/src/providers/${name}.ts`),
    ]],
  ] as const) it(`${entry} does not load its private runtime or registries`, () => {
    const pending = [join(root, entry)]
    const visited = new Set<string>()
    const violations: string[] = []
    while (pending.length > 0) {
      const file = pending.pop()!
      if (visited.has(file)) continue
      visited.add(file)
      if (!allowed.some(path => inside(join(root, path), file))) violations.push(relative(root, file))
      for (const { specifier, typeOnly } of imports(file)) {
        if (typeOnly) continue
        if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier))
        else if (!isBuiltin(specifier)) violations.push(`${relative(root, file)}: ${specifier}`)
      }
    }
    expect(visited.size).toBeGreaterThan(1)
    expect(violations).toEqual([])
  })
})

describe('component package metadata', () => {
  const components = [runtime, documents, spaces, skills, threeTier, general, capture, light, scoped]
  const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as Record<string, unknown>

  it.each(components.map(plugin => [plugin.packageName, plugin] as const))('%s shows DSH the name and description it declares', (pkgName, plugin) => {
    for (const [file, language] of [['en', 'en'], ['zh', 'zh-CN']] as const) {
      expect(read(`plugins/${pkgName}/locale/${file}.json`)).toEqual({ meta: { title: plugin.label?.[language], description: plugin.description?.[language] } })
    }
    const manifest = read(`plugins/${pkgName}/package.json`) as { exports: Record<string, unknown>; files: string[] }
    expect(manifest.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.files).toContain('locale')
  })

  it('gives every component row the Starter declares a page of its own', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const rows = [...patch.matchAll(/- id: ([\w-]+)\n\s+name: (dsh-mnemon-(?:source|strategy)-[\w-]+)/gu)]
    expect(rows.map(row => ({ rowId: row[1], packageName: row[2] }))).toEqual(STARTER_COMPONENT_ROWS)
    expect(rows.map(row => row[2]).sort()).toEqual(components.map(plugin => plugin.packageName).sort())
  })

  it('names exactly the components package.json pins', () => {
    const { dependencies } = read('package.json') as { dependencies: Record<string, string> }
    const pinned = Object.entries(dependencies).filter(([name]) => /^dsh-mnemon-(?:source|strategy)-/u.test(name))
    expect(pinned.map(([name]) => name).sort()).toEqual(STARTER_COMPONENT_ROWS.map(row => row.packageName).sort())
    for (const [name, version] of pinned) expect(version, name).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u)
  })

  it('tells a shipped component from an installed one by the Starter rows', () => {
    for (const { packageName: pkgName } of STARTER_COMPONENT_ROWS) expect(isShipped({ packageName: pkgName } as MemoryPluginEntryView), pkgName).toBe(true)
    for (const pkgName of ['dsh-mnemon-strategy-focus', 'dsh-mnemon-provider-mem0', 'dsh-mnemon']) {
      expect(isShipped({ packageName: pkgName } as MemoryPluginEntryView), pkgName).toBe(false)
    }
  })

  it('names the shipped enhancements and the packages whose own bundle patch registers their row', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const enhancements = components.filter(plugin => plugin.roles.includes('strategy-extension')).map(plugin => plugin.packageName)
    expect([...STARTER_ENHANCEMENT_PACKAGES].sort()).toEqual(enhancements.sort())
    for (const name of STARTER_ENHANCEMENT_PACKAGES) expect(patch, name).toMatch(new RegExp(`name: ${name}\n\\s+disabled: true\n`, 'u'))
    const withOwnPatch = STARTER_COMPONENT_ROWS.map(row => row.packageName)
      .filter(name => (read(`plugins/${name}/package.json`) as { dsh?: { bundle?: { patch?: string } } }).dsh?.bundle?.patch !== undefined)
    expect([...STARTER_SELF_REGISTERING_PACKAGES].sort()).toEqual(withOwnPatch.sort())
  })

  it('installs Mnemon Native under the id Memory Spaces knows it by', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toMatch(new RegExp(`- use: dsh-mnemon-provider-mnemon-native\n\\s+instanceId: ${NATIVE_PROVIDER_ID}\n`, 'u'))
  })
})
