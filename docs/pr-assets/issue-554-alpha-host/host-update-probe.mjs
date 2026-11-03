import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const host = realpathSync(process.argv[2])
const requireHost = createRequire(join(host, 'package.json'))
const { boot } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-app-boot')))
const tmp = await mkdtemp('/tmp/dsh-host-update-only-')
let ctx
try {
 await writeFile(join(tmp,'package.json'),'{"type":"module"}')
 await writeFile(join(tmp,'probe.mjs'),'export function apply(ctx, config) { ctx.provide("probe", {value:config.value}) }')
 await writeFile(join(tmp,'cordis.yml'),'- id: probe\n  name: ./probe.mjs\n  config:\n    value: 1\n')
 ctx = await boot('dsh',join(tmp,'cordis.yml'),[])
 console.log(JSON.stringify({step:'startup',dsh:requireHost('@deepseek-ai/dsh/package.json').version,cordis:requireHost('@deepseek-ai/cordis/package.json').version,loader:requireHost('@deepseek-ai/cordis-plugin-loader/package.json').version,value:ctx.get('probe')?.value}))
 const entry = [...ctx.loader.entries()].find(e=>e.options.id==='probe')
 await entry.fiber.update({value:2})
 await ctx.loader.await()
 console.log(JSON.stringify({step:'updated',value:ctx.get('probe')?.value}))
} catch(error) {console.error(error.stack);process.exitCode=1}
finally {await ctx?.fiber.dispose();await rm(tmp,{recursive:true,force:true})}
