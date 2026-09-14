import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const pluginNames = readdirSync(join(root, 'plugins')).filter(name => name.startsWith('dsh-mnemon-')).sort()
const coreImports = new Set(['dsh-mnemon/contracts', 'dsh-mnemon/extension-sdk', 'dsh-mnemon/source-sdk', 'dsh-mnemon/testing', 'dsh-mnemon/client'])
const providerImports = new Set(['dsh-mnemon-source-memory-spaces/provider-sdk', 'dsh-mnemon-source-memory-spaces/testing'])
const threeTierExtensions = new Set(['dsh-mnemon-strategy-auto-capture', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-scoped'])
const threeTierOwner = 'dsh-mnemon-strategy-default-three-tier'
const workspaceOwner = 'dsh-mnemon-strategy-workspace'
const workspaceExtensions = new Set(['focus', 'journal-capture', 'learning-cycle', 'prompt-schedule', 'review-cycle', 'skill-refinement', 'team-coordination'].map(name => 'dsh-mnemon-strategy-' + name))
const libraryNames = new Set(['dsh-mnemon-workspace-kit'])
const manifests = new Map(pluginNames.map(name => [name, JSON.parse(readFileSync(join(root, 'plugins', name, 'package.json'), 'utf8'))]))

function publicExport(name: string, specifier: string): boolean {
  return Object.hasOwn(manifests.get(name)?.exports ?? {}, '.' + specifier.slice(name.length))
}

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
  it('keeps independent Sources, complete Strategies, their contributions and private Providers explicit', () => {
    expect(pluginNames.filter(name => name.startsWith('dsh-mnemon-source-'))).toEqual([
      'agent-jobs', 'canvas', 'collaboration', 'documents', 'files', 'journal', 'learning', 'memory-spaces',
      'notifications', 'playbooks', 'project-context', 'review', 'runtime', 'sessions', 'sync', 'tasks',
    ].map(name => 'dsh-mnemon-source-' + name))
    expect(pluginNames.filter(name => name.startsWith('dsh-mnemon-strategy-'))).toEqual([...threeTierExtensions, threeTierOwner, ...workspaceExtensions, workspaceOwner].sort())
    expect(pluginNames.filter(name => name.startsWith('dsh-mnemon-provider-'))).toHaveLength(9)
    expect(pluginNames.filter(name => !/^dsh-mnemon-(source|strategy|provider)-/.test(name))).toEqual([...libraryNames])
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
    const policyOwner = threeTierExtensions.has(name) ? threeTierOwner : workspaceExtensions.has(name) ? workspaceOwner : undefined
    if (policyOwner) {
      expect(manifest.peerDependencies[policyOwner]).toBeTruthy()
    }
    if (threeTierExtensions.has(name)) {
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
        const importedName = packageName(specifier)
        const ownerContract = policyOwner && specifier === policyOwner + '/extension-sdk'
        const libraryContract = libraryNames.has(importedName) && publicExport(importedName, specifier)
        // Integration tests may compose published entry points. Production Sources
        // still cannot import another Source or a Strategy implementation.
        const testContract = file.includes(`${sep}tests${sep}`) && publicExport(importedName, specifier)
        if (specifier.startsWith('dsh-mnemon') && !(provider ? providerImports : coreImports).has(specifier) && !ownerContract && !libraryContract && !testContract) {
          violations.push(`${relative(root, file)} crosses its public contract: ${specifier}`)
        }
      }
      if (file.includes(`${sep}src${sep}`) && /\.mnemonMemorySpace\b|\b(?:ctx|context)\.(?:mnemon\.)?binding\b/u.test(readFileSync(file, 'utf8'))) {
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

  for (const [entry, allowed] of [
    ['src/sdk/index.ts', ['src/sdk', 'src/core/contracts', 'src/core/definitions.ts', 'src/core/decision-contracts.ts', 'src/core/operation-contracts.ts']],
    ['src/sdk/source/index.ts', ['src/sdk', 'src/core/contracts', 'src/core/definitions.ts', 'src/core/decision-contracts.ts', 'src/core/operation-contracts.ts']],
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
        else if (!isBuiltin(specifier) && !(entry === 'src/sdk/source/index.ts' && ['proper-lockfile', '@vscode/ripgrep'].includes(specifier))) violations.push(`${relative(root, file)}: ${specifier}`)
      }
    }
    expect(visited.size).toBeGreaterThan(1)
    expect(violations).toEqual([])
  })
})
