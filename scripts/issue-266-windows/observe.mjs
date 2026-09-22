import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalWorkspacePath, workspaceStorageId } from '../../src/host/workspace-storage.ts'

const phase = process.argv[2]
assert.ok(phase === 'baseline' || phase === 'fixed')
assert.equal(process.platform, 'win32', 'This observation requires a real Windows filesystem')
const root = mkdtempSync(join(tmpdir(), 'mnemon-issue-266-'))
const file = join(root, 'file')
const workspace = join(root, 'workspace')
const alias = join(root, 'alias')
const summarize = (operation) => {
  try { return { returned: operation() } }
  catch (error) { return { threw: true, code: error.code ?? null, errno: error.errno ?? null } }
}
try {
  mkdirSync(workspace)
  writeFileSync(file, 'retained')
  symlinkSync(workspace, alias, 'junction')
  const paths = [
    ['empty', '', true],
    ['relative', '../escape', true],
    ['nul', join(root, 'invalid\0'), true],
    ['file-child', join(file, 'child'), true],
    ['file-deeper', join(file, 'child', 'deeper'), true],
    ['unicode-missing', join(root, '项目 with spaces'), false],
    ['existing-file', file, false],
    ['missing-deeper', join(root, 'missing', 'deeper'), false],
    ['existing-root', root, false],
    ['workspace', workspace, false],
    ['junction', alias, false],
    ['junction-missing', join(alias, 'missing', '项目 with spaces'), false],
  ]
  const cases = paths.map(([name, path, shouldThrow]) => {
    const result = summarize(() => workspaceStorageId(path))
    return { name, shouldThrow, ...result, passed: shouldThrow ? result.threw === true : /^[0-9a-f]{64}$/u.test(result.returned) }
  })
  const native = [
    { name: 'file-child', ...summarize(() => realpathSync.native(join(file, 'child'))) },
    { name: 'file-ancestor', ...summarize(() => realpathSync.native(file).replace(realpathSync.native(root), '<fixture>')) },
  ]
  assert.equal(workspaceStorageId(alias), workspaceStorageId(workspace))
  assert.equal(workspaceStorageId(join(alias, 'missing', '项目 with spaces')), workspaceStorageId(join(workspace, 'missing', '项目 with spaces')))
  assert.equal(canonicalWorkspacePath(file), realpathSync.native(file))
  assert.equal(readFileSync(file, 'utf8'), 'retained')
  const report = {
    phase, platform: process.platform, osRelease: release(), node: process.version, libuv: process.versions.uv,
    sourceSha256: createHash('sha256').update(readFileSync(new URL('../../src/host/workspace-storage.ts', import.meta.url))).digest('hex'),
    native, cases, contractFailures: cases.filter(row => !row.passed).map(row => row.name),
    junctionAliasesMatch: true, originalFileRetained: true,
  }
  mkdirSync('issue-266-results', { recursive: true })
  writeFileSync('issue-266-results/native.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  assert.equal(native[0].code, 'ENOENT')
  assert.equal(native[1].returned, '<fixture>\\file')
  assert.deepEqual(report.contractFailures, phase === 'baseline' ? ['file-child', 'file-deeper'] : [])
  if (phase === 'fixed') {
    for (const name of ['file-child', 'file-deeper']) assert.equal(cases.find(row => row.name === name).code, 'ENOTDIR')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
