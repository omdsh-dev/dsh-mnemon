import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemorySourcePageProps } from 'dsh-mnemon/client'
import type { RecordSnapshot, RecordValue } from 'dsh-mnemon/source-sdk'
import { collectionStyles, managementError } from 'dsh-mnemon/client'
import type { ReviewResult } from './engine.ts'
export function Proposals(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'),
    [records, setRecords] = useState<RecordValue[]>([]),
    [reviewId, setReviewId] = useState(''),
    [project, setProject] = useState(''),
    [library, setLibrary] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const epoch = useRef(0), pending = useRef(false)
  useEffect(() => { epoch.current++; pending.current = false; setBusy(false); setRecords([]); setReviewId(''); setProject(''); setLibrary(''); setNotice(''); return () => { epoch.current++ } }, [props.management, props.managementDirectory, props.workspaceId, props.sessionId])
  const load = useCallback(async () => {
    const generation = epoch.current
    const response = await props.management?.read('snapshot')
    if (!response || generation !== epoch.current) return
    const rows = (response.value as unknown as RecordSnapshot).records.filter(
      (record) => record.kind === 'review' && record.data.status === 'completed',
    )
    setRecords(rows)
    setReviewId((id) => (rows.some((record) => record.id === id) ? id : (rows.at(-1)?.id ?? '')))
  }, [props.management])
  useEffect(() => {
    void load().catch((error) => setNotice(managementError(error, zh)))
  }, [load, zh])
  const review = records.find((record) => record.id === reviewId),
    result = review?.data.result as unknown as ReviewResult | undefined
  async function propose(kind: 'fact' | 'decision' | 'skill', title: string, content: string, slug?: string) {
    const target = props.managementDirectory?.client(kind === 'skill' ? library : project)
    if (!target) {
      setNotice(zh ? '请选择对应的目标插件实例。' : 'Choose the destination Source instance.')
      return
    }
    if (pending.current || !props.writable) return
    const generation = epoch.current; pending.current = true
    setBusy(true)
    setNotice('')
    try {
      const snapshot = await target.read('snapshot')
      if (generation !== epoch.current) return
      const previous = (snapshot.value as unknown as RecordSnapshot).records.filter(record => record.state === 'active' && record.kind === kind && record.scope === 'project' && kind === 'skill' && record.data.slug === slug)
      if (previous.length > 1) throw new Error('Multiple active skills share this name; choose the original in Playbooks before proposing a revision')
      await target.mutate(
        'receive-proposal',
        {
          transferKey: `${props.sourceInstanceKey}:${reviewId}:${kind}:${slug ?? title}`,
          ...(previous[0] ? { supersedes: { id: previous[0].id, version: previous[0].version } } : {}),
          kind,
          title,
          content,
          scope: 'project',
          data: { origin: 'conversation-review', reviewId: reviewId, ...(slug ? { slug, enabled: true } : {}) },
        },
        { confirmed: true, expectedRevision: snapshot.revision },
      )
      if (generation !== epoch.current) return
      setNotice(
        zh
          ? '已转为目标插件中的待审核建议，尚未生效。'
          : 'Saved as a pending proposal in the destination Source. It is not active.',
      )
      props.onRefresh?.()
    } catch (error) {
      if (generation === epoch.current) setNotice(managementError(error, zh))
    } finally {
      if (generation === epoch.current) { pending.current = false; setBusy(false) }
    }
  }
  return (
    <section data-mnemon-collection aria-label={zh ? '审核建议' : 'Review proposals'}>
      <style>{collectionStyles}</style>
      <header>
        <h2>{zh ? '审核建议' : 'Review proposals'}</h2>
        <button onClick={() => void load().catch((error) => setNotice(String(error)))}>
          {zh ? '刷新建议' : 'Refresh proposals'}
        </button>
      </header>
      <label>
        {zh ? '选择审核结果' : 'Choose review'}{' '}
        <select value={reviewId} onChange={(event) => setReviewId(event.target.value)}>
          <option value="">{zh ? '请选择' : 'Choose a review'}</option>
          {records.map((record) => (
            <option key={record.id} value={record.id}>
              {record.title} · {record.createdAt}
            </option>
          ))}
        </select>
      </label>
      <div className="mc-fields">
        {[
          ['project-context', project, setProject, zh ? '项目笔记目标' : 'Project notes destination'],
          ['instruction-library', library, setLibrary, zh ? '技能目标' : 'Skill destination'],
        ].map(([role, value, setter, label]) => (
          <label key={String(role)}>
            {String(label)}
            <select value={String(value)} onChange={(event) => (setter as (value: string) => void)(event.target.value)}>
              <option value="">{zh ? '选择目标插件实例' : 'Choose a destination Source'}</option>
              {props.managementDirectory?.sources
                .filter((source) => source.role === role)
                .map((source) => (
                  <option key={source.sourceInstanceKey} value={source.sourceInstanceKey}>
                    {source.management.label} · {source.sourceInstanceKey}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
      {result && (
        <>
          {result.proposals.map((proposal, index) => (
            <article key={index}>
              <h3>{proposal.title}</h3>
              <p className="mc-content">{proposal.content}</p>
              <button
                disabled={busy || !props.writable || !project}
                onClick={() => void propose(proposal.kind, proposal.title, proposal.content)}
              >
                {zh ? '转为项目笔记待审核建议' : 'Propose as project context'}
              </button>
            </article>
          ))}
          {result.skill && (
            <article>
              <h3>{result.skill.title}</h3>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{result.skill.content}</pre>
              <button
                disabled={busy || !props.writable || !library}
                onClick={() => void propose('skill', result.skill!.title, result.skill!.content, result.skill!.slug)}
              >
                {zh ? '转为待审核技能' : 'Propose reusable skill'}
              </button>
            </article>
          )}
          {!result.proposals.length && !result.skill && (
            <p>{zh ? '本次审核没有生成需要采纳的建议。' : 'This review has no proposals to approve.'}</p>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
