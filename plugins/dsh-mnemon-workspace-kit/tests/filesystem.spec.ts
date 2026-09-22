import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { allowedDirectories, readBoundedFile, resolveRipgrepPath, runBoundedProcess } from '../src/filesystem.ts'
describe('bounded process and file operations', () => {
  it('searches with the declared binary when no system command is on PATH', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mnemon-search-'))
    try {
      await writeFile(join(directory, 'note.md'), 'portable search sentinel')
      const result = await runBoundedProcess(await resolveRipgrepPath(), ['--no-config', '--fixed-strings', '--', 'portable search sentinel', directory], {
        env: { ...process.env, PATH: '' }, maxBytes: 1024,
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('portable search sentinel')
      expect(result.truncated).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('passes shell-looking text as a literal argument and bounds runaway output', async () => {
    const result = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo intrusion); literal'])
    expect(result.stdout).toBe('$(echo intrusion); literal')
    const flood = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBytes: 1024 })
    expect(flood.truncated).toBe(true); expect(flood.stdout.length).toBe(1024)
  })
  it('terminates a cancelled or timed-out process and rejects oversized reads', async () => {
    const controller = new AbortController()
    const waiting = runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal })
    controller.abort(new Error('test cancellation'))
    await expect(waiting).rejects.toThrow('test cancellation')
    await expect(runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30 })).rejects.toThrow(/timed out/)
    const dir = await mkdtemp(join(tmpdir(), 'mnemon-bounded-')); await writeFile(join(dir, 'large.txt'), 'large')
    await expect(readBoundedFile(await allowedDirectories([dir]), join(dir, 'large.txt'), 2)).rejects.toThrow(/limit/)
  })
})
