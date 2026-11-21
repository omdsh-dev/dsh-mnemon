import type { JsonValue, RpcResult, SettingsOperation } from "./protocol.ts"

export type {
  ClientConnectionHandle,
  ClientSettingsScope,
  ClientSettingsSnapshot,
  JsonPrimitive,
  JsonValue,
  RpcError,
  RpcResult,
  SettingsOperation,
} from "./protocol.ts"

export type HostRpcHandler = (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>>

export interface HostConnectionHandle {
  rpc: {
    handle(channel: string, handler: HostRpcHandler): unknown
  }
}

export interface HostSettingsScope<T> {
  get(): T
}

export interface HostSettingsService {
  readonly writable: boolean
  register<T>(
    namespace: string,
    schema: unknown,
    options: { base?: Partial<T>; applies: 'live' | 'restart'; validate?: (value: T) => void },
  ): HostSettingsScope<T>
  describe(options?: { redactSecrets?: boolean }): Array<{
    ns: string
    value: unknown
    base?: unknown
    user?: unknown
    revision: number
    applies: 'live' | 'restart'
  }>
  mutate(namespace: string, ops: SettingsOperation[], expectedRevision?: number): Promise<void>
  onUpdated(listener: (namespace: string, value: unknown) => void): () => void
}

export interface ToolExecution {
  callId?: string
  rootCallId?: string
  signal: AbortSignal
  agent?: HostAgent
  name?: string
  arguments?: unknown
  parent?: symbol
  token?: symbol
  concludeTurn?: () => void
}

export type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

export interface CommandInvocation {
  agent: HostAgent
  rawInput: string
  signal: AbortSignal
}

export interface CommandDefinition {
  name: string
  description: string
  input?: { hint: string }
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>
}

export interface CommandService {
  register(definition: CommandDefinition): unknown
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown>, value: never) => Array<{ type: 'text'; text: string }>
    presentationMeta?: (args: unknown, value: unknown) => JsonValue
  }
  execute: (args: never, execution: ToolExecution) => Promise<unknown>
  presentCall?: (args: never) => Record<string, unknown>
  presentResult?: () => Record<string, unknown>
}

export interface HostMessageSource {
  kind: string
  plugin?: string
  form?: string
  summary?: string
}

export interface HostOpaqueContentBlock {
  type: string
  text?: string
}

export interface HostTextContentBlock extends HostOpaqueContentBlock {
  type: 'text'
  text: string
}

export interface HostImageAttachmentRef {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

export interface HostImageContentBlock extends HostOpaqueContentBlock {
  type: 'image'
  attachment: HostImageAttachmentRef
}

export type HostUserContentBlock = HostTextContentBlock | HostImageContentBlock | HostOpaqueContentBlock

export interface HostUserMessage {
  id: string
  role: 'user'
  content: HostUserContentBlock[]
  source: HostMessageSource
}

export interface HostSessionEvent {
  type: string
  seq?: number
  time?: number
  data: Record<string, unknown>
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number }
  sourceEventSeqs?: readonly number[]
}

export interface HostSession {
  readonly seq?: number
  inheritedEventCount?: number
  header?: { origin?: 'subagent'; parentSession?: string; delegationDepth?: number; cwd?: string; agentPreset?: string }
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly HostSessionEvent[]
  eventAt(seq: number): HostSessionEvent | undefined
  requestHeader?(): { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined
  surface: { readonly nodes: readonly number[] }
  append?(type: string, data: unknown, options?: { surfaceOp?: 'append' | HostSessionEvent['surfaceOp']; sourceEventSeqs?: readonly number[] }): unknown
}

export type HostPreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: HostUserMessage[] }

export interface HostToolExecutionInput {
  callId: string
  name: string
  arguments: unknown
  agent: HostAgent
  signal: AbortSignal
}

export interface HostAgentContext {
  readonly fiber?: { assertActive(): void }
  tools?: {
    execute?(input: HostToolExecutionInput): Promise<{ isError: boolean }>
    setExecutor?(executor: unknown): unknown
    guard?(guard: (execution: ToolExecution) => string | undefined): unknown
    get?(name: string, scope?: HostAgent): unknown
    restrict?(filter: { allow?: string[]; deny?: string[] }): unknown
  }
  systemPrompt?: {
    section?(section: { name: string; order: number; text: string }): unknown
    getSectionOrder?(name: string): number
  }
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => unknown
  effect(callback: () => (() => unknown) | void, label?: string): () => unknown
  get?(name: string): unknown
}

