import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findMnemonCommand, resolveMnemonInvocation } from '../plugins/dsh-mnemon-source-memory-spaces/src/native-cli.ts'
import { resolveByteRoverInvocation } from '../plugins/dsh-mnemon-provider-byterover/src/cli.ts'

// Install synthetic packages with the actual pnpm used by CI. This exercises
// generated Windows shims and virtual-store links without a vendor account,
// network service, paid model, user profile, or globally installed package.
assert.equal(process.platform, 'win32', 'Run this acceptance check on Windows')
assert.ok(process.env.npm_execpath, 'Run with pnpm run verify:windows-pnpm')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mnemon pnpm acceptance ')))
try {
  const bin = join(scratch, 'global bin')
  const packs = join(scratch, 'tarballs')
  const cwd = join(scratch, 'knowledge with spaces')
  for (const directory of [bin, packs, cwd]) mkdirSync(directory, { recursive: true })
  // A single PATH spelling is necessary on Windows.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
  const path = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const installEnv = { ...inherited, PNPM_HOME: bin, PATH: `${bin};${path}` }
  const pnpm = (args, directory = scratch) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: directory, env: installEnv, encoding: 'utf8', timeout: 120_000, stdio: 'pipe',
  })
  for (const [name, command, entry] of [
    ['@mnemon-dev/mnemon', 'mnemon', 'mnemon.js'],
    ['byterover-cli', 'brv', 'run.js'],
  ]) {
    const root = join(scratch, command)
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name, version: '0.0.0', type: 'module', bin: { [command]: `bin/${entry}` },
    }))
    writeFileSync(join(root, 'bin', entry), '#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), electron: process.env.ELECTRON_RUN_AS_NODE }))\n')
    pnpm(['pack', '--pack-destination', packs], root)
  }
  pnpm(['add', '--global', '--global-dir', join(scratch, 'global'), '--global-bin-dir', bin,
    '--store-dir', join(scratch, 'store'), '--offline', '--ignore-scripts',
    ...readdirSync(packs).filter(name => name.endsWith('.tgz')).map(name => join(packs, name))])

  // Reproduce a Desktop environment without the new global bin in its PATH.
  const env = { ...inherited, PNPM_HOME: bin, PATH: '' }
  const args = ['literal & | > < ^ %PATH% !bang! $value `command` "quoted"\nsecond line']
  const mnemon = findMnemonCommand({}, { env })
  assert.equal(mnemon, join(bin, 'mnemon.cmd'))
  for (const invocation of [resolveMnemonInvocation(mnemon, args, env), resolveByteRoverInvocation('brv', args, env, cwd)]) {
    assert.equal(invocation.command, process.execPath)
    const output = execFileSync(invocation.command, invocation.args, { cwd, env: invocation.env, encoding: 'utf8', timeout: 10_000 })
    assert.deepEqual(JSON.parse(output.trim()), { args, cwd, electron: '1' })
  }
  console.log('PASS: real pnpm global installation; both CLIs discovered outside PATH; verified entries run with literal arguments and the intended cwd.')
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
