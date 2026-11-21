import { useEffect, useState, type JSX } from 'react'
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MnemonSyncGitHubRepository, MnemonSyncGitHubStatus } from '../host/protocol.ts'
import { message } from './page-kit.tsx'
import css from './MnemonSettingsCard.module.css'
import { failureText, reasonOf } from './sync-view.ts'
import type { RepositoryEditorProps } from './sync-repository-editor.ts'
import { RepositoryPicker } from './MnemonSyncRepositoryPicker.tsx'

export function GitHubConnect(props: RepositoryEditorProps & { github: MnemonSyncGitHubStatus }): JSX.Element {
  const { client, github, disabled, cancellable, t, onGitHub, onReadGitHub, onCancel, onConnected } = props
  const [busy, setBusy] = useState<'start' | 'cancel' | 'signout' | 'choose' | 'create' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pollTick, setPollTick] = useState(0)
  const [pollMs, setPollMs] = useState(5_000)
  const flow = github.flow
  const signedIn = github.signedIn

  const start = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('start'); setFailed(null); setCopied(false)
    try {
      const next = await client.githubStart()
      onGitHub(next)
      setPollMs(next.flow?.intervalMs ?? 5_000)
      setPollTick(0)
    } catch (reason) {
      setFailed(t('config.syncGitHubFailed', { error: message(reason) }))
    } finally { setBusy(null) }
  }

  const cancel = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('cancel'); setFailed(null)
    try {
      onGitHub(await client.githubCancel())
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  const signOut = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('signout'); setFailed(null)
    try {
      onGitHub(await client.githubSignOut())
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  const signInAgain = async (): Promise<void> => {
    await signOut()
    await start()
  }

  const copyAndOpen = async (): Promise<void> => {
    if (flow === undefined) return
    const copying = writeClipboard(flow.userCode).catch(() => false)
    const opened = window.open(flow.verificationUri, '_blank')
    if (opened !== null) opened.opener = null
    setCopied(await copying)
    if (opened === null) setFailed(t('config.syncGitHubOpenBlocked', { url: flow.verificationUri }))
  }

  useEffect(() => {
    if (flow === undefined || signedIn) return
    let active = true
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const answer = await client.githubPoll()
          if (!active) return
          setFailed(null)
          if (answer.status === 'pending') {
            if (answer.intervalMs !== undefined) setPollMs(answer.intervalMs)
            setPollTick(current => current + 1)
            return
          }
          await onReadGitHub()
          if (!active) return
          if (answer.status === 'expired') setFailed(t('config.syncGitHubExpired'))
          else if (answer.status === 'denied') setFailed(t('config.syncGitHubDenied'))
          else if (answer.status === 'error') setFailed(t('config.syncGitHubFailed', { error: answer.message ?? '' }))
        } catch (reason) {
          if (active) { setFailed(message(reason)); setPollTick(current => current + 1) }
        }
      })()
    }, Math.max(pollMs, 1_000))
    return () => { active = false; clearTimeout(timer) }
  }, [client, flow?.userCode, signedIn, pollMs, pollTick, onReadGitHub, t])

  const choose = async (repository: MnemonSyncGitHubRepository): Promise<void> => {
    setBusy('choose'); setFailed(null)
    try {
      await client.configureSync({ repoUrl: repository.url, token: null })
      await onConnected()
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  const create = async (name: string): Promise<void> => {
    setBusy('create'); setFailed(null)
    try {
      const created = await client.githubCreateRepository(name, true)
      await client.configureSync({ repoUrl: created.url, token: null })
      await onConnected()
    } catch (reason) {
      setFailed(failureText(t, reasonOf(reason), message(reason), ''))
    } finally { setBusy(null) }
  }

  return <>
    {!signedIn && flow === undefined && <>
      <p className={css.editorNote}>{github.writable ? t('config.syncGitHubHint') : t('config.syncGitHubReadOnly')}</p>
      <div className={css.rowActions}>
        <Button variant="primary" size="sm" disabled={disabled || !github.writable || busy !== null} onClick={() => void start()}>
          {busy === 'start' ? t('config.syncGitHubStarting') : t('config.syncGitHubSignIn')}</Button>
        {cancellable && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onCancel}>{t('common.cancel')}</Button>}
      </div>
    </>}
    {!signedIn && flow !== undefined && <div className={css.syncDevice}>
      <p className={css.editorNote}>{t('config.syncGitHubCode')}</p>
      <div className={css.syncCode}>
        <code>{flow.userCode}</code>
        <Button variant="primary" size="sm" onClick={() => void copyAndOpen()}>{t('config.syncGitHubCopyOpen')}</Button>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void cancel()}>{t('common.cancel')}</Button>
      </div>
      <p className={css.editorNote} role="status">{copied ? t('config.syncGitHubCopied') : t('config.syncGitHubWaiting')}</p>
    </div>}
    {signedIn && <>
      <div className={css.syncAccount}>
        <span>{github.login === undefined ? t('config.syncViaGitHubAnonymous') : t('config.syncGitHubSignedIn', { login: github.login })}</span>
        <Button variant="ghost" size="sm" disabled={disabled || busy !== null} onClick={() => void signOut()}>{t('config.syncGitHubSignOut')}</Button>
      </div>
      <RepositoryPicker client={client} login={github.login} current={props.status.config.repoUrl} disabled={disabled || busy !== null}
        creating={busy === 'create'} t={t} onChoose={choose} onCreate={create} onSignInAgain={() => void signInAgain()} />
      {cancellable && <div className={css.rowActions}><Button variant="ghost" size="sm" disabled={busy !== null} onClick={onCancel}>{t('common.cancel')}</Button></div>}
    </>}
    {failed !== null && <p className={css.error} role="alert">{failed}</p>}
  </>
}
