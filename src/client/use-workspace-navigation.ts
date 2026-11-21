import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { JsonValue, MemorySourceManagementCatalog, MemorySourceManagementInstance } from '../host/protocol.ts'
import type { MemoryViewDashboard } from '../host/view-protocol.ts'
import { consumeMnemonAnchor, subscribeMnemonAnchor, type MnemonAnchor, type MnemonAnchorFilter } from './anchor.ts'
import { sourceOf } from './component-model.ts'
import type { MnemonToast } from './feedback.tsx'
import { useT } from './page-kit.tsx'
import type { MemorySourcePageEntry } from './source-pages.tsx'

type SourcePage = `source:${string}`

type ManagedSourcePage = `source-management:${string}`

type StoppedSourcePage = `source-stopped:${string}`

export type Page = 'status' | SourcePage | ManagedSourcePage | StoppedSourcePage

function sourcePage(entryId: string): SourcePage {
  return `source:${entryId}`
}

export function sourcePageEntryId(page: Page): string | undefined {
  return page.startsWith('source:') ? page.slice('source:'.length) : undefined
}

function managedSourcePage(sourceTypeId: string): ManagedSourcePage {
  return `source-management:${sourceTypeId}`
}

export function managedSourceTypeId(page: Page): string | undefined {
  return page.startsWith('source-management:') ? page.slice('source-management:'.length) : undefined
}

function stoppedSourcePage(sourceTypeId: string): StoppedSourcePage {
  return `source-stopped:${sourceTypeId}`
}

export function stoppedSourceTypeId(page: Page): string | undefined {
  return page.startsWith('source-stopped:') ? page.slice('source-stopped:'.length) : undefined
}

export interface SourceNavigationEntry {
  id: string
  page: Page
  sourceTypeId?: string
  label: string
  detail: string
  group: 'system' | 'storage' | 'tools' | 'sources'
  glyph: string
  primary: boolean
  stopped?: boolean
}

