import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig, TsdownPlugin } from 'tsdown'
import { transform } from 'lightningcss'
import ts from 'typescript'

const PLUGIN_ID = 'dsh-mnemon'
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))
const CLIENT_EXTERNALS = [
  /^react(?:\/.*)?$/,
  /^react-dom(?:\/.*)?$/,
  /^@deepseek-ai\/dsh-client-ui-primitives(?:\/.*)?$/,
]
const CSS_RUNTIME_ID = '\0dsh-mnemon-css-runtime.mjs'
const CSS_VIRTUAL_PREFIX = '\0dsh-mnemon-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const LOCALE_CORE_VIRTUAL_ID = '\0dsh-mnemon-locales:core.mjs'
const LOCALE_JSON_VIRTUAL_PREFIX = '\0dsh-mnemon-locales:json:'
const LOCALE_VIRTUAL_SUFFIX = '.mjs'
const CORE_LOCALE_IDS = ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'] as const
const CORE_LOCALE_CATALOG_PATH = resolvePath(PROJECT_ROOT, 'src/client/locales/catalog.ts')

const host: UserConfig = {
  name: PLUGIN_ID,
  entry: {
    index: 'src/index.ts', starter: 'src/starter.ts', bundle: 'src/bundle.ts', core: 'src/core/plugin.ts', contracts: 'src/core/contracts/index.ts',
    'extension-sdk': 'src/sdk/index.ts', testing: 'src/sdk/testing.ts',
    compaction: 'src/compaction.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  deps: { neverBundle: true },
  plugins: [standardDecoratorsPlugin()],
}

const client: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  fixedExtension: false,
  outExtensions: () => ({ js: '.js' }),
  platform: 'browser',
  target: 'es2022',
  minify: true,
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: CLIENT_EXTERNALS,
    // Source presentation assets, and what the Starter still draws of Memory Spaces (src/client/memory-spaces-client.ts),
    // taken from the pinned version's source through the tsconfig path of its public client entry.
    alwaysBundle: [/^dsh-mnemon-source-[^/]+\/presentation\//, /^dsh-mnemon-source-memory-spaces\/client$/,
      // Runtime settings share the Source's byte limits; DSH has no browser factory for its contracts entry.
      /^dsh-mnemon-source-runtime\/contracts$/],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  plugins: [clientCssPlugin(), clientLocalePlugin()],
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export function clientCssPlugin(injectStyles = true): TsdownPlugin {
  return {
    name: 'dsh-mnemon-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (source === CSS_RUNTIME_ID) return CSS_RUNTIME_ID
      if (source === 'dsh-mnemon/client') return resolvePath(PROJECT_ROOT, 'src/client/extension-sdk.ts')
      if (!source.endsWith('.module.css')) return null
      const absolute = source.startsWith('dsh-mnemon-source-')
        ? fileURLToPath(import.meta.resolve(source))
        : importer === undefined ? source : resolveAssetPath(source, importer)
      return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (virtualId === CSS_RUNTIME_ID) return lazyCssRuntimeCode()
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const filename = portableRelativePath(PROJECT_ROOT, fileId)
      const { code, exports: cssExports } = transform({
        filename: presentationNamespace(filename),
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = stableCssClassMap(cssExports)
      if (!injectStyles) return `export default ${JSON.stringify(classMap)};`
      const tagId = filename.match(/dsh-mnemon-source-[^/]+\/presentation\/[^/]+$/)?.[0] ?? `${PLUGIN_ID}/${filename}`
      return [
        `import { lazyCssModule } from ${JSON.stringify(CSS_RUNTIME_ID)};`,
        `export default /* @__PURE__ */ lazyCssModule(${JSON.stringify(tagId)}, ${cssCascadeOrder(filename)}, ${JSON.stringify(code.toString())}, ${JSON.stringify(classMap)});`,
      ].join('\n')
    },
  }
}

function clientLocalePlugin(): TsdownPlugin {
  return {
    name: 'dsh-mnemon-compact-locales',
    resolveId(source: string, importer: string | undefined) {
      if (importer === undefined) return null
      if (source.endsWith('/locales/catalog.ts') || source === './locales/catalog.ts') {
        const resolved = resolveAssetPath(source, importer)
        if (resolved === CORE_LOCALE_CATALOG_PATH) return LOCALE_CORE_VIRTUAL_ID
      }
      if (!source.endsWith('/presentation/locales.json')) return null
      const absolute = source.startsWith('dsh-mnemon-source-')
        ? fileURLToPath(import.meta.resolve(source))
        : resolveAssetPath(source, importer)
      return LOCALE_JSON_VIRTUAL_PREFIX + absolute + LOCALE_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (virtualId === LOCALE_CORE_VIRTUAL_ID) {
        const tables: Record<string, Record<string, string>> = {}
        for (const id of CORE_LOCALE_IDS) {
          const filePath = resolvePath(PROJECT_ROOT, `src/client/locales/${id}.ts`)
          this.addWatchFile(filePath)
          tables[id] = extractStaticLocaleRecord(filePath, await readFile(filePath, 'utf8'))
        }
        return { code: emitCompactLocaleModule(tables, 'export const coreLocales ='), moduleType: 'js' as const }
      }
      if (!virtualId.startsWith(LOCALE_JSON_VIRTUAL_PREFIX)) return null
      const filePath = virtualId.slice(LOCALE_JSON_VIRTUAL_PREFIX.length, -LOCALE_VIRTUAL_SUFFIX.length)
      this.addWatchFile(filePath)
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
      return { code: emitCompactLocaleModule(parseLocaleTables(parsed, filePath), 'export default'), moduleType: 'js' as const }
    },
  }
}

function lazyCssRuntimeCode(): string {
  return [
    'export function lazyCssModule(tagId, order, css, classes) {',
    '  let styleTag = null;',
    '  function ensureStyle() {',
    '    if (typeof document === "undefined") return;',
    '    if (styleTag !== null && styleTag.isConnected) return;',
    '    let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");',
    '    if (!tag) {',
    '      tag = document.createElement("style");',
    '      tag.dataset.pluginCss = tagId;',
    '      tag.dataset.pluginCssOrder = String(order);',
    '      let anchor = null;',
    '      for (const existing of document.head.querySelectorAll("style[data-plugin-css-order]")) {',
    '        if (Number(existing.dataset.pluginCssOrder) > order) { anchor = existing; break; }',
    '      }',
    '      document.head.insertBefore(tag, anchor);',
    '    } else if (!tag.dataset.pluginCssOrder) {',
    '      tag.dataset.pluginCssOrder = String(order);',
    '    }',
    '    if (tag.textContent !== css) tag.textContent = css;',
    '    styleTag = tag;',
    '  }',
    '  return new Proxy(classes, {',
    '    get(target, prop, receiver) {',
    '      if (typeof prop === "string" && Object.hasOwn(target, prop)) ensureStyle();',
    '      return Reflect.get(target, prop, receiver);',
    '    },',
    '  });',
    '}',
  ].join('\n')
}

function cssCascadeOrder(filename: string): number {
  if (filename === 'src/client/MnemonSettingsCard.module.css') return 10
  if (filename === 'src/client/MnemonView.module.css') return 20
  if (/dsh-mnemon-source-[^/]+\/presentation\/page\.module\.css$/.test(filename)) return 30
  if (filename === 'src/client/MnemonSidebarView.module.css') return 40
  if (/dsh-mnemon-source-[^/]+\/presentation\/sidebar\.module\.css$/.test(filename)) return 50
  return 60
}

function extractStaticLocaleRecord(filePath: string, source: string): Record<string, string> {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true)
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      let initializer = declaration.initializer
      while (initializer !== undefined && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))) {
        initializer = initializer.expression
      }
      if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) continue
      const entries: Record<string, string> = {}
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property)) {
          throw new Error(`Unsupported locale property in ${filePath}: ${property.getText(sourceFile)}`)
        }
        const key = ts.isStringLiteral(property.name) || ts.isNoSubstitutionTemplateLiteral(property.name) || ts.isIdentifier(property.name)
          ? property.name.text
          : undefined
        const value = ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)
          ? property.initializer.text
          : undefined
        if (key === undefined || value === undefined || key === '__proto__') {
          throw new Error(`Unsupported static locale entry in ${filePath}: ${property.getText(sourceFile)}`)
        }
        entries[key] = value
      }
      return entries
    }
  }
  throw new Error(`No static locale record found in ${filePath}`)
}

