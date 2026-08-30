import { installRuntimeMemoryUI } from 'dsh-mnemon-source-runtime/client'
import { installDocumentsMemoryUI } from 'dsh-mnemon-source-documents/client'
import { installMemorySpacesUI } from 'dsh-mnemon-source-memory-spaces/client'
import type { MnemonClientContext } from '../../../src/client/dsh-compat.ts'
import type { MnemonTranslate } from '../../../src/client/locales.ts'

export const BUILTIN_MEMORY_SOURCE_PAGE_IDS = Object.freeze({
  runtime: 'runtime/entries',
  documents: 'documents/library',
  overview: 'memory-spaces/spaces',
  explore: 'memory-spaces/explore',
  entities: 'memory-spaces/entities',
  remember: 'memory-spaces/remember',
  list: 'memory-spaces/content',
})

export const BUILTIN_MEMORY_SOURCE_PAGE_ID_SET: ReadonlySet<string> = new Set(Object.values(BUILTIN_MEMORY_SOURCE_PAGE_IDS))
export const BUILTIN_MEMORY_SOURCE_TYPE_ID_SET: ReadonlySet<string> = new Set(['runtime', 'documents', 'memory-spaces'])


/** Explicit default client composition; Source packages own the page implementations. */
export function installBuiltinMemorySourceUI(ctx: MnemonClientContext, t: MnemonTranslate): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(installRuntimeMemoryUI(ctx, t, { fallback: true }))
    disposers.push(installDocumentsMemoryUI(ctx, t, { fallback: true }))
    disposers.push(installMemorySpacesUI(ctx, t, { fallback: true }))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