export interface HostAgent {
  id: string
  status: 'idle' | 'running'
  options?: { provider?: string; model?: string; maxTokens?: number; reasoningEffort?: string; subagentDepth?: number }
  session: HostSession
  ctx: HostAgentContext
  followup(message: HostUserMessage): void
  steer(message: HostUserMessage): void
  inject(message: HostUserMessage): void
  cancel(cause: { kind: 'hook'; reason: string }, options?: { keepInbox?: boolean }): void
}

export interface HostAgentHandle {
  agent: HostAgent
  dispose(): Promise<void>
}

export interface CreateHostAgentOptions {
  sessionId: string
  meta?: { cwd?: string; agentPreset?: string; origin?: 'subagent' }
  agentOptions?: { provider?: string; model?: string; maxTokens?: number; reasoningEffort?: string }
  signal?: AbortSignal
  setup?: (agentCtx: HostAgentContext, agent?: HostAgent) => unknown | Promise<unknown>
}

export interface HostAgentsService {
  get(id: string): HostAgent | undefined
  isOwnedBy?(id: string, parent: HostAgent): boolean
  roots?(): HostAgent[]
  list?(): HostAgent[]
  create(options: CreateHostAgentOptions): Promise<HostAgentHandle>
}

export interface HostWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds?: readonly string[]
}

export interface HostWorkspaceRegistry {
  get(id: string): HostWorkspace | undefined
  list(): HostWorkspace[]
  readonly archivedSessionIds?: readonly string[]
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
}

export interface HostSubagentResult {
  output: Array<{ type: string; text?: string; [key: string]: unknown }>
  structured?: unknown
  diagnostic?: string
  stopReason: string
}

export interface HostSubagentRun {
  id: string
  messageId?: string
  localAgent?: HostAgent
  result: Promise<HostSubagentResult>
  dispose(): Promise<void>
}

export interface HostSubagentProvider {
  inheritsParentContext?: boolean
  capabilities: { outputSchema: boolean; depthLimit: boolean; toolFilter?: boolean; persona?: boolean }
  prepareContinuable?: unknown
}

export interface HostSubagentStartRequest {
  label?: string
  cwd?: string
  name?: string
  prompt: Array<{ type: 'text'; text: string }>
  parent: HostAgent
  signal: AbortSignal
  agentOptions?: { provider?: string; model?: string; maxTokens?: number; reasoningEffort?: string }
  outputSchema?: Record<string, unknown>
  maxDepth?: number
  toolFilter?: { allow?: string[]; deny?: string[] }
  persona?: string
}

export interface HostSubagentActivation {
  childId: string
  messageId?: string
  result: Promise<HostSubagentResult>
  dispose(): Promise<void>
}

export interface HostSubagentsService {
  list?(): string[]
  rootOf?(agent: HostAgent): HostAgent
  getProvider(name: string): HostSubagentProvider | undefined
  start?(name: string, request: HostSubagentStartRequest): Promise<HostSubagentRun>
  startActivation?(spec: {
    childId?: string
    provider: string
    label: string
    request: Omit<HostSubagentStartRequest, 'label' | 'signal'>
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<HostSubagentActivation>
}

export interface HostLlmService {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{
    id: string
    name: string
    description?: string
    inputModalities?: readonly string[]
  }>>
}

export interface HostCredentialRecordInfo {
  configured: boolean
  kind?: 'api-key' | 'grant'
  writable: boolean
}

export interface HostCredentialsService {
  readRecord(key: string): Promise<unknown>
  describeRecord(key: string): Promise<HostCredentialRecordInfo>
  modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>): Promise<unknown>
  deleteRecord(key: string): Promise<void>
}

export interface HostContextShape {
  tools: { register(definition: ToolDefinition): unknown }
  commands: CommandService
  settings: unknown
  connection?: HostConnectionHandle
  agents: HostAgentsService
  subagents: HostSubagentsService
  workspaceRegistry?: HostWorkspaceRegistry
  credentials?: HostCredentialsService
  get(name: string): unknown
  provide(name: string, value?: unknown, check?: () => boolean): unknown
  inject(services: string[], callback: (ctx: HostContextShape) => void): unknown
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => unknown
  effect(callback: () => (() => unknown) | void, label?: string): () => unknown
}