function parseLocaleTables(raw: unknown, filePath: string): Record<string, Record<string, string>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Expected locale table object in ${filePath}`)
  }
  const tables: Record<string, Record<string, string>> = {}
  for (const [localeId, dictionary] of Object.entries(raw)) {
    if (localeId === '__proto__' || typeof dictionary !== 'object' || dictionary === null || Array.isArray(dictionary)) {
      throw new Error(`Expected locale dictionary object for ${localeId} in ${filePath}`)
    }
    const entries: Record<string, string> = {}
    for (const [key, value] of Object.entries(dictionary)) {
      if (key === '__proto__' || typeof value !== 'string') {
        throw new Error(`Expected string entry for ${localeId}.${key} in ${filePath}`)
      }
      entries[key] = value
    }
    tables[localeId] = entries
  }
  return tables
}

function emitCompactLocaleModule(tables: Record<string, Record<string, string>>, exportPrefix: string): string {
  const localeIds = Object.keys(tables).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (localeIds.length === 0) throw new Error('Expected at least one locale dictionary')
  const keys = Object.keys(tables[localeIds[0]!]!).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const valuesByLocale: Record<string, string[]> = {}
  for (const localeId of localeIds) {
    const dictionary = tables[localeId]!
    const localeKeys = Object.keys(dictionary)
    if (localeKeys.length !== keys.length) {
      throw new Error(`Locale ${localeId} key count ${localeKeys.length} does not match expected ${keys.length}`)
    }
    valuesByLocale[localeId] = keys.map(key => {
      if (!Object.hasOwn(dictionary, key)) throw new Error(`Locale ${localeId} is missing key ${key}`)
      return dictionary[key]!
    })
  }
  const descriptors = localeIds
    .map(id => `${JSON.stringify(id)}: { enumerable: true, get() { return materialize(${JSON.stringify(id)}); } }`)
    .join(',\n  ')
  return [
    `const keys = ${JSON.stringify(keys)};`,
    `const tables = ${JSON.stringify(valuesByLocale)};`,
    'const cache = Object.create(null);',
    'function materialize(id) {',
    '  let dictionary = cache[id];',
    '  if (dictionary !== undefined) return dictionary;',
    '  const values = tables[id];',
    '  if (values === undefined) return undefined;',
    '  dictionary = {};',
    '  for (let index = 0; index < keys.length; index += 1) dictionary[keys[index]] = values[index];',
    '  cache[id] = dictionary;',
    '  return dictionary;',
    '}',
    `${exportPrefix} /* @__PURE__ */ Object.defineProperties({}, {`,
    `  ${descriptors}`,
    '});',
  ].join('\n')
}

/** Lower standard decorators because Rolldown currently preserves their syntax. */
function standardDecoratorsPlugin(): TsdownPlugin {
  return {
    name: 'dsh-mnemon-standard-decorators',
    transform(code: string, id: string) {
      if (!id.replaceAll('\\', '/').endsWith('/src/host/remote-rpc.ts')) return null
      const output = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          verbatimModuleSyntax: true,
        },
      })
      return { code: output.outputText, map: null }
    },
  }
}

function resolveAssetPath(source: string, importer: string): string {
  return resolvePath(dirname(importer), source)
}

export function portableRelativePath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/')
}

export function presentationNamespace(filename: string): string {
  if (/dsh-mnemon-source-[^/]+\/presentation\/page\.module\.css$/.test(filename)) return 'src/client/MnemonView.module.css'
  if (/dsh-mnemon-source-[^/]+\/presentation\/sidebar\.module\.css$/.test(filename)) return 'src/client/MnemonSidebarView.module.css'
  return filename
}

export function stableCssClassMap(cssExports: Record<string, { name: string }> | void): Record<string, string> {
  return Object.fromEntries(Object.entries(cssExports ?? {})
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([local, exported]) => [local, exported.name]))
}

export default [host, client]
