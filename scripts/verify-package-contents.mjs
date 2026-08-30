import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

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
const required = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/core.js',
  'lib/source-runtime.js',
  'lib/source-documents.js',
  'lib/source-memory-spaces.js',
  'lib/source-memory-spaces/provider-sdk.js',
  'lib/view-strategy-default-three-tier.js',
  'lib/client.js',
  'lib/contracts.js',
  'lib/kernel.js',
  'lib/extension-sdk.js',
  'lib/provider-sdk.js',
  'lib/strategy-sdk.js',
  'lib/strategy-default-three-tier.js',
  'lib/layers/runtime.js',
  'lib/layers/documents.js',
  'lib/layers/memory-spaces.js',
  'lib/types/src/index.d.ts',
  'lib/types/src/core.d.ts',
  'lib/types/src/plugins/source-runtime.d.ts',
  'lib/types/src/plugins/source-documents.d.ts',
  'lib/types/src/plugins/source-memory-spaces.d.ts',
  'lib/types/src/memory-spaces/provider-sdk.d.ts',
  'lib/types/src/plugins/strategy-default-three-tier.d.ts',
  'lib/types/src/client/index.d.ts',
]
const allowedRootFiles = new Set(['package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'README.zh-CN.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md'])
const missing = required.filter(path => !paths.includes(path))
const unexpected = paths.filter(path => !allowedRootFiles.has(path) && !(/^lib\/.+\.(?:js|d\.ts)$/.test(path)))
const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const hostLeaks = ['require("node:', "require('node:", '#region src/version-updates.ts', '#region src/rpc.ts']
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

// Independent Source pages share the existing styles/locales, rather than
// duplicating the UI. Their public page kit and artifact test fixture lift the
// measured default distribution from 1.986 MB to about 2.003 MB. Keep 1% room.
const maximumUnpackedBytes = 2_030_000

if (missing.length > 0 || unexpected.length > 0 || hostLeaks.length > 0 || relativeReadmeImages.length > 0 || pack.unpackedSize > maximumUnpackedBytes) {
  if (missing.length > 0) console.error(`Missing package files:\n${missing.map(path => `- ${path}`).join('\n')}`)
  if (unexpected.length > 0) console.error(`Unexpected package files:\n${unexpected.map(path => `- ${path}`).join('\n')}`)
  if (hostLeaks.length > 0) console.error(`Host-only code leaked into lib/client.js:\n${hostLeaks.map(pattern => `- ${pattern}`).join('\n')}`)
  if (relativeReadmeImages.length > 0) console.error(`README images must use absolute HTTPS URLs so npm can render assets excluded from the package:\n${relativeReadmeImages.map(image => `- ${image}`).join('\n')}`)
  if (pack.unpackedSize > maximumUnpackedBytes) console.error(`Unpacked package is ${pack.unpackedSize} bytes; expected at most ${maximumUnpackedBytes}.`)
  process.exit(1)
}

console.log(`Verified package contents: ${pack.entryCount} files, ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes.`)
