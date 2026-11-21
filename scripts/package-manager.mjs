import { extname } from 'node:path'

const JAVASCRIPT_ENTRIES = new Set(['.js', '.cjs', '.mjs'])

export function packageManagerCommand(environment = process.env) {
  const npmExecPath = environment.npm_execpath
  if (npmExecPath === undefined || npmExecPath === '') {
    throw new Error('Run this check through the package manager')
  }
  if (JAVASCRIPT_ENTRIES.has(extname(npmExecPath).toLowerCase())) {
    return { command: process.execPath, args: [npmExecPath] }
  }
  return { command: npmExecPath, args: [] }
}
