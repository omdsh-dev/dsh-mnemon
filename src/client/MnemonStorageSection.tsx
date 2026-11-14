import { useEffect, useRef, useState, type JSX } from 'react'
import { Button, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import { MNEMON_PACK_COMPONENTS, type ClientConnectionHandle, type ClientSettingsScope, type Config, type SettingsOperation } from '../host/protocol.ts'
import type { MemoryPluginEntryView, MemoryViewDashboard } from '../host/view-protocol.ts'
import { componentCopy } from './component-copy.ts'
import { ComponentChips } from './CompositionBoard.tsx'
import { GlobalLocationSetting } from './GlobalLocationSetting.tsx'
import type { MnemonTranslate } from './locales.ts'
import css from './MnemonSettingsCard.module.css'
import { MnemonPackSection, type PackTarget } from './MnemonPackSection.tsx'
import { MnemonReviewSection } from './MnemonReviewSection.tsx'
import { MnemonSyncSection } from './MnemonSyncSection.tsx'
import { SelectRow, SettingRow } from './settings-controls.tsx'
import { PanelActions, useLive, WriteFailure, useStaged } from './settings-panel.tsx'
import type { MnemonDirectoryPicker } from './picker.ts'

type StorageChoice = 'global' | 'workspace' | 'workspaces'
/** Whether a shared or central directory is Mnemon's default one or one the user chose. */
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

/** The scope the configuration stores; a global scope with its own directory is `custom`. */
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
  // The global scope ignores a directory it does not store as `custom`; the others use any one set.
  const location: LocationChoice = stored === 'custom' || (stored !== 'global' && dataDir !== '') ? 'custom' : 'default'
  return { scope, location, dataDir }
}

/** Whether the draft waits for a directory to be typed; an empty field is not yet a mistake. */
function storageMissing(draft: StorageDraft): boolean {
  return draft.scope !== 'workspace' && draft.location === 'custom' && draft.dataDir.trim() === ''
}

function storageProblem(t: MnemonTranslate, draft: StorageDraft): string | null {
  if (draft.scope === 'workspace' || draft.location === 'default') return null
  const directory = draft.dataDir.trim()
  if (directory === '') return null
  const posixAbsolute = directory.startsWith('/')
  const homeRelative = directory === '~' || directory.startsWith('~/')
  const windowsDriveAbsolute = /^[a-zA-Z]:[\\/]/.test(directory)
  const windowsUncAbsolute = /^\\\\[^\\/]+[\\/][^\\/]+/.test(directory)
  if (directory.includes('\0') || (!posixAbsolute && !homeRelative && !windowsDriveAbsolute && !windowsUncAbsolute)) return t('config.customAbsolute')
  return null
}

/** A directory as DSH shows a path: its end stays in view, the whole of it on hover. */
function Path(props: { value: string; label?: string }): JSX.Element {
  return <span className={css.location}>{props.label !== undefined && <span>{props.label}</span>}<PathLabel path={props.value} /></span>
}

export interface MnemonStorageSectionProps {
  scope: ClientSettingsScope<Config>
  /** The saved configuration, and what the user file itself holds, for retiring legacy keys. */
  value: Config | undefined
  user: Record<string, unknown>
  disabled: boolean
  /** The components installed, to name the ones that keep their data here. */
  dashboard: MemoryViewDashboard | null
  /** The directory memory reads and writes now. */
  target: PackTarget | null
  connection?: ClientConnectionHandle
  directoryPicker?: MnemonDirectoryPicker
  sessionId?: string
  workspaceId?: string
  language: string
  t: MnemonTranslate
  onOpen: (entry: MemoryPluginEntryView) => void
  onSaved: () => void
  /** A sync, a merge, an import or an applied plan may have changed memory, which views elsewhere show. */
  onDataChanged?: () => void
}

/**
 * Where memory lives: the scope and directory, applied together because a
 * change moves where every component below reads and writes, the ZIP backup
 * that carries the data from one place to another, and the git sync that
 * carries it between machines.
 *
 * The directory is Mnemon's default one or one the user types, chosen
 * outright rather than implied by an empty field, and the row shows the one
 * path memory uses.
 */
