import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { Button, PathLabel, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  MNEMON_SYNC_TOKEN_ENV,
  type ClientConnectionHandle,
  type MnemonSyncCredentialSource,
  type MnemonSyncGitHubStatus,
  type MnemonSyncPushResult,
  type MnemonSyncStatus,
} from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'
import { message } from './page-kit.tsx'
import css from './MnemonSettingsCard.module.css'
import { SettingRow, SettingSelect, ToggleRow, type SettingOption } from './settings-controls.tsx'
import { SyncCompareDialog, SyncConfirmDialog, SyncHistoryDialog } from './MnemonSyncDialogs.tsx'
import {
  AUTO_SYNC_CHOICES, runtimeArchiveNotice, credentialText, failureText, intervalLabel, issueText, onGitHub, reasonOf, repositoryName, repositoryProblem, transportOf, when,
} from './sync-view.ts'
import { FeedbackLine, type Feedback } from './sync-feedback.tsx'
import type { RepositoryEditorProps } from './sync-repository-editor.ts'
import { GitHubConnect } from './MnemonSyncGitHubConnect.tsx'
import { AdvancedSettings } from './MnemonSyncAdvancedSettings.tsx'

/** Exponential backoff while waiting for the Host to observe the newly saved sync switch. */
const STATUS_SETTLE_INITIAL_MS = 250
const STATUS_SETTLE_MAX_MS = 1_000
const STATUS_SETTLE_ATTEMPTS = 8

interface MnemonSyncSectionProps {
  client?: MnemonClient
  connection?: ClientConnectionHandle
  sessionId?: string
  workspaceId?: string
  /** Whether the Host accepts writes at all; a read-only Host only reports status. */
  disabled: boolean
  /**
   * Whether this installation syncs at all. Off is the default, and off is
   * silent: the section asks the Host nothing and runs no Git.
   */
  enabled: boolean
  /** Saves the switch's choice; the storage section above owns the stored value. */
  onEnabled: (enabled: boolean) => void
  /** A sync or a merge ran, and may have brought memory in from the repository. */
  onMerged?: () => void
  t: MnemonTranslate
}

/**
 * Git repository sync, in the order a person sets it up: connect a repository,
 * sync, choose how often it syncs on its own, look back at what it kept, and
 * only then the advanced choices of branch, directory and commit author.
 *
 * The switch is the whole gate: switched off, this is one row that asks the Host
 * nothing — no status, no repository, no Git.
 *
 * A sync merges the repository's memory into this computer and then publishes
 * the result, so it is the one primary action. "Check remote" reads what a sync
 * would change and writes nothing until a button in it is pressed.
 */
