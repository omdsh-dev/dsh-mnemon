import { css, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { CATEGORIES, type Category, type MemorySpaceView } from '../contracts.ts'
import type { MemorySpacesPageClient } from './api.ts'
import { message, SidebarModal, EmptyState, SelectField, TaskAgentTag, WriteReceipt } from 'dsh-mnemon/client'
import { categoryLabel } from './widgets.tsx'

/** `embeddingManaged`, from this Source's status, words a memory saved without a vector; left out, the receipt keeps the caution. */
export function RememberPage(props: { client: MemorySpacesPageClient; agentAvailable: boolean; memoryBodies: MemorySpaceView[]; writeEnabled: boolean; seed: string; embeddingManaged?: boolean | undefined; onMutate: () => void; onClose: () => void; onView?: () => void }): JSX.Element {
  const t = useT()
  const rememberFormId = useId()
  const candidateId = useId()
  const [content, setContent] = useState(props.seed)
  const [category, setCategory] = useState<Category>('general')
  const [importance, setImportance] = useState(3)
  const [tags, setTags] = useState('')
  const [entities, setEntities] = useState('')
  const [memoryBodyId, setMemoryBodyId] = useState('')
  const [supervising, setSupervising] = useState(false)
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<{ content: string; action?: string; summary?: string; unembedded?: boolean; embeddingManaged?: boolean | undefined; error?: string } | null>(null)
  // A read-only space is recalled and takes no writes, so it is no place to save to (#434).
  const targets = useMemo(() => props.memoryBodies.filter(body => body.writePolicy !== 'read-only'), [props.memoryBodies])
  useEffect(() => { if (props.seed !== '') setContent(props.seed) }, [props.seed])
  useEffect(() => {
    // A target made read only while the dialog is open is chosen again.
    if (props.memoryBodies.some(body => body.id === memoryBodyId && body.writePolicy === 'read-only')) setMemoryBodyId('')
    else if (memoryBodyId === '' && targets.length > 0) setMemoryBodyId((targets.find(body => body.active) ?? targets[0])!.id)
  }, [memoryBodyId, props.memoryBodies, targets])
  const selectedMemoryBody = targets.find(body => body.id === memoryBodyId)
  const candidate = content.trim()
  // A receipt answers one text: sending the same text again waits for an edit.
  const answered = outcome !== null && outcome.content === candidate
  const busy = supervising || saving

  const supervise = async (event: FormEvent) => {
    event.preventDefault()
    if (candidate === '' || !props.agentAvailable || answered || busy) return
    setSupervising(true); setOutcome(null)
    try {
      const response = await props.client.supervise(candidate)
      setOutcome({ content: candidate, action: response.action, summary: response.summary, unembedded: (response.unembedded ?? []).length > 0, embeddingManaged: props.embeddingManaged })
      props.onMutate()
    } catch (reason) { setOutcome({ content: candidate, error: message(reason) }) } finally { setSupervising(false) }
  }

  const manualSave = async (event: FormEvent) => {
    event.preventDefault()
    if (candidate === '' || busy) return
    setSaving(true); setOutcome(null)
    try {
      const response = await props.client.remember({ content: candidate, category, importance, tags: tags.split(',').map(value => value.trim()).filter(Boolean), entities: entities.split(',').map(value => value.trim()).filter(Boolean), source: 'user', ...(memoryBodyId === '' ? {} : { memoryBodyId }) })
      // Mnemon Native says embedded: false for a memory it saved without a vector (#388).
      setOutcome({ content: candidate, action: typeof response.action === 'string' ? response.action : 'stored', summary: typeof response.summary === 'string' ? response.summary : '', unembedded: response.embedded === false, embeddingManaged: props.embeddingManaged })
      props.onMutate()
    } catch (reason) { setOutcome({ content: candidate, error: message(reason) }) } finally { setSaving(false) }
  }

  const composer = <section className={css.supervisedComposer}>
    <form id={rememberFormId} className={css.supervisedForm} onSubmit={event => void supervise(event)}>
      <div className={css.candidateHeading}><label htmlFor={candidateId}>{t('remember.candidate')}</label><TaskAgentTag available={props.agentAvailable} /></div>
      <textarea id={candidateId} value={content} onChange={event => setContent(event.target.value)} maxLength={8000} rows={8} placeholder={t('remember.placeholder')} />
      {!props.agentAvailable && <p className={css.sessionHint}>{t('remember.taskAgentHint')}</p>}
      {outcome !== null && <WriteReceipt action={outcome.action} summary={outcome.summary} error={outcome.error} unembedded={outcome.unembedded} embeddingManaged={outcome.embeddingManaged} onView={props.onView} />}
    </form>
    <details className={css.advancedWrite}>
      <summary><span><strong>{t('remember.advanced')}</strong><small>{t('remember.advancedHint')}</small></span><span>{t('remember.expand')}</span></summary>
      <form className={css.manualForm} onSubmit={event => void manualSave(event)}>
        <div className={css.formGrid}>
          <div className={css.fieldWide}>
            <SelectField label={t('remember.target')} value={memoryBodyId} options={targets.map(body => ({ value: body.id, label: `${body.name} · ${body.provider.label}${body.active ? ` · ${t('common.active')}` : ''}` }))} onChange={setMemoryBodyId} />
            {selectedMemoryBody?.provider.capabilities.writeMode === 'async-extracting' && <small className={css.providerWriteHint}>{t('remember.asyncProviderHint')}</small>}
          </div>
          <SelectField label={t('common.category')} value={category} options={CATEGORIES.map(value => ({ value, label: categoryLabel(t, value) }))} onChange={setCategory} />
          <SelectField label={t('common.importanceLabel')} value={String(importance)} options={[1, 2, 3, 4, 5].map(value => ({ value: String(value), label: `${value} / 5` }))} onChange={value => setImportance(Number(value))} />
          <label className={css.fieldWide}>{t('remember.entities')}<input value={entities} onChange={event => setEntities(event.target.value)} placeholder="SQLite, DSH" /></label>
          <label className={css.fieldWide}>{t('remember.tags')}<input value={tags} onChange={event => setTags(event.target.value)} placeholder="architecture, local-first" /></label>
        </div>
        <div className={css.manualActions}><p>{t('remember.advancedText')}</p><button type="submit" className={css.secondaryButton} disabled={busy || candidate === '' || memoryBodyId === '' || answered}>{saving ? t('remember.saving') : t('remember.advancedAction')}</button></div>
      </form>
    </details>
  </section>

  return <SidebarModal title={t('remember.title')} description={t('remember.description')} busy={busy} onClose={props.onClose} footer={props.writeEnabled ? <div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.secondaryButton} disabled={busy} onClick={props.onClose}>{t(outcome === null ? 'common.cancel' : 'common.close')}</button><button type="submit" form={rememberFormId} className={css.primaryButton} disabled={busy || candidate === '' || !props.agentAvailable || answered}>{supervising ? t('remember.processing') : t('remember.action')}</button></div> : undefined}>{props.writeEnabled ? composer : <EmptyState glyph="⊘" title={t('remember.readOnlyTitle')}>{t('remember.readOnlyText')}</EmptyState>}</SidebarModal>
}
