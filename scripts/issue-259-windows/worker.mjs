import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const [configFile, phase] = process.argv.slice(2)
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const destination = `${config.outputDir}/${phase}-result.json`
const output = { phase, platform: process.platform, node: process.version, uv: process.versions.uv, pid: process.pid }
try {
  assert.equal(process.platform, 'win32')
  writeFileSync(`${config.outputDir}/${phase}-ready`, String(process.pid))
  await setTimeout(350)
  if (phase === 'positive-control') {
    await setTimeout(1500)
    output.success = true
  } else {
    const variant = phase.split('-')[0]
    const { resolveGitBranch } = await import(pathToFileURL(config[`${variant}Module`]).href)
    const started = performance.now()
    const values = []
    for (let i = 0; i < config.repetitions; i++) values.push(resolveGitBranch(config.fixture))
    assert.deepEqual(values, Array(config.repetitions).fill('console-probe'))
    const behaviors = {
      padded: resolveGitBranch(`  ${config.fixture}  `),
      absent: resolveGitBranch() ?? null,
      blank: resolveGitBranch('  ') ?? null,
      detached: resolveGitBranch(config.detached) ?? null,
      nonRepository: resolveGitBranch(config.nonRepository) ?? null,
      nonexistent: resolveGitBranch(`${config.fixture}/absent-directory`) ?? null,
    }
    assert.deepEqual(behaviors, { padded: 'console-probe', absent: null, blank: null, detached: null, nonRepository: null, nonexistent: null })
    Object.assign(output, { variant, probes: values.length, branch: values[0], behaviors, elapsedMs: performance.now() - started, success: true })
  }
} catch (error) {
  output.success = false
  output.error = String(error.stack ?? error)
  process.exitCode = 1
} finally {
  writeFileSync(destination, JSON.stringify(output, null, 2))
}