export function MnemonSyncSection({ client: sharedClient, connection, sessionId, workspaceId, disabled, enabled, onEnabled, onMerged, t }: MnemonSyncSectionProps): JSX.Element {
  const client = useMemo(
    () => sharedClient ?? (connection === undefined ? null : new MnemonClient(connection, sessionId, workspaceId)),
    [connection, sessionId, sharedClient, workspaceId],
  )
  const [status, setStatus] = useState<MnemonSyncStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [github, setGithub] = useState<MnemonSyncGitHubStatus | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'sync' | 'disconnect' | 'auto' | null>(null)
  const [syncFeedback, setSyncFeedback] = useState<Feedback | null>(null)
  const [repositoryFeedback, setRepositoryFeedback] = useState<Feedback | null>(null)
  const [autoFeedback, setAutoFeedback] = useState<Feedback | null>(null)
  const [dialog, setDialog] = useState<'compare' | 'history' | 'disconnect' | null>(null)
  const [disconnectFailed, setDisconnectFailed] = useState<string | null>(null)
  // The way the editor opens: the state line can ask for the GitHub sign-in directly.
  const [editMode, setEditMode] = useState<'github' | 'address' | undefined>(undefined)

  const readStatus = useCallback(async (): Promise<void> => {
    if (client === null) return
    setChecking(true)
    try {
      setStatus(await client.syncStatus())
      setLoadFailed(null)
    } catch (reason) {
      setLoadFailed(message(reason))
    } finally {
      setChecking(false)
      setLoaded(true)
    }
  }, [client])

  const readGitHub = useCallback(async (): Promise<void> => {
    if (client === null) return
    try {
      setGithub(await client.githubStatus())
    } catch {
      // A Host without the sign-in channel offers the address form alone.
      setGithub(null)
    }
  }, [client])

  useEffect(() => {
    if (client === null) { setLoaded(true); return }
    // Switched off there is nothing to report: reading the channel here would run
    // Git for a reader who never asked for a repository.
    if (!enabled) return
    let active = true
    // The switch saves the profile first, and until the Host's runtime has the new value
    // the channel still answers as switched off, with nothing checked. Read again for a
    // moment instead of showing that answer as the state of Git and the remote.
    setLoaded(false)
    void (async () => {
      let next = await client.syncStatus()
      let delayMs = STATUS_SETTLE_INITIAL_MS
      for (let attempt = 0; active && next.enabled === false && attempt < STATUS_SETTLE_ATTEMPTS; attempt += 1) {
        await new Promise(settle => setTimeout(settle, delayMs))
        delayMs = Math.min(delayMs * 2, STATUS_SETTLE_MAX_MS)
        next = await client.syncStatus()
      }
      return next
    })().then(
      next => { if (active) { setStatus(next); setLoadFailed(null); setLoaded(true) } },
      reason => { if (active) { setLoadFailed(message(reason)); setLoaded(true) } },
    )
    void client.githubStatus().then(
      next => { if (active) setGithub(next) },
      () => { if (active) setGithub(null) },
    )
    return () => { active = false }
  }, [client, enabled])

  const repoUrl = status?.config.repoUrl
  const connected = status !== null && status.enabled !== false && repoUrl !== undefined
  const editable = !disabled && client !== null
  const gitReady = status?.git.available === true
  // The credential the Host offers the repository, which a refusal is then said to be about.
  const credential: MnemonSyncCredentialSource = status?.config.credentialSource ?? 'none'

  /**
   * The one primary action: merge the repository here, then publish the result.
   * Answers why it did not finish, or null when it did, for a caller that shows it elsewhere.
   */
  const sync = async (): Promise<string | null> => {
    if (client === null || busy !== null || repoUrl === undefined) return null
    setBusy('sync'); setSyncFeedback(null)
    let failure: string | null = null
    try {
      const result = await client.pushSync()
      const feedback = syncResult(t, result, repoUrl, credential)
      setSyncFeedback(feedback)
      if (feedback.tone === 'error') failure = feedback.text
    } catch (reason) {
      failure = t('config.syncFailed', { error: failureText(t, reasonOf(reason), message(reason), repoUrl, credential) })
      setSyncFeedback({ tone: 'error', text: failure })
    } finally { setBusy(null) }
    // The branch is folded in before anything is published, so even a sync that did not
    // finish can have changed memory here.
    onMerged?.()
    // The state line follows on its own; the buttons do not wait for it.
    void readStatus()
    return failure
  }

  const setAutoSync = async (minutes: number): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('auto'); setAutoFeedback(null)
    try {
      const next = await client.configureSync({ autoBackupMinutes: minutes })
      setStatus(current => current === null ? current : { ...current, config: next })
      // The selector already shows the interval, and the hint when the next run is due.
      void readStatus()
    } catch (reason) {
      setAutoFeedback({ tone: 'error', text: message(reason) })
    } finally { setBusy(null) }
  }

  const disconnect = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('disconnect'); setRepositoryFeedback(null); setSyncFeedback(null); setDisconnectFailed(null)
    try {
      // The token belonged to that repository, and the timer synced to it, so both go with it.
      await client.configureSync({ repoUrl: null, token: null, autoBackupMinutes: 0 })
      setDialog(null); setEditing(false)
      setRepositoryFeedback({ tone: 'success', text: t('config.syncDisconnected') })
      void readStatus()
    } catch (reason) {
      // The dialog is still open over the row, so the failure is said inside it.
      setDisconnectFailed(message(reason))
    } finally { setBusy(null) }
  }

  /**
   * A connection was saved: the editor closes and the repository is read again.
   * The state line under the repository is the answer, so nothing claims it is
   * connected before the Host has said whether it answers.
   */
  const connectedTo = async (): Promise<void> => {
    setEditing(false); setSyncFeedback(null); setRepositoryFeedback(null)
    await readStatus()
  }

  /** The state line's own way out: credentials are changed in the editor that set them. */
  const fixCredentials = (): void => {
    setRepositoryFeedback(null)
    setEditMode(repoUrl !== undefined && onGitHub(repoUrl) && github?.available === true ? 'github' : 'address')
    setEditing(true)
  }

  const autoBackup = status?.autoBackup
  const minutes = status?.config.autoBackupMinutes ?? 0
  const autoOptions: SettingOption<string>[] = AUTO_SYNC_CHOICES.map(choice => ({ value: String(choice), label: intervalLabel(t, choice) }))
  const autoHint: ReactNode = autoBackup?.lastError !== undefined && minutes > 0
    ? <span className={css.error}>{t('config.syncAutoFailed', { error: failureText(t, autoBackup.lastFailure, autoBackup.lastError, repoUrl ?? '', credential) })}</span>
    : minutes <= 0
      ? t('config.syncAutoHintOff')
      : [autoBackup?.nextAt === undefined ? '' : t('config.syncAutoNext', { time: when(autoBackup.nextAt) }), autoBackup?.lastAt === undefined ? '' : t('config.syncAutoLast', { time: when(autoBackup.lastAt) })].filter(Boolean).join(' · ') || t('config.syncAutoHintOn')
  const lastRun = status?.lastRun
  const syncHint = lastRun === undefined
    ? t('config.syncNever')
    : lastRun.kind === 'merge' ? t('config.syncLastMerge', { time: when(lastRun.at) }) : t('config.syncLast', { time: when(lastRun.at) })

  return <div className={css.syncRow} role="group" aria-labelledby="mnemon-sync-heading">
    <ToggleRow id="mnemon-sync-enabled" titleId="mnemon-sync-heading" label={t('config.syncTitle')} hint={t('config.syncSimpleDescription')}
      checked={enabled} disabled={disabled} onChange={onEnabled} />
    {enabled && <div className={css.syncPanel}>
      {client === null && <p className={css.readOnly}>{t('config.syncUnavailable')}</p>}
      {client !== null && !loaded && <p className={css.syncDialogNote} role="status">{t('config.syncLoading')}</p>}
      {client !== null && loaded && status === null && <p className={css.error} role="alert">{t('config.syncUnavailableReason', { error: loadFailed ?? '' })}</p>}
      {client !== null && loaded && status !== null && <>
        {!gitReady && status.enabled !== false && <div className={css.syncWarning} role="status">
          <span>{t('config.syncGitMissing', { required: status.git.required })}</span>
          <Button variant="ghost" size="sm" disabled={checking} onClick={() => void readStatus()}>{t('config.syncRecheck')}</Button>
        </div>}
        {connected && !editing
          ? <SettingRow title={t('config.syncRepository')} titleId="mnemon-sync-repository-title"
            hint={<><RepositoryState status={status} checking={checking} t={t} onRecheck={() => void readStatus()} onFix={editable ? fixCredentials : undefined} /><FeedbackLine value={repositoryFeedback} /></>}>
            <Button variant="outline" size="sm" disabled={!editable || busy !== null} onClick={() => { setRepositoryFeedback(null); setEditMode(undefined); setEditing(true) }}>{t('config.syncChange')}</Button>
            <Button variant="ghost" size="sm" disabled={!editable || busy !== null} onClick={() => setDialog('disconnect')}>{t('config.syncDisconnect')}</Button>
          </SettingRow>
          : <div className={css.syncConnect}>
            <SettingRow title={t('config.syncRepository')} titleId="mnemon-sync-repository-title" hint={<>{t('config.syncRepositoryHint')}<FeedbackLine value={repositoryFeedback} /></>} />
            <RepositoryEditor client={client} status={status} github={github} disabled={!editable} cancellable={connected} initialMode={editMode}
              t={t} onGitHub={setGithub} onReadGitHub={readGitHub} onRefresh={readStatus}
              onCancel={() => { setEditing(false); void readStatus() }} onConnected={connectedTo} />
          </div>}
        {connected && !editing && <>
          <SettingRow title={t('config.syncRowTitle')} titleId="mnemon-sync-now-title" hint={<>{syncHint}<FeedbackLine value={syncFeedback} /></>}>
            <Button variant="outline" size="sm" disabled={!gitReady || busy !== null} onClick={() => { setSyncFeedback(null); setDialog('compare') }}>{t('config.syncCheck')}</Button>
            <Button variant="primary" size="sm" disabled={!gitReady || !editable || busy !== null} onClick={() => void sync()}>
              {busy === 'sync' ? t('config.syncNowRunning') : t('config.syncNow')}</Button>
          </SettingRow>
          <SettingRow title={t('config.syncAuto')} titleId="mnemon-sync-auto-title" hint={<>{autoHint}<FeedbackLine value={autoFeedback} /></>}>
            <SettingSelect labelledBy="mnemon-sync-auto-title" value={String(minutes)} options={autoOptions} disabled={!editable || busy !== null}
              onChange={value => void setAutoSync(Number(value))} />
          </SettingRow>
          <SettingRow title={t('config.syncHistory')} titleId="mnemon-sync-history-title" hint={t('config.syncHistoryHint')}>
            <Button variant="outline" size="sm" disabled={!gitReady} onClick={() => setDialog('history')}>{t('config.syncHistoryView')}</Button>
          </SettingRow>
        </>}
        <AdvancedSettings client={client} status={status} disabled={!editable} t={t} onSaved={readStatus} />
      </>}
    </div>}
    {client !== null && repoUrl !== undefined && dialog === 'compare' && <SyncCompareDialog client={client} repoUrl={repoUrl} credential={credential} writable={editable} t={t}
      onClose={() => setDialog(null)} onSync={sync} onChanged={() => { onMerged?.(); void readStatus() }} />}
    {client !== null && repoUrl !== undefined && dialog === 'history' && <SyncHistoryDialog client={client} repoUrl={repoUrl} credential={credential} t={t} onClose={() => setDialog(null)} />}
    {repoUrl !== undefined && dialog === 'disconnect' && <SyncConfirmDialog title={t('config.syncDisconnectTitle')}
      body={t('config.syncDisconnectBody', { repository: repositoryName(repoUrl) })} confirm={t('config.syncDisconnect')}
      busy={busy === 'disconnect'} error={disconnectFailed} t={t} onConfirm={() => void disconnect()} onClose={() => { setDialog(null); setDisconnectFailed(null) }} />}
  </div>
}

