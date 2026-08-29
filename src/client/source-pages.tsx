import type { ReactNode } from 'react'
import type { MnemonClientContext, MnemonSourcePageOwnerProps } from './dsh-compat.ts'
import type { MnemonTranslate } from './locales.ts'

export const MNEMON_SOURCE_PAGE_SLOT = 'mnemon.source.page' as const
/** Conventional operations used by Mnemon's descriptor-driven Source page. */
export const MNEMON_SOURCE_CONFIGURATION_READ = 'configuration' as const
export const MNEMON_SOURCE_CONFIGURATION_MUTATE = 'configuration' as const

const SOURCE_TYPE_ID = /^[a-z][a-z0-9-]{0,127}$/u
const PAGE_ID = /^[a-z][a-z0-9-]{0,127}$/u

export interface MemorySourcePageProps extends MnemonSourcePageOwnerProps {
  /** No Host Context, Runtime, credential, raw transport, or View grant crosses this boundary. */
}

export type MemorySourcePageComponent = (props: MemorySourcePageProps) => ReactNode

export interface MemorySourcePageDefinition {
  id: string
  label: string | (() => string)
  order?: number
  component: MemorySourcePageComponent
}

export interface MemorySourceUIContribution {
  sourceTypeId: string
  pages: readonly MemorySourcePageDefinition[]
}

export interface MemorySourcePageEntry {
  id: string
  sourceTypeId: string
  pageId: string
  label: string
  order: number
}

export interface MemorySourcePageDirectory {
  getSnapshot(): readonly MemorySourcePageEntry[]
  subscribe(listener: () => void): () => void
}

export function memorySourcePageEntryId(sourceTypeId: string, pageId: string): string {
  if (!SOURCE_TYPE_ID.test(sourceTypeId)) throw new Error('memory Source UI sourceTypeId must match [a-z][a-z0-9-]{0,127}')
  if (!PAGE_ID.test(pageId)) throw new Error('memory Source UI page id must match [a-z][a-z0-9-]{0,127}')
  return `${sourceTypeId}/${pageId}`
}

/**
 * Thin Client-Fiber adapter over the DSH child Slot. It creates no service or
 * registry: `slots.inject/register` own declaration waiting and disposal.
 */
export function installMemorySourceUI(
  ctx: Pick<MnemonClientContext, 'slots'>,
  contribution: MemorySourceUIContribution,
): () => void {
  if (contribution.pages.length === 0) throw new Error('memory Source UI requires at least one page')
  const seen = new Set<string>()
  const pages = contribution.pages.map((page, index) => {
    const entryId = memorySourcePageEntryId(contribution.sourceTypeId, page.id)
    if (seen.has(entryId)) throw new Error(`memory Source UI page is duplicated: ${entryId}`)
    seen.add(entryId)
    return { page, entryId, order: page.order ?? 1_000 + index }
  })

  // One declaration wait owns the whole contribution. Once the parent exists,
  // registrations commit transactionally and are released in reverse order.
  return ctx.slots.inject(MNEMON_SOURCE_PAGE_SLOT, () => {
    const disposers: Array<() => void> = []
    try {
      for (const { page, entryId, order } of pages) {
        disposers.push(ctx.slots.register({
          name: MNEMON_SOURCE_PAGE_SLOT,
          id: entryId,
          order,
          label: page.label,
        }, page.component))
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  })
}

/** Stable uSES directory over the Slot ledger; no parallel page registry. */
export function createMemorySourcePageDirectory(ctx: Pick<MnemonClientContext, 'slots'>): MemorySourcePageDirectory {
  let version = -1
  let snapshot: readonly MemorySourcePageEntry[] = Object.freeze([])
  const read = (): readonly MemorySourcePageEntry[] => {
    const currentVersion = ctx.slots.getVersion(MNEMON_SOURCE_PAGE_SLOT)
    if (currentVersion === version) return snapshot
    version = currentVersion
    snapshot = Object.freeze(ctx.slots.entriesOfSlot(MNEMON_SOURCE_PAGE_SLOT).flatMap(entry => {
      const id = entry.options.id
      if (id === undefined) return []
      const separator = id.indexOf('/')
      if (separator <= 0 || separator === id.length - 1) return []
      let label: string | undefined
      try {
        label = typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label
      } catch {
        // Presentation metadata must fail locally; a broken label cannot take
        // down the canonical workspace or any Host/Headless memory behavior.
      }
      return [{
        id,
        sourceTypeId: id.slice(0, separator),
        pageId: id.slice(separator + 1),
        label: label?.trim() || id.slice(separator + 1),
        order: entry.options.order ?? 0,
      }]
    }))
    return snapshot
  }
  return {
    getSnapshot: read,
    subscribe(listener) {
      return ctx.slots.subscribe(MNEMON_SOURCE_PAGE_SLOT, () => {
        read()
        listener()
      })
    },
  }
}

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

function BuiltinMemorySourcePage(props: MemorySourcePageProps): ReactNode {
  return props.children ?? null
}

/** Migration-time physical co-location; every built-in uses the public helper. */
export function installBuiltinMemorySourceUI(ctx: MnemonClientContext, t: MnemonTranslate): () => void {
  const disposers = [
    installMemorySourceUI(ctx, {
      sourceTypeId: 'runtime',
      pages: [{ id: 'entries', label: () => t('nav.runtime'), component: BuiltinMemorySourcePage }],
    }),
    installMemorySourceUI(ctx, {
      sourceTypeId: 'documents',
      pages: [{ id: 'library', label: () => t('nav.documents'), component: BuiltinMemorySourcePage }],
    }),
    installMemorySourceUI(ctx, {
      sourceTypeId: 'memory-spaces',
      pages: [
        { id: 'spaces', label: () => t('nav.bodies'), component: BuiltinMemorySourcePage },
        { id: 'explore', label: () => t('nav.search'), component: BuiltinMemorySourcePage },
        { id: 'entities', label: () => t('nav.entities'), component: BuiltinMemorySourcePage },
        { id: 'remember', label: () => t('nav.remember'), component: BuiltinMemorySourcePage },
        { id: 'content', label: () => t('nav.content'), component: BuiltinMemorySourcePage },
      ],
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
