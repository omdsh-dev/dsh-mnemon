import type { TrajectoryStep, TrajectoryStats } from 'dsh-mnemon-source-skills/contracts'
import { SessionEventCursor } from './session-events.ts'
import type { HostSession, HostSessionEvent } from './dsh.ts'
import { scoreReviewActivity } from './review-activity.ts'
import type { ReviewActivityScore, TurnSkillUse } from './protocol.ts'

/** Each step keeps at most this much text; a window keeps at most this many steps. */
export const TRAJECTORY_STEP_CHARACTERS = 600
export const TRAJECTORY_INPUT_CHARACTERS = 300
export const TRAJECTORY_MAX_STEPS = 160

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9]{4})[A-Za-z0-9_-]+/gu, '$1***'],
  [/(Bearer\s+)[A-Za-z0-9_\-.~+/]+=*/giu, '$1***'],
  [/(Authorization:\s*)\S+/giu, '$1***'],
  [/((?:password|passwd|secret|token|api_key|apikey|access_token|refresh_token)\s*[=:]\s*)[^\s&"',;]+/giu, '$1***'],
  [/\b(AKIA[A-Z0-9]{4})[A-Z0-9]+/gu, '$1***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[private key]'],
]

/** Remove what looks like a credential before a step is stored or shown to a model. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text)
}

function clip(text: string, maximum: number): string {
  const value = redact(text.replace(/\s+\n/gu, '\n').trim())
  return value.length <= maximum ? value : value.slice(0, maximum - 1) + '…'
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    const value = record(block)
    if (value.type === 'text' && typeof value.text === 'string') return value.text
    if (value.type === 'tool-result') return blocksText(value.content)
    return ''
  }).filter(Boolean).join('\n')
}

/** The `name` a `skill` tool call asked for, from its JSON arguments. */
function skillArgument(raw: unknown): string | undefined {
  const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown } catch { return undefined } })() : raw
  const name = record(parsed).name
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
}

/** A short, readable rendering of tool arguments: key=value pairs, long values cut. */
function argumentsText(raw: unknown): string {
  const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown } catch { return raw } })() : raw
  if (typeof parsed === 'string') return clip(parsed, TRAJECTORY_INPUT_CHARACTERS)
  const fields = Object.entries(record(parsed)).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return clip(fields.join(' '), TRAJECTORY_INPUT_CHARACTERS)
}

export interface CapturedTurn {
  turn: number
  steps: Array<Omit<TrajectoryStep, 'index'>>
  userCharacters: number
  toolCalls: number
  toolFailures: number
  toolNames: string[]
  skills: string[]
  /** Whether the turn ended normally; an aborted turn is still evidence of a correction. */
  reason?: string
}

/**
 * Read one finished turn from the durable log: the user's own messages, skill
 * loads, tool calls with their result or error, and the assistant's text, in
 * log order. Nothing here calls a model.
 */