/** What one finished sync did, said as one line. */
function syncResult(t: MnemonTranslate, result: MnemonSyncPushResult, repoUrl: string, credential: MnemonSyncCredentialSource): Feedback {
  const added = result.merged?.runtime?.added ?? 0
  const commit = result.commit.slice(0, 8)
  const archive = runtimeArchiveNotice(t, result.merged?.runtime?.archived)
  if (result.pushed) return { tone: 'success', text: (added > 0 ? t('config.syncDoneMerged', { count: added, commit }) : t('config.syncDone', { commit })) + archive }
  if (!result.committed) return { tone: 'success', text: (added > 0 ? t('config.syncUpToDateMerged', { count: added }) : t('config.syncUpToDate')) + archive }
  return { tone: 'error', text: t('config.syncPushFailed', { reason: failureText(t, result.failure, result.reason ?? '', repoUrl, credential) }) + archive }
}

/** Where the repository is, whether it answers, and how it is authenticated. */
function RepositoryState({ status, checking, t, onRecheck, onFix }: { status: MnemonSyncStatus; checking: boolean; t: MnemonTranslate; onRecheck: () => void; onFix?: (() => void) | undefined }): JSX.Element {
  const url = status.config.repoUrl ?? ''
  const remote = status.remote
  const credential = credentialText(t, status)
  const state = checking
    ? { dot: 'ongoing' as const, text: t('config.syncStateChecking') }
    : !status.git.available
      ? { dot: 'idle' as const, text: t('config.syncReasonGitMissing') }
      : !remote.reachable
        ? { dot: 'error' as const, text: issueText(t, remote.issue, url, remote.error, status.config.credentialSource) }
        : {
          // Reading an HTTPS repository can succeed without credentials while pushing to it cannot.
          dot: credential === undefined && transportOf(url) === 'https' ? 'warning' as const : 'done' as const,
          text: [
            remote.branchExists ? t('config.syncStateConnected') : t('config.syncStateNewBranch', { branch: status.config.branch }),
            ...(credential !== undefined ? [credential] : transportOf(url) === 'https' ? [onGitHub(url) ? t('config.syncNoCredential') : t('config.syncNoCredentialToken')] : []),
          ].join(' · '),
        }
  return <span className={css.syncRepositoryState}>
    <span className={css.syncRepositoryName}>{transportOf(url) === 'local' ? <PathLabel path={url} /> : repositoryName(url)}</span>
    <span className={css.syncStateLine} data-tone={state.dot}>
      <StateDot state={state.dot} />
      <span>{state.text}</span>
      {/* GitHub also answers "not found" for a repository the credentials cannot reach. */}
      {!checking && onFix !== undefined && (remote.issue === 'auth' || remote.issue === 'not-found') && transportOf(url) === 'https' && status.git.available
        && <button type="button" className={css.syncInlineAction} onClick={onFix}>{t('config.syncFixCredentials')}</button>}
      {!checking && <button type="button" className={css.syncInlineAction} onClick={onRecheck}>{t('config.syncRecheck')}</button>}
    </span>
  </span>
}

