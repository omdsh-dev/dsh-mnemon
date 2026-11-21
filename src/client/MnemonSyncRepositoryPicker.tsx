import { useCallback, useEffect, useState, type JSX } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MnemonSyncGitHubRepository } from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'
import { message } from './page-kit.tsx'
import css from './MnemonSettingsCard.module.css'
import { SyncConfirmDialog } from './MnemonSyncDialogs.tsx'
import { reasonOf, repositoryNameValid } from './sync-view.ts'

const SHOWN_REPOSITORIES = 50

interface RepositoryPickerProps {
  client: MnemonClient
  login: string | undefined
  current: string | undefined
  disabled: boolean
  creating: boolean
  t: MnemonTranslate
  onChoose: (repository: MnemonSyncGitHubRepository) => Promise<void>
  onCreate: (name: string) => Promise<void>
  onSignInAgain: () => void
}

export function RepositoryPicker({ client, login, current, disabled, creating, t, onChoose, onCreate, onSignInAgain }: RepositoryPickerProps): JSX.Element {
  const [repositories, setRepositories] = useState<MnemonSyncGitHubRepository[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<{ text: string; expired: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const [confirming, setConfirming] = useState<MnemonSyncGitHubRepository | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setFailed(null)
    try {
      setRepositories((await client.githubRepositories()).repositories)
    } catch (reason) {
      const expired = reasonOf(reason) === 'github-unauthorized'
      setFailed({ text: expired ? t('config.syncGitHubExpiredGrant') : t('config.syncRepositoriesFailed', { error: message(reason) }), expired })
    } finally { setLoading(false) }
  }, [client, t])

  useEffect(() => { void load() }, [load])

  const needle = query.trim().toLowerCase()
  const matches = (repositories ?? []).filter(repository => needle === '' || repository.fullName.toLowerCase().includes(needle))
  const exact = (repositories ?? []).some(repository => repository.name.toLowerCase() === needle && (login === undefined || repository.owner.toLowerCase() === login.toLowerCase()))
  const creatable = needle !== '' && !exact && repositoryNameValid(query) && !query.includes('/')

  const pick = (repository: MnemonSyncGitHubRepository): void => {
    if (!repository.private) { setConfirming(repository); return }
    void onChoose(repository)
  }

  return <div className={css.syncPicker}>
    <div className={css.fieldGrid}>
      <label>{t('config.syncRepositoryLabel')}
        <input type="search" value={query} aria-label={t('config.syncRepositorySearch')} placeholder={t('config.syncRepositorySearch')} disabled={disabled}
          autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off" onChange={event => setQuery(event.target.value)} />
      </label>
    </div>
    {loading && repositories === null && <p className={css.editorNote} role="status">{t('config.syncRepositoriesLoading')}</p>}
    {failed !== null && <div className={css.syncWarning} role="alert">
      <span>{failed.text}</span>
      {failed.expired
        ? <Button variant="ghost" size="sm" onClick={onSignInAgain}>{t('config.syncGitHubSignInAgain')}</Button>
        : <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>{t('config.syncRepositoriesRetry')}</Button>}
    </div>}
    {repositories !== null && <ul className={css.syncRepositoryList} aria-label={t('config.syncRepositoryLabel')}>
      {creatable && <li>
        <button type="button" className={css.syncRepositoryOption} disabled={disabled} onClick={() => void onCreate(query.trim())}>
          <span>{creating ? t('config.syncRepositoryCreating') : t('config.syncRepositoryCreate', { name: (login === undefined ? '' : login + '/') + query.trim() })}</span>
          <Tag tone="quiet">{t('config.syncRepositoryPrivate')}</Tag>
        </button>
      </li>}
      {matches.slice(0, SHOWN_REPOSITORIES).map(repository => <li key={repository.fullName}>
        <button type="button" className={css.syncRepositoryOption} disabled={disabled || !repository.push} aria-current={repository.url === current ? 'true' : undefined}
          onClick={() => pick(repository)}>
          <span>{repository.fullName}</span>
          {repository.url === current && <Tag tone="outline">{t('config.syncRepositoryCurrent')}</Tag>}
          {!repository.push && <Tag tone="quiet">{t('config.syncRepositoryNoPush')}</Tag>}
          <Tag tone="quiet">{repository.private ? t('config.syncRepositoryPrivate') : t('config.syncRepositoryPublic')}</Tag>
        </button>
      </li>)}
      {matches.length === 0 && !creatable && <li className={css.editorNote}>{needle === '' ? t('config.syncRepositoriesNone') : t('config.syncRepositoriesEmpty')}</li>}
      {matches.length > SHOWN_REPOSITORIES && <li className={css.editorNote}>{t('config.syncRepositoriesMore', { count: matches.length - SHOWN_REPOSITORIES })}</li>}
    </ul>}
    {needle !== '' && !creatable && !exact && !repositoryNameValid(query) && !query.includes('/') && <p className={css.error}>{t('config.syncRepositoryNameInvalid')}</p>}
    {confirming !== null && <SyncConfirmDialog title={t('config.syncPublicTitle')} body={t('config.syncPublicBody', { name: confirming.fullName })}
      confirm={t('config.syncPublicConfirm')} t={t} onClose={() => setConfirming(null)}
      onConfirm={() => { const repository = confirming; setConfirming(null); void onChoose(repository) }} />}
  </div>
}
