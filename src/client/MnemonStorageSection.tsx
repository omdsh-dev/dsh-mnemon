import { useMemo, useRef, useState, type JSX } from 'react'
import { Button, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import { MNEMON_PACK_COMPONENTS, type ClientConnectionHandle, type ClientSettingsScope, type Config, type SettingsOperation } from '../host/protocol.ts'
import type { MemoryPluginEntryView, MemoryViewDashboard } from '../host/view-protocol.ts'
import type { MnemonMigrationPlan } from '../host/storage-migration.ts'
import { MnemonClient } from './api.ts'
import { componentCopy } from './component-copy.ts'
import { ComponentChips } from './CompositionBoard.tsx'
import { GlobalLocationSetting } from './GlobalLocationSetting.tsx'
import type { MnemonTranslate } from './locales.ts'
import { MnemonDialog } from './MnemonDialog.tsx'
import css from './MnemonSettingsCard.module.css'
import { MnemonPackSection, type PackTarget } from './MnemonPackSection.tsx'
import { MnemonReviewSection } from './MnemonReviewSection.tsx'
import { MnemonSyncSection } from './MnemonSyncSection.tsx'
import { humanBytes, message } from './page-kit.tsx'
import type { MnemonDirectoryPicker } from './picker.ts'
import { SelectRow, SettingRow } from './settings-controls.tsx'
import { PanelActions, useLive, WriteFailure, useStaged } from './settings-panel.tsx'

type StorageChoice = 'global' | 'workspace' | 'workspaces'
/** Whether a shared or central directory is Mnemon's default one or one the user chose. */
type LocationChoice = 'default' | 'custom'

interface StorageDraft {
  scope: StorageChoice
  location: LocationChoice
  dataDir: string
}

/** A chosen directory waiting on the user's word: what it holds and what moving there costs. */
interface MoveDraft {
  directory: string
  /** What the move would do, once the Host has read the source; null while it reads. */
  plan: MnemonMigrationPlan | null
  failed: string | null
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
  sessionId?: string
  workspaceId?: string
  language: string
  t: MnemonTranslate
  /** The shell's own directory chooser; without one the directory is still typed. */
  pickDirectory?: MnemonDirectoryPicker
  onOpen: (entry: MemoryPluginEntryView) => void
  onSaved: () => void
}

/**
 * Where memory lives: the scope and directory, applied together because a
 * change moves where every component below reads and writes, the ZIP backup
 * that carries the data from one place to another, and the git sync that
 * carries it between machines.
 *
 * The directory is Mnemon's default one or one the user picks, through the
 * shell's own chooser where it has one and by typing where it does not. A
 * chosen directory that differs from the one memory uses now is offered as a
 * move: the Host reads the source first, and only the user's confirmation
 * deletes it.
 */
export function MnemonStorageSection(props: MnemonStorageSectionProps): JSX.Element {
  const { t } = props
  const value = props.value ?? {}
  const saved = storageDraft(value)
  const client = useMemo(
    () => props.connection === undefined ? null : new MnemonClient(props.connection, props.sessionId, props.workspaceId),
    [props.connection, props.sessionId, props.workspaceId],
  )
  const [move, setMove] = useState<MoveDraft | null>(null)
  const [moving, setMoving] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const storage = useStaged(saved, async draft => {
    const operations: SettingsOperation[] = []
    const scope = storedScope(draft)
    if (scope !== savedScope(value)) operations.push({ op: 'set', path: ['storageScope'], value: scope })
    // A workspace's own directory takes none; the others store the one typed.
    if (draft.scope !== 'workspace') {
      const typed = draft.dataDir.trim()
      if (draft.scope === 'global') {
        // A global scope reads its own default directory and ignores this value,
        // so choosing the default stops memory from *using* a custom directory
        // and nothing more: the choice stays saved, because forgetting it is
        // exactly what would make it impossible to take back. Only the custom
        // location writes the field at all.
        if (draft.location === 'custom' && typed !== saved.dataDir.trim()) {
          operations.push(typed === '' ? { op: 'unset', path: ['dataDir'] } : { op: 'set', path: ['dataDir'], value: typed })
        }
      } else {
        // A central root stores the directory it uses, so returning to the
        // default means storing none: an empty value is a value no lower
        // settings layer could fill.
        const directory = draft.location === 'custom' ? typed : ''
        if (directory !== saved.dataDir.trim()) operations.push({ op: 'set', path: ['dataDir'], value: directory })
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
  // Choosing to type a directory puts the cursor in the field.
  const focusDirectory = useRef(false)
  const chooseLocation = (location: LocationChoice): void => {
    focusDirectory.current = location === 'custom'
    // Choosing the default stops memory from *using* a custom directory; it
    // never means forgetting which one was chosen, or the choice could not be
    // taken back. The field keeps whatever was typed, and falls back to the
    // saved directory when the draft has not named one yet.
    storage.edit({ location, dataDir: draft.dataDir.trim() === '' ? saved.dataDir : draft.dataDir })
  }
  // A picked directory becomes the draft's, and a move is offered whenever it
  // is not the one memory already uses.
  const adopt = (directory: string): void => {
    storage.edit({ scope: 'global', location: 'custom', dataDir: directory })
  }
  const readPlan = async (directory: string): Promise<void> => {
    if (client === null) { setMove({ directory, plan: null, failed: null }); return }
    try {
      const plan = await client.storagePlan(directory)
      setMove({ directory, plan, failed: null })
    } catch (reason) {
      setMove({ directory, plan: null, failed: message(reason) })
    }
  }
  const chooseDirectory = (): void => {
    if (props.pickDirectory === undefined) return
    setChoosing(true)
    setFailed(null)
    setNotice(null)
    void props.pickDirectory()
      .then(async directory => {
        if (directory === null) return
        adopt(directory)
        if (directory !== props.target?.root) await readPlan(directory)
      })
      .catch(reason => setFailed(message(reason)))
      .finally(() => setChoosing(false))
  }
  const confirmMove = (): void => {
    if (client === null || move === null) return
    setMoving(true)
    setFailed(null)
    void client.migrateStorage(move.directory)
      .then(result => {
        setMove(null)
        setNotice(t('storage.moved', { to: result.to, files: result.files, size: humanBytes(result.bytes) }))
        // The move endpoint records the new location before it returns, because
        // the live runtime has to be rebuilt on it. Re-read instead of saving
        // the same value a second time.
        props.onSaved()
      })
      .catch(reason => setMove(current => current === null ? null : { ...current, failed: message(reason) }))
      .finally(() => setMoving(false))
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
  const blocked = move?.plan?.blocked
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
          <div className={css.directoryRow}>
            <input id="mnemon-data-directory" className={css.directoryInput} type="text" value={draft.dataDir}
              aria-label={t('config.dataDirectory')} aria-invalid={problem !== null}
              placeholder={t('storage.directoryExample')}
              disabled={props.disabled} autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off"
              ref={element => { if (element !== null && focusDirectory.current) { focusDirectory.current = false; element.focus() } }}
              onChange={event => storage.edit({ dataDir: event.target.value })} />
            {props.pickDirectory !== undefined && <Button variant="outline" size="sm" disabled={props.disabled || choosing}
              onClick={chooseDirectory}>{choosing ? t('storage.choosing') : t('storage.choose')}</Button>}
          </div>
        </GlobalLocationSetting>}
      <PanelActions dirty={storage.dirty} saving={storage.saving} invalid={problem} failed={storage.failed} applied={storage.applied} disabled={props.disabled || storageMissing(draft)}
        note={t('storage.moveNote')} t={t} onDiscard={storage.discard} onApply={() => { void storage.apply() }} />
      {(failed !== null || notice !== null) && <div className={css.packFeedback} aria-live="polite">
        {failed !== null && <p className={css.error} role="alert">{t('storage.actionFailed', { error: failed })}</p>}
        {notice !== null && <p className={css.packSuccess} role="status">{notice}</p>}
      </div>}
      <MnemonPackSection {...(props.connection === undefined ? {} : { connection: props.connection })} {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        {...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId })} target={props.target} t={t} />
      <MnemonSyncSection {...(props.connection === undefined ? {} : { connection: props.connection })} {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        {...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId })} disabled={props.disabled} enabled={sync.value} onEnabled={sync.set} t={t} />
      <WriteFailure error={sync.failed} t={t} />
      {/* The reconciliation is the other half of one channel: it reads the branch the
          switch above publishes to, so it only exists once that switch is on. */}
      {sync.value && <MnemonReviewSection {...(props.connection === undefined ? {} : { connection: props.connection })} {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        {...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId })} disabled={props.disabled} t={t} />}
    </div>
    {move !== null && <MnemonDialog title={t('storage.moveTitle')} closeLabel={t('common.close')} description={t('storage.moveDescription')} busy={moving}
      onClose={() => { if (!moving) setMove(null) }}
      footer={<>
        <Button variant="ghost" size="sm" disabled={moving} onClick={() => setMove(null)}>{t('common.cancel')}</Button>
        <Button variant="outline" size="sm" disabled={moving} onClick={() => { setMove(null); adopt(move.directory) }}>{t('storage.moveUseOnly')}</Button>
        <Button variant="primary" size="sm" disabled={moving || move.plan === null || blocked !== undefined} onClick={confirmMove}>
          {moving ? t('storage.moving') : t('storage.moveConfirm')}</Button>
      </>}>
      <div className={css.moveSummary}>
        <p><strong>{t('storage.moveFrom')}</strong> <PathLabel path={move.plan?.from ?? props.target?.root ?? ''} /></p>
        <p><strong>{t('storage.moveTo')}</strong> <PathLabel path={move.directory} /></p>
        {move.plan === null && move.failed === null && <p>{t('storage.moveReading')}</p>}
        {move.plan !== null && <p>{t('storage.moveSource', { files: move.plan.source.files, size: humanBytes(move.plan.source.bytes) })}</p>}
        {move.plan !== null && !move.plan.sameDevice && <p>{t('storage.moveAcrossDisks')}</p>}
        {blocked !== undefined && <p className={css.error} role="alert">{t('storage.moveBlocked', { reason: blocked })}</p>}
        {move.failed !== null && <p className={css.error} role="alert">{t('storage.moveFailed', { error: move.failed })}</p>}
        <p>{t('storage.moveKeepsSource')}</p>
      </div>
    </MnemonDialog>}
  </section>
}
