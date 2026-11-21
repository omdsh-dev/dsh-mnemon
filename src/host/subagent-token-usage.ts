import { z } from 'zod'
import type { HostContextShape } from "./dsh.ts"

export interface MnemonTokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface MnemonSubagentTokenUsageState {
  descriptorSeen: boolean
  totals: MnemonTokenUsageProjection
  last: {
    turn: number
    step: number
    buckets: MnemonTokenUsageProjection
  } | null
}

type UsageSample = NonNullable<MnemonSubagentTokenUsageState['last']>

interface ProjectionEvent {
  type: string
  data: unknown
}

interface ProjectionRegistry {
  register(definition: typeof subagentTokenUsageProjection): unknown
}

type ProjectionContext = HostContextShape & { sessionProjections?: ProjectionRegistry }

const tokenCountSchema = z.number().int().nonnegative()

const tokenUsageSchema: z.ZodType<MnemonTokenUsageProjection> = z.object({
  uncachedInputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
}).strict()

const tokenUsageStateSchema: z.ZodType<MnemonSubagentTokenUsageState> = z.object({
  descriptorSeen: z.boolean(),
  totals: tokenUsageSchema,
  last: z.object({
    turn: tokenCountSchema,
    step: tokenCountSchema,
    buckets: tokenUsageSchema,
  }).strict().nullable(),
}).strict()

const tokenUsageWire = {
  viewSchema: tokenUsageSchema.nullable(),
  view: (state: MnemonSubagentTokenUsageState): MnemonTokenUsageProjection | null =>
    state.descriptorSeen ? state.totals : null,
}

const emptyTokenUsage = (): MnemonTokenUsageProjection => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function usageBuckets(value: unknown): MnemonTokenUsageProjection | undefined {
  if (!isPlainObject(value)) return undefined
  const inputTokens = nonnegativeInteger(value.inputTokens)
  const outputTokens = nonnegativeInteger(value.outputTokens)
  const cacheReadTokens = value.cacheReadTokens === undefined
    ? 0
    : nonnegativeInteger(value.cacheReadTokens)
  const cacheWriteTokens = value.cacheWriteTokens === undefined
    ? 0
    : nonnegativeInteger(value.cacheWriteTokens)
  if (inputTokens === undefined || outputTokens === undefined
    || cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined
  return {
    uncachedInputTokens: inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }
}

function usageSample(event: ProjectionEvent): UsageSample | undefined {
  if (!isPlainObject(event.data)) return undefined
  const turn = nonnegativeInteger(event.data.turn)
  const step = nonnegativeInteger(event.data.step)
  if (turn === undefined || step === undefined) return undefined
  let rawUsage: unknown
  if (event.type === 'assistant/chunk') {
    if (!isPlainObject(event.data.chunk) || event.data.chunk.type !== 'usage') return undefined
    rawUsage = event.data.chunk.usage
  } else if (event.type === 'assistant/message') {
    rawUsage = event.data.usage
  } else {
    return undefined
  }
  const buckets = usageBuckets(rawUsage)
  return buckets === undefined ? undefined : { turn, step, buckets }
}

function isSameStep(last: UsageSample | null, sample: UsageSample): boolean {
  return last !== null && last.turn === sample.turn && last.step === sample.step
}

function equalTokenUsage(left: MnemonTokenUsageProjection, right: MnemonTokenUsageProjection): boolean {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

function replaceTokenUsage(
  totals: MnemonTokenUsageProjection,
  previous: MnemonTokenUsageProjection | undefined,
  next: MnemonTokenUsageProjection,
): MnemonTokenUsageProjection {
  return {
    uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
    outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
  }
}

export const MNEMON_SUBAGENT_TOKEN_USAGE_KEY = 'mnemonSubagentTokenUsage'

export const subagentTokenUsageProjection = {
  key: MNEMON_SUBAGENT_TOKEN_USAGE_KEY,
  stateVersion: 1,
  stateSchema: tokenUsageStateSchema,
  init: (): MnemonSubagentTokenUsageState => ({
    descriptorSeen: false,
    totals: emptyTokenUsage(),
    last: null,
  }),
  apply: (state: MnemonSubagentTokenUsageState, event: ProjectionEvent): MnemonSubagentTokenUsageState => {
    if (event.type === 'subagent/descriptor') {
      return { descriptorSeen: true, totals: emptyTokenUsage(), last: null }
    }
    if (!state.descriptorSeen) return state
    const sample = usageSample(event)
    if (sample === undefined) return state
    const previous = isSameStep(state.last, sample) ? state.last!.buckets : undefined
    if (previous !== undefined && equalTokenUsage(previous, sample.buckets)) return state
    return {
      descriptorSeen: true,
      totals: replaceTokenUsage(state.totals, previous, sample.buckets),
      last: sample,
    }
  },
  wire: tokenUsageWire,
} as const

export function registerSubagentTokenUsage(ctx: HostContextShape): void {
  ctx.inject(['sessionProjections'], (rawContext) => {
    const projectionContext = rawContext as ProjectionContext
    projectionContext.sessionProjections?.register(subagentTokenUsageProjection)
  })
}
