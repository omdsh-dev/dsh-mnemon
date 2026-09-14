import { expect, it } from 'vitest'
import { pluginBuildLayers } from '../scripts/lib/plugin-build-order.mjs'
it('builds shared utilities and Strategy/Source SDKs before their consumers despite the Starter cycle', () => {
  const layers=pluginBuildLayers([
    {name:'source',dependencies:{kit:'1.0'},peerDependencies:{starter:'1.0'}},
    {name:'provider',peerDependencies:{source:'1.0',starter:'1.0'}},
    {name:'enhancement',peerDependencies:{strategy:'1.0'}},
    {name:'strategy',peerDependencies:{starter:'1.0'}},
    {name:'kit',peerDependencies:{starter:'1.0'}},
  ])
  expect(layers).toEqual([['kit','strategy'],['enhancement','source'],['provider']])
})
it('fails explicitly on an actual plugin dependency cycle', () => {
  expect(()=>pluginBuildLayers([{name:'a',dependencies:{b:'1'}},{name:'b',peerDependencies:{a:'1'}}])).toThrow('Cyclic')
})
