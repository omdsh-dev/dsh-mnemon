import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type * as SDK from 'dsh-mnemon/extension-sdk'

vi.mock('dsh-mnemon/extension-sdk', async original => ({ ...await original<typeof SDK>(), reserveMemoryProjection: undefined }))
import { createRuntimeMemorySource } from '../src/source.ts'
import { RuntimeMemoryController } from '../src/controller.ts'

it('keeps unpinned use available on an older SDK and refuses unsafe pin activation or maintenance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mnemon-pin-older-sdk-'))
  try {
    const source = createRuntimeMemorySource({ dataDir: directory }).create({ sourceInstanceKey: 'source:test', provenance: { packageName: 'dsh-mnemon-source-runtime', entryId: 'test' } })
    const base = { scope: { storage: 'custom' as const }, sourceInstanceKey: 'source:test', mode: 'mutate' as const, confirmed: true }
    await source.manage!({ ...base, operation: 'mutate', input: { action: 'add', target: 'memory', content: 'Original rule.' } })
    const controller = new RuntimeMemoryController({ effectiveDataDir: () => directory })
    await expect(source.manage!({ ...base, operation: 'pin', input: { target: 'memory', content: 'Original rule.', pinned: true } })).rejects.toThrow('newer dsh-mnemon Host')
    expect(controller.snapshot().entries[0]).not.toHaveProperty('pinned')
    await controller.setPinned('memory', 'Original rule.', true)
    await expect(source.manage!({ ...base, mode: 'read', operation: 'maintenance-plan', input: { action: 'add', target: 'memory', content: 'Pending' } })).rejects.toThrow('newer dsh-mnemon Host')
    await source.manage!({ ...base, operation: 'pin', input: { target: 'memory', content: 'Original rule.', pinned: false } })
    expect(controller.snapshot().entries[0]?.pinned).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
