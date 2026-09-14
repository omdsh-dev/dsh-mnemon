import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginBuildLayers } from './lib/plugin-build-order.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const folders = (await readdir(join(root, 'plugins'))).filter(name => name.startsWith('dsh-mnemon-')).sort()
const manifests = await Promise.all(folders.map(async name => JSON.parse(await readFile(join(root, 'plugins', name, 'package.json'), 'utf8'))))
const directories = new Map(manifests.map((manifest, index) => [manifest.name, join(root, 'plugins', folders[index])]))
const value = process.env.MNEMON_PLUGIN_BUILD_CONCURRENCY ?? '4'
if (!/^[1-9]\d*$/.test(value)) throw new Error('MNEMON_PLUGIN_BUILD_CONCURRENCY must be a positive integer')
const concurrency = Math.min(16, Number(value))
for (const layer of pluginBuildLayers(manifests)) {
  const queue = [...layer]
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const name = queue.shift()
      await new Promise((resolve, reject) => {
        const child = spawn('pnpm', ['build'], { cwd: directories.get(name), stdio: 'inherit' })
        const timer = setTimeout(() => child.kill('SIGTERM'), 180000)
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('close', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${name} build failed (${code ?? signal})`)) })
      })
      console.log(`Built ${name}`)
    }
  }))
  const failures = results.filter(value => value.status === 'rejected').map(value => value.reason)
  if (failures.length) throw new AggregateError(failures, 'Plugin builds failed')
}
console.log(`Built ${manifests.length} independent packages in dependency order.`)