export function MnemonStorageSection(props: MnemonStorageSectionProps): JSX.Element {
  const { t } = props
  const value = props.value ?? {}
  const exclusion = useStaged({ paths: (value.excludedWorkspaces ?? []).join('\n') }, async draft => {
    await props.scope.mutate([{ op: 'set', path: ['excludedWorkspaces'], value: [...new Set(draft.paths.split(/\r?\n/u).map(path => path.trim()).filter(Boolean))] }])
    props.onSaved()
  })
  const saved = storageDraft(value)
  const storage = useStaged(saved, async draft => {
    const operations: SettingsOperation[] = []
    const scope = storedScope(draft)
    if (scope !== savedScope(value)) operations.push({ op: 'set', path: ['storageScope'], value: scope })
    // A workspace's own directory takes none; the others keep the one typed or return to the default.
    if (draft.scope !== 'workspace') {
      const directory = draft.location === 'custom' ? draft.dataDir.trim() : ''
      if (directory !== saved.dataDir.trim()) {
        // A central root returns to the default as an empty value, which no lower settings layer can fill.
        operations.push(directory === '' && draft.scope === 'global' ? { op: 'unset', path: ['dataDir'] } : { op: 'set', path: ['dataDir'], value: directory })
      }
    }
    if (operations.length === 0) return
    // A saved directory retires the named Packs an earlier version kept.
    if (Object.hasOwn(props.user, 'customPackId')) operations.push({ op: 'unset', path: ['customPackId'] })
    if (Object.hasOwn(props.user, 'customPacks')) operations.push({ op: 'unset', path: ['customPacks'] })
    await props.scope.mutate(operations)
    props.onSaved()
  })
  // Git sync is one choice with no half-typed state: it saves the moment it is
  // made, and the switch that made it shows the saved value again if the Host
  // refuses the write. The choice lives in the profile rather than in the storage
  // root, so a reader who has not switched it on has no Git run for them at all.
  const sync = useLive(props.value?.syncEnabled === true, async value => {
    await props.scope.mutate([{ op: 'set', path: ['syncEnabled'], value }])
  })
  const { draft } = storage
  const problem = storageProblem(t, draft)
  const canPick = props.target?.nativeDirectoryPicker === true && props.directoryPicker?.available() === true
  const [picking, setPicking] = useState(false)
  const [pickerFailed, setPickerFailed] = useState(false)
  const pendingPick = useRef<{ active: boolean } | undefined>(undefined)
  const savedKey = JSON.stringify(saved)
  // A chooser can outlive a draft, workspace, permission or saved-setting change.
  // Its late answer must not overwrite the operator's newer intent.
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
  // Choosing to type a directory puts the cursor in the field.
  const focusDirectory = useRef(false)
  const chooseLocation = (location: LocationChoice): void => {
    focusDirectory.current = location === 'custom'
    storage.edit({ location, dataDir: saved.dataDir })
  }
  // The Sources that keep their data here, in the order a backup lists them.
  const order = (entry: MemoryPluginEntryView): number => (MNEMON_PACK_COMPONENTS as readonly string[]).indexOf(entry.typeId ?? '')
  const users = (props.dashboard?.entries ?? []).filter(entry => entry.roles.includes('source') && order(entry) >= 0).sort((left, right) => order(left) - order(right))
  // Where memory lives now; while a change waits, the Apply line says what it does instead.
  const current = storage.dirty ? undefined : props.target?.root
  const defaultRoot = props.target?.defaultRoot ?? (saved.scope === 'global' && saved.location === 'default' ? current : undefined)
  // The row shows one path: the default one, or this workspace's under a central root; a typed one is in its field.
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
        const name = componentCopy(entry, props.language).label
        return { key: entry.entryId, name, on: entry.enabled, title: t('storage.usedByTitle', { component: name }), open: () => props.onOpen(entry) }
      })} />
    </div>
    <div className={css.rows}>
      <SelectRow id="mnemon-storage-scope" label={t('config.scopeTitle')} value={draft.scope} disabled={props.disabled} onChange={scope => storage.edit({ scope })} options={[
        { value: 'global', label: t('config.global'), detail: t('config.globalScopeHint') },
        { value: 'workspace', label: t('config.workspace'), detail: t('config.workspaceScopeHint') },
        { value: 'workspaces', label: t('config.workspaces'), detail: t('config.workspacesHint') },
      ]} />
      {/* A workspace keeps its own directory, so there is nothing to choose, only where it is. */}
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
      <SettingRow title={t('workspace.excludeTitle')} hint={t('workspace.excludeHint')} htmlFor="mnemon-excluded-workspaces" stacked>
        <textarea id="mnemon-excluded-workspaces" className={css.workspacePaths} rows={3} value={exclusion.draft.paths} disabled={props.disabled || exclusion.saving}
          spellCheck={false} autoCapitalize="none" onChange={event => exclusion.edit({ paths: event.target.value })} />
      </SettingRow>
      <PanelActions dirty={exclusion.dirty} saving={exclusion.saving} invalid={null} failed={exclusion.failed} applied={exclusion.applied} disabled={props.disabled}
        note={t('workspace.excludeNote')} t={t} onDiscard={exclusion.discard} onApply={() => { void exclusion.apply() }} />
      <MnemonPackSection {...(props.connection === undefined ? {} : { connection: props.connection })} {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        {...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId })} target={props.target}
        {...(props.onDataChanged === undefined ? {} : { onImported: props.onDataChanged })} t={t} />
      <MnemonSyncSection {...(props.connection === undefined ? {} : { connection: props.connection })} {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        {...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId })} disabled={props.disabled} enabled={sync.value} onEnabled={sync.set}
        {...(props.onDataChanged === undefined ? {} : { onMerged: props.onDataChanged })} t={t} />
      <WriteFailure error={sync.failed} t={t} />
      {/* The reconciliation is the other half of one channel: it reads the branch the
          switch above publishes to, so it only exists once that switch is on. */}
      {sync.value && <MnemonReviewSection {...(props.connection === undefined ? {} : { connection: props.connection })} {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        {...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId })} disabled={props.disabled}
        {...(props.onDataChanged === undefined ? {} : { onApplied: props.onDataChanged })} t={t} />}
    </div>
  </section>
}
