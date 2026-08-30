import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const pluginNames = readdirSync(join(root, 'plugins')).filter(name => name.startsWith('dsh-mnemon-')).sort()
const coreImports = new Set(['dsh-mnemon/contracts', 'dsh-mnemon/extension-sdk', 'dsh-mnemon/testing', 'dsh-mnemon/client'])
const providerImports = new Set(['dsh-mnemon-source-memory-spaces/provider-sdk', 'dsh-mnemon-source-memory-spaces/testing'])

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
  it('keeps the expected three Sources, one Strategy and nine private Providers explicit', () => {
    expect(pluginNames.filter(name => name.startsWith('dsh-mnemon-source-'))).toEqual([
      'dsh-mnemon-source-documents', 'dsh-mnemon-source-memory-spaces', 'dsh-mnemon-source-runtime',
    ])
    expect(pluginNames.filter(name => name.startsWith('dsh-mnemon-strategy-'))).toEqual(['dsh-mnemon-strategy-default-three-tier'])
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
        if (!Object.hasOwn(dependencies, packageName(specifier))) violations.push(`${relative(root, file)} has undeclared dependency ${specifier}`)
        if (specifier.startsWith('dsh-mnemon') && !(provider ? providerImports : coreImports).has(specifier)) {
          violations.push(`${relative(root, file)} crosses its public contract: ${specifier}`)
        }
      }
      if (file.includes(`${sep}src${sep}`) && /\.(?:binding|mnemonMemorySpace)\b/u.test(readFileSync(file, 'utf8'))) {
        violations.push(`${relative(root, file)} reaches into a Host business binding`)
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps the pure Core import closure independent of Sources, Providers, clients and the default bundle', () => {
    const pending = [join(root, 'src/core.ts')]
    const visited = new Set<string>()
    const allowed = ['packages/contracts', 'packages/extension-sdk', 'packages/kernel'].map(directory => join(root, directory))
    const violations: string[] = []
    while (pending.length > 0) {
      const file = pending.pop()!
      if (visited.has(file)) continue
      visited.add(file)
      if (!allowed.some(directory => inside(directory, file)) && !['src/core.ts', 'src/composable/turns.ts'].includes(relative(root, file))) {
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
})
