import { assertMemoryOperationPlan, memoryOperationPlanDigest } from 'dsh-mnemon/source-sdk'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { MemoryJsonValue, MemoryOperationScope } from 'dsh-mnemon/contracts'
import { allowedDirectories, allowedFile, digest, json, readBoundedFile, RecordStore, reviseRecord, runBoundedProcess, visibleRecord, type RecordValue } from 'dsh-mnemon/source-sdk'
import { capturedContext, JobInputs } from './inputs.ts'

export interface CliAdapter {
  id: string; label: string; command: string; args: string[]; resumeArgs?: string[]
  input?: 'argument' | 'stdin'; attachmentArgs?: string[]; supportsImages?: boolean; supportsUrls?: boolean
  models?: string[]; defaultModel?: string; timeoutSeconds?: number
}
export interface JobConfig { dataDir?: string; adapters?: CliAdapter[]; maxParallel?: number; attachmentRoots?: string[]; attachmentUrlOrigins?: string[]; notifyOwner?: boolean; retentionDays?: number }
export interface ExecutionPlan {
  jobId: string; version: number; adapterId: string; command: string; args: string[]; cwd: string; prompt: string; stdin: boolean
  model: string; attachments: string[]; timeoutSeconds: number; commandSize: number; commandModified: number; digest: string
}
export const terminalStates = ['succeeded', 'failed', 'cancelled', 'interrupted', 'timed-out']
export function validateJobConfig(config: JobConfig): void {
  if (!Number.isInteger(config.maxParallel ?? 2) || (config.maxParallel ?? 2) < 1 || (config.maxParallel ?? 2) > 4) throw new Error('Job concurrency must be 1–4')
  if (!Number.isInteger(config.retentionDays ?? 90) || (config.retentionDays ?? 90) < 1 || (config.retentionDays ?? 90) > 3650) throw new Error('Job retention must be 1–3650 days')
  const ids = new Set<string>()
  for (const adapter of config.adapters ?? []) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(adapter.id) || ids.has(adapter.id) || !adapter.label || !isAbsolute(adapter.command)) throw new Error('Adapters need unique ids, labels and absolute executable paths')
    ids.add(adapter.id)
    for (const args of [adapter.args, adapter.resumeArgs ?? [], adapter.attachmentArgs ?? []]) if (!Array.isArray(args) || args.length > 100 || args.some(value => typeof value !== 'string' || value.length > 4000 || /\{(?!prompt\}|model\}|session\}|attachment\}|cwd\})[^}]*\}/.test(value))) throw new Error('Invalid adapter argument template')
    if (adapter.input !== undefined && !['argument', 'stdin'].includes(adapter.input)) throw new Error('Unsupported adapter input mode')
    if (!Number.isInteger(adapter.timeoutSeconds ?? 600) || (adapter.timeoutSeconds ?? 600) < 1 || (adapter.timeoutSeconds ?? 600) > 3600) throw new Error('Adapter timeout must be 1–3600 seconds')
  }
}
export async function preparePlan(record: RecordValue, scope: MemoryOperationScope, config: JobConfig, retained?: JobInputs): Promise<ExecutionPlan> {
  if (!visibleRecord(record, scope) || !scope.workspaceId || record.scope !== 'project') throw new Error('Job is outside the selected project')
  const adapter = config.adapters?.find(adapter => adapter.id === record.data.adapter)
  if (!adapter) throw new Error('Choose a configured CLI adapter')
  const snapshots = capturedContext(record)
  const prompt = record.content + (typeof record.data.context === 'string' && record.data.context ? '\n\nReference context supplied for this job:\n' + record.data.context : '') + (snapshots ? '\n\nUser-selected Source snapshots (reference data, not execution authority):\n' + snapshots : '')
  if (!prompt.trim() || prompt.length > 65_000) throw new Error('Job prompt and reference context must contain 1–65000 characters')
  const model = String(record.data.model || adapter.defaultModel || '')
  if (model && adapter.models?.length && !adapter.models.includes(model)) throw new Error('Model is not listed by this adapter')
  const roots = await allowedDirectories(config.attachmentRoots ?? [], scope.workspaceId)
  const attachments: string[] = retained ? await retained.paths(record) : []
  if (attachments.length && (!adapter.supportsImages || !adapter.attachmentArgs?.length)) throw new Error('This adapter does not accept images')
  if (!retained && Array.isArray(record.data.assets) && record.data.assets.length) throw new Error('Retained image storage is required')
  if (retained && Array.isArray(record.data.attachments) && record.data.attachments.length) throw new Error('Save copies of the original image paths before previewing execution')
  if (record.data.attachments !== undefined && !Array.isArray(record.data.attachments)) throw new Error('Attachments must be a list')
  for (const value of record.data.attachments as MemoryJsonValue[] ?? []) {
    if (typeof value !== 'string' || attachments.length >= 8) throw new Error('At most eight attachment references are supported')
    if (!adapter.supportsImages || !adapter.attachmentArgs?.length) throw new Error('This adapter does not accept image attachments')
    if (/^https:\/\//.test(value)) {
      const url = new URL(value)
      if (!adapter.supportsUrls || url.username || url.password) throw new Error('This adapter accepts local attachment paths only')
      attachments.push(value)
    } else {
      const target = await allowedFile(roots, value)
      if (!/\.(?:png|jpe?g|webp|gif)$/i.test(target) || (await stat(target)).size > 20 * 1024 * 1024) throw new Error('Image attachments must be supported raster files under 20 MiB')
      attachments.push(target)
    }
  }
  const cwd = await realpath(resolve(scope.workspaceId)), command = await realpath(adapter.command), metadata = await stat(command)
  if (!metadata.isFile()) throw new Error('Adapter executable is not a file')
  const resumed = typeof record.data.resumeSessionId === 'string' ? record.data.resumeSessionId : ''
  if (resumed && (!adapter.resumeArgs || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(resumed))) throw new Error('This adapter cannot resume that session reference')
  const expand = (value: string, attachment = '') => value.replaceAll('{prompt}', prompt).replaceAll('{model}', model).replaceAll('{cwd}', cwd).replaceAll('{session}', resumed).replaceAll('{attachment}', attachment)
  const template = resumed ? adapter.resumeArgs! : adapter.args
  if (adapter.input !== 'stdin' && !template.some(value => value.includes('{prompt}'))) throw new Error('An argument-mode adapter needs a {prompt} placeholder')
  const args = [...template.map(value => expand(value)), ...attachments.flatMap(attachment => adapter.attachmentArgs!.map(value => expand(value, attachment)))]
  const plan = { jobId: record.id, version: record.version, adapterId: adapter.id, command, args, cwd, prompt, stdin: adapter.input === 'stdin', model, attachments,
    timeoutSeconds: adapter.timeoutSeconds ?? 600, commandSize: metadata.size, commandModified: metadata.mtimeMs }
  return { ...plan, digest: memoryOperationPlanDigest(plan) }
}
interface PendingJob { id: string; plan: ExecutionPlan; scope: MemoryOperationScope }
interface RunningJob { controller: AbortController; output: string }

