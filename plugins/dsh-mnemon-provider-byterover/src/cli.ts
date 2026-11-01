import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const INSTALL_GUIDANCE = 'Install ByteRover with npm install -g byterover-cli, ensure its directory is on PATH, or set cliPath to its brv.cmd or executable.'

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** npm batch shims cannot run with shell:false; execute their verified JS entry. */
export function resolveByteRoverInvocation(command: string, args: readonly string[], env: NodeJS.ProcessEnv): {
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
        const candidate = join(root, name)
        if (isFile(candidate)) { found = candidate; break }
      }
      if (found !== undefined) break
    }
    if (found === undefined) throw new Error(`ByteRover brv was not found. ${INSTALL_GUIDANCE}`)
    command = found
  }
  if (!/\.cmd$/i.test(command)) return { command, args: [...args], env }
  const root = join(dirname(command), 'node_modules', 'byterover-cli')
  const launcher = join(root, 'bin', 'run.js')
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; bin?: { brv?: string } }
    const bin = pkg.bin?.brv?.replace(/^\.\//, '')
    const shim = readFileSync(command, 'utf8').replaceAll('\\', '/')
    if (pkg.name === 'byterover-cli' && bin === 'bin/run.js' && isFile(launcher)
      && /"%(?:dp0%|~dp0)\/node_modules\/byterover-cli\/bin\/run\.js"/i.test(shim)) {
      // process.execPath may be the Desktop Host's Electron executable. Windows
      // environment names are case-insensitive, so emit only one spelling.
      const inherited = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'))
      return { command: process.execPath, args: [launcher, ...args], env: { ...inherited, ELECTRON_RUN_AS_NODE: '1' } }
    }
  } catch {}
  throw new Error(`ByteRover cliPath is not a recognized npm brv.cmd launcher. ${INSTALL_GUIDANCE}`)
}
