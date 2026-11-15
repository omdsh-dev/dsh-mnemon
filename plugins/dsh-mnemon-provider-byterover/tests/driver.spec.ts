import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture, mountMemorySpaceProvider } from 'dsh-mnemon-source-memory-spaces/testing'
import type { MemorySpaceAuthority, ProcessRunner } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import module, { ByteRoverProvider, definition, descriptor } from '../src/index.ts'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('standalone byterover data plane', () => {
  it('runs ByteRover through a shell-free scoped CLI boundary', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-byterover-'))
    temporaryDirectories.push(dataDir)
    const calls: Array<{ command: string; args: readonly string[]; options: Parameters<ProcessRunner>[2] }> = []
    const process = vi.fn<ProcessRunner>(async (command, args, options) => {
      calls.push({ command, args, options })
      if (args[0] === 'status') return { stdout: 'ByteRover ready', stderr: '', exitCode: 0 }
      if (args[0] === 'query') return { stdout: 'Past context: use a staged rollout before production deployment.', stderr: '', exitCode: 0 }
      if (args[0] === 'curate') return { stdout: 'Curated', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: 'unknown', exitCode: 1 }
    })

    const { authority: registry, body } = createMemorySpaceProviderFixture(descriptor, { cliPath: '/opt/byterover/bin/brv', workingDirectory: 'brv-space', apiKey: 'brv-secret' }, { dataDir, instanceId: 'work-account' })
    const provider = new ByteRoverProvider(registry, { process, queryTimeoutMs: 1_000, curateTimeoutMs: 2_000 })

    expect(definition.manifest.scoreSemantics).toBe('provider-native')
    expect(provider.scoreSemantics).toEqual({ kind: 'provider-native' })

    await expect(provider.status(body)).resolves.toEqual({ healthy: true })
    await expect(provider.status(body)).resolves.toEqual({ healthy: true })
    expect(calls.filter(call => call.args[0] === 'status')).toHaveLength(1)
    const recalled = await provider.search(body, { query: 'How should we deploy?' })
    expect(recalled.results).toEqual([expect.objectContaining({ id: expect.stringMatching(/^byterover:/), category: 'context' })])
    expect(recalled.results[0]?.score).toBeUndefined()
    expect(JSON.stringify(recalled)).not.toContain('brv-secret')
    await expect(provider.remember(body, { content: 'Always use staged rollout.' })).resolves.toMatchObject({ action: 'stored' })
    // `remember` invalidates the cached status automatically so subsequent health probes reflect writes.
    await expect(provider.status(body)).resolves.toEqual({ healthy: true })
    expect(calls.filter(call => call.args[0] === 'status')).toHaveLength(2)
    await expect(provider.graph(body)).resolves.toMatchObject({ nodes: [], edges: [] })

    expect(calls[1]).toMatchObject({ command: '/opt/byterover/bin/brv', args: ['query', '--', 'How should we deploy?'] })
    expect(calls[1]?.options.cwd).toBe(resolve(dataDir, 'brv-space'))
    expect(calls[1]?.options.env?.BRV_API_KEY).toBe('brv-secret')
    expect(calls[1]?.options.label).toBe('ByteRover')
    provider.invalidateStatus(body.id)
    await expect(provider.status(body)).resolves.toEqual({ healthy: true })
    expect(calls.filter(call => call.args[0] === 'status')).toHaveLength(3)
  })

  it('treats ByteRover no-relevant-context CLI messages as empty recall instead of a high-confidence hit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-byterover-empty-'))
    temporaryDirectories.push(dataDir)
    const process = vi.fn<ProcessRunner>(async (_command, args) => {
      if (args[0] === 'query') return { stdout: 'No relevant context found in the knowledge tree.', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: 'unknown', exitCode: 1 }
    })
    const { authority: registry, body } = createMemorySpaceProviderFixture(descriptor, { cliPath: '/opt/byterover/bin/brv' }, { dataDir })
    const provider = new ByteRoverProvider(registry, { process })
    await expect(provider.search(body, { query: 'missing topic' })).resolves.toEqual({
      results: [],
      hint: 'ByteRover found no relevant memories.',
    })
  })
})

describe('independent byterover Provider', () => {
  it('installs complete immutable metadata in one parent-owned child', async () => {
    const mounted = await mountMemorySpaceProvider(module, { instanceId: 'work', config: undefined })
    try {
      expect(mounted.descriptor).toMatchObject({ id: 'work', typeId: 'byterover', label: descriptor.label })
      expect(Object.isFrozen(mounted.manifest)).toBe(true)
      const authority: MemorySpaceAuthority = { runner: { effectiveDataDir: () => '/unused' }, list: () => [], providerConnection: () => ({}) }
      expect(mounted.createAdapter({ memoryBodies: authority, config: { timeoutMs: 200 } }).id).toBe('work')
      expect(mounted.registered).toBe(true)
      expect(definition.manifest.secrets).toEqual(descriptor.fields.filter(field => field.input === 'secret').map(field => field.key).sort())
    } finally { await mounted.dispose() }
    expect(mounted.registered).toBe(false)
  })

  it('constructs its own driver from a structural authority, without the main repository', () => {
    const authority: MemorySpaceAuthority = { runner: { effectiveDataDir: () => '/unused' }, list: () => [], providerConnection: () => ({}) }
    const adapter = definition.create({ memoryBodies: authority, config: { timeoutMs: 200 }, providerInstanceId: 'byterover', manifest: definition.manifest })
    expect(adapter).toBeInstanceOf(ByteRoverProvider)
    expect(adapter.id).toBe('byterover')
  })
})
