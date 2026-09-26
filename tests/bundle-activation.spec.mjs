import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const fixture = fileURLToPath(new URL('./fixtures/bundle-activation.mjs', import.meta.url))

describe('published Starter activation contracts', () => {
  it('retains the legacy mnemon gate and independent component choices on the pinned DSH', async () => {
    const { stdout } = await run(process.execPath, ['--expose-internals', fixture], { timeout: 30_000 })
    expect(stdout).toContain('"result":"passed"')
  })

  it.skipIf(!process.env.MNEMON_BUNDLE_TEST_PROFILE)('persists real component and bundle toggles without bypassing the core gate', async () => {
    const { stdout } = await run(process.execPath, ['--expose-internals', fixture, process.env.MNEMON_BUNDLE_TEST_PROFILE, 'manager'], { timeout: 30_000 })
    expect(stdout).toContain('"manager":true,"result":"passed"')
  })
})
