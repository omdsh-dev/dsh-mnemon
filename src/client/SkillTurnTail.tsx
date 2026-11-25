import { memo, useCallback, useEffect, useSyncExternalStore, type JSX } from 'react'
import { IconSkillOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientConnectionHandle, SkillActivitySnapshot } from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import { dispatchMnemonAnchor } from './anchor.ts'
import type { MnemonClientContext } from './dsh-context.ts'
import type { MnemonKey } from './locales.ts'
import { useDocumentVisible } from './document-visibility.ts'
import { MnemonChangeSignal } from './change-signal.ts'
import { MnemonTooltip } from './tooltip.tsx'
import css from './SkillTurnTail.module.css'

export const SKILLS_PAGE = 'skills/library'
const POLL_MS = 3_000
const SETTLE_CHECKS = 2
const NO_CHANGES = new MnemonChangeSignal()

interface Entry {
  snapshot?: SkillActivitySnapshot
  loading?: Promise<void>
  cancelScheduled?: () => void
  nextReadAt?: number
  settle: number
  checkedCursor: number
  requestedCursor: number
  revision: number
  componentRevision: number
  listeners: Set<() => void>
}

const MAX_SKILL_ACTIVITY_SESSIONS = 32

const entries = new WeakMap<ClientConnectionHandle, Map<string, Entry>>()

function entryOf(connection: ClientConnectionHandle, sessionId: string): Entry {
  let sessions = entries.get(connection)
  if (sessions === undefined) {
    sessions = new Map()
    entries.set(connection, sessions)
  }
  let entry = sessions.get(sessionId)
  if (entry !== undefined) {
    sessions.delete(sessionId)
    sessions.set(sessionId, entry)
    return entry
  }
  entry = { settle: 0, checkedCursor: -1, requestedCursor: -1, revision: 0, componentRevision: 0, listeners: new Set() }
  sessions.set(sessionId, entry)
  if (sessions.size > MAX_SKILL_ACTIVITY_SESSIONS) {
    for (const [candidateId, candidate] of sessions) {
      if (candidateId !== sessionId && candidate.listeners.size === 0 && candidate.loading === undefined) {
        cancelScheduled(candidate)
        sessions.delete(candidateId)
        if (sessions.size <= MAX_SKILL_ACTIVITY_SESSIONS) break
      }
    }
    while (sessions.size > MAX_SKILL_ACTIVITY_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined || oldest === sessionId) break
      const victim = sessions.get(oldest)
      if (victim !== undefined) cancelScheduled(victim)
      sessions.delete(oldest)
    }
  }
  return entry
}

function waiting(snapshot: SkillActivitySnapshot | undefined): boolean {
  return snapshot?.reviews.some(review => review.state === 'scheduled' || review.state === 'reviewing') === true
}

function cancelScheduled(entry: Entry): void {
  entry.cancelScheduled?.()
  delete entry.cancelScheduled
}

function invalidate(entry: Entry): void {
  entry.revision += 1
  entry.checkedCursor = -1
  entry.settle = SETTLE_CHECKS
  cancelScheduled(entry)
}

export function invalidateSkillActivity(connection: ClientConnectionHandle): void {
  for (const [sessionId, entry] of entries.get(connection) ?? []) {
    invalidate(entry)
    schedule(connection, sessionId, entry, 0, true)
  }
}

function schedule(connection: ClientConnectionHandle, sessionId: string, entry: Entry, delay = 0, idle = false): void {
  if (entry.loading !== undefined || entry.cancelScheduled !== undefined || entry.listeners.size === 0) return
  const run = (): void => { delete entry.cancelScheduled; load(connection, sessionId, entry) }
  if (idle && typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(run, { timeout: 1_000 })
    entry.cancelScheduled = () => cancelIdleCallback(id)
  } else {
    const timer = setTimeout(run, delay)
    entry.cancelScheduled = () => clearTimeout(timer)
  }
}

function load(connection: ClientConnectionHandle, sessionId: string, entry: Entry): void {
  if (entry.loading !== undefined || entry.listeners.size === 0) return
  const cursor = entry.requestedCursor
  const revision = entry.revision
  let succeeded = false
  entry.loading = new MnemonClient(connection, sessionId).skillActivity()
    .then(snapshot => {
      if (revision !== entry.revision) return
      entry.snapshot = snapshot
      entry.checkedCursor = snapshot.available ? cursor : -1
      succeeded = true
    }, () => undefined)
    .finally(() => {
      delete entry.loading
      for (const listener of [...entry.listeners]) listener()
      if (revision !== entry.revision || succeeded && entry.requestedCursor > cursor) entry.nextReadAt = Date.now()
      else if (waiting(entry.snapshot)) entry.nextReadAt = Date.now() + POLL_MS
      else if (entry.settle > 0) { entry.settle -= 1; entry.nextReadAt = Date.now() + POLL_MS }
      else delete entry.nextReadAt
      if (entry.nextReadAt !== undefined) schedule(connection, sessionId, entry, Math.max(0, entry.nextReadAt - Date.now()))
    })
}

