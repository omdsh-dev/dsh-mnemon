import { useCallback, useEffect, useState, type JSX } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MnemonPackComponent, MnemonPackComponentSummary, MnemonSyncBackupList, MnemonSyncCredentialSource, MnemonSyncDiff, MnemonSyncPreview } from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'
import { Reveal } from './feedback.tsx'
import type { MnemonTranslate } from './locales.ts'
import { MnemonDialog } from './MnemonDialog.tsx'
import css from './MnemonSettingsCard.module.css'
import { message } from './page-kit.tsx'
import { failureText, reasonOf, runtimeArchiveNotice, when } from './sync-view.ts'

/** How many backups one page of the branch history holds. */
const HISTORY_PAGE = 20
/** How many conflicting pairs the comparison lists before it only counts them. */
const SHOWN_CONFLICTS = 5

/** One component's item count as a reader reads it. */
export function componentCount(t: MnemonTranslate, component: MnemonPackComponent, count: number): string {
  if (component === 'runtime') return t('config.syncCountRuntime', { count })
  if (component === 'documents') return t('config.syncCountDocuments', { count })
  return t('config.syncCountSpaces', { count })
}

function componentName(t: MnemonTranslate, component: MnemonPackComponent): string {
  if (component === 'runtime') return t('config.syncComponentRuntime')
  if (component === 'documents') return t('config.syncComponentDocuments')
  return t('config.syncComponentSpaces')
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

/** The commit message a sync writes on its own, which says nothing a backup's time does not. */
const AUTOMATIC_MESSAGE = /^Mnemon sync \d{4}-\d{2}-\d{2}T[\d:.]+Z$/u

function summaryLine(t: MnemonTranslate, summary: readonly MnemonPackComponentSummary[]): string {
  return summary.map(entry => componentCount(t, entry.component, entry.items)).join(' · ')
}

interface SyncDialogProps {
  client: MnemonClient
  repoUrl: string
  /** The credential the Host offers the repository, which a refusal is then said to be about. */
  credential: MnemonSyncCredentialSource
  t: MnemonTranslate
  onClose: () => void
}

/**
 * The versions the repository holds, newest first: when each was synced, from
 * which computer, and what it held. A page is read at a time; the commit is a
 * quiet tag, because the time and the computer are what a reader looks for.
 */
export function SyncHistoryDialog({ client, repoUrl, credential, t, onClose }: SyncDialogProps): JSX.Element {
  const [history, setHistory] = useState<MnemonSyncBackupList | null>(null)
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState<string | null>(null)
  // The Host reads a bounded window of the branch; a page that adds nothing is its end.
  const [capped, setCapped] = useState(false)

  const load = useCallback(async (limit?: number): Promise<void> => {
    setBusy(true); setFailed(null)
    try {
      const page = await client.syncBackups(limit)
      setHistory(current => {
        if (current === null || limit === undefined) return page
        const fresh = page.commits.filter(commit => !current.commits.some(held => held.commit === commit.commit))
        if (fresh.length === 0) setCapped(true)
        return { ...page, commits: [...current.commits, ...fresh] }
      })
    } catch (reason) {
      setFailed(failureText(t, reasonOf(reason), message(reason), repoUrl, credential))
    } finally { setBusy(false) }
  }, [client, repoUrl, credential, t])

  useEffect(() => { void load() }, [load])

  return <MnemonDialog title={t('config.syncHistory')} description={t('config.syncHistoryHint')} closeLabel={t('common.close')} wide
    busy={busy} contentReady={history !== null || failed !== null} onClose={onClose}>
    <div className={css.syncDialogBody}>
      {history === null && failed === null && <p className={css.syncDialogNote} role="status">{t('config.syncHistoryLoading')}</p>}
      {failed !== null && <p className={css.error} role="alert">{failed}</p>}
      {history !== null && history.commits.length === 0 && <p className={css.syncDialogNote}>{t('config.syncHistoryEmpty')}</p>}
      {history !== null && history.commits.length > 0 && <ol className={css.syncHistoryList}>
        {history.commits.map(commit => <li key={commit.commit} className={css.syncHistoryEntry}>
          <div className={css.syncHistoryHead}>
            <strong>{when(commit.pushedAt ?? commit.committedAt)}</strong>
            <span>{t('config.syncHistoryFrom', { machine: commit.machine === undefined ? t('config.syncHistoryUnknownMachine') : commit.machine.label.trim() || commit.machine.id })}</span>
            <Tag tone="quiet">{commit.commit.slice(0, 8)}</Tag>
          </div>
          {commit.components.length > 0 && <small>{summaryLine(t, commit.components)}</small>}
          {!AUTOMATIC_MESSAGE.test(commit.message) && commit.message.trim() !== '' && <small className={css.syncHistoryMessage}>{commit.message}</small>}
        </li>)}
      </ol>}
      {capped && history !== null && <p className={css.syncDialogNote}>{t('config.syncHistoryCapped', { count: history.commits.length })}</p>}
      {history?.truncated === true && !capped && <div className={css.rowActions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(history.commits.length + HISTORY_PAGE)}>
          {busy ? t('config.syncHistoryLoading') : t('config.syncHistoryMore')}</Button>
      </div>}
    </div>
  </MnemonDialog>
}

interface SyncCompareDialogProps extends SyncDialogProps {
  /** Whether this Host accepts writes; reading the comparison never needs them. */
  writable: boolean
  /** Runs the same sync the row's button runs; answers why it did not finish, or null. */
  onSync: () => Promise<string | null>
  /** A merge ran here and may have written, so the section reads its status again. */
  onChanged: () => void
}

/**
 * What a sync would do, read before running it: per component whether the two
 * sides differ, and for runtime memory which entries are only on one side, which
 * subjects both wrote differently, which the branch holds that this computer
 * deleted, and which removals the branch recorded. Reading writes nothing; the
 * footer offers the sync itself and a merge that publishes nothing.
 */
export function SyncCompareDialog({ client, repoUrl, credential, writable, t, onClose, onSync, onChanged }: SyncCompareDialogProps): JSX.Element {
  const [preview, setPreview] = useState<MnemonSyncPreview | null>(null)
  const [difference, setDifference] = useState<MnemonSyncDiff | null>(null)
  const [busy, setBusy] = useState<'read' | 'merge' | 'revive' | 'sync' | null>('read')
  const [failed, setFailed] = useState<string | null>(null)
  // A branch that holds no backup yet is not a dead end: the first sync is what creates it.
  const [empty, setEmpty] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [showConflicts, setShowConflicts] = useState(false)

  const read = useCallback(async (): Promise<void> => {
    setBusy('read'); setFailed(null); setEmpty(false)
    try {
      // Both reads take the channel's lock, so they run one after the other: the second
      // would otherwise wait on the first and could give up while it fetches.
      const nextPreview = await client.previewSync()
      const nextDifference = await client.syncDiff()
      setPreview(nextPreview); setDifference(nextDifference)
    } catch (reason) {
      setPreview(null); setDifference(null)
      setEmpty(reasonOf(reason) === 'remote-empty')
      setFailed(failureText(t, reasonOf(reason), message(reason), repoUrl, credential))
    } finally { setBusy(null) }
  }, [client, repoUrl, credential, t])

  useEffect(() => { void read() }, [read])

  const merge = async (revive: boolean): Promise<void> => {
    if (busy !== null) return
    setBusy(revive ? 'revive' : 'merge'); setFailed(null); setNotice(null)
    let failure: string | null = null
    try {
      const result = await client.pullSync(undefined, revive)
      const added = result.runtime?.added ?? 0
      setNotice((revive ? t('config.syncCompareRevived', { count: added }) : added > 0 ? t('config.syncMergedCount', { count: added }) : t('config.syncMerged', { commit: result.commit.slice(0, 8) })) + runtimeArchiveNotice(t, result.runtime?.archived))
    } catch (reason) {
      failure = failureText(t, reasonOf(reason), message(reason), repoUrl, credential)
    } finally { setBusy(null) }
    // A merge that failed can have written already: the Host reads Memory Spaces again
    // after the write, and that read can fail on its own.
    onChanged()
    // Reading the comparison again clears this dialog's line, so a failure is said after it.
    await read()
    if (failure !== null) setFailed(failure)
  }

  const sync = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('sync'); setFailed(null); setNotice(null)
    const failure = await onSync()
    setBusy(null)
    if (failure === null) { onClose(); return }
    // The row's own line sits behind this dialog, so the failure is said here too.
    await read()
    setFailed(failure)
  }

  const goToReview = (): void => {
    onClose()
    const heading = document.getElementById('mnemon-review-heading')
    if (heading !== null && typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const conflicts = difference?.conflicts ?? []
  const conflicted = new Set(conflicts.flatMap(conflict => [conflict.target + '\u0000' + conflict.local.content, conflict.target + '\u0000' + conflict.remote.content]))
  const heldBack = difference?.heldBack ?? 0
  const removals = difference?.remoteTombstones.length ?? 0
  // Each entry is counted once, in the kind a merge treats it as: the branch's entries this
  // computer deleted stay out of "only on the remote", and the entries the branch's removals
  // will take away stay out of "only here"; both are said apart below.
  const remoteOnly = difference === null ? 0 : Math.max(difference.remoteOnly.filter(entry => !conflicted.has(entry.target + '\u0000' + entry.content)).length - heldBack, 0)
  const localOnly = difference === null ? 0 : Math.max(difference.localOnly.filter(entry => !conflicted.has(entry.target + '\u0000' + entry.content)).length - removals, 0)
  const differs = (component: MnemonPackComponent): boolean => preview?.components.find(entry => entry.component === component)?.changed === true
  const runtimeDiffers = remoteOnly + localOnly + conflicts.length > 0
  const anything = runtimeDiffers || removals + heldBack > 0 || differs('documents') || differs('memory-spaces')
  // A merge writes something only where the branch brings an entry, a wording or a removal in.
  const mergeable = remoteOnly + conflicts.length + removals > 0 || differs('documents') || differs('memory-spaces')
  const ready = preview !== null && difference !== null
  const machine = difference?.remote.machine === undefined ? t('config.syncHistoryUnknownMachine') : difference.remote.machine.label.trim() || difference.remote.machine.id

  return <MnemonDialog title={t('config.syncCompareTitle')} closeLabel={t('common.close')} wide busy={busy !== null && busy !== 'read'}
    contentReady={ready || failed !== null} onClose={onClose}
    footer={<>
      <Button variant="outline" size="sm" disabled={busy !== null || !writable || !ready || !mergeable} onClick={() => void merge(false)}>
        {busy === 'merge' ? t('config.syncMerging') : t('config.syncMergeOnly')}</Button>
      <Button variant="primary" size="sm" disabled={busy !== null || !writable || !(ready || empty)} onClick={() => void sync()}>
        {busy === 'sync' ? t('config.syncNowRunning') : t('config.syncNow')}</Button>
    </>}>
    <div className={css.syncDialogBody}>
      {busy === 'read' && !ready && <p className={css.syncDialogNote} role="status">{t('config.syncCompareLoading')}</p>}
      {failed !== null && <p className={css.error} role="alert">{failed}</p>}
      {notice !== null && <p className={css.syncSuccess} role="status">{notice}</p>}
      {ready && <>
        <p className={css.syncDialogNote}>{t('config.syncCompareRemote', { machine, time: when(difference.pushedAt ?? preview.pushedAt) })}</p>
        <ul className={css.syncCompareList}>
          <li>
            <span>{componentName(t, 'runtime')}</span>
            <small data-differs={runtimeDiffers || undefined}>{runtimeDiffers
              ? [t('config.syncCompareRuntime', { remote: remoteOnly, local: localOnly }), ...(conflicts.length > 0 ? [t('config.syncCompareConflicts', { count: conflicts.length })] : [])].join(' · ')
              : t('config.syncCompareSame')}</small>
          </li>
          {(['documents', 'memory-spaces'] as const).map(component => <li key={component}>
            <span>{componentName(t, component)}</span>
            <small data-differs={differs(component) || undefined}>{differs(component) ? t('config.syncCompareDiffers') : t('config.syncCompareSame')}</small>
          </li>)}
        </ul>
        {!anything && <p className={css.syncDialogNote}>{t('config.syncCompareAllSame')}</p>}
        {difference.truncated && <p className={css.syncDialogNote}>{t('config.syncCompareTruncated')}</p>}
        {removals > 0 && <p className={css.syncDialogNote}>{t('config.syncCompareRemovals', { count: removals })}</p>}
        {conflicts.length > 0 && <div className={css.syncCompareNote}>
          <p className={css.syncDialogNote}>{t('config.syncCompareConflictNote', { count: conflicts.length })}</p>
          <div className={css.rowActions}>
            <Button variant="ghost" size="sm" aria-expanded={showConflicts} onClick={() => setShowConflicts(value => !value)}>
              {showConflicts ? t('review.collapse') : t('config.syncCompareShowConflicts')}</Button>
            <Button variant="ghost" size="sm" onClick={goToReview}>{t('config.syncCompareGoReview')}</Button>
          </div>
          <Reveal>{showConflicts && <ul className={css.syncConflictList}>
            {conflicts.slice(0, SHOWN_CONFLICTS).map(conflict => <li key={conflict.target + '\u0000' + conflict.local.content} className={css.syncConflict}>
              <span><small>{t('config.syncDiffHere')}</small>{clip(conflict.local.content, 240)}</span>
              <span><small>{t('config.syncDiffThere')}</small>{clip(conflict.remote.content, 240)}</span>
            </li>)}
          </ul>}</Reveal>
        </div>}
        {heldBack > 0 && <div className={css.syncCompareNote}>
          <p className={css.syncDialogNote}>{t('config.syncCompareHeldBack', { count: heldBack })}</p>
          <div className={css.rowActions}>
            <Button variant="ghost" size="sm" disabled={busy !== null || !writable} onClick={() => void merge(true)}>
              {busy === 'revive' ? t('config.syncCompareReviving') : t('config.syncCompareRevive')}</Button>
          </div>
        </div>}
      </>}
    </div>
  </MnemonDialog>
}

/** A short question before an action whose consequence is easy to miss. */
export function SyncConfirmDialog(props: { title: string; body: string; confirm: string; busy?: boolean; error?: string | null; t: MnemonTranslate; onConfirm: () => void; onClose: () => void }): JSX.Element {
  return <MnemonDialog title={props.title} closeLabel={props.t('common.close')} busy={props.busy === true} onClose={props.onClose}
    footer={<>
      <Button variant="outline" size="sm" disabled={props.busy === true} onClick={props.onClose}>{props.t('common.cancel')}</Button>
      <Button variant="primary" size="sm" disabled={props.busy === true} onClick={props.onConfirm}>{props.confirm}</Button>
    </>}>
    <div className={css.syncDialogBody}>
      <p className={css.syncDialogNote}>{props.body}</p>
      {props.error !== undefined && props.error !== null && <p className={css.error} role="alert">{props.error}</p>}
    </div>
  </MnemonDialog>
}
