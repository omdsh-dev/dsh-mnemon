import { memo, useCallback, useEffect, useState, useSyncExternalStore, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { memoryTool, type ClientConnectionHandle, type MemoryActivityItem, type TurnMemoryActivity } from "../host/protocol.ts"
import { MnemonClient } from './api.ts'
import { dispatchMnemonAnchor, type MnemonAnchorPage } from './anchor.ts'
import { Reveal } from './feedback.tsx'
import type { MnemonKey } from './locales.ts'
import type { MnemonClientContext } from './dsh-context.ts'
import css from './MnemonTurnTail.module.css'
import { IconChevronDownOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { MemoryIcon } from './memory-icon.tsx'

interface MnemonTurnTailProps {
  /** Engine-owned closing Turn boundary (TurnLocation on the wire). */
  turn: unknown
  seq: number
  openFile: (path: string) => void
  /** Injected by the slot host: the session this tail belongs to. */
  sessionId?: string
  connection: ClientConnectionHandle
  localeRuntime: Pick<MnemonClientContext['locale'], 'getSnapshot' | 'subscribe'>
  t: (key: MnemonKey, params?: Record<string, unknown>) => string
}

function turnNumber(turn: unknown): number | undefined {
  const value = (turn as { turn?: unknown } | null)?.turn
  return typeof value === 'number' ? value : undefined
}

function isClosedTurn(turn: unknown): boolean {
  return (turn as { status?: unknown } | null)?.status === 'closed'
}

/** Route a settled tool name to the workbench page its row in the tool table names; a tool without a row, or whose row names no page, opens Memory Spaces. */
export function memoryPageForTool(name: string): MnemonAnchorPage {
  return memoryTool(name)?.page ?? 'memory-spaces/spaces'
}

/** One chip per tool, in the order the turn first used it, with how many times it did. */
export function turnTools(names: readonly string[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count }))
}

/** A memory the turn read or wrote, named as people read it, with the page that shows it. */
export interface TurnItem {
  key: string
  text: string
  /** The Memory Space that holds a recalled or saved memory. */
  place?: string
  page: MnemonAnchorPage
  seed?: string
}

/** Open a document by id, a memory by recalling its text, a runtime entry by its text. */
function itemTarget(toolName: string, sourceTypeId: string | undefined, operationId: string, item: MemoryActivityItem, text: string): Pick<TurnItem, 'page' | 'seed'> {
  if (sourceTypeId === 'documents') return { page: 'documents/library', seed: item.id }
  if (sourceTypeId === 'runtime') return { page: 'runtime/entries', seed: text }
  if (sourceTypeId === 'memory-spaces' && operationId !== 'manage-spaces') return { page: 'memory-spaces/explore', seed: text }
  return { page: memoryPageForTool(toolName) }
}

/** What each tool read or wrote this turn; an item known only by its id is left out. */
export function turnItems(activity: Partial<Pick<TurnMemoryActivity, 'retrieved' | 'writebacks'>>): Map<string, TurnItem[]> {
  const byTool = new Map<string, TurnItem[]>()
  const add = (toolName: string, sourceTypeId: string | undefined, operationId: string, item: MemoryActivityItem, key: string): void => {
    // Memory Spaces title an item with its space and carry the memory itself as the excerpt.
    const memory = sourceTypeId === 'memory-spaces' && item.excerpt !== undefined
    const text = memory ? item.excerpt! : item.title
    if (text === item.id) return
    const items = byTool.get(toolName) ?? []
    if (items.some(existing => existing.text === text)) return
    items.push({ key, text, ...(memory ? { place: item.title } : {}), ...itemTarget(toolName, sourceTypeId, operationId, item, text) })
    byTool.set(toolName, items)
  }
  for (const read of activity.retrieved ?? []) read.items.forEach((item, index) => add(read.toolName, read.sourceTypeId, read.operationId, item, `${read.callId}:${index}`))
  for (const write of activity.writebacks ?? []) add(write.toolName, write.sourceTypeId, write.operationId, write.item, write.callId)
  return byTool
}