function useSkillActivity(connection: ClientConnectionHandle, sessionId: string | undefined, cursor: number | undefined, revision: number): SkillActivitySnapshot | undefined {
  const visible = useDocumentVisible()
  const entry = sessionId === undefined ? undefined : entryOf(connection, sessionId)
  const subscribe = useCallback((listener: () => void) => {
    if (entry === undefined || !visible || cursor === undefined) return () => {}
    entry.listeners.add(listener)
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size === 0) cancelScheduled(entry)
    }
  }, [entry, visible, cursor])
  const getSnapshot = useCallback(() => entry?.snapshot, [entry])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    if (entry === undefined || sessionId === undefined || cursor === undefined || !visible) return
    if (entry.componentRevision !== revision) {
      entry.componentRevision = revision
      invalidate(entry)
    }
    if (cursor > entry.requestedCursor) {
      entry.requestedCursor = cursor
      entry.settle = SETTLE_CHECKS
      cancelScheduled(entry)
    }
    if (entry.snapshot === undefined || cursor > entry.checkedCursor) schedule(connection, sessionId, entry, 0, true)
    else if (entry.nextReadAt !== undefined) schedule(connection, sessionId, entry, Math.max(0, entry.nextReadAt - Date.now()))
  }, [connection, entry, sessionId, cursor, visible, revision])
  return snapshot
}

interface SkillTurnTailProps {
  turn: unknown
  seq: number
  sessionId?: string
  connection: ClientConnectionHandle
  componentChanges?: MnemonChangeSignal
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

export const SkillTurnTail = memo(function SkillTurnTail({ turn, seq, sessionId, connection, componentChanges = NO_CHANGES, localeRuntime, t }: SkillTurnTailProps): JSX.Element | null {
  const subscribeLocale = useCallback((listener: () => void) => localeRuntime.subscribe(listener), [localeRuntime])
  const getLocale = useCallback(() => localeRuntime.getSnapshot(), [localeRuntime])
  useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const number = turnNumber(turn)
  const closed = isClosedTurn(turn)
  const revision = useSyncExternalStore(componentChanges.subscribe, componentChanges.getSnapshot, componentChanges.getSnapshot)
  const snapshot = useSkillActivity(connection, sessionId, closed && number !== undefined ? seq : undefined, revision)
  if (!closed || number === undefined || snapshot?.available !== true) return null
  const used = snapshot.turns.find(entry => entry.turn === number)?.skills ?? []
  const review = snapshot.reviews.find(entry => entry.turn === number)
  const reviewing = review?.state === 'scheduled' || review?.state === 'reviewing'
  const suggestions = review?.suggestions ?? []
  const failed = review?.state === 'error'
  if (used.length === 0 && !reviewing && suggestions.length === 0 && !failed) return null
  const open = (seed: string): void => dispatchMnemonAnchor({ page: SKILLS_PAGE, seed, ...(sessionId === undefined ? {} : { sessionId }) })
  return <div className={css.root}>
    <span className={css.mark} aria-hidden="true"><IconSkillOutlineRegular size={14} /></span>
    <span className={css.label}>{t('skillTail.label')}</span>
    <span className={css.items}>
      {used.map(skill => <MnemonTooltip key={skill.name} label={t('skillTail.openSkill', { name: skill.name })} side="bottom"><button type="button" className={css.item} onClick={() => open(`name:${skill.name}`)}>{skill.name}</button></MnemonTooltip>)}
      {reviewing && <span className={css.state} role="status"><TextShimmer active>{t('skillTail.reviewing')}</TextShimmer></span>}
      {!reviewing && suggestions.length > 0 && <MnemonTooltip label={t('skillTail.openSuggestions')} side="bottom"><button type="button" className={css.item} data-tone="accent"
        onClick={() => open(suggestions.length === 1 ? `suggestion:${suggestions[0]!.id}` : 'evolution:pending')}>{t('skillTail.suggested', { count: suggestions.length })}</button></MnemonTooltip>}
      {!reviewing && failed && <MnemonTooltip label={review.error} side="bottom" maxWidth={360}><span className={css.state} data-tone="error">{t('skillTail.failed')}</span></MnemonTooltip>}
    </span>
  </div>
})
