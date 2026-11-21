import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as notes from '../lib/external-source.js'

const run = promisify(execFile)

describe('bundled external Source without its Host (#507)', () => {
  it('imports with no Mnemon package and waits for its required service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mnemon-absent-host-'))
    try {
      await cp(new URL('../lib/', import.meta.url), directory, { recursive: true })
      const entry = pathToFileURL(join(directory, 'external-source.js')).href
      const cordis = pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/cordis')).href
      const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict'
        import { Context } from ${JSON.stringify(cordis)}
        const source = await import(${JSON.stringify(entry)})
        assert.deepEqual(source.inject, ['mnemonMemory'])
        assert.equal(JSON.parse(JSON.stringify(source.memoryPlugin)).packageName, source.name)
        let applied = false
        const ctx = new Context()
        const fiber = ctx.plugin({ ...source, apply(...args) { applied = true; return source.apply(...args) } }, { path: 'not-read-while-waiting' })
        await fiber.await()
        assert.equal(applied, false)
        await fiber.dispose()
        console.log('External Source imported without Mnemon and remained waiting for mnemonMemory.')
      `], { cwd: directory, env: { ...process.env, NODE_PATH: '' }, timeout: 10_000 })
      expect(stdout).toContain('remained waiting for mnemonMemory')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('registers when the service appears, cleans up when it leaves, and can reactivate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mnemon-source-service-'))
    const ctx = new Context()
    const cleanup = vi.fn()
    const installContributions = vi.fn(() => cleanup)
    ctx.provide('loader', { locate: () => 'external-notes' })
    const source = ctx.plugin(notes, { path: join(directory, 'notes.txt') })
    const host = { name: 'fixture-host', apply(ctx: Context) { ctx.provide('mnemonMemory', { installContributions }) } }
    let service: ReturnType<Context['plugin']> | undefined
    try {
      await source.await()
      expect(installContributions).not.toHaveBeenCalled()
      service = ctx.plugin(host)
      await service.await()
      await source.await()
      expect(installContributions).toHaveBeenCalledTimes(1)
      expect(installContributions.mock.calls[0]).toEqual([
        expect.objectContaining({ plugin: expect.objectContaining({ packageName: notes.name }), sources: [expect.any(Object)] }),
        expect.objectContaining({ instanceId: 'external-notes' }),
      ])
      await service.dispose()
      await source.await()
      expect(cleanup).toHaveBeenCalledTimes(1)
      service = ctx.plugin(host)
      await service.await()
      await source.await()
      expect(installContributions).toHaveBeenCalledTimes(2)
      await source.dispose()
      expect(cleanup).toHaveBeenCalledTimes(2)
    } finally {
      await source.dispose()
      await service?.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
