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
const executables = Object.values(manifest.bin ?? {})
const required = [...executables, ...locales, 'package.json', 'cordis.patch.yml', 'lib/client.js', ...Object.entries(manifest.exports)
  .filter(([name]) => name !== './package.json' && name !== localeExport)
  .flatMap(([, value]) => [value.default.slice(2), value.types.slice(2)])]

const allowedRootFiles = new Set(['package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'README.zh-CN.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md'])
const missing = required.filter(path => !paths.includes(path))
const unexpected = paths.filter(path => !allowedRootFiles.has(path) && !executables.includes(path) && !locales.includes(path) && !(/^lib\/.+\.(?:js|d\.ts)$/.test(path)))
const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const hostLeaks = ['require("node:', "require('node:", '#region src/host/version-updates.ts', '#region src/host/rpc.ts']
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

// Core/Host and the shared page kit only; Source/Provider implementations must
// ship in their own artifacts. Keep a bounded budget, not the old monolith size.
// Includes the bounded legacy Session copy-repair executable and its bilingual
// recovery instructions; Source implementations remain independent artifacts.
// Runtime archive preflight and compensation add bounded Host recovery code.
// The review publication/guard helper adds about 4 KB of Host-only code.
// Audited legacy repair, including recorded-ID chain proofs, stays in the
// maintenance executable. Its measured growth is ~24 KB over the null-name
// repair baseline; retain ~2.2 KB for the separately verified Host grant fix.
// No Source implementation enters the Starter.
// Bounded idle review adds Host checkpoint/receipt handling, budgets and the
// bilingual settings/status UI: measured 1,335,573 bytes (+19,717), with no
// Source implementation included. Retain less than 3 KB of headroom.
// Public DSH session binding, reactive settings context and list-slot guards
// bring the measured package to 1,338,363 bytes (+2,624). Keep less than 1 KB
// of headroom; Source implementations still ship only in their own packages.
// Config-backed settings, retained-backup recovery, composition replay and
// icon/Session compatibility bring the measured baseline to 1,370,778 bytes.
// Explicit Team compatibility, complete user checkpoints and bilingual settings
// add 2,872 bytes, for 1,373,650 total and 2,350 bytes of headroom. Source and
// framework implementations stay external; the artifact still has 49 files.
const maximumUnpackedBytes = 1_376_000

if (missing.length > 0 || unexpected.length > 0 || hostLeaks.length > 0 || relativeReadmeImages.length > 0 || pack.unpackedSize > maximumUnpackedBytes) {
  if (missing.length > 0) console.error(`Missing package files:\n${missing.map(path => `- ${path}`).join('\n')}`)
  if (unexpected.length > 0) console.error(`Unexpected package files:\n${unexpected.map(path => `- ${path}`).join('\n')}`)
  if (hostLeaks.length > 0) console.error(`Host-only code leaked into lib/client.js:\n${hostLeaks.map(pattern => `- ${pattern}`).join('\n')}`)
  if (relativeReadmeImages.length > 0) console.error(`README images must use absolute HTTPS URLs so npm can render assets excluded from the package:\n${relativeReadmeImages.map(image => `- ${image}`).join('\n')}`)
  if (pack.unpackedSize > maximumUnpackedBytes) console.error(`Unpacked package is ${pack.unpackedSize} bytes; expected at most ${maximumUnpackedBytes}.`)
  process.exit(1)
}

console.log(`Verified package contents: ${pack.entryCount} files, ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes.`)
