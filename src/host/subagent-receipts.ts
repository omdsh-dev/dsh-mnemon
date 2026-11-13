/**
 * Reading back what a delegated child returned: its structured result, the receipts of the memory tools
 * it called, which can stand in for a result it did not record, and the bounded detail of a failure.
 */
import type { HostSubagentResult, HostSubagentRun } from "./dsh.ts"
import { reverseSessionEvents } from './session-events.ts'
import { mutationResultCommitted } from './receipts.ts'
import type { IdleReviewFailure, MemoryToolName } from './protocol.ts'
import { WRITE_ACTIONS } from './subagent-prompts.ts'

/** Whether a call or a receipt names one of these memory tools, each a row of the tool table. */
export function isTool(name: string | undefined, ...tools: readonly MemoryToolName[]): boolean {
  return tools.some(tool => tool === name)
}

const WRITE_ACTION_SET = new Set<string>(WRITE_ACTIONS)

const WRITE_TOOL_FALLBACK_ACTION: Readonly<Record<string, string>> = {
  mnemon_remember: 'stored',
  mnemon_link: 'linked',
  mnemon_forget: 'forgotten',
  mnemon_memory_body_create: 'created',
  mnemon_memory_body_update: 'updated',
  mnemon_memory_body_merge: 'merged',
} satisfies Partial<Record<MemoryToolName, string>>

export interface CapturedSubagentResult {
  agentId: string
  value: unknown
}

export interface CapturedToolReceipt extends CapturedSubagentResult {
  name: string
  arguments: unknown
}

export function reviewReceipt(receipt: CapturedToolReceipt): IdleReviewFailure['receipts'][number] | undefined {
  if (!mutationResultCommitted(receipt.value)) return undefined
  const value = object(receipt.value)
  const args = optionalObject(receipt.arguments)
  const document = optionalObject(value.document)
  return {
    tool: receipt.name,
    action: typeof value.action === 'string' ? value.action : 'committed',
    ...(typeof document?.id === 'string' ? { documentId: document.id } : {}),
    ...(typeof args?.target === 'string' ? { target: args.target } : {}),
    ...(typeof value.revision === 'string' ? { revision: value.revision } : {}),
  }
}

export interface ToolReceiptRecovery {
  terminalTools: readonly string[]
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('memory subagent returned an invalid structured result')
  return value as Record<string, unknown>
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export function safeFailureDetail(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500)
}

/** Recover the contained DSH model/transport error without exposing the child transcript. */
export function subagentFailureDetail(run: HostSubagentRun, result: HostSubagentResult): string | undefined {
  // Prefer a provider's bounded diagnostic. In-process children publish none,
  // so fall back to the local Agent's last turn error.
  if (typeof result.diagnostic === 'string') {
    const diagnostic = safeFailureDetail(result.diagnostic)
    if (diagnostic !== '') return diagnostic
  }
  const events = run.localAgent === undefined ? [] : reverseSessionEvents(run.localAgent.session)
  for (const { event } of events) {
    if (event?.type !== 'turn/end') continue
    const reason = event.data.reason
    if (typeof reason !== 'object' || reason === null || Array.isArray(reason)) continue
    const error = (reason as Record<string, unknown>).error
    if (typeof error !== 'object' || error === null || Array.isArray(error)) continue
    const code = typeof (error as Record<string, unknown>).code === 'string' ? String((error as Record<string, unknown>).code) : ''
    const message = typeof (error as Record<string, unknown>).message === 'string' ? String((error as Record<string, unknown>).message) : ''
    const detail = safeFailureDetail([code, message].filter(Boolean).join(': '))
    if (detail !== '') return detail
  }
  return undefined
}

export function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function addString(target: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim() !== '') target.add(value)
}

function addStrings(target: Set<string>, value: unknown): void {
  if (Array.isArray(value)) for (const entry of value) addString(target, entry)
}

function receiptMemorySpaceIds(receipt: CapturedToolReceipt): string[] {
  const ids = new Set<string>()
  const args = optionalObject(receipt.arguments)
  const value = optionalObject(receipt.value)
  for (const record of [args, value]) {
    addString(ids, record?.memoryBodyId)
    addString(ids, record?.targetMemoryBodyId)
    addStrings(ids, record?.memoryBodyIds)
    addStrings(ids, record?.sourceMemoryBodyIds)
  }
  if (isTool(receipt.name, 'mnemon_memory_body_create', 'mnemon_memory_body_update')) addString(ids, value?.id)
  return [...ids]
}

function recoverWriteResult(receipts: readonly CapturedToolReceipt[]): Record<string, unknown> | undefined {
  const receipt = receipts.at(-1)
  if (receipt === undefined) return undefined
  const value = optionalObject(receipt.value)
  const completion = optionalObject(value?.memoryReceipt)?.completion
  const candidateAction = typeof value?.action === 'string' && WRITE_ACTION_SET.has(value.action) ? value.action : undefined
  const action = typeof completion === 'string' && completion !== 'committed'
    ? WRITE_ACTION_SET.has(completion) ? completion : 'unknown'
    : candidateAction ?? WRITE_TOOL_FALLBACK_ACTION[receipt.name]
  if (action === undefined) return undefined
  const memoryBodyIds = new Set<string>()
  const documentIds = new Set<string>()
  for (const entry of receipts) {
    for (const id of receiptMemorySpaceIds(entry)) memoryBodyIds.add(id)
    addStrings(documentIds, optionalObject(entry.value)?.documentIds)
  }
  const summary = typeof value?.summary === 'string'
    ? value.summary
    : typeof value?.message === 'string' ? value.message : ''
  return {
    summary,
    action,
    memoryBodyIds: [...memoryBodyIds],
    ...(documentIds.size === 0 ? {} : { documentIds: [...documentIds] }),
  }
}

/** Recover a terminal tool's observed result without promoting handler success to durable completion. */
export function recoverStructuredResult(recovery: ToolReceiptRecovery | undefined, receipts: readonly CapturedToolReceipt[]): Record<string, unknown> | undefined {
  if (recovery === undefined) return undefined
  const terminalTools = new Set(recovery.terminalTools)
  const matching = receipts.filter(receipt => terminalTools.has(receipt.name))
  return recoverWriteResult(matching)
}
