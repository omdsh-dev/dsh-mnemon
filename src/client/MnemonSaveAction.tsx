import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { Button, IconDataOutline16, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientConnectionHandle, ClientSettingsScope, Config } from "../host/protocol.ts"
import { MnemonClient } from './api.ts'
import type { MnemonKey } from './locales.ts'
import type { MnemonClientContext } from './dsh-context.ts'
import css from './MnemonSaveAction.module.css'

export interface MnemonSaveActionProps {
  /** Stable identity of the finalized assistant message this action addresses. */
  messageId: string
  /** Injected by the slot host: the session this message belongs to. */
  sessionId?: string
  connection: ClientConnectionHandle
  settingsScope: ClientSettingsScope<Config>
  localeRuntime: Pick<MnemonClientContext['locale'], 'getSnapshot' | 'subscribe'>
  t: (key: MnemonKey, params?: Record<string, unknown>) => string
}

interface SuperviseOutcome {
  summary: string
  action: string
}

const PREVIEW_LIMIT = 8000

/** Save-to-memory action on finalized assistant messages, routed through the supervised writeback gate. */
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
  const [candidate, setCandidate] = useState<string | undefined>(undefined)
  const [truncated, setTruncated] = useState(false)
  const [missing, setMissing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<SuperviseOutcome | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const openRef = useRef(false)
  const requestVersionRef = useRef(0)
  const submitActiveRef = useRef(false)

  const setPanelOpen = (next: boolean): void => {
    requestVersionRef.current += 1
    openRef.current = next
    setOpen(next)
  }

  useEffect(() => {
    if (!open) {
      setWriteEnabled(undefined)
      setCandidate(undefined)
      setTruncated(false)
      setMissing(false)
      setSubmitting(submitActiveRef.current)
      setOutcome(null)
      setFailure(null)
      return
    }
    const requestVersion = ++requestVersionRef.current
    let alive = true
    setSubmitting(submitActiveRef.current)
    const client = new MnemonClient(connection, sessionId)
    client.status()
      .then(status => { if (alive && requestVersionRef.current === requestVersion) setWriteEnabled(status.writeEnabled && managementWritable) })
      .catch(() => { if (alive && requestVersionRef.current === requestVersion) setWriteEnabled(false) })
    client.assistantMessageText(messageId)
      .then(result => {
        if (!alive || requestVersionRef.current !== requestVersion) return
        if (result === null || result.text === '') setMissing(true)
        else {
          setTruncated(result.text.length > PREVIEW_LIMIT)
          setCandidate(result.text.slice(0, PREVIEW_LIMIT))
        }
      })
      .catch(() => { if (alive && requestVersionRef.current === requestVersion) setMissing(true) })
    return () => { alive = false }
  }, [open, connection, sessionId, messageId, managementWritable])

  const submit = (): void => {
    const content = textareaRef.current?.value.trim() ?? ''
    if (content === '' || writeEnabled !== true || submitActiveRef.current) return
    const requestVersion = requestVersionRef.current
    submitActiveRef.current = true
    setSubmitting(true)
    setFailure(null)
    setOutcome(null)
    const client = new MnemonClient(connection, sessionId)
    client.supervise(content, messageId)
      .then(result => {
        if (!openRef.current || requestVersionRef.current !== requestVersion) return
        setOutcome({ summary: result.summary, action: result.action })
        setCandidate(content)
      })
      .catch(reason => {
        if (openRef.current && requestVersionRef.current === requestVersion) setFailure(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        submitActiveRef.current = false
        if (openRef.current) setSubmitting(false)
      })
  }

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
          <IconDataOutline16 size={16} className={css.icon} />
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={() => setPanelOpen(false)}
        title={t('saveAction.title')}
        closeLabel={t('saveAction.close')}
        description={t('saveAction.hint')}
        className={css.modal as string}
        contentClassName={css.modalContent as string}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} disabled={submitting} onClick={() => setPanelOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              className={css.modalAction}
              disabled={candidate === undefined || submitting || writeEnabled !== true}
              onClick={submit}
            >
              {submitting ? t('saveAction.submitting') : t('saveAction.submit')}
            </Button>
          </>
        )}
      >
        {writeEnabled === false && <div className={css.readOnly} role="status">{t('saveAction.readOnly')}</div>}
        {candidate === undefined && !missing && <div className={css.status}>{t('saveAction.fetching')}</div>}
        {missing && <div className={css.status} role="status">{t('saveAction.missing')}</div>}
        {candidate !== undefined && (
          <label className={css.candidate}>
            <span>{t('saveAction.candidate')}</span>
            <textarea ref={textareaRef} rows={12} defaultValue={candidate} autoFocus />
            {truncated && <small className={css.truncated}>{t('saveAction.truncated', { limit: PREVIEW_LIMIT })}</small>}
          </label>
        )}
        {outcome !== null && <div className={css.outcome} role="status">{t('saveAction.result', { summary: outcome.summary })}</div>}
        {failure !== null && <div className={css.failure} role="alert">{t('saveAction.failed', { error: failure })}</div>}
      </Modal>
    </div>
  )
})