/** Connect a repository: through a GitHub sign-in, or by its address. */
function RepositoryEditor(props: RepositoryEditorProps): JSX.Element {
  const { status, github, t } = props
  const githubOffered = github?.available === true
  const saved = status.config.repoUrl
  const [mode, setMode] = useState<'github' | 'address'>(() => props.initialMode ?? (githubOffered && (saved === undefined || onGitHub(saved)) ? 'github' : 'address'))
  // A sign-in channel that answers after the editor opened still becomes the default way in.
  const chosen = useRef(props.initialMode !== undefined)
  useEffect(() => {
    if (!chosen.current && githubOffered && saved === undefined) setMode('github')
  }, [githubOffered, saved])
  const name = useId()
  return <div className={css.editor}>
    {githubOffered && <div className={css.inlineChoices} role="radiogroup" aria-label={t('config.syncConnectWith')}>
      {(['github', 'address'] as const).map(value => <label key={value}>
        <input type="radio" name={name} value={value} checked={mode === value} disabled={props.disabled}
          onChange={() => { chosen.current = true; setMode(value) }} />
        <span>{value === 'github' ? t('config.syncModeGitHub') : t('config.syncModeAddress')}</span>
      </label>)}
    </div>}
    {mode === 'github' && githubOffered && github !== null
      ? <GitHubConnect {...props} github={github} />
      : <AddressConnect {...props} />}
  </div>
}

