import { useEffect, useRef, useState, type JSX } from 'react'
import { Button, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import { MNEMON_PACK_COMPONENTS, type ClientConnectionHandle, type ClientSettingsScope, type Config, type SettingsOperation } from '../host/protocol.ts'
import type { MemoryPluginEntryView, MemoryViewDashboard } from '../host/view-protocol.ts'
import { componentCopy } from './component-copy.ts'
import { ComponentChips, PageLink } from './CompositionBoard.tsx'
import { RUNTIME_PACKAGE } from './component-settings.tsx'
import { GlobalLocationSetting } from './GlobalLocationSetting.tsx'
import type { MnemonTranslate } from './locales.ts'
import css from './MnemonSettingsCard.module.css'
import { MnemonPackSection, type PackTarget } from './MnemonPackSection.tsx'
import { MnemonReviewSection } from './MnemonReviewSection.tsx'
import { MnemonSyncSection } from './MnemonSyncSection.tsx'
import { useLocalePreference } from './page-kit.tsx'
import { AdvancedSection, SelectRow, SettingRow } from './settings-controls.tsx'
import { PanelActions, useLive, WriteFailure, useStaged } from './settings-panel.tsx'
import type { MnemonClient } from './api.ts'
import type { MnemonDirectoryPicker } from './picker.ts'

type StorageChoice = 'global' | 'workspace' | 'workspaces'
type LocationChoice = 'default' | 'custom'

interface StorageDraft {
  scope: StorageChoice
  location: LocationChoice
  dataDir: string
}

function legacyPackDirectory(value: Config): string {
  const packs = value.customPacks ?? []
  return packs.find(pack => pack.id === value.customPackId)?.dataDir?.trim()
    ?? (packs.length === 1 ? packs[0]?.dataDir?.trim() : undefined)
    ?? ''
}

function savedDirectory(value: Config): string {
  return value.dataDir?.trim() || legacyPackDirectory(value)
}

function savedScope(value: Config): string {
  return value.storageScope ?? (savedDirectory(value) === '' ? 'global' : 'custom')
}

function storedScope(draft: StorageDraft): string {
  return draft.scope === 'global' ? (draft.location === 'custom' ? 'custom' : 'global') : draft.scope
}

function storageDraft(value: Config | undefined): StorageDraft {
  const resolved = value ?? {}
  const dataDir = savedDirectory(resolved)
  const stored = savedScope(resolved)
  const scope: StorageChoice = stored === 'workspace' || stored === 'workspaces' ? stored : 'global'
  const location: LocationChoice = stored === 'custom' || (stored !== 'global' && dataDir !== '') ? 'custom' : 'default'
  return { scope, location, dataDir }
}

function storageMissing(draft: StorageDraft): boolean {
  return draft.scope !== 'workspace' && draft.location === 'custom' && draft.dataDir.trim() === ''
}

function isAbsoluteDirectoryPath(directory: string): boolean {
  if (directory.includes('\0')) return false
  const posixAbsolute = directory.startsWith('/')
  const homeRelative = directory === '~' || directory.startsWith('~/')
  const windowsDriveAbsolute = /^[a-zA-Z]:[\\/]/.test(directory)
  const windowsUncAbsolute = /^\\\\[^\\/]+[\\/][^\\/]+/.test(directory)
  return posixAbsolute || homeRelative || windowsDriveAbsolute || windowsUncAbsolute
}

function storageProblem(t: MnemonTranslate, draft: StorageDraft): string | null {
  if (draft.scope === 'workspace' || draft.location === 'default') return null
  const directory = draft.dataDir.trim()
  if (directory === '') return null
  return isAbsoluteDirectoryPath(directory) ? null : t('config.customAbsolute')
}

function Path(props: { value: string; label?: string }): JSX.Element {
  return <span className={css.location}>{props.label !== undefined && <span>{props.label}</span>}<PathLabel path={props.value} /></span>
}

export interface MnemonStorageSectionProps {
  scope: ClientSettingsScope<Config>
  value: Config | undefined
  user: Record<string, unknown>
  disabled: boolean
  dashboard: MemoryViewDashboard | null
  target: PackTarget | null
  client?: MnemonClient
  connection?: ClientConnectionHandle
  directoryPicker?: MnemonDirectoryPicker
  sessionId?: string
  workspaceId?: string
  language: string
  t: MnemonTranslate
  onOpen: (entry: MemoryPluginEntryView, section?: string) => void
  onSaved: () => void
  onDataChanged?: () => void
}

export function MnemonStorageSection(props: MnemonStorageSectionProps): JSX.Element {
  const { t } = props
  const localePreference = useLocalePreference(props.language)
  const value = props.value ?? {}
  const excludedCount = (value.excludedWorkspaces ?? []).length
  const exclusion = useStaged({ paths: (value.excludedWorkspaces ?? []).join('\n') }, async draft => {
    await props.scope.mutate([{ op: 'set', path: ['excludedWorkspaces'], value: [...new Set(draft.paths.split(/\r?\n/u).map(path => path.trim()).filter(Boolean))] }])
    props.onSaved()
  })
  const saved = storageDraft(value)
  const storage = useStaged(saved, async draft => {
    const operations: SettingsOperation[] = []
    const scope = storedScope(draft)
    if (scope !== savedScope(value)) operations.push({ op: 'set', path: ['storageScope'], value: scope })
    if (draft.scope !== 'workspace') {
      const directory = draft.location === 'custom' ? draft.dataDir.trim() : ''
      if (directory !== saved.dataDir.trim()) {
        operations.push(directory === '' && draft.scope === 'global' ? { op: 'unset', path: ['dataDir'] } : { op: 'set', path: ['dataDir'], value: directory })
      }
    }
    if (operations.length === 0) return
    if (Object.hasOwn(props.user, 'customPackId')) operations.push({ op: 'unset', path: ['customPackId'] })
    if (Object.hasOwn(props.user, 'customPacks')) operations.push({ op: 'unset', path: ['customPacks'] })
    await props.scope.mutate(operations)
    props.onSaved()
  })
  const sync = useLive(props.value?.syncEnabled === true, async value => {
    await props.scope.mutate([{ op: 'set', path: ['syncEnabled'], value }])
  })
  const documentsScope = useLive<'storage' | 'global'>(props.value?.documentsScope === 'global' ? 'global' : 'storage', async value => {
    await props.scope.mutate([{ op: 'set', path: ['documentsScope'], value }])
  })
  const memorySpacesScope = useLive<'storage' | 'global'>(props.value?.memorySpacesScope === 'global' ? 'global' : 'storage', async value => {
    await props.scope.mutate([{ op: 'set', path: ['memorySpacesScope'], value }])
  })
  const { draft } = storage
  const problem = storageProblem(t, draft)
  const canPick = props.target?.nativeDirectoryPicker === true && props.directoryPicker?.available() === true
  const [picking, setPicking] = useState(false)
  const [pickerFailed, setPickerFailed] = useState(false)
  const pendingPick = useRef<{ active: boolean } | undefined>(undefined)
  const savedKey = JSON.stringify(saved)
  useEffect(() => {
    setPickerFailed(false)
    return () => { if (pendingPick.current !== undefined) pendingPick.current.active = false }
  }, [draft, savedKey, props.scope, props.disabled, props.sessionId, props.workspaceId, props.directoryPicker, canPick, storage.saving])
  useEffect(() => () => { pendingPick.current = undefined }, [])
  const pickDirectory = async (): Promise<void> => {
    if (!canPick || props.disabled || storage.saving || pendingPick.current !== undefined) return
    const request = { active: true }
    pendingPick.current = request
    setPicking(true)
    setPickerFailed(false)
    try {
      const directory = await props.directoryPicker!.pick()
      if (pendingPick.current === request && request.active && directory !== null) storage.edit({ dataDir: directory })
    } catch {
      if (pendingPick.current === request && request.active) setPickerFailed(true)
    } finally {
      if (pendingPick.current === request) { pendingPick.current = undefined; setPicking(false) }
    }
  }
  const focusDirectory = useRef(false)
  const chooseLocation = (location: LocationChoice): void => {
    focusDirectory.current = location === 'custom'
    storage.edit({ location, dataDir: saved.dataDir })
  }
  const order = (entry: MemoryPluginEntryView): number => (MNEMON_PACK_COMPONENTS as readonly string[]).indexOf(entry.typeId ?? '')
  const users = (props.dashboard?.entries ?? []).filter(entry => entry.roles.includes('source') && order(entry) >= 0).sort((left, right) => order(left) - order(right))
  const runtime = users.find(entry => entry.packageName === RUNTIME_PACKAGE && entry.enabled)
  const current = storage.dirty ? undefined : props.target?.root
  const defaultRoot = props.target?.defaultRoot ?? (saved.scope === 'global' && saved.location === 'default' ? current : undefined)
  const directoryHint = draft.scope === 'workspaces'
    ? current === undefined ? '' : <Path label={t('storage.thisWorkspace')} value={current} />
    : draft.location === 'default' && defaultRoot !== undefined ? <Path value={defaultRoot} /> : ''
  const directoryInput = <input id="mnemon-data-directory" className={css.directoryInput} type="text" value={draft.dataDir}
    aria-label={t('config.dataDirectory')} aria-invalid={problem !== null}
    placeholder={t('storage.directoryExample')}
    disabled={props.disabled} autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off"
    ref={element => { if (element !== null && focusDirectory.current) { focusDirectory.current = false; element.focus() } }}
    onChange={event => storage.edit({ dataDir: event.target.value })} />
  return <section className={css.section} aria-labelledby="mnemon-storage-heading">
    <div className={css.sectionHeading}>
      <h2 id="mnemon-storage-heading">{t('config.storageTitle')}</h2>
      <ComponentChips label={t('storage.usedBy')} chips={users.map(entry => {
        const name = componentCopy(entry, localePreference).label
        return { key: entry.entryId, name, on: entry.enabled, title: t('storage.usedByTitle', { component: name }), open: () => props.onOpen(entry) }
      })} />
    </div>
    <div className={css.rows}>
      <SelectRow id="mnemon-storage-scope" label={t('config.scopeTitle')} value={draft.scope} disabled={props.disabled} onChange={scope => storage.edit({ scope })} options={[
        { value: 'global', label: t('config.global'), detail: t('config.globalScopeHint') },
        { value: 'workspace', label: t('config.workspace'), detail: t('config.workspaceScopeHint') },
        { value: 'workspaces', label: t('config.workspaces'), detail: t('config.workspacesHint') },
      ]} />
      {draft.scope === 'workspace'
        ? current === undefined ? null : <SettingRow title={t('config.dataDirectory')} hint={<Path value={current} />} />
        : <GlobalLocationSetting name="mnemon-data-location" className={css.locationRow} ariaLabel={t('config.dataDirectory')}
          label={t('config.dataDirectory')} hint={directoryHint} defaultLabel={t('storage.default')} customLabel={t('config.custom')}
          custom={draft.location === 'custom'} workspace={false} disabled={props.disabled}
          onChange={custom => chooseLocation(custom ? 'custom' : 'default')}>
          {canPick ? <div className={css.directoryPickerRow}>
            {directoryInput}
            <Button variant="outline" size="sm" disabled={props.disabled || storage.saving || picking} aria-busy={picking || undefined}
              onClick={() => { void pickDirectory() }}>{t('storage.chooseDirectory')}</Button>
          </div> : directoryInput}
          {pickerFailed && <p className={css.panelError} role="alert">{t('storage.pickFailed')}</p>}
        </GlobalLocationSetting>}
      <PanelActions dirty={storage.dirty} saving={storage.saving} invalid={problem} failed={storage.failed} applied={storage.applied} disabled={props.disabled || storageMissing(draft)}
        note={t('storage.moveNote')} t={t} onDiscard={storage.discard} onApply={() => { void storage.apply() }} />
      {saved.scope !== 'global' && runtime !== undefined && (
        <SettingRow title={t('config.runtimeUserScopeTitle')}
          hint={t(value.runtimeUserScope === 'global' ? 'storage.userProfileShared' : 'storage.userProfileByWorkspace')}>
          <PageLink label={t('storage.runtimeSettings')} onOpen={() => props.onOpen(runtime, 'user-scope')} />
        </SettingRow>
      )}
      {saved.scope !== 'global' && <>
        <p className={css.panelNote}>{t('config.componentScopeSwitchHint')}</p>
        <SelectRow id="mnemon-documents-scope" label={t('config.documentsScopeTitle')} value={documentsScope.value} disabled={props.disabled} onChange={documentsScope.set} options={[
          { value: 'storage', label: t('config.componentScopeStorage'), detail: t('config.documentsScopeStorageHint') },
          { value: 'global', label: t('config.componentScopeGlobal'), detail: t('config.documentsScopeGlobalHint') },
        ]} />
        <SelectRow id="mnemon-memory-spaces-scope" label={t('config.memorySpacesScopeTitle')} value={memorySpacesScope.value} disabled={props.disabled} onChange={memorySpacesScope.set} options={[
          { value: 'storage', label: t('config.componentScopeStorage'), detail: t('config.memorySpacesScopeStorageHint') },
          { value: 'global', label: t('config.componentScopeGlobal'), detail: t('config.memorySpacesScopeGlobalHint') },
        ]} />
        <WriteFailure error={documentsScope.failed ?? memorySpacesScope.failed} t={t} />
      </>}
      <AdvancedSection title={t('workspace.excludeTitle')} hint={t('workspace.excludeHint')}
        badge={excludedCount > 0 ? t('workspace.excludeCount', { count: excludedCount }) : t('workspace.excludeNone')}
        defaultOpen={excludedCount > 0} section="exclusions">
        <textarea id="mnemon-excluded-workspaces" className={css.workspacePaths} rows={3}
          aria-label={t('workspace.excludeTitle')} placeholder={t('workspace.excludePlaceholder')}
          value={exclusion.draft.paths} disabled={props.disabled || exclusion.saving}
          spellCheck={false} autoCapitalize="none" onChange={event => exclusion.edit({ paths: event.target.value })} />
        <PanelActions dirty={exclusion.dirty} saving={exclusion.saving} invalid={null} failed={exclusion.failed} applied={exclusion.applied} disabled={props.disabled}
          note={t('workspace.excludeNote')} t={t} onDiscard={exclusion.discard} onApply={() => { void exclusion.apply() }} />
      </AdvancedSection>
      <MnemonPackSection {...(props.client === undefined ? {} : { client: props.client })} {...(props.connection === undefined ? {} : { connection: props.connection })} {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        {...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId })} target={props.target}
        {...(props.onDataChanged === undefined ? {} : { onImported: props.onDataChanged })} t={t} />
      <MnemonSyncSection {...(props.client === undefined ? {} : { client: props.client })} {...(props.connection === undefined ? {} : { connection: props.connection })} {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        {...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId })} disabled={props.disabled} enabled={sync.value} onEnabled={sync.set}
        {...(props.onDataChanged === undefined ? {} : { onMerged: props.onDataChanged })} t={t} />
      <WriteFailure error={sync.failed} t={t} />
      {sync.value && <MnemonReviewSection {...(props.client === undefined ? {} : { client: props.client })} {...(props.connection === undefined ? {} : { connection: props.connection })} {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        {...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId })} disabled={props.disabled}
        {...(props.onDataChanged === undefined ? {} : { onApplied: props.onDataChanged })} t={t} />}
    </div>
  </section>
}
