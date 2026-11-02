import { useEffect, useId, useState, type JSX } from 'react'
import { Button, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL,
  MNEMON_SYNC_DEFAULT_AUTHOR_NAME,
  MNEMON_SYNC_DEFAULT_BRANCH,
  MNEMON_SYNC_DEFAULT_SUBDIR,
  type MnemonMachineLabelSource,
  type MnemonSyncStatus,
} from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'
import { message } from './page-kit.tsx'
import css from './MnemonSettingsCard.module.css'
import { DEFAULT_AUTHOR, authorModeOf, branchValid, directoryValid, emailValid, machineNameValid, type AuthorMode } from './sync-view.ts'
import { FeedbackLine, type Feedback } from './sync-feedback.tsx'

/**
 * What this computer is called, where on the branch the memory goes and whose name
 * its commits carry. Each field shows the value in use; the computer's name is the
 * host name or a typed one. The default author follows this computer's Git
 * identity with a placeholder fallback; a custom author overrides it.
 */
export function AdvancedSettings({ client, status, disabled, t, onSaved }: { client: MnemonClient; status: MnemonSyncStatus; disabled: boolean; t: MnemonTranslate; onSaved: () => Promise<void> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const config = status.config
  const savedMode = authorModeOf(config.authorName, config.authorEmail)
  const [branch, setBranch] = useState(config.branch)
  const [subdir, setSubdir] = useState(config.subdir)
  const [mode, setMode] = useState<AuthorMode>(savedMode)
  const [name, setName] = useState(savedMode === 'custom' ? config.authorName : '')
  const [email, setEmail] = useState(savedMode === 'custom' ? config.authorEmail : '')
  // This computer's name: its host name, which it then follows, or one typed here.
  const savedLabel = status.machine?.label ?? ''
  const savedSource: MnemonMachineLabelSource = status.machineLabel?.source ?? 'hostname'
  const hostname = status.machineLabel?.hostname ?? savedLabel
  const [nameSource, setNameSource] = useState<MnemonMachineLabelSource>(savedSource)
  const [machineName, setMachineName] = useState(savedSource === 'custom' ? savedLabel : '')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const radio = useId()
  const nameRadio = useId()

  // The saved values seed the form again whenever the Host reports new ones.
  useEffect(() => {
    setBranch(config.branch); setSubdir(config.subdir)
    const next = authorModeOf(config.authorName, config.authorEmail)
    setMode(next)
    setName(next === 'custom' ? config.authorName : ''); setEmail(next === 'custom' ? config.authorEmail : '')
  }, [config.branch, config.subdir, config.authorName, config.authorEmail])
  useEffect(() => {
    setNameSource(savedSource); setMachineName(savedSource === 'custom' ? savedLabel : '')
  }, [savedSource, savedLabel])

  const author = mode === 'default'
    ? { authorName: MNEMON_SYNC_DEFAULT_AUTHOR_NAME, authorEmail: MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL }
    : mode === 'machine' ? { authorName: '', authorEmail: '' } : { authorName: name.trim(), authorEmail: email.trim() }
  const branchOk = branchValid(branch)
  const subdirOk = directoryValid(subdir)
  // A saved author kept as it is never blocks another change, even one an older version
  // stored with a single field; a typed custom author needs both.
  const authorChanged = author.authorName !== config.authorName || author.authorEmail !== config.authorEmail
  const customOk = mode !== 'custom' || !authorChanged || (name.trim() !== '' && emailValid(email))
  const normalizedSubdir = subdir.trim().replaceAll('\\', '/').split('/').filter(part => part !== '').join('/') + '/'
  const moved = branch.trim() !== config.branch || normalizedSubdir !== config.subdir
  const nameOk = nameSource === 'hostname' || machineNameValid(machineName)
  const renamed = nameSource !== savedSource || (nameSource === 'custom' && machineName.trim() !== savedLabel)
  const changed = moved || renamed || author.authorName !== config.authorName || author.authorEmail !== config.authorEmail
  const ready = changed && branchOk && subdirOk && customOk && nameOk
  // The name a version will carry once this form is saved, as history will show it.
  const shownName = nameSource === 'hostname' ? hostname : machineName.trim()

  const save = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true); setFeedback(null)
    try {
      await client.configureSync({
        branch: branch.trim(), subdir: subdir.trim(), ...author,
        ...(renamed ? { machineLabel: nameSource === 'hostname' ? null : machineName.trim() } : {}),
      })
      setFeedback({ tone: 'success', text: t('config.syncAdvancedSaved') })
      void onSaved()
    } catch (reason) {
      setFeedback({ tone: 'error', text: message(reason) })
    } finally { setBusy(false) }
  }

  return <div className={css.syncAdvanced}>
    <button type="button" className={css.syncDisclosure} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span>{t('config.syncAdvanced')}</span>
      <small>{[savedLabel, config.branch, config.subdir, savedMode === 'default' ? t('config.syncAuthorDefault') : savedMode === 'machine' ? t('config.syncAuthorMachine') : config.authorName || config.authorEmail || t('config.syncAuthorCustom')].filter(part => part !== '').join(' · ')}</small>
      <IconChevronDownOutlineRegular className={css.providerChevron} size={14} />
    </button>
    {open && <div className={css.editor}>
      {status.machine !== undefined && <div className={css.syncChoice}>
        <span className={css.syncFieldLabel} id={nameRadio + '-label'}>{t('config.syncMachineName')}</span>
        <div className={css.inlineChoices} role="radiogroup" aria-labelledby={nameRadio + '-label'}>
          {(['hostname', 'custom'] as const).map(value => <label key={value}>
            <input type="radio" name={nameRadio} value={value} checked={nameSource === value} disabled={disabled || busy} onChange={() => setNameSource(value)} />
            <span>{value === 'hostname' ? t('config.syncMachineHostname') : t('config.syncMachineCustom')}</span>
          </label>)}
        </div>
        {nameSource === 'custom' && <div className={css.fieldGrid}>
          <label>{t('config.syncMachineNameLabel')}
            <input type="text" value={machineName} aria-label={t('config.syncMachineName')} disabled={disabled || busy}
              aria-invalid={machineName.trim() === '' || nameOk ? undefined : true} autoComplete="off" spellCheck={false}
              onChange={event => setMachineName(event.target.value)} />
            {machineName.trim() !== '' && !nameOk && <small className={css.error}>{t('config.syncMachineNameInvalid')}</small>}
          </label>
        </div>}
        {(nameSource === 'hostname' || nameOk) && <p className={css.editorNote}>
          {nameSource === 'hostname' ? t('config.syncMachineHostnameNote', { name: shownName }) : t('config.syncMachineCustomNote', { name: shownName })}
        </p>}
      </div>}
      <div className={css.fieldGrid}>
        <label>{t('config.syncBranch')}
          <input type="text" value={branch} aria-label={t('config.syncBranch')} disabled={disabled || busy} aria-invalid={branchOk ? undefined : true}
            autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off" onChange={event => setBranch(event.target.value)} />
          <small>{branchOk ? t('config.syncDefaultValue', { value: MNEMON_SYNC_DEFAULT_BRANCH }) : t('config.syncBranchInvalid')}</small>
        </label>
        <label>{t('config.syncSubdir')}
          <input type="text" value={subdir} aria-label={t('config.syncSubdir')} disabled={disabled || busy} aria-invalid={subdirOk ? undefined : true}
            autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off" onChange={event => setSubdir(event.target.value)} />
          <small>{subdirOk ? t('config.syncDefaultValue', { value: MNEMON_SYNC_DEFAULT_SUBDIR }) : t('config.syncSubdirInvalid')}</small>
        </label>
      </div>
      <div className={css.syncChoice}>
        <span className={css.syncFieldLabel} id={radio + '-label'}>{t('config.syncAuthor')}</span>
        <div className={css.inlineChoices} role="radiogroup" aria-labelledby={radio + '-label'}>
          {(['default', 'machine', 'custom'] as const).map(value => <label key={value}>
            <input type="radio" name={radio} value={value} checked={mode === value} disabled={disabled || busy} onChange={() => setMode(value)} />
            <span>{value === 'default' ? t('config.syncAuthorDefault') : value === 'machine' ? t('config.syncAuthorMachine') : t('config.syncAuthorCustom')}</span>
          </label>)}
        </div>
        {mode === 'default' && <p className={css.editorNote}>{t('config.syncAuthorDefaultNote', { identity: DEFAULT_AUTHOR })}</p>}
        {mode === 'machine' && <p className={css.editorNote}>{t('config.syncAuthorMachineNote')}</p>}
        {mode === 'custom' && <div className={css.fieldGrid}>
          <label>{t('config.syncAuthorName')}
            <input type="text" value={name} aria-label={t('config.syncAuthorName')} disabled={disabled || busy} autoComplete="off" spellCheck={false} onChange={event => setName(event.target.value)} />
          </label>
          <label>{t('config.syncAuthorEmail')}
            <input type="email" value={email} aria-label={t('config.syncAuthorEmail')} disabled={disabled || busy} aria-invalid={email.trim() === '' || emailValid(email) ? undefined : true}
              autoComplete="off" spellCheck={false} onChange={event => setEmail(event.target.value)} />
            {email.trim() !== '' && !emailValid(email) && <small className={css.error}>{t('config.syncAuthorEmailInvalid')}</small>}
          </label>
        </div>}
      </div>
      <div className={css.memoryConfigFooter}>
        <div className={css.configFeedback} aria-live="polite">
          {feedback !== null ? <FeedbackLine value={feedback} />
            : moved && branchOk && subdirOk ? <span className={css.editorNote}>{t('config.syncAdvancedNote')}</span>
              : renamed && nameOk ? <span className={css.editorNote}>{t('config.syncMachineRenameNote')}</span> : null}
        </div>
        <div>
          <Button variant="primary" size="sm" disabled={disabled || !ready || busy} onClick={() => void save()}>{busy ? t('config.syncSaving') : t('config.syncSave')}</Button>
        </div>
      </div>
    </div>}
  </div>
}