/** Whether two HTTPS addresses name the same host, the one a saved token was saved for. */
function sameHost(left: string, right: string): boolean {
  try {
    return new URL(left.trim()).host.toLowerCase() === new URL(right.trim()).host.toLowerCase()
  } catch {
    return false
  }
}

/** The address form: a repository URL, and a token where the address is HTTPS. */
function AddressConnect({ client, status, disabled, cancellable, t, onRefresh, onCancel, onConnected }: RepositoryEditorProps): JSX.Element {
  const saved = status.config.repoUrl ?? ''
  const [url, setUrl] = useState(saved)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'connect' | 'token' | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const tokenId = useId()
  const problem = repositoryProblem(url)
  const https = transportOf(url) === 'https'
  const environment = status.config.credentialSource === 'environment'
  // A saved token belongs to the host it was saved for; another host starts without one.
  const storedToken = status.config.credentialSource === 'token' && sameHost(url, saved)
  const changed = url.trim() !== saved || token.trim() !== ''
  const ready = url.trim() !== '' && problem === undefined && changed

  const connect = async (): Promise<void> => {
    if (!ready || busy !== null) return
    setBusy('connect'); setFeedback(null)
    try {
      const next = url.trim()
      await client.configureSync({ repoUrl: next, ...(https && token.trim() !== '' ? { token: token.trim() } : {}), ...(https ? {} : { token: null }) })
      setToken('')
      await onConnected()
    } catch (reason) {
      setFeedback({ tone: 'error', text: message(reason) })
    } finally { setBusy(null) }
  }

  const removeToken = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('token'); setFeedback(null)
    try {
      await client.configureSync({ token: null })
      setFeedback({ tone: 'success', text: t('config.syncTokenRemoved') })
      void onRefresh()
    } catch (reason) {
      setFeedback({ tone: 'error', text: message(reason) })
    } finally { setBusy(null) }
  }

  return <>
    <div className={css.fieldGrid}>
      <label>{t('config.syncRepoUrl')}
        <input type="text" value={url} aria-label={t('config.syncRepoUrl')} placeholder={t('config.syncRepoUrlPlaceholder')} disabled={disabled || busy !== null}
          aria-invalid={problem === undefined ? undefined : true} autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off"
          onChange={event => setUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void connect() }} />
      </label>
      {https && <div className={css.syncFieldBox}>
        {/* The caption labels the input alone; Remove sits beside it, outside the label, so a
            click meant to focus the field never removes the saved token. */}
        <span className={css.syncFieldLabel}>
          <label htmlFor={tokenId}>{t('config.syncToken')}</label>
          {storedToken && <button type="button" className={css.syncInlineAction} disabled={disabled || busy !== null} onClick={() => void removeToken()}>{t('config.syncTokenRemove')}</button>}
        </span>
        <input id={tokenId} type="password" value={token} aria-label={t('config.syncToken')} disabled={disabled || busy !== null || environment}
          placeholder={environment ? t('config.syncTokenEnvironment', { env: MNEMON_SYNC_TOKEN_ENV }) : storedToken ? t('config.syncTokenSaved') : t('config.syncTokenOptional')}
          autoComplete="new-password" spellCheck={false} onChange={event => setToken(event.target.value)} />
      </div>}
    </div>
    {problem !== undefined && <p className={css.error}>{problem === 'credentials' ? t('config.syncRepoUrlCredentials') : t('config.syncRepoUrlInvalid')}</p>}
    {https && problem === undefined && <p className={css.editorNote}>{t('config.syncTokenHint')}</p>}
    <div className={css.memoryConfigFooter}>
      <div className={css.configFeedback} aria-live="polite"><FeedbackLine value={feedback} /></div>
      <div>
        {cancellable && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onCancel}>{t('common.cancel')}</Button>}
        <Button variant="primary" size="sm" disabled={disabled || !ready || busy !== null} onClick={() => void connect()}>
          {busy === 'connect' ? t('config.syncConnecting') : saved === '' ? t('config.syncConnect') : t('config.syncSave')}</Button>
      </div>
    </div>
  </>
}
