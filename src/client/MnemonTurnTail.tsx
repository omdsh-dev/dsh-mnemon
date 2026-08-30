import { memo, useCallback, useEffect, useState, useSyncExternalStore, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import type { ClientConnectionHandle, TurnMemoryActivity } from "../host/protocol.ts"
import { MnemonClient } from './api.ts'
import { dispatchMnemonAnchor, type MnemonAnchorPage } from './anchor.ts'
import type { MnemonKey } from './locales.ts'
import type { MnemonClientContext } from './dsh-context.ts'
import css from './MnemonTurnTail.module.css'

export interface MnemonTurnTailProps {
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

/** Route a settled tool name to the workbench page that explains its effect. */
export function memoryPageForTool(name: string): MnemonAnchorPage {
  if (name === 'mnemon_document_search' || name === 'mnemon_document_manage') return 'documents/library'
  if (name === 'mnemon_runtime_memory') return 'runtime/entries'
  if (name === 'mnemon_recall' || name === 'mnemon_related') return 'memory-spaces/explore'
  if (name === 'mnemon_status') return 'status'
  return 'memory-spaces/spaces'
}

/** Whether this entry renders for the owner; chain selectors decline quietly. */
export function selectMnemonTurnTail(owner: { turn: unknown }): Record<string, never> | null {
  const turn = owner.turn as unknown as { status?: unknown }
  return turn.status === 'closed' ? {} : null
}

/** One-line memory-activity bar under a completed turn; hides when the turn touched no memory. */
export const MnemonTurnTail = memo(function MnemonTurnTail({ turn, seq, sessionId, connection, localeRuntime, t }: MnemonTurnTailProps): JSX.Element | null {
  const subscribeLocale = useCallback((listener: () => void) => localeRuntime.subscribe(listener), [localeRuntime])
  const getLocale = useCallback(() => localeRuntime.getSnapshot(), [localeRuntime])
  useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const [activity, setActivity] = useState<TurnMemoryActivity | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const number = turnNumber(turn)

  useEffect(() => {
    if (number === undefined) {
      setActivity(null)
      return
    }
    let alive = true
    const client = new MnemonClient(connection, sessionId)
    client.turnActivity(number, seq)
      .then(result => { if (alive) setActivity(result) })
      .catch(() => { if (alive) setActivity(null) })
    return () => { alive = false }
  }, [connection, sessionId, number, seq])

  if (activity === undefined || activity === null) return null
  if (number === undefined) return null

  const openTool = (name: string, event: ReactMouseEvent): void => {
    event.stopPropagation()
    dispatchMnemonAnchor({ page: memoryPageForTool(name), ...(sessionId === undefined ? {} : { sessionId }) })
  }

  return (
    <div className={css.root} data-open={open || undefined}>
      <button type="button" className={css.bar} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className={css.mark} aria-hidden="true">◈</span>
        <span className={css.label}>{t('turnTail.label')}</span>
        <span className={css.metrics}>
          {activity.recalls > 0 && <span>{t('turnTail.recall', { count: activity.recalls })}</span>}
          {activity.writes > 0 && <span>{t('turnTail.write', { count: activity.writes })}</span>}
          {activity.documentSearches > 0 && <span>{t('turnTail.documents', { count: activity.documentSearches })}</span>}
          {activity.inspections > 0 && <span>{t('turnTail.inspect', { count: activity.inspections })}</span>}
          {activity.failures > 0 && <span className={css.failureMetric}>{t('turnTail.failed', { count: activity.failures })}</span>}
        </span>
        <span className={`${css.chevron} ${open ? css.chevronOpen : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className={css.details}>
          <span className={css.detailLabel}>{t('turnTail.toolList')}</span>
          <div className={css.tools}>
            {activity.names.map((name, index) => (
              <button
                key={`${name}-${index}`}
                type="button"
                className={css.toolChip}
                aria-label={t('turnTail.openTool', { tool: name })}
                onClick={event => openTool(name, event)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})
