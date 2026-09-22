import { useEffect, useRef, useState } from 'react'
import type { MemorySourcePageProps } from 'dsh-mnemon/client'
interface Statistics { parallelLimit: number; running: number; queued: number; queueCapacity: number; processors: number; loadAverage: number[]; memoryTotal: number; memoryFree: number; retentionDays: number; expired: number; statuses: Record<string, number> }
export function JobStatistics(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [value, setValue] = useState<Statistics>(), [revision, setRevision] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0)
  const epoch = useRef(0)
  useEffect(() => { epoch.current++; let active = true, pending = false; setValue(undefined); setError(''); setBusy(false)
    const read = async () => { if (!props.management || pending) return; pending = true; try { const result = await props.management.read('statistics'); if (active) { setValue(result.value as unknown as Statistics); setRevision(result.revision) } } catch (error) { if (active) setError(String(error)) } finally { pending = false } }
    void read(); const timer = setInterval(() => void read(), 5000); return () => { active = false; epoch.current++; clearInterval(timer) }
  }, [props.management, refresh])
  return <section data-mnemon-collection aria-label={t('Runner activity', '执行器负载')}><h2>{t('Runner activity', '执行器负载')}</h2>{value && <>
    <p>{t('Running', '运行中')}: {value.running} / {value.parallelLimit} · {t('Queued', '排队中')}: {value.queued} / {value.queueCapacity}</p>
    <p>{t('Host processors', '主机处理器')}: {value.processors} · {t('Load averages', '平均负载')}: {value.loadAverage.map(number => number.toFixed(2)).join(' / ')} · {t('Free memory', '空闲内存')}: {(value.memoryFree / 1024 ** 3).toFixed(1)} / {(value.memoryTotal / 1024 ** 3).toFixed(1)} GiB</p>
    <p>{t('Project jobs', '本项目任务')}: {Object.values(value.statuses).reduce((sum, count) => sum + count, 0)} · {t('Finished history older than', '超过以下天数的已结束历史')}: {value.retentionDays} {t('days', '天')} · {value.expired} {t('eligible for cleanup', '条可清理')}</p>
    <button disabled={busy || !props.writable || !value.expired} onClick={() => { if (!props.management) return; const current = epoch.current; setBusy(true); setError(''); void props.management.mutate('prune-jobs', {}, { confirmed: true, expectedRevision: revision }).then(() => { if (current === epoch.current) { props.onRefresh?.(); setRefresh(value => value + 1) } }).catch(error => { if (current === epoch.current) setError(String(error)) }).finally(() => { if (current === epoch.current) setBusy(false) }) }}>{t('Remove expired finished history', '清理到期的已结束历史')}</button>
  </>}{error && <p role="alert">{error}</p>}</section>
}
