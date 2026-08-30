import type { ReactNode } from 'react'
import type { MemorySourcePageProps } from './source-contracts.ts'
export type { MemorySourcePageProps } from './source-contracts.ts'

export const MNEMON_SOURCE_PAGE_SLOT = 'mnemon.source.page' as const
/** Conventional operations used by Mnemon's descriptor-driven Source page. */
export const MNEMON_SOURCE_CONFIGURATION_READ = 'configuration' as const
export const MNEMON_SOURCE_CONFIGURATION_MUTATE = 'configuration' as const

const SOURCE_TYPE_ID = /^[a-z][a-z0-9-]{0,127}$/u
const PAGE_ID = /^[a-z][a-z0-9-]{0,127}$/u

export type MemorySourcePageComponent = (props: MemorySourcePageProps) => ReactNode

/** The existing DSH Slot capability narrowed to this one child Slot. */
export interface MemorySourceUIContext {
  slots: {
    inject(name: typeof MNEMON_SOURCE_PAGE_SLOT, setup: () => () => void): () => void
    register(options: {
      name: typeof MNEMON_SOURCE_PAGE_SLOT
      id: string
      order: number
      label: string | (() => string)
      priority?: number
    }, component: MemorySourcePageComponent): () => void
  }
}

interface MemorySourcePageDirectoryContext {
  slots: {
    getVersion(name: typeof MNEMON_SOURCE_PAGE_SLOT): number
    entriesOfSlot(name: typeof MNEMON_SOURCE_PAGE_SLOT): readonly { options: { id?: string; label?: string | (() => string); order?: number } }[]
    subscribe(name: typeof MNEMON_SOURCE_PAGE_SLOT, listener: () => void): () => void
  }
}

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

export interface MemorySourceUIOptions {
  /** Default distributions yield to an explicitly installed Source client. */
  fallback?: boolean
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
  ctx: MemorySourceUIContext,
  contribution: MemorySourceUIContribution,
  options: MemorySourceUIOptions = {},
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
          ...(options.fallback === true ? { priority: 10_000 } : {}),
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
export function createMemorySourcePageDirectory(ctx: MemorySourcePageDirectoryContext): MemorySourcePageDirectory {
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
