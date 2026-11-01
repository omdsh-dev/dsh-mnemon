import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const INSTALL_GUIDANCE = 'Install ByteRover with npm install -g byterover-cli, ensure its directory is on PATH, or set cliPath to its brv.cmd or executable.'

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** npm batch shims cannot run with shell:false; execute their verified JS entry. */
export function resolveByteRoverInvocation(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd = process.cwd()): {
  command: string; args: string[]; env: NodeJS.ProcessEnv
} {
  if (process.platform !== 'win32') return { command, args: [...args], env }
  if (/^brv(?:\.cmd)?$/i.test(command)) {
    const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
    let found: string | undefined
    for (const directory of path.split(';')) {
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
    const target = /"%(?:dp0%|~dp0)\/(node_modules\/byterover-cli|\.\.\/byterover-cli)\/bin\/run\.js"/i.exec(shim)?.[1]
    if (target === undefined) throw new Error('Unrecognized npm shim target')
    const root = resolve(dirname(command), target)
    const launcher = join(root, 'bin', 'run.js')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; bin?: { brv?: string } }
    const bin = pkg.bin?.brv?.replace(/^\.\//, '')
    if (pkg.name === 'byterover-cli' && bin === 'bin/run.js' && isFile(launcher)) {
      // process.execPath may be the Desktop Host's Electron executable. Windows
      // environment names are case-insensitive, so emit only one spelling.
      const inherited = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'))
      return { command: process.execPath, args: [launcher, ...args], env: { ...inherited, ELECTRON_RUN_AS_NODE: '1' } }
    }
  } catch {}
  throw new Error(`ByteRover cliPath is not a recognized npm brv.cmd launcher. ${INSTALL_GUIDANCE}`)
}