export function captureTurn(events: Iterable<HostSessionEvent>, turn: number): CapturedTurn | undefined {
  let started = false
  let end: HostSessionEvent | undefined
  const steps: CapturedTurn['steps'] = []
  const calls = new Map<string, { name: string; input: string; skill?: string; at?: string }>()
  const skills = new Set<string>()
  const toolNames = new Set<string>()
  let userCharacters = 0
  let toolCalls = 0
  let toolFailures = 0
  const at = (event: HostSessionEvent) => typeof event.time === 'number' ? new Date(event.time).toISOString() : undefined
  for (const event of events) {
    if (steps.length > TRAJECTORY_MAX_STEPS) steps.splice(0, steps.length - TRAJECTORY_MAX_STEPS)
    if (event.type === 'turn/start' && event.data.turn === turn) {
      started = true; end = undefined
      steps.length = 0; calls.clear(); skills.clear(); toolNames.clear()
      userCharacters = 0; toolCalls = 0; toolFailures = 0
      continue
    }
    if (!started || end !== undefined) continue
    if (event.type === 'turn/end' && event.data.turn === turn) { end = event; continue }
    if (event.type === 'user/message') {
      const source = record(event.data.source)
      if (source.kind === 'skill-invocation' && typeof source.name === 'string') {
        skills.add(source.name)
        steps.push({ turn, kind: 'skill', text: source.name, skill: { name: source.name, by: 'user' }, ...(at(event) === undefined ? {} : { at: at(event)! }) })
        continue
      }
      if (source.kind !== 'user') continue
      const text = blocksText(event.data.content).trim()
      if (text === '') continue
      userCharacters += text.length
      steps.push({ turn, kind: 'user', text: clip(text, TRAJECTORY_STEP_CHARACTERS), ...(at(event) === undefined ? {} : { at: at(event)! }) })
      continue
    }
    if (event.type === 'tool/call' && typeof event.data.callId === 'string' && typeof event.data.name === 'string') {
      const name = event.data.name
      const skill = name === 'skill' ? skillArgument(event.data.arguments) : undefined
      calls.set(event.data.callId, { name, input: argumentsText(event.data.arguments), ...(skill === undefined ? {} : { skill }), ...(at(event) === undefined ? {} : { at: at(event)! }) })
      continue
    }
    if (event.type === 'tool/result') {
      const message = record(event.data.message)
      const callId = typeof record(message.source).callId === 'string' ? String(record(message.source).callId) : typeof message.toolCallId === 'string' ? message.toolCallId : undefined
      const call = callId === undefined ? undefined : calls.get(callId)
      if (call === undefined) continue
      calls.delete(callId!)
      toolCalls++
      toolNames.add(call.name)
      const error = event.data.error === undefined && message.isError !== true ? undefined
        : clip(typeof record(event.data.error).reason === 'string' ? String(record(event.data.error).reason) : blocksText(message.content) || 'failed', 300)
      if (error !== undefined) toolFailures++
      if (call.skill !== undefined && error === undefined) {
        skills.add(call.skill)
        steps.push({ turn, kind: 'skill', text: call.skill, skill: { name: call.skill, by: 'model' }, ...(call.at === undefined ? {} : { at: call.at }) })
        continue
      }
      const output = error === undefined ? clip(blocksText(message.content), 240) : ''
      steps.push({
        turn, kind: 'tool', text: error === undefined ? output : error,
        tool: { name: call.name, ok: error === undefined, ...(call.input === '' ? {} : { input: call.input }), ...(error === undefined ? {} : { error }) },
        ...(call.at === undefined ? {} : { at: call.at }),
      })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = blocksText(record(event.data.message).content).trim()
      if (text === '') continue
      steps.push({ turn, kind: 'assistant', text: clip(text, TRAJECTORY_STEP_CHARACTERS), ...(at(event) === undefined ? {} : { at: at(event)! }) })
    }
  }
  if (!started) return undefined
  if (steps.length > TRAJECTORY_MAX_STEPS) steps.splice(0, steps.length - TRAJECTORY_MAX_STEPS)
  const reason = end === undefined ? undefined : record(end.data.reason).kind
  return { turn, steps, userCharacters, toolCalls, toolFailures, toolNames: [...toolNames], skills: [...skills], ...(typeof reason === 'string' ? { reason } : {}) }
}

/**
 * The skills each turn used, read once over the whole log: the user's `/name`
 * and the model's successful `skill` calls, each name once per turn.
 */