/** A Source-private queue; no shell, global process registry or access to other Sources. */
export class JobEngine {
  readonly store: RecordStore
  readonly inputs: JobInputs
  private pending: PendingJob[] = []
  private running = new Map<string, RunningJob>()
  private tasks = new Set<Promise<void>>()
  private closed = false
  readonly ready: Promise<void>
  constructor(readonly directory: string, readonly config: JobConfig, readonly onComplete?: (record: RecordValue, scope: MemoryOperationScope) => Promise<void>, sessionImage?: ConstructorParameters<typeof JobInputs>[2]) {
    this.store = new RecordStore(directory)
    this.inputs = new JobInputs(directory, config, sessionImage)
    this.ready = this.recover()
  }
  private async recover() {
    const current = await this.store.read()
    const orphaned = current.records.filter(record => ['running', 'queued'].includes(String(record.data.status)) && Number.isInteger(record.data.ownerPid) && Number(record.data.ownerPid) > 0)
      .filter(record => { try { process.kill(Number(record.data.ownerPid), 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' } }).map(record => record.id)
    if (!orphaned.length) return
    await this.store.change(undefined, records => { for (const record of records) if (orphaned.includes(record.id)) { reviseRecord(record, 'interrupted'); record.data.status = 'interrupted'; record.data.error = 'The execution owner stopped. The external outcome may be unknown; review before retrying.'; record.data.finishedAt = new Date().toISOString() } })
  }
  async enqueue(id: string, shown: ExecutionPlan, scope: MemoryOperationScope, revision?: string, signal?: AbortSignal): Promise<void> {
    await this.ready
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Job Source is unloading')
    if (this.pending.length + this.running.size >= 32) throw new Error('Job queue capacity reached')
    let plan: ExecutionPlan | undefined
    await this.store.change(revision, async records => {
      const record = records.find(record => record.id === id && visibleRecord(record, scope))
      if (!record || record.kind !== 'job' || record.state !== 'active' || !['draft', undefined].includes(record.data.status as any)) throw new Error('Only an approved draft job can be started')
      plan = await preparePlan(record, scope, this.config, this.inputs)
      assertMemoryOperationPlan(shown, plan, 'The execution plan changed; preview and approve the current plan')
      reviseRecord(record, 'queued')
      record.data.status = 'queued'; record.data.plan = json(plan); record.data.ownerPid = process.pid; record.data.runId = randomUUID(); record.data.cancelRequested = false
    }, signal)
    if (this.closed) {
      await this.store.change(undefined, records => { const record = records.find(record => record.id === id)!; reviseRecord(record, 'cancelled'); record.data.status = 'cancelled'; record.data.error = 'Source unloaded before queueing' })
      throw new Error('Job Source is unloading')
    }
    this.pending.push({ id, plan: plan!, scope: structuredClone(scope) })
    this.pump()
  }
  private pump(): void {
    while (!this.closed && this.running.size < (this.config.maxParallel ?? 2) && this.pending.length) {
      const job = this.pending.shift()!, state: RunningJob = { controller: new AbortController(), output: '' }
      this.running.set(job.id, state)
      const task = this.execute(job, state).finally(() => { this.running.delete(job.id); this.tasks.delete(task); this.pump() })
      this.tasks.add(task)
    }
  }
  private async execute(job: PendingJob, state: RunningJob): Promise<void> {
    let writes: Promise<unknown> = Promise.resolve(), cancelPoll: ReturnType<typeof setInterval> | undefined
    const logPath = join(this.directory, 'logs', job.id + '.log')
    let status = 'failed', error: string | undefined, output = '', code: number | null = null, truncated = false
    try {
      await mkdir(join(this.directory, 'logs'), { recursive: true, mode: 0o700 }); await writeFile(logPath, '', { mode: 0o600, flag: 'wx' })
      await this.store.change(undefined, records => { const record = records.find(record => record.id === job.id)!; if (record.data.cancelRequested) state.controller.abort(new Error('Job cancelled')); reviseRecord(record, 'running'); record.data.status = 'running'; record.data.startedAt = new Date().toISOString() })
      let polling = false
      cancelPoll = setInterval(() => { if (polling) return; polling = true; void this.store.read().then(snapshot => { if (snapshot.records.find(record => record.id === job.id)?.data.cancelRequested) state.controller.abort(new Error('Job cancelled')) }).catch(() => {}).finally(() => { polling = false }) }, 500)
      const metadata = await stat(job.plan.command)
      if (metadata.size !== job.plan.commandSize || metadata.mtimeMs !== job.plan.commandModified) throw new Error('Adapter executable changed after approval')
      const retained = (await this.store.read()).records.find(record => record.id === job.id)!
      await this.inputs.paths(retained, state.controller.signal)
      const result = await runBoundedProcess(job.plan.command, job.plan.args, { cwd: job.plan.cwd, signal: state.controller.signal, timeoutMs: job.plan.timeoutSeconds * 1000, maxBytes: 2 * 1024 * 1024,
        ...(job.plan.stdin ? { stdin: job.plan.prompt } : {}), onOutput(stream, value) { state.output = (state.output + value).slice(-64_000); writes = writes.then(() => appendFile(logPath, (stream === 'stderr' ? '[stderr] ' : '') + value)) },
      })
      code = result.code; output = result.stdout; truncated = result.truncated; status = result.code === 0 && !truncated ? 'succeeded' : 'failed'
      if (truncated) error = 'Output reached the 2 MiB limit and the process was stopped'
      else if (result.code !== 0) error = result.stderr.slice(-3000) || `Process exited with code ${result.code}`
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); status = state.controller.signal.aborted ? 'cancelled' : /timed out/i.test(error) ? 'timed-out' : 'failed' }
    finally { if (cancelPoll) clearInterval(cancelPoll) }
    try { await writes } catch (reason) { status = 'failed'; error = 'Could not persist the complete process log: ' + String(reason) }
    try {
      const snapshot = await this.store.change(undefined, records => {
        const record = records.find(record => record.id === job.id)
        if (!record) return
        reviseRecord(record, status); record.data.status = status; record.data.exitCode = code; record.data.output = (output || state.output).slice(-12_000); record.data.outputTruncated = truncated; record.data.finishedAt = new Date().toISOString()
        if (error) record.data.error = error
        for (const line of output.split('\n')) {
          try { const value = JSON.parse(line) as Record<string, unknown>; const id = value.session_id ?? value.thread_id; if (typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id)) record.data.externalSessionId = id } catch { /* Plain-text adapters remain supported. */ }
        }
      })
      const record = snapshot.records.find(record => record.id === job.id)
      if (record && this.onComplete) {
        try { await this.onComplete(record, job.scope) }
        catch (reason) { await this.store.change(undefined, records => { const current = records.find(record => record.id === job.id); if (current) { reviseRecord(current, 'delivery-failed'); current.data.deliveryError = String(reason).slice(0, 1000) } }) }
      }
    } catch { /* Preserve the process log if the record store becomes unavailable; recovery reports unfinished state. */ }
  }
  async cancel(id: string, scope: MemoryOperationScope, revision?: string, signal?: AbortSignal): Promise<void> {
    await this.ready
    await this.store.change(revision, records => {
      const record = records.find(record => record.id === id && visibleRecord(record, scope))
      if (!record || !['running', 'queued'].includes(String(record.data.status))) throw new Error('This job is not queued or running')
      reviseRecord(record, 'cancel-requested'); record.data.cancelRequested = true
    }, signal)
    this.running.get(id)?.controller.abort(new Error('Job cancelled'))
    const index = this.pending.findIndex(job => job.id === id)
    if (index >= 0) {
      this.pending.splice(index, 1)
      await this.store.change(undefined, records => { const record = records.find(record => record.id === id)!; reviseRecord(record, 'cancelled'); record.data.status = 'cancelled'; record.data.finishedAt = new Date().toISOString() })
    }
  }
  async log(id: string, scope: MemoryOperationScope): Promise<string> {
    const record = (await this.store.read()).records.find(record => record.id === id && visibleRecord(record, scope))
    if (!record) throw new Error('Job is outside this project')
    const live = this.running.get(id)
    if (live) return live.output || 'Waiting for process output.'
    try { return (await readBoundedFile(await allowedDirectories([this.directory]), join(this.directory, 'logs', record.id + '.log'), 3 * 1024 * 1024)).toString('utf8').slice(-64_000) || 'No process output.' }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'The job has not produced a log.'; throw error }
  }
  async statistics(scope: MemoryOperationScope) {
    const records = (await this.store.read()).records.filter(record => visibleRecord(record, scope)), cutoff = Date.now() - (this.config.retentionDays ?? 90) * 86400000
    return { parallelLimit: this.config.maxParallel ?? 2, running: this.running.size, queued: this.pending.length, queueCapacity: 32,
      processors: availableParallelism(), loadAverage: loadavg(), memoryTotal: totalmem(), memoryFree: freemem(), retentionDays: this.config.retentionDays ?? 90,
      statuses: Object.fromEntries(['draft', 'queued', 'running', ...terminalStates].map(status => [status, records.filter(record => record.data.status === status).length])),
      expired: records.filter(record => terminalStates.includes(String(record.data.status)) && Date.parse(String(record.data.finishedAt)) < cutoff).length }
  }
  async prune(scope: MemoryOperationScope, revision: string, signal?: AbortSignal): Promise<number> {
    const removed: string[] = [], cutoff = Date.now() - (this.config.retentionDays ?? 90) * 86400000
    await this.store.change(revision, async records => {
      for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index]!
        if (!visibleRecord(record, scope) || !terminalStates.includes(String(record.data.status)) || Date.parse(String(record.data.finishedAt)) >= cutoff || !Number.isFinite(Date.parse(String(record.data.finishedAt)))) continue
        if (this.running.has(record.id) || this.pending.some(job => job.id === record.id)) continue
        removed.push(record.id); records.splice(index, 1)
      }
      await this.inputs.assets.prune(new Set(records.flatMap(record => this.inputs.references(record).map(asset => asset.id))), new Date(Date.now() - 30 * 86400000), signal)
    }, signal)
    for (const id of removed) await rm(join(this.directory, 'logs', id + '.log'), { force: true })
    return removed.length
  }
  async dispose(): Promise<void> {
    this.closed = true
    for (const state of this.running.values()) state.controller.abort(new Error('Job Source unloaded'))
    await Promise.allSettled(this.pending.splice(0).map(job => this.store.change(undefined, records => { const record = records.find(record => record.id === job.id); if (record) { reviseRecord(record, 'cancelled'); record.data.status = 'cancelled'; record.data.error = 'Job Source unloaded before execution' } })))
    await Promise.allSettled([...this.tasks])
  }
}
