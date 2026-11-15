import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Button, Checkbox, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ClientConnectionHandle, type MnemonReconcileOperation, type MnemonReviewEntry, type MnemonReviewLedgerView, type MnemonReviewStatus } from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import { Reveal } from './feedback.tsx'
import type { MnemonTranslate } from './locales.ts'
import { MnemonDialog } from './MnemonDialog.tsx'
import css from './MnemonSettingsCard.module.css'
import { message } from './page-kit.tsx'
import { SettingRow } from './settings-controls.tsx'

export interface MnemonReviewSectionProps {
  client?: MnemonClient
  connection?: ClientConnectionHandle
  sessionId?: string
  workspaceId?: string
  disabled: boolean
  /** A plan was applied, in full or in part, and wrote memory. */
  onApplied?: () => void
  t: MnemonTranslate
}

export const STATUS_KEY: Record<MnemonReviewStatus, 'review.statusPending' | 'review.statusAccepted' | 'review.statusRejected'> = {
  pending: 'review.statusPending',
  accepted: 'review.statusAccepted',
  rejected: 'review.statusRejected',
}

export const STATUS_TONE: Record<MnemonReviewStatus, 'warning' | 'success' | 'quiet'> = {
  pending: 'warning',
  accepted: 'success',
  rejected: 'quiet',
}

function brief(value: string, max: number): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

function targetName(t: MnemonTranslate, target: 'memory' | 'user'): string {
  return target === 'user' ? t('review.targetUser') : t('review.targetMemory')
}

/** One operation as a reviewer reads it: what changes, and to which entry. */
export function operationText(t: MnemonTranslate, operation: MnemonReconcileOperation): string {
  switch (operation.kind) {
    case 'runtime-add': return t('review.opAdd', { target: targetName(t, operation.target), content: brief(operation.content, 160) })
    case 'runtime-replace': return t('review.opReplace', { target: targetName(t, operation.target), from: brief(operation.oldText, 80), to: brief(operation.content, 160) })
    case 'runtime-remove': return t('review.opRemove', { target: targetName(t, operation.target), text: brief(operation.oldText, 160) })
    case 'document-archive': return t('review.opArchive', { id: operation.documentId })
  }
}

