// Isolate the older Node 24 macOS behavior seen in independent Source tests.
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const directory = mkdtempSync(join(tmpdir(), 'mnemon-node-symlink-'))
const target = join(directory, 'target'), link = join(directory, 'link')
const result = { node: process.version, platform: process.platform, arch: process.arch }
try {
  mkdirSync(target)
  symlinkSync(target, link, 'dir')
  try { rmSync(link); result.linkRemoved = true } catch (error) { result.linkRemoved = false; result.errorCode = error.code }
  result.targetRetained = existsSync(target)
  console.log(JSON.stringify(result))
} finally { rmSync(directory, { recursive: true, force: true }) }
