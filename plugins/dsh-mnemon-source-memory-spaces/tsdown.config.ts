import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const CSS_RUNTIME_ID = '\0source-css-runtime.mjs'
const CSS_VIRTUAL_PREFIX = '\0source-css:'
const LOCALE_VIRTUAL_PREFIX = '\0source-locales:'

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

function compactLocaleJsonModule(raw: unknown, filePath: string): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Expected locale table object in ${filePath}`)
  }
  const localeIds = Object.keys(raw).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (localeIds.length === 0) throw new Error(`Expected at least one locale dictionary in ${filePath}`)
  const entries = raw as Record<string, unknown>
  const first = entries[localeIds[0]!]
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    throw new Error(`Expected locale dictionary object for ${localeIds[0]} in ${filePath}`)
  }
  const keys = Object.keys(first).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const valuesByLocale: Record<string, string[]> = {}
  for (const localeId of localeIds) {
    if (localeId === '__proto__') throw new Error(`Unsupported locale id in ${filePath}`)
    const dictionary = entries[localeId]
    if (typeof dictionary !== 'object' || dictionary === null || Array.isArray(dictionary)) {
      throw new Error(`Expected locale dictionary object for ${localeId} in ${filePath}`)
    }
    const record = dictionary as Record<string, unknown>
    if (Object.keys(record).length !== keys.length) {
      throw new Error(`Locale ${localeId} key count does not match expected ${keys.length} in ${filePath}`)
    }
    valuesByLocale[localeId] = keys.map(key => {
      const value = Object.hasOwn(record, key) ? record[key] : undefined
      if (key === '__proto__' || typeof value !== 'string') {
        throw new Error(`Expected string entry for ${localeId}.${key} in ${filePath}`)
      }
      return value
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
    'export default /* @__PURE__ */ Object.defineProperties({}, {',
    `  ${descriptors}`,
    '});',
  ].join('\n')
}

export default defineConfig([
{
  entry: ['src/native-cli.ts', 'src/contracts.ts', 'src/index.ts', 'src/provider-sdk.ts', 'src/testing.ts', 'src/space-identity.ts'], outDir: 'lib', format: 'esm', platform: 'node',
  target: 'es2024', dts: true, clean: true, fixedExtension: false, deps: { neverBundle: true },
},
{
  entry: { client: 'src/client.ts' }, outDir: 'lib', format: 'cjs', platform: 'browser',
  target: 'es2022', minify: true, dts: false, clean: false, fixedExtension: false,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: { neverBundle: true },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },

  plugins: [{
    name: 'source-presentation',
    resolveId(source: string, importer: string | undefined) {
      if (source === CSS_RUNTIME_ID) return CSS_RUNTIME_ID
      if (importer === undefined) return null
      if (source.endsWith('.module.css')) return CSS_VIRTUAL_PREFIX + resolve(dirname(importer), source) + '.mjs'
      if (source.endsWith('/presentation/locales.json')) return LOCALE_VIRTUAL_PREFIX + resolve(dirname(importer), source) + '.mjs'
      return null
    },
    async load(id: string) {
      if (id === CSS_RUNTIME_ID) return lazyCssRuntimeCode()
      if (id.startsWith(LOCALE_VIRTUAL_PREFIX)) {
        const path = id.slice(LOCALE_VIRTUAL_PREFIX.length, -'.mjs'.length)
        this.addWatchFile(path)
        return { code: compactLocaleJsonModule(JSON.parse(await readFile(path, 'utf8')), path), moduleType: 'js' as const }
      }
      if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const path = id.slice(CSS_VIRTUAL_PREFIX.length, -'.mjs'.length)
      this.addWatchFile(path)
      const file = basename(path)
      const filename = file === 'page.module.css' ? 'src/client/MnemonView.module.css' : 'src/client/MnemonSidebarView.module.css'
      const order = file === 'page.module.css' ? 30 : 50
      const { code, exports } = transform({ filename, code: await readFile(path), cssModules: { pattern: '[hash]_[local]' }, minify: true })
      const classes = Object.fromEntries(Object.entries(exports ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, value.name]))
      return [
        `import { lazyCssModule } from ${JSON.stringify(CSS_RUNTIME_ID)};`,
        `export default /* @__PURE__ */ lazyCssModule(${JSON.stringify('dsh-mnemon-source-memory-spaces/presentation/' + file)}, ${order}, ${JSON.stringify(code.toString())}, ${JSON.stringify(classes)});`,
      ].join('\n')
    },
  }],
  outputOptions: {
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mnemon-source-memory-spaces", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
},
])
