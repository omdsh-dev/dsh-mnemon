// Dry-run pack the root package and check its files, client bundle, README images and size ceiling.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { localeExport, readPackageLocales } from './package-locales.mjs'

const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
if (result.error !== undefined) {
  console.error(result.error.message)
  process.exit(1)
}
if (result.status !== 0) {
  if (result.stderr !== undefined) process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}

const parsedPack = JSON.parse(result.stdout)
const pack = Array.isArray(parsedPack) ? parsedPack[0] : Object.values(parsedPack)[0]
const paths = pack.files.map(file => file.path)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const locales = readPackageLocales(fileURLToPath(new URL('../', import.meta.url)), manifest).map(asset => asset.path)
const details = ['locale/detail.en.md', 'locale/detail.zh.md']
const executables = Object.values(manifest.bin ?? {})
const required = [...executables, ...locales, ...details, 'package.json', 'cordis.patch.yml', 'lib/client.js', ...Object.entries(manifest.exports)
  .filter(([name]) => name !== './package.json' && name !== localeExport)
  .flatMap(([, value]) => [value.default.slice(2), value.types.slice(2)])]

const allowedRootFiles = new Set(['package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'README.zh-CN.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md'])
const missing = required.filter(path => !paths.includes(path))
const unexpected = paths.filter(path => !allowedRootFiles.has(path) && !executables.includes(path) && !locales.includes(path) && !details.includes(path) && !(/^lib\/.+\.(?:js|d\.ts)$/.test(path)))
const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const hostLeaks = ['require("node:', "require('node:", '#region src/host/version-updates.ts', '#region src/host/rpc.ts',
  'login/device/code', 'login/oauth/access_token', 'api.github.com', 'Ov23liq4i7n8UsylGRfb']
  .filter(pattern => clientBundle.includes(pattern))
const readmeFiles = ['README.md', 'README.zh-CN.md']
const relativeReadmeImages = readmeFiles.flatMap((path) => {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const markdownImages = [...source.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^)]*['"])?\)/g)]
  const htmlImages = [...source.matchAll(/<img\b[^>]*\bsrc=['"]([^'"]+)['"]/gi)]
  return [...markdownImages, ...htmlImages]
    .map(match => match[1])
    .filter(source => !/^https:\/\//.test(source))
    .map(source => `${path}: ${source}`)
})

// The Starter ships Core/Host, the client bundle and the shared page kit.
// Component implementations ship in their own packages: the Host build never
// bundles dependencies, and tests/plugin-repository-boundary.spec.ts limits
// the client bundle to presentation assets and types from component packages,
// besides the Memory Spaces settings fallback and Provider marks it takes
// through one module.
// This ceiling only catches an accident, such as a dependency bundled into
// lib/client.js. Pull requests leave it alone; a release raises it once the
// measured package comes within about 10% of it. The release branch measured
// 2,233,414 bytes at v0.5.39 (about 89% of the previous 2.5 MB ceiling).
const maximumUnpackedBytes = 3_000_000

if (missing.length > 0 || unexpected.length > 0 || hostLeaks.length > 0 || relativeReadmeImages.length > 0 || pack.unpackedSize > maximumUnpackedBytes) {
  if (missing.length > 0) console.error(`Missing package files:\n${missing.map(path => `- ${path}`).join('\n')}`)
  if (unexpected.length > 0) console.error(`Unexpected package files:\n${unexpected.map(path => `- ${path}`).join('\n')}`)
  if (hostLeaks.length > 0) console.error(`Host-only code leaked into lib/client.js:\n${hostLeaks.map(pattern => `- ${pattern}`).join('\n')}`)
  if (relativeReadmeImages.length > 0) console.error(`README images must use absolute HTTPS URLs so npm can render assets excluded from the package:\n${relativeReadmeImages.map(image => `- ${image}`).join('\n')}`)
  if (pack.unpackedSize > maximumUnpackedBytes) console.error(`Unpacked package is ${pack.unpackedSize} bytes; expected at most ${maximumUnpackedBytes}.`)
  process.exit(1)
}

console.log(`Verified package contents: ${pack.entryCount} files, ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes.`)
