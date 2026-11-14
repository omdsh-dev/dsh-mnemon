import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryCompositionRunner, type MemoryTestTurn } from 'dsh-mnemon/testing'
import { resolveMemorySpacesConfig } from '../src/config.ts'
import type { MemorySpaceView, Insight } from '../src/contracts.ts'
import { installMemorySpaces } from '../src/index.ts'
import { findMnemonCommand } from '../src/native-cli.ts'
import { createRunner } from '../src/runner.ts'
import { strategy } from './fixture.ts'
import { nativeProviderModule } from './providers.ts'

// Opt in with a verified release binary; never discover or mutate a personal root.
const cliPath = process.env.MNEMON_NATIVE_TEST_CLI
describe.skipIf(!cliPath)('real Native Provider through Source composition', () => {
  it('creates a space, writes via a View, recalls and forgets through the real CLI', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-native-integration-'))
    const runner = new MemoryCompositionRunner()
    const turns: MemoryTestTurn[] = []
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'mnemon-native', module: nativeProviderModule, config: undefined }], {
          config: { dataDir: directory, ...(cliPath === undefined ? {} : { cliPath }), timeoutMs: 10_000 },
        })
      } }, { instanceId: 'native' })
      const management = await runner.managementClient('source:native')
      const created = await management.mutate('body-create', {
        name: 'Isolated native test', description: 'Synthetic plugin integration fixture.', providerId: 'mnemon-native', active: true,
      }, { confirmed: true })
      const body = created.value as unknown as MemorySpaceView
      const turn = await runner.beginTurn()
      turns.push(turn)
      const offer = turn.view.actionOffers.find(item => item.sourceActionId === 'remember')!
      const text = 'composablenativesentinel verifies independent Source and Provider artifacts.'
      await expect(turn.executeAction(offer.id, {
        content: text, memoryBodyId: body.id, category: 'fact', source: 'user', importance: 5,
      }, () => true)).resolves.toMatchObject({ status: 'succeeded', completion: 'committed', committedAt: expect.any(String) })
      const listed = await management.read('list', { memoryBodyIds: [body.id], limit: 10 })
      const items = (listed.value as unknown as { items: Insight[] }).items
      const stored = items.find(item => item.content === text)
      expect(stored).toBeDefined()
      const route = turn.view.routes.find(item => item.sourceRouteId === 'recall')!
      const evidence = await turn.executeRoute(route.id, {
        query: 'composablenativesentinel', mode: 'keyword', memoryBodyIds: [body.id],
      })
      expect(evidence.items.some(item => item.text.includes('composablenativesentinel'))).toBe(true)
      await management.mutate('forget', { id: stored!.id, memoryBodyId: body.id }, { confirmed: true })
      const after = await management.read('list', { memoryBodyIds: [body.id], limit: 10 })
      expect((after.value as unknown as { items: Insight[] }).items).toHaveLength(0)
    } finally {
      turns.forEach(turn => turn.release())
      await runner.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})

const windowsSmokeEnabled = process.platform === 'win32' && process.env.RUN_WINDOWS_MNEMON_SMOKE === '1'
describe.skipIf(!windowsSmokeEnabled)('Windows Mnemon integration', () => {
  const temporaryDirectories: string[] = []

  afterAll(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('discovers the verified release binary outside PATH and runs status', async () => {
    const expected = process.env.MNEMON_WINDOWS_SMOKE_PATH
    if (expected === undefined || expected === '') throw new Error('MNEMON_WINDOWS_SMOKE_PATH is required')
    expect(existsSync(expected)).toBe(true)
    expect((process.env.PATH ?? '').split(delimiter).some(directory => directory.toLowerCase() === dirname(expected).toLowerCase())).toBe(false)

    const command = findMnemonCommand({})
    expect(command?.toLowerCase()).toBe(expected.toLowerCase())

    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-windows-smoke-'))
    temporaryDirectories.push(dataDir)
    const runner = createRunner(resolveMemorySpacesConfig({ dataDir }))
    expect(runner.commandFound).toBe(true)
    await expect(runner.runText(['--version'], { globalFlags: false }))
      .resolves.toContain(`mnemon version ${process.env.MNEMON_WINDOWS_SMOKE_VERSION ?? '0.2.3'}`)
    await expect(runner.runJson(['status'])).resolves.toMatchObject({ total_insights: 0 })
  })
})