export function useWorkspaceNavigation(options: {
  sessionId: string | undefined
  viewContextKey: string
  resetViewportScroll: () => void
  sourceCatalog: MemorySourceManagementCatalog | null
  sourcePageEntries: readonly MemorySourcePageEntry[]
  visibleSourcePages: readonly MemorySourcePageEntry[]
  managedSourceTypes: ReadonlyArray<readonly [string, readonly MemorySourceManagementInstance[]]>
  stoppedTypes: ReadonlySet<string>
  disabledTypes: ReadonlySet<string>
  dashboard: MemoryViewDashboard | null
  sourceName: (sourceTypeId: string, fallback?: string) => string
  showWorkspaceToast: (toast: MnemonToast) => void
  accepts?: MnemonAnchorFilter
  home?: Page
}): {
  page: Page
  navigationInput: { page: string; value: JsonValue } | undefined
  openTab: (next: Page) => void
  sourceNavigationEntries: SourceNavigationEntry[]
} {
  const { sessionId, viewContextKey, resetViewportScroll, sourceCatalog, sourcePageEntries, visibleSourcePages, managedSourceTypes, stoppedTypes, disabledTypes, dashboard, sourceName, showWorkspaceToast, accepts, home = 'status' } = options
  const t = useT()
  const [page, setPage] = useState<Page>(home)
  const isDisabled = useCallback((target: Page) => {
    const type = sourcePageEntryId(target)?.split('/')[0] ?? managedSourceTypeId(target) ?? stoppedSourceTypeId(target)
    return type !== undefined && disabledTypes.has(type)
  }, [disabledTypes])
  useEffect(() => { if (page === 'status' && home !== 'status') setPage(home) }, [home, page])

  const selectPage = useCallback((next: Page) => setPage(next), [])

  useLayoutEffect(() => { resetViewportScroll() }, [viewContextKey, page, resetViewportScroll])
  const [navigationInput, setNavigationInput] = useState<{ page: string; value: JsonValue } | undefined>()
  const openTab = useCallback((next: Page) => { setNavigationInput(undefined); setPage(next) }, [])
  const sourceNavigationEntries = useMemo<SourceNavigationEntry[]>(() => {
    const entries: SourceNavigationEntry[] = []
    const stopped = (sourceTypeId: string, label: string): SourceNavigationEntry => ({
      id: 'stopped:' + sourceTypeId, page: stoppedSourcePage(sourceTypeId), sourceTypeId, label, detail: sourceTypeId, group: 'sources', glyph: '◇', primary: true, stopped: true,
    })
    const stoppedShown = new Set<string>()
    const named = new Set<string>()
    const tabName = (sourceTypeId: string, label: string): string => {
      if (named.has(sourceTypeId)) return label
      named.add(sourceTypeId)
      return sourceName(sourceTypeId, label)
    }
    for (const entry of sourcePageEntries) {
      const primary = entry.navigation?.primary ?? true
      if (visibleSourcePages.includes(entry)) {
        entries.push({
          id: entry.id, page: sourcePage(entry.id), sourceTypeId: entry.sourceTypeId, label: primary ? tabName(entry.sourceTypeId, entry.label) : entry.label,
          detail: entry.navigation?.detail ?? entry.sourceTypeId, group: entry.navigation?.group ?? 'sources',
          glyph: entry.navigation?.glyph ?? '◇', primary,
        })
      } else if (stoppedTypes.has(entry.sourceTypeId) && !stoppedShown.has(entry.sourceTypeId) && primary) {
        stoppedShown.add(entry.sourceTypeId)
        entries.push(stopped(entry.sourceTypeId, tabName(entry.sourceTypeId, entry.label)))
      }
    }
    for (const sourceTypeId of stoppedTypes) {
      if (!stoppedShown.has(sourceTypeId) && dashboard !== null && sourceOf(dashboard, sourceTypeId) !== undefined) entries.push(stopped(sourceTypeId, sourceName(sourceTypeId)))
    }
    entries.push(...managedSourceTypes.map(([sourceTypeId, instances]) => ({
      id: 'management:' + sourceTypeId, page: managedSourcePage(sourceTypeId), sourceTypeId,
      label: sourceName(sourceTypeId, instances[0]!.management.label), detail: sourceTypeId, group: 'sources' as const, glyph: '◇', primary: true,
    })))
    return entries.filter(entry => entry.sourceTypeId === undefined || !disabledTypes.has(entry.sourceTypeId))
  }, [dashboard, disabledTypes, managedSourceTypes, sourceName, sourcePageEntries, stoppedTypes, visibleSourcePages])

  useEffect(() => {
    if (isDisabled(page)) {
      setPage(home)
      setNavigationInput(undefined)
      return
    }
    if (sourceCatalog === null) return
    const entryId = sourcePageEntryId(page)
    const managedTypeId = managedSourceTypeId(page)
    const stoppedTypeId = stoppedSourceTypeId(page)
    const whileStopped = (sourceTypeId: string | undefined): Page => sourceTypeId !== undefined && stoppedTypes.has(sourceTypeId) ? stoppedSourcePage(sourceTypeId) : home
    if (entryId !== undefined && !visibleSourcePages.some(entry => entry.id === entryId)) {
      setPage(whileStopped(sourcePageEntries.find(entry => entry.id === entryId)?.sourceTypeId))
    } else if (managedTypeId !== undefined && !managedSourceTypes.some(([sourceTypeId]) => sourceTypeId === managedTypeId)) {
      setPage(whileStopped(managedTypeId))
    } else if (stoppedTypeId !== undefined && !stoppedTypes.has(stoppedTypeId)) {
      const resumed = visibleSourcePages.find(entry => entry.sourceTypeId === stoppedTypeId && (entry.navigation?.primary ?? true))
      setPage(resumed !== undefined ? sourcePage(resumed.id)
        : managedSourceTypes.some(([sourceTypeId]) => sourceTypeId === stoppedTypeId) ? managedSourcePage(stoppedTypeId) : home)
      showWorkspaceToast({ text: t('feedback.layerResumed', { layer: sourceName(stoppedTypeId, resumed?.label) }), tone: 'success' })
    }
  }, [isDisabled, managedSourceTypes, page, sourcePageEntries, stoppedTypes, visibleSourcePages, sourceCatalog, showWorkspaceToast, sourceName, t, home])

  useLayoutEffect(() => { setNavigationInput(undefined) }, [viewContextKey])

  const applyAnchor = useCallback((anchor: MnemonAnchor) => {
    if (anchor.page !== 'status' && isDisabled(sourcePage(anchor.page))) {
      setNavigationInput(undefined)
      selectPage(home)
      return
    }
    setNavigationInput({ page: anchor.page, value: { seed: anchor.seed ?? '', nonce: Date.now() } })
    selectPage(anchor.page === 'status' ? 'status' : sourcePage(anchor.page))
  }, [home, isDisabled, selectPage])
  useEffect(() => {
    const held = consumeMnemonAnchor(sessionId, accepts)
    if (held !== null) applyAnchor(held)
    return subscribeMnemonAnchor(sessionId, applyAnchor, accepts)
  }, [sessionId, applyAnchor, accepts])
  return { page: isDisabled(page) ? home : page, navigationInput, openTab, sourceNavigationEntries }
}
