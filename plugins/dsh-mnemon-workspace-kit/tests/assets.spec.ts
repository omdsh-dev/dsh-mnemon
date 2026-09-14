import { createServer } from 'node:http'
import { mkdtemp, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AssetStore, readAssetUrl } from '../src/assets.ts'

describe('Source-owned assets', () => {
  it('registers bytes once, verifies reads and rejects changed files and escaping paths', async () => {
    const root=await mkdtemp(join(tmpdir(),'mnemon-assets-')), file=join(root,'note.txt'), store=new AssetStore(join(root,'objects'))
    await writeFile(file,'A synthetic attachment')
    const reference=await store.ingest({path:file},{roots:[root]})
    expect(reference).toMatchObject({name:'note.txt',mediaType:'text/plain',bytes:22})
    expect(await store.read(reference)).toEqual(Buffer.from('A synthetic attachment'))
    expect((await store.ingest({base64:Buffer.from('A synthetic attachment').toString('base64')},{})).id).toBe(reference.id)
    await writeFile(join(store.directory,reference.id),'Changed attachment!!!')
    await expect(store.read(reference)).rejects.toThrow(/changed|damaged|limit/)
    const outside=await mkdtemp(join(tmpdir(),'mnemon-outside-')), secret=join(outside,'hidden.txt');await writeFile(secret,'outside')
    await symlink(secret,join(root,'escape.txt'))
    await expect(store.ingest({path:join(root,'escape.txt')},{roots:[root]})).rejects.toThrow(/outside/)
  })
  it('bounds base64, enforces single-source input and preserves referenced or recent objects', async () => {
    const store=new AssetStore(await mkdtemp(join(tmpdir(),'mnemon-asset-retention-')),8)
    const kept=await store.ingest({base64:Buffer.from('keep').toString('base64')},{})
    await expect(store.ingest({base64:'!!!'},{})).rejects.toThrow(/base64/)
    await expect(store.ingest({base64:'eA==',url:'https://invalid.example'},{})).rejects.toThrow(/exactly one/)
    await expect(store.ingest({base64:Buffer.from('oversized').toString('base64')},{maxBytes:3})).rejects.toThrow(/oversized/)
    await expect(store.ingest({base64:Buffer.from('limit').toString('base64')},{})).rejects.toThrow(/full/)
    const old=new Date(Date.now()-3*86400000),cutoff=new Date(Date.now()-2*86400000)
    await utimes(join(store.directory,kept.id),old,old)
    expect(await store.prune(new Set([kept.id]),cutoff)).toBe(0)
    await store.ingest({base64:Buffer.from('keep').toString('base64')},{})
    expect(await store.prune(new Set(),cutoff)).toBe(0)
    await utimes(join(store.directory,kept.id),old,old)
    expect(await store.prune(new Set(),cutoff)).toBe(1)
    await expect(store.prune(new Set(),new Date())).rejects.toThrow(/grace/)
  })
  it('uses the caller’s session image resolver and applies the same byte limit', async () => {
    const store=new AssetStore(await mkdtemp(join(tmpdir(),'mnemon-session-asset-')))
    let requested:string|undefined
    const reference=await store.ingest({sessionAttachmentId:'owned-ref'},{resolveSessionImage:async id=>{requested=id;return{data:Buffer.from('image bytes'),name:'session-image.png'}}})
    expect(requested).toBe('owned-ref');expect(reference.name).toBe('session-image.png')
    await expect(store.ingest({latestSessionImage:true},{})).rejects.toThrow(/unavailable/)
  })
  it('checks every redirect origin, bounds streamed responses and cancels downloads', async () => {
    const server=createServer((request,response)=>{
      if(request.url==='/redirect'){response.writeHead(302,{location:'http://localhost:1/forbidden'});response.end();return}
      if(request.url==='/large'){response.end('x'.repeat(100));return}
      response.end('asset')
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const origin='http://127.0.0.1:'+String((server.address() as {port:number}).port)
    try {
      expect((await readAssetUrl(origin+'/small',[origin],10)).toString()).toBe('asset')
      await expect(readAssetUrl(origin+'/small',[],10)).rejects.toThrow(/origin/)
      await expect(readAssetUrl(origin+'/large',[origin],10)).rejects.toThrow(/limit/)
      await expect(readAssetUrl(origin+'/redirect',[origin],10)).rejects.toThrow(/origin/)
      const controller=new AbortController();controller.abort(new Error('cancel download'))
      await expect(readAssetUrl(origin+'/small',[origin],10,controller.signal)).rejects.toThrow(/cancel download/)
    } finally { server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())) }
  })
})