function skillUseAccumulator() {
  const turns = new Map<number, TurnSkillUse[]>()
  const calls = new Map<string, { turn: number; name: string }>()
  let turn: number | undefined
  const use = (at: number, skill: TurnSkillUse): void => {
    const list = turns.get(at) ?? []
    if (!list.some(existing => existing.name === skill.name)) list.push(skill)
    turns.set(at, list)
  }
  return {
    consume(event: HostSessionEvent): void {
      if (event.type === 'turn/start' && typeof event.data.turn === 'number') { turn = event.data.turn; return }
      if (event.type === 'turn/end') { turn = undefined; return }
      if (turn === undefined) return
      if (event.type === 'user/message') {
        const source = record(event.data.source)
        if (source.kind === 'skill-invocation' && typeof source.name === 'string' && source.name.trim() !== '') use(turn, { name: source.name.trim(), by: 'user' })
        return
      }
      if (event.type === 'tool/call' && event.data.name === 'skill' && typeof event.data.callId === 'string') {
        const name = skillArgument(event.data.arguments)
        if (name !== undefined) calls.set(event.data.callId, { turn, name })
        return
      }
      if (event.type === 'tool/result') {
        const message = record(event.data.message)
        const callId = typeof record(message.source).callId === 'string' ? String(record(message.source).callId) : typeof message.toolCallId === 'string' ? message.toolCallId : undefined
        const call = callId === undefined ? undefined : calls.get(callId)
        if (call === undefined) return
        calls.delete(callId!)
        if (event.data.error === undefined && message.isError !== true) use(call.turn, { name: call.name, by: 'model' })
      }
    },
    reset(): void { turns.clear(); calls.clear(); turn = undefined },
    result(): Array<{ turn: number; skills: TurnSkillUse[] }> {
      return [...turns].map(([number, skills]) => ({ turn: number, skills: skills.map(skill => ({ ...skill })) }))
    },
  }
}

export function turnSkillUses(events: Iterable<HostSessionEvent>): Array<{ turn: number; skills: TurnSkillUse[] }> {
  const projection = skillUseAccumulator()
  for (const event of events) projection.consume(event)
  return projection.result()
}

export class TurnSkillUseProjection {
  private readonly cursor = new SessionEventCursor()
  private readonly projection = skillUseAccumulator()

  snapshot(session: HostSession): Array<{ turn: number; skills: TurnSkillUse[] }> {
    this.cursor.consume(session, event => this.projection.consume(event), () => this.projection.reset())
    return this.projection.result()
  }
}

/** The session's newest title, when DSH has one. */
export function sessionTitle(events: readonly HostSessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'session/title' && typeof event.data.title === 'string' && event.data.title.trim() !== '') return event.data.title.trim().slice(0, 200)
  }
  return undefined
}

/**
 * One session's open review window: the turns captured since the last skill
 * review and the post-turn score they add up to.
 */
export class TrajectoryWindow {
  private turns: CapturedTurn[] = []
  private readonly toolNames = new Set<string>()
  startedAt: string | undefined

  add(turn: CapturedTurn, now: Date): void {
    if (this.turns.some(existing => existing.turn === turn.turn)) return
    this.turns.push(turn)
    this.startedAt ??= now.toISOString()
    for (const name of turn.toolNames) this.toolNames.add(name)
  }

  get size(): number {
    return this.turns.length
  }

  /** The newest turn in the window, which a review of it is placed under. */
  get lastTurn(): number | undefined {
    return this.turns.length === 0 ? undefined : Math.max(...this.turns.map(turn => turn.turn))
  }

  /** The captured turns, oldest first. */
  captured(): readonly CapturedTurn[] {
    return this.turns
  }

  score(): ReviewActivityScore {
    return scoreReviewActivity({
      totalUserTextLength: this.turns.reduce((sum, turn) => sum + turn.userCharacters, 0),
      turnCount: this.turns.length,
      toolCallCount: this.turns.reduce((sum, turn) => sum + turn.toolCalls, 0),
      uniqueToolCount: this.toolNames.size,
    })
  }

  /** Numbered steps, newest kept when the window is longer than the bound. */
  steps(): TrajectoryStep[] {
    const all = this.turns.flatMap(turn => turn.steps)
    return all.slice(-TRAJECTORY_MAX_STEPS).map((step, offset) => ({ ...step, index: offset + 1 }))
  }

  stats(): TrajectoryStats {
    return {
      turns: this.turns.length,
      userCharacters: this.turns.reduce((sum, turn) => sum + turn.userCharacters, 0),
      toolCalls: this.turns.reduce((sum, turn) => sum + turn.toolCalls, 0),
      toolFailures: this.turns.reduce((sum, turn) => sum + turn.toolFailures, 0),
      uniqueTools: this.toolNames.size,
      skills: [...new Set(this.turns.flatMap(turn => turn.skills))],
    }
  }

  reset(): void {
    this.turns = []
    this.toolNames.clear()
    this.startedAt = undefined
  }
}