const ITEMS_PER_TOOL = 3

/** One-line memory-activity bar under a completed turn; hides when the turn touched no memory. */
export const MnemonTurnTail = memo(function MnemonTurnTail({ turn, seq, sessionId, connection, localeRuntime, t }: MnemonTurnTailProps): JSX.Element | null {
  const subscribeLocale = useCallback((listener: () => void) => localeRuntime.subscribe(listener), [localeRuntime])
  const getLocale = useCallback(() => localeRuntime.getSnapshot(), [localeRuntime])
  useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const [activity, setActivity] = useState<TurnMemoryActivity | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const number = turnNumber(turn)
  // The turn-tail list renders every entry, so the entry itself waits for the closing Turn.
  const closed = isClosedTurn(turn)

  useEffect(() => {
    if (!closed || number === undefined) {
      setActivity(null)
      return
    }
    let alive = true
    const client = new MnemonClient(connection, sessionId)
    client.turnActivity(number, seq)
      .then(result => { if (alive) setActivity(result) })
      .catch(() => { if (alive) setActivity(null) })
    return () => { alive = false }
  }, [connection, sessionId, number, seq, closed])

  if (!closed || number === undefined) return null
  if (activity === undefined || activity === null) return null

  const openPage = (page: MnemonAnchorPage, seed: string | undefined, event: ReactMouseEvent): void => {
    event.stopPropagation()
    dispatchMnemonAnchor({ page, ...(seed === undefined ? {} : { seed }), ...(sessionId === undefined ? {} : { sessionId }) })
  }
  const items = turnItems(activity)

  return (
    <div className={css.root} data-open={open || undefined}>
      <button type="button" className={css.bar} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className={css.mark}><MemoryIcon size={14} /></span>
        <span className={css.label}>{t('turnTail.label')}</span>
        <span className={css.metrics}>
          {activity.recalls > 0 && <span>{t('turnTail.recall', { count: activity.recalls })}</span>}
          {activity.writes > 0 && <span>{t('turnTail.write', { count: activity.writes })}</span>}
          {activity.documentSearches > 0 && <span>{t('turnTail.documents', { count: activity.documentSearches })}</span>}
          {activity.inspections > 0 && <span>{t('turnTail.inspect', { count: activity.inspections })}</span>}
          {activity.failures > 0 && <span className={css.failureMetric}>{t('turnTail.failed', { count: activity.failures })}</span>}
        </span>
        <IconChevronDownOutlineRegular size={12} className={`${css.chevron} ${open ? css.chevronOpen : ''}`} />
      </button>
      <Reveal>{open && (
        <ul className={css.details} aria-label={t('turnTail.toolList')}>
          {turnTools(activity.names).map(({ name, count }) => {
            const key = memoryTool(name)?.label
            const label = key === undefined ? name : t(key)
            const used = items.get(name) ?? []
            return (
              <li key={name} className={css.toolRow}>
                <Tooltip label={name} side="bottom">
                  <button
                    type="button"
                    className={css.toolChip}
                    aria-label={t('turnTail.openTool', { tool: label })}
                    onClick={event => openPage(memoryPageForTool(name), undefined, event)}
                  >
                    {label}{count > 1 && <span className={css.toolCount}>×{count}</span>}
                  </button>
                </Tooltip>
                {used.length > 0 && (
                  <span className={css.items}>
                    {used.slice(0, ITEMS_PER_TOOL).map(item => (
                      <button key={item.key} type="button" className={css.item} title={item.text} onClick={event => openPage(item.page, item.seed, event)}>
                        <span className={css.itemText}>{item.text}</span>
                        {item.place !== undefined && <span className={css.itemPlace}>{item.place}</span>}
                      </button>
                    ))}
                    {used.length > ITEMS_PER_TOOL && <span className={css.itemMore}>{t('turnTail.more', { count: used.length - ITEMS_PER_TOOL })}</span>}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}</Reveal>
    </div>
  )
})
