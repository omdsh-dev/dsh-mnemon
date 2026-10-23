import { memo, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { isDefaultSourceInstance, type ClientConnectionHandle, type ClientSettingsScope, type ClientSettingsSnapshot, type Config, type StatusView } from "../host/protocol.ts"
import { MnemonClient } from './api.ts'
import { dispatchMnemonAnchor } from './anchor.ts'
import type { MnemonKey } from './locales.ts'
import type { MnemonClientContext } from './dsh-context.ts'
import { MemoryIcon } from './memory-icon.tsx'
import { humanBytes, message } from './page-kit.tsx'
import { SelectField, TaskAgentTag, WriteReceipt, writeOutcome, type FieldOption } from './page-controls.tsx'
import { NATIVE_PROVIDER_ID } from './memory-spaces-client.ts'
import css from './MnemonSaveAction.module.css'

interface MnemonSaveActionProps {
  /** Stable identity of the finalized assistant message this action addresses. */
  messageId: string
  /** Injected by the slot host: the session this message belongs to. */
  sessionId?: string
  connection: ClientConnectionHandle
  settingsScope: ClientSettingsScope<Config>
  localeRuntime: Pick<MnemonClientContext['locale'], 'getSnapshot' | 'subscribe'>
  t: (key: MnemonKey, params?: Record<string, unknown>) => string
}

/** Where a candidate goes: a task Agent decides, or the user names the place. */
type SaveDestination = 'agent' | 'runtime:memory' | 'runtime:user' | `space:${string}`

/** A summary the dialog writes itself, rendered in the language of the moment. */
interface SaveNote {
  key: MnemonKey
  params?: Record<string, unknown>
  /** A place named by a key, translated with the rest. */
  place?: MnemonKey
}

/** What the task Agent, or the chosen place, did with the text it was given. */
interface SaveOutcome {
  /** The candidate and place the outcome answers; sending them again waits for an edit or another place. */
  content: string
  destination: SaveDestination
  action?: string
  summary?: string
  note?: SaveNote
  /** A memory was saved without a vector (#388). */
  unembedded?: boolean
  /** Whether DSH managed the embedding settings when the write answered, which words a missing vector. */
  embeddingManaged?: boolean
  error?: string
}

type RuntimePlace = 'runtime:memory' | 'runtime:user'
type RuntimeUsage = Partial<Record<'memory' | 'user', { used: number; limit: number }>>

const PREVIEW_LIMIT = 8000
/** One working-memory entry as Runtime Memory stores it: one line of at most 8 KiB, without the § delimiter. */
const RUNTIME_ENTRY_BYTES = 8 * 1024
const RUNTIME_PLACES: Readonly<Record<RuntimePlace, MnemonKey>> = { 'runtime:memory': 'saveAction.to.memory', 'runtime:user': 'saveAction.to.user' }

type Translate = (key: MnemonKey, params?: Record<string, unknown>) => string

function isRuntimePlace(destination: SaveDestination): destination is RuntimePlace {
  return destination === 'runtime:memory' || destination === 'runtime:user'
}

/**
 * The places a candidate can go. A layer takes it while it is on, its Source
 * runs and its writes are not switched off. What the status does not say
 * counts as available, so a partial status never hides the task Agent.
 */
function saveDestinations(status: Partial<StatusView> | undefined, taskAgent: boolean | undefined, t: Translate): Array<FieldOption<SaveDestination>> {
  const system = status?.memorySystem
  const takes = (sourceTypeId: string): boolean => {
    const layer = system?.configuration.layers[sourceTypeId]
    return layer?.enabled !== false && layer?.participation?.write !== 'off'
      && (system?.sources === undefined || system.sources.some(source => source.sourceTypeId === sourceTypeId))
  }
  const runtimeOn = takes('runtime')
  const spacesOn = takes('memory-spaces')
  // Active spaces, as the Agent sees them. A Mnemon Native space takes writes only while its CLI is found;
  // a read-only space takes none (#434).
  const spaces = spacesOn ? (status?.memoryBodies ?? []).filter(body => body.active !== false && body.writePolicy !== 'read-only' && body.providerEnabled !== false && body.provider.capabilities.remember
    && ((body.provider.typeId ?? body.provider.id) !== NATIVE_PROVIDER_ID || status?.commandFound !== false)) : []
  // The task Agent writes to Memory Spaces only: it needs one, or a ready Provider to create one with.
  const providerReady = spaces.length > 0 || status?.commandFound !== false || (status?.providerServices ?? []).some(provider => provider.enabled && provider.configured)
  return [
    { value: 'agent', label: t('saveAction.to.agent'), detail: t('saveAction.to.agentDetail'), disabled: taskAgent === false || !spacesOn || !providerReady },
    ...(runtimeOn ? (Object.keys(RUNTIME_PLACES) as RuntimePlace[]).map(value => ({ value, label: t(RUNTIME_PLACES[value]) })) : []),
    ...spaces.map(body => ({ value: `space:${body.id}` as const, label: body.name, detail: t('saveAction.to.space', { provider: body.provider.label }) })),
  ]
}

/**
 * Whether DSH managed the Mnemon Native embedding settings when a write
 * answered, as the settings say. While they are not read it says nothing, and
 * the receipt keeps the caution.
 */
function embeddingManagement(snapshot: ClientSettingsSnapshot<Config>): Pick<SaveOutcome, 'embeddingManaged'> {
  return snapshot.value === undefined ? {} : { embeddingManaged: snapshot.value.embedding?.enabled === true }
}

/** The default instance of a Source type, as the workbench picks it, else the first. */
function placeSource<Source extends { sourceInstanceKey: string; sourceTypeId: string }>(catalog: { sources: readonly Source[] }, sourceTypeId: string): Source | undefined {
  const sources = catalog.sources.filter(source => source.sourceTypeId === sourceTypeId)
  return sources.find(source => isDefaultSourceInstance(source.sourceInstanceKey, sourceTypeId)) ?? sources[0]
}

/** Write the text to the place the user chose, through that Source's own operation, with a fresh revision. */
async function saveDirectly(client: MnemonClient, destination: Exclude<SaveDestination, 'agent'>, place: string, content: string, t: Translate): Promise<{ action: string; note: SaveNote; unembedded?: boolean }> {
  const source = placeSource(await client.sourceManagementCatalog(), isRuntimePlace(destination) ? 'runtime' : 'memory-spaces')
  if (source === undefined) throw new Error(t('saveAction.unavailable'))
  if (isRuntimePlace(destination)) {
    const input = { action: 'add', target: destination === 'runtime:user' ? 'user' : 'memory', content }
    // The Runtime Memory page's own path: Host assistance checks the layer's
    // writes and makes room when the file is full.
    const written = source.assistance?.includes('mutate') === true
      ? await client.assistSource(source.sourceInstanceKey, 'mutate', input, source.revision, true)
      : await client.mutateSourceManagement(source.sourceInstanceKey, 'mutate', input, source.revision, true)
    const result = written.value as { message?: string; entryCount?: number; maintenance?: unknown }
    // Runtime Memory keeps one copy of an entry and says so.
    if (result.message?.startsWith('Entry already exists') === true) return { action: 'skipped', note: { key: 'saveAction.saved.duplicate' } }
    return { action: 'added', note: { key: result.maintenance === undefined ? 'saveAction.saved.runtime' : 'saveAction.saved.runtimeMaintained', params: { count: result.entryCount }, place: RUNTIME_PLACES[destination] } }
  }
  const result = (await client.mutateSourceManagement(source.sourceInstanceKey, 'remember',
    { content, memoryBodyId: destination.slice('space:'.length), source: 'user' }, source.revision, true)).value as { action?: unknown; embedded?: unknown }
  const answered = typeof result.action === 'string' ? result.action : 'stored'
  // A Provider that queues its writes confirms them later.
  const action = answered === 'queued' ? 'accepted' : answered
  const outcome = writeOutcome(action)
  const key: MnemonKey = outcome === 'skipped' ? 'saveAction.saved.duplicate'
    : outcome === 'pending' ? 'saveAction.saved.spacePending'
      : outcome === 'written' || outcome === 'updated' ? 'saveAction.saved.space' : 'saveAction.saved.spaceOther'
  return { action, note: { key, params: { space: place, action: answered } }, ...(result.embedded === false ? { unembedded: true } : {}) }
}

/**
 * What a working-memory place says about this text before it is saved, and
 * whether it can take it at all, by the Runtime Source's own rules: one line of
 * at most 8 KiB and never more than its file, without the § delimiter. A full
 * file keeps its entries within 70% of its limit, less the new one.
 */
function runtimePlaceNote(destination: SaveDestination, content: string, usage: RuntimeUsage | undefined, taskAgent: boolean | undefined, agentOpen: boolean, t: Translate): { text: string; blocked: boolean } | undefined {
  if (!isRuntimePlace(destination) || content === '') return undefined
  const user = destination === 'runtime:user'
  const target = t(RUNTIME_PLACES[destination])
  const entry = content.replace(/\s+/gu, ' ')
  if (entry.includes('§')) return { text: t('saveAction.place.delimiter', { target }), blocked: true }
  const bytes = new TextEncoder().encode(entry).length
  const room = usage?.[user ? 'user' : 'memory']
  const cap = Math.min(RUNTIME_ENTRY_BYTES, room?.limit ?? RUNTIME_ENTRY_BYTES)
  const orAgent = agentOpen ? t('saveAction.place.orAgent') : ''
  if (bytes > cap) {
    // Rounded sizes that read the same name both in bytes.
    const exact = humanBytes(bytes) === humanBytes(cap)
    return { text: t('saveAction.place.tooLong', { target, size: exact ? `${bytes} B` : humanBytes(bytes), limit: exact ? `${cap} B` : humanBytes(cap) }) + orAgent, blocked: true }
  }
  if (room === undefined || room.used + bytes + (room.used > 0 ? 4 : 0) <= room.limit) return undefined
  const kept = Math.floor(room.limit * 0.7) - 4
  const keep = Math.max(0, kept - bytes)
  const used = humanBytes(room.used)
  const limit = humanBytes(room.limit)
  if (user) {
    // A full profile is condensed by a task Agent, and keeps no archive.
    if (taskAgent === false) return { text: t('saveAction.place.userFull'), blocked: true }
    if (keep === 0) return { text: t('saveAction.place.userTooLong', { size: humanBytes(bytes), max: humanBytes(Math.max(0, kept)) }) + orAgent, blocked: true }
    return { text: t('saveAction.place.userCondense', { used, limit, keep: humanBytes(keep) }), blocked: false }
  }
  return { text: t(keep === 0 ? 'saveAction.place.fullAll' : 'saveAction.place.full', { target, used, limit, keep: humanBytes(keep) }), blocked: false }
}

/**
 * Save-to-memory action on finalized assistant messages. A task Agent decides
 * whether the (editable) reply is worth keeping and where it goes, or the user
 * names the place and the text goes there through that place's own write. The
 * dialog shows the same receipt as Save to memory on the Memory Spaces page.
 */
export const MnemonSaveAction = memo(function MnemonSaveAction({ messageId, sessionId, connection, settingsScope, localeRuntime, t }: MnemonSaveActionProps): JSX.Element {
  const subscribeLocale = useCallback((listener: () => void) => localeRuntime.subscribe(listener), [localeRuntime])
  const getLocale = useCallback(() => localeRuntime.getSnapshot(), [localeRuntime])
  useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const subscribeSettings = useCallback((listener: () => void) => settingsScope.subscribe(listener), [settingsScope])
  const getSettingsSnapshot = useCallback(() => settingsScope.getSnapshot(), [settingsScope])
  const settingsSnapshot = useSyncExternalStore(subscribeSettings, getSettingsSnapshot, getSettingsSnapshot)
  const managementWritable = settingsSnapshot.status === 'ready' && settingsSnapshot.writable
  const [open, setOpen] = useState(false)
  const [writeEnabled, setWriteEnabled] = useState<boolean | undefined>(undefined)
  const [taskAgent, setTaskAgent] = useState<boolean | undefined>(undefined)
  const [status, setStatus] = useState<Partial<StatusView> | undefined>(undefined)
  const [chosen, setChosen] = useState<SaveDestination | undefined>(undefined)
  const [candidate, setCandidate] = useState<string | undefined>(undefined)
  const [truncated, setTruncated] = useState(false)
  const [missing, setMissing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null)
  const [usage, setUsage] = useState<RuntimeUsage | undefined>(undefined)
  const candidateId = useId()
  const openRef = useRef(false)
  const requestVersionRef = useRef(0)
  // The text and place a running save writes, and a direct save's result the
  // dialog was closed for: neither is lost when the dialog closes and opens again.
  const inFlightRef = useRef<{ content: string; destination: SaveDestination } | undefined>(undefined)
  const unseenRef = useRef<SaveOutcome | undefined>(undefined)

  const setPanelOpen = (next: boolean): void => {
    requestVersionRef.current += 1
    openRef.current = next
    setOpen(next)
  }

  useEffect(() => {
    if (!open) {
      setWriteEnabled(undefined)
      setTaskAgent(undefined)
      setStatus(undefined)
      setChosen(undefined)
      setCandidate(undefined)
      setTruncated(false)
      setMissing(false)
      setSubmitting(inFlightRef.current !== undefined)
      setOutcome(null)
      setUsage(undefined)
      return
    }
    const requestVersion = ++requestVersionRef.current
    let alive = true
    setSubmitting(inFlightRef.current !== undefined)
    const unseen = unseenRef.current
    unseenRef.current = undefined
    // The dialog opens again on the text and place it was writing, or wrote.
    const restored = unseen ?? inFlightRef.current
    if (restored !== undefined) setChosen(restored.destination)
    if (unseen !== undefined) setOutcome(unseen)
    const client = new MnemonClient(connection, sessionId)
    client.status()
      .then(status => {
        if (!alive || requestVersionRef.current !== requestVersion) return
        setWriteEnabled(status.writeEnabled && managementWritable)
        setTaskAgent(status.lifecycle?.taskAgentAvailable)
        setStatus(status)
      })
      .catch(() => { if (alive && requestVersionRef.current === requestVersion) setWriteEnabled(false) })
    client.assistantMessageText(messageId)
      .then(result => {
        if (!alive || requestVersionRef.current !== requestVersion) return
        if (restored !== undefined) setCandidate(restored.content)
        else if (result === null || result.text === '') setMissing(true)
        else {
          setTruncated(result.text.length > PREVIEW_LIMIT)
          setCandidate(result.text.slice(0, PREVIEW_LIMIT))
        }
      })
      .catch(() => {
        if (!alive || requestVersionRef.current !== requestVersion) return
        if (restored !== undefined) setCandidate(restored.content)
        else setMissing(true)
      })
    return () => { alive = false }
  }, [open, connection, sessionId, messageId, managementWritable])

  const content = candidate?.trim() ?? ''
  const options = saveDestinations(status, taskAgent, t)
  const usable = options.filter(option => option.disabled !== true)
  // The user's choice, else the first place open: the task Agent while it can write, then working memory.
  const destination: SaveDestination = chosen ?? usable[0]?.value ?? 'agent'
  const selected = options.find(option => option.value === destination)
  const runtimeTarget = isRuntimePlace(destination) ? destination : undefined

  // A working-memory place says up front when the text cannot fit, or will make room first.
  useEffect(() => {
    if (!open || runtimeTarget === undefined || usage !== undefined || status === undefined) return
    const runtime = status.memorySystem === undefined ? undefined : placeSource(status.memorySystem, 'runtime')
    // With nothing to read, the save goes ahead without a note.
    if (runtime === undefined) { setUsage({}); return }
    let alive = true
    new MnemonClient(connection, sessionId).readSourceManagement(runtime.sourceInstanceKey, 'snapshot')
      .then(result => { if (alive) setUsage((result.value as { targets?: RuntimeUsage } | null)?.targets ?? {}) }, () => { if (alive) setUsage({}) })
    return () => { alive = false }
  }, [open, runtimeTarget, usage, status, connection, sessionId])
  const agentOpen = options.some(option => option.value === 'agent' && option.disabled !== true)
  const placeNote = runtimePlaceNote(destination, content, usage, taskAgent, agentOpen, t)

  // A result answers one text in one place: sending the same text there again
  // waits for an edit. A failure can be sent again as it is.
  const answered = outcome !== null && outcome.error === undefined && outcome.content === content && outcome.destination === destination
  // A working-memory place waits for its usage, so its note comes before the save.
  const placeReady = runtimeTarget === undefined || usage !== undefined
  const canSubmit = content !== '' && !submitting && writeEnabled === true && selected !== undefined && selected.disabled !== true
    && placeReady && placeNote?.blocked !== true && !answered

  const submit = (): void => {
    if (!canSubmit || inFlightRef.current !== undefined) return
    const requestVersion = requestVersionRef.current
    const target = destination
    inFlightRef.current = { content, destination: target }
    setSubmitting(true)
    setOutcome(null)
    const client = new MnemonClient(connection, sessionId)
    const written: Promise<Omit<SaveOutcome, 'content' | 'destination'>> = target === 'agent'
      ? client.supervise(content, messageId).then(result => ({ action: result.action, summary: result.summary, unembedded: (result.unembedded ?? []).length > 0 }))
      : saveDirectly(client, target, selected?.label ?? target, content, t)
    void written
      .then(result => ({ content, destination: target, ...result, ...embeddingManagement(settingsScope.getSnapshot()) }),
        (reason: unknown) => ({ content, destination: target, error: message(reason) }))
      .then((result: SaveOutcome) => {
        inFlightRef.current = undefined
        // The task Agent's request is keyed by its reply and can be sent again
        // safely. A direct write has no such guard, so a dialog opened again
        // meanwhile, or later, still gets its receipt.
        if (openRef.current && (target !== 'agent' || requestVersionRef.current === requestVersion)) setOutcome(result)
        else if (!openRef.current && target !== 'agent') unseenRef.current = result
        if (openRef.current) setSubmitting(false)
        if (isRuntimePlace(target) && result.error === undefined) setUsage(undefined)
      })
  }

  const viewMemory = (): void => {
    const runtime = outcome !== null && isRuntimePlace(outcome.destination)
    setPanelOpen(false)
    // Runtime Memory opens on the entry it now holds, stored as one line.
    dispatchMnemonAnchor({ page: runtime ? 'runtime/entries' : 'memory-spaces/content',
      ...(runtime ? { seed: outcome.content.replace(/\s+/gu, ' ') } : {}),
      ...(sessionId === undefined ? {} : { sessionId }) })
  }
  const direct = writeEnabled === true && destination !== 'agent'
  const receiptSummary = outcome?.note === undefined ? outcome?.summary
    : t(outcome.note.key, { ...outcome.note.params, ...(outcome.note.place === undefined ? {} : { target: t(outcome.note.place) }) })

  return (
    <div className={css.wrap}>
      <Tooltip label={t('saveAction.tooltip')} side="bottom" disabled={open}>
        <button
          type="button"
          className={css.button}
          aria-label={t('saveAction.button')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setPanelOpen(!openRef.current)}
        >
          <span className={css.icon}><MemoryIcon size={16} /></span>
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={() => setPanelOpen(false)}
        title={t('saveAction.title')}
        closeLabel={t('saveAction.close')}
        description={t(direct ? 'saveAction.hintDirect' : 'saveAction.hint')}
        className={css.modal as string}
        contentClassName={css.modalContent as string}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} disabled={submitting} onClick={() => setPanelOpen(false)}>
              {outcome === null ? t('common.cancel') : t('saveAction.close')}
            </Button>
            <Button variant="primary" className={css.modalAction} disabled={!canSubmit} onClick={submit}>
              {direct ? (submitting ? t('saveAction.saving') : t('saveAction.save')) : (submitting ? t('saveAction.submitting') : t('saveAction.submit'))}
            </Button>
          </>
        )}
      >
        {writeEnabled === false && <div className={css.readOnly} role="status">{t('saveAction.readOnly')}</div>}
        {candidate === undefined && !missing && <div className={css.status}>{t('saveAction.fetching')}</div>}
        {missing && <div className={css.status} role="status">{t('saveAction.missing')}</div>}
        {candidate !== undefined && (
          <div className={css.candidate}>
            <div className={css.candidateHeading}>
              <label htmlFor={candidateId}>{t('saveAction.candidate')}</label>
              {writeEnabled === true && !direct && taskAgent !== undefined && usable.length > 0 && <TaskAgentTag available={taskAgent && selected?.disabled !== true} t={t} />}
            </div>
            <textarea id={candidateId} rows={12} value={candidate} onChange={event => setCandidate(event.target.value)} autoFocus />
            {truncated && <small className={css.truncated}>{t('saveAction.truncated', { limit: PREVIEW_LIMIT })}</small>}
            {writeEnabled === true && (
              <SelectField
                className={css.destination}
                label={t('saveAction.to')}
                value={destination}
                options={options}
                disabled={submitting}
                onChange={setChosen}
              />
            )}
            {writeEnabled === true && placeNote !== undefined && <small className={css.placeNote} data-tone={placeNote.blocked ? 'blocked' : 'caution'}>{placeNote.text}</small>}
            {writeEnabled === true && status !== undefined && usable.length === 0 && <small className={css.placeNote} data-tone="blocked">{t('saveAction.noPlace')}</small>}
          </div>
        )}
        {outcome !== null && <WriteReceipt t={t} action={outcome.action} summary={receiptSummary} error={outcome.error} unembedded={outcome.unembedded} embeddingManaged={outcome.embeddingManaged} onView={viewMemory}
          {...(isRuntimePlace(outcome.destination) ? { viewLabel: t('receipt.viewRuntime') } : {})} />}
      </Modal>
    </div>
  )
})