function stamp(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

/**
 * What an agent proposes to do with memory that arrived from another machine.
 * The proposal is evidence, not an instruction: it changes nothing until the
 * user accepts it, and the user can leave an opinion on it either way, which
 * the next reconciliation run reads back as part of its own evidence.
 *
 * The reviewer also states what the run should accomplish, and picks which of
 * the proposed changes are actually applied; the rest stay in the ledger.
 */
export function MnemonReviewSection(props: MnemonReviewSectionProps): JSX.Element {
  const { t } = props
  const client = useMemo(
    () => props.client ?? (props.connection === undefined ? null : new MnemonClient(props.connection, props.sessionId, props.workspaceId)),
    [props.client, props.connection, props.sessionId, props.workspaceId],
  )
  const [ledger, setLedger] = useState<MnemonReviewLedgerView | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // The page's own refusal is not a Host failure, so it never borrows that wording.
  const [complaint, setComplaint] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [opinion, setOpinion] = useState('')
  const [guidance, setGuidance] = useState('')
  const [chosen, setChosen] = useState<Record<string, number[]>>({})
  const [historyOpen, setHistoryOpen] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null) return
    setLedger(await client.reviewLedger())
  }, [client])

  useEffect(() => {
    if (client === null) return
    let active = true
    client.reviewLedger()
      .then(value => { if (active) setLedger(value) })
      .catch(reason => { if (active) setFailed(message(reason)) })
    return () => { active = false }
  }, [client])

  // Every action ends the same way: re-read the ledger, then say what happened.
  const submit = (id: string, work: (api: MnemonClient) => Promise<unknown>): void => {
    if (client === null) return
    setBusy(id)
    setFailed(null)
    setComplaint(null)
    setNotice(null)
    void work(client).then(refresh).catch(reason => setFailed(message(reason))).finally(() => setBusy(null))
  }

  /**
   * Every position the plan holds that has not run yet. An untouched review applies all of
   * them, and the ones already written are never offered again: running them a second time
   * would address text the first run replaced.
   */
  const restOf = (entry: MnemonReviewEntry): number[] => {
    const done = entry.appliedOperations ?? []
    return entry.operations.map((_operation, index) => index).filter(index => !done.includes(index))
  }

  const selectionOf = (entry: MnemonReviewEntry): number[] => chosen[entry.id] ?? restOf(entry)

  const keep = (entry: MnemonReviewEntry, next: number[]): void => {
    setChosen(previous => ({ ...previous, [entry.id]: next.sort((left, right) => left - right) }))
  }

  const toggle = (entry: MnemonReviewEntry, index: number): void => {
    const current = selectionOf(entry)
    keep(entry, current.includes(index) ? current.filter(item => item !== index) : [...current, index])
  }

  const runReconcile = (): void => {
    if (client === null) return
    setBusy('reconcile')
    setFailed(null)
    setComplaint(null)
    setNotice(null)
    void client.reconcile(guidance)
      .then(async result => {
        // What the run was given and what it read are part of the answer: a plan
        // that never saw the branch is a different plan from one that did.
        const parts = [result.action === 'planned' ? t('review.planned', { operations: result.operations }) : t('review.none')]
        if (result.guided === true) parts.push(t('review.guided'))
        if (result.remoteEntries !== undefined && result.remoteEntries > 0) parts.push(t('review.remoteEntries', { count: result.remoteEntries }))
        setNotice(parts.join(' '))
        setLedger(await client.reviewLedger())
      })
      .catch(reason => setFailed(message(reason)))
      .finally(() => setBusy(null))
  }

  const leaveOpinion = (id: string): void => {
    const text = opinion.trim()
    if (text === '') return
    submit(id, api => api.reviewOpinion(id, text).then(() => {
      setOpinion('')
      setNotice(t('review.opinionAdded'))
    }))
  }

  const apply = (entry: MnemonReviewEntry): void => {
    const selection = selectionOf(entry)
    if (selection.length === 0) { setComplaint(t('review.noSelection')); return }
    // A plan stops at the first operation that fails and keeps the ones that ran, so
    // the memory views read again whether or not it finished.
    submit(entry.id, api => api.applyReview(entry.id, selection).finally(() => props.onApplied?.()).then(result => {
      setNotice(t('review.applied', { count: result.applied }))
      // What ran is what the ledger now records; the ledger is re-read, so the plan keeps
      // only the positions still left to decide.
      setChosen(previous => {
        const next = { ...previous }
        delete next[entry.id]
        return next
      })
    }))
  }

  const entries = ledger?.entries ?? []
  const pending = ledger?.pending ?? 0
  // A plan that already ran is history: it leaves the list entirely and stays readable
  // in its own popup, so the list holds only what still needs an answer. A plan that was
  // refused stays in the list, because it is still waiting for the opinion the next run
  // reads back.
  // History is a plan with nothing left to decide: every operation ran, or - for an entry
  // written before the ledger recorded positions - one that has been applied at all. A plan
  // applied only in part is still work, and it stays where the reviewer can finish it.
  const finished = (entry: MnemonReviewEntry): boolean => (entry.appliedOperations ?? []).length >= entry.operations.length
  const history = entries.filter(entry => entry.status === 'accepted'
    && (finished(entry) || (entry.appliedAt !== undefined && entry.appliedOperations === undefined)))
  const current = entries.filter(entry => !history.includes(entry))
  /** One plan, as it reads in the open list and in the history popup alike. */
  const renderEntry = (entry: MnemonReviewEntry): JSX.Element => {
    const open = openId === entry.id
    const selection = selectionOf(entry)
    return <div key={entry.id} className={css.reviewEntry} data-status={entry.status}>
      <header>
        <div className={css.reviewTitle}>
          <strong>{entry.title}</strong>
          <Tag tone={STATUS_TONE[entry.status]}>{t(STATUS_KEY[entry.status])}</Tag>
        </div>
        <div className={css.rowActions}>
          <Button variant="ghost" size="sm" onClick={() => { setOpenId(open ? null : entry.id) }}>{open ? t('review.collapse') : t('review.expand')}</Button>
          {entry.status === 'pending' && <>
            <Button variant="outline" size="sm" disabled={busy !== null}
              onClick={() => { submit(entry.id, api => api.decideReview(entry.id, 'accepted')) }}>{t('review.accept')}</Button>
            <Button variant="ghost" size="sm" disabled={busy !== null}
              onClick={() => { submit(entry.id, api => api.decideReview(entry.id, 'rejected')) }}>{t('review.reject')}</Button>
          </>}
          {entry.status === 'accepted' && <Button variant="primary" size="sm" disabled={busy !== null || props.disabled}
            onClick={() => { apply(entry) }}>
            {busy === entry.id
              ? t('review.applying')
              : selection.length > 0 && selection.length < restOf(entry).length ? t('review.applyCount', { count: selection.length }) : t('review.apply')}</Button>}
          {entry.status !== 'pending' && <Button variant="ghost" size="sm" disabled={busy !== null}
            onClick={() => { submit(entry.id, api => api.reopenReview(entry.id)) }}>{t('review.reopen')}</Button>}
        </div>
      </header>
      <small>{t('review.meta', { count: entry.operations.length, machine: entry.machine.label, time: stamp(entry.createdAt) })}</small>
      {entry.foreignMachines.length > 0 && <small>{t('review.foreign', { machines: entry.foreignMachines.join(', ') })}</small>}
      {entry.appliedAt !== undefined && <small className={css.syncSuccess}>{t('review.appliedAt', { time: stamp(entry.appliedAt) })}</small>}
      {(entry.appliedOperations ?? []).length > 0 && <small>{t('review.appliedCount', { count: (entry.appliedOperations ?? []).length, total: entry.operations.length })}</small>}
      {entry.failure !== undefined && <p className={css.error} role="alert">{t('review.applyFailed', { error: entry.failure })}</p>}
      {entry.status === 'rejected' && <small>{t('review.rejectedHint')}</small>}
      <Reveal>{open && <div className={css.reviewDetails}>
        <p>{entry.summary}</p>
        {entry.status === 'accepted' && <div className={css.reviewSelection}>
          <small>{t('review.selectHint')}</small>
          <div className={css.rowActions}>
            <span className={css.reviewSelected}>{t('review.selected', { count: selection.length, total: restOf(entry).length })}</span>
            <Button variant="ghost" size="sm" disabled={busy !== null}
              onClick={() => { keep(entry, restOf(entry)) }}>{t('review.selectAll')}</Button>
            <Button variant="ghost" size="sm" disabled={busy !== null}
              onClick={() => { keep(entry, []) }}>{t('review.selectNone')}</Button>
          </div>
        </div>}
        <ol className={css.reviewOperations}>
          {entry.operations.map((operation, index) => <li key={index} data-applied={(entry.appliedOperations ?? []).includes(index)}>
            {/* A position that already ran is shown for reading, never offered again. */}
            {(entry.appliedOperations ?? []).includes(index)
              ? <span>{operationText(t, operation)}</span>
              : entry.status === 'accepted'
                ? <Checkbox
                    className={css.reviewOperationCheckbox}
                    checked={selection.includes(index)}
                    disabled={busy !== null}
                    label={operationText(t, operation)}
                    onChange={() => { toggle(entry, index) }}
                  />
                : <span>{operationText(t, operation)}</span>}
            <small>{operation.reason}</small>
          </li>)}
        </ol>
        <div className={css.reviewOpinions}>
          <strong>{t('review.opinions')}</strong>
          {entry.opinions.length === 0
            ? <small>{t('review.noOpinions')}</small>
            : entry.opinions.map(item => <div key={item.id}>
                <strong>{item.author === 'agent' ? t('review.authorAgent') : t('review.authorUser')}</strong>
                <span>{item.text}</span>
              </div>)}
        </div>
        <div className={css.reviewOpinionForm}>
          <input type="text" value={opinion} placeholder={t('review.opinionPlaceholder')} aria-label={t('review.opinions')}
            disabled={busy !== null} onChange={event => setOpinion(event.target.value)} />
          <Button variant="outline" size="sm" disabled={busy !== null || opinion.trim() === ''}
            onClick={() => { leaveOpinion(entry.id) }}>{t('review.opinionSend')}</Button>
        </div>
      </div>}</Reveal>
    </div>
  }

  return <div className={css.syncRow} role="group" aria-labelledby="mnemon-review-heading">
    <SettingRow title={t('config.reconcileTitle')} titleId="mnemon-review-heading" hint={t('config.reconcileDescription')}>
      <div className={css.rowActions}>
        <Button variant="outline" size="sm" disabled={props.disabled || client === null || busy !== null}
          onClick={runReconcile}>{busy === 'reconcile' ? t('review.reconciling') : t('review.reconcile')}</Button>
        <Button variant="ghost" size="sm" disabled={client === null || busy !== null}
          onClick={() => { submit('load', refresh) }}>{t('review.refresh')}</Button>
      </div>
    </SettingRow>
    <div className={css.reviewGuidance}>
      <label htmlFor="mnemon-review-guidance">{t('review.guidanceLabel')}</label>
      <input id="mnemon-review-guidance" type="text" value={guidance} placeholder={t('review.guidancePlaceholder')}
        disabled={busy !== null} onChange={event => setGuidance(event.target.value)} />
      <small>{t('review.guidanceHint')}</small>
    </div>
    <div className={css.syncState} aria-live="polite">
      <span>{pending === 0 ? t('review.empty') : t('review.pending', { count: pending })}</span>
    </div>
    <Reveal>{complaint !== null && <p className={css.error} role="alert">{complaint}</p>}</Reveal>
    <Reveal>{failed !== null && <p className={css.error} role="alert">{t('review.failed', { error: failed })}</p>}</Reveal>
    <Reveal>{notice !== null && <p className={css.syncSuccess} role="status">{notice}</p>}</Reveal>
    {history.length > 0 && <div className={css.rowActions}>
      <Button variant="ghost" size="sm" onClick={() => { setHistoryOpen(true) }}>
        {t('review.history', { count: history.length })}</Button>
    </div>}
    {current.length > 0 && <div className={css.reviewList}>{current.map(renderEntry)}</div>}
    {/* A plan that already ran is history: it stays readable in its own popup, so it stops
        crowding the plans that still need an answer. */}
    {historyOpen && <MnemonDialog title={t('review.historyTitle')} closeLabel={t('common.close')} busy={busy !== null}
      onClose={() => { setHistoryOpen(false) }}>
      <div className={css.syncDialogBody}>
        <small>{t('review.historyHint')}</small>
        {history.length === 0
          ? <small>{t('review.historyEmpty')}</small>
          : <div className={css.reviewList}>{history.map(renderEntry)}</div>}
      </div>
    </MnemonDialog>}
  </div>
}
