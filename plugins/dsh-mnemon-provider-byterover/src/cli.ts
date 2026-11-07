import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const INSTALL_GUIDANCE = 'Install ByteRover with npm install -g byterover-cli or pnpm add -g byterover-cli. Ensure DSH can see PATH or PNPM_HOME, or set cliPath to its brv.cmd or executable.'

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

function globalBins(env: NodeJS.ProcessEnv): string[] {
  const directory = (name: string): string | undefined => {
    const value = Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]?.trim().replace(/^"(.*)"$/, '$1')
    return value !== undefined && isAbsolute(value) ? value : undefined
  }
  const pnpm = directory('PNPM_HOME')
  const local = directory('LOCALAPPDATA') ?? join(homedir(), 'AppData', 'Local')
  const roaming = directory('APPDATA') ?? join(homedir(), 'AppData', 'Roaming')
  return [pnpm, pnpm === undefined ? undefined : join(pnpm, 'bin'), directory('NVM_SYMLINK'),
    join(local, 'pnpm'), join(local, 'pnpm', 'bin'), join(roaming, 'npm')].filter((value): value is string => value !== undefined)
}

/** npm/pnpm batch shims cannot run with shell:false; execute their verified JS entry. */
export function resolveByteRoverInvocation(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd = process.cwd()): {
  command: string; args: string[]; env: NodeJS.ProcessEnv
} {
  if (process.platform !== 'win32') return { command, args: [...args], env }
  // Leave explicit executable names/paths on the existing process route.
  if (/^brv(?:\.cmd)?$/i.test(command)) {
    const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
    let found: string | undefined
    for (const directory of [...path.split(';'), ...globalBins(env)]) {
      if (directory === '') continue
      const root = directory.replace(/^"(.*)"$/, '$1')
      for (const name of /\.cmd$/i.test(command) ? ['brv.cmd'] : ['brv.exe', 'brv.cmd']) {
        // Windows resolves relative PATH entries from the child's cwd.
        const candidate = resolve(cwd, root, name)
        if (isFile(candidate)) { found = candidate; break }
      }
      if (found !== undefined) break
    }
    if (found === undefined) throw new Error(`ByteRover brv was not found. ${INSTALL_GUIDANCE}`)
    command = found
  }
  if (!/\.cmd$/i.test(command)) return { command, args: [...args], env }
  // Validate the same explicit path that the subprocess would see, then keep
  // its JS entry absolute when Node starts in the knowledge directory.
  command = resolve(cwd, command)
  try {
    const shim = readFileSync(command, 'utf8').replaceAll('\\', '/')
    const launchers = new Set<string>()
    for (const match of shim.matchAll(/"([^"\r\n]+)"/g)) {
      let target = match[1]!
      if (!target.endsWith('/bin/run.js')) continue
      if (/^%(?:dp0%|~dp0)\//i.test(target)) target = target.replace(/^%(?:dp0%|~dp0)\//i, '')
      else if (!isAbsolute(target)) continue
      if (target.includes('%')) continue
      const launcher = resolve(dirname(command), target)
      const pkg = JSON.parse(readFileSync(join(dirname(dirname(launcher)), 'package.json'), 'utf8')) as { name?: string; bin?: { brv?: string } }
      const bin = pkg.bin?.brv
      if (pkg.name === 'byterover-cli' && typeof bin === 'string' && bin.replace(/^\.\//, '') === 'bin/run.js' && isFile(launcher)) launchers.add(realpathSync(launcher))
    }
    if (launchers.size === 1) {
      // process.execPath may be the Desktop Host's Electron executable. Windows
      // environment names are case-insensitive, so emit only one spelling.
      const inherited = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'))
      return { command: process.execPath, args: [[...launchers][0]!, ...args], env: { ...inherited, ELECTRON_RUN_AS_NODE: '1' } }
    }
  } catch {}
  throw new Error(`ByteRover cliPath is not a recognized npm/pnpm brv.cmd launcher. ${INSTALL_GUIDANCE}`)
}
