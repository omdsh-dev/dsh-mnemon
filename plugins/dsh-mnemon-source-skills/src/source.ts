import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { COMPOSABLE_MEMORY_API_VERSION, type MemoryJsonValue, type MemorySourceDefinition, type MemorySourceFacts } from 'dsh-mnemon/contracts'
import { defineMemorySource, memoryInputRecord as record, memoryInputStringArray as stringArray, memoryInputText as text } from 'dsh-mnemon/extension-sdk'
import { EVOLUTION_SIGNALS, SKILL_ROOT_KINDS, type CaseResult, type EvolutionSignal, type ReviewRecordInput, type RunTarget, type SkillRootKind, type SkillsPolicy, type TrajectoryStep } from './contracts.ts'
import { SkillsService, type CaseInput } from './service.ts'

export const SKILLS_SOURCE_TYPE_ID = 'skills'
export const SKILLS_SOURCE_ROLE = 'procedural'
const CAPABILITIES = ['status', 'read', 'write'] as const

export interface Config {
  /** Absolute directory holding `skills/`; the Host supplies its storage root. */
  dataDir?: string
  /** DSH's home; defaults to `$DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** The shared agents home; defaults to `$DSH_AGENTS_HOME`, then `~/.agents`. */
  agentsHome?: string
}

function workspace(scope: { workspaceId?: string }): string | undefined {
  const value = scope.workspaceId?.trim()
  return value === undefined || value === '' ? undefined : value
}

function optionalText(value: MemoryJsonValue | undefined, label: string, maximum: number): string | undefined {
  return value === undefined || value === null ? undefined : text(value, label, maximum, false)
}

function bool(value: MemoryJsonValue | undefined, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function integers(value: MemoryJsonValue | undefined, label: string, maximum = 200): number[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'number' || !Number.isInteger(item))) throw new Error(`${label} must be an integer array`)
  return value as number[]
}

function rootKind(value: MemoryJsonValue | undefined): SkillRootKind | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !(SKILL_ROOT_KINDS as readonly string[]).includes(value)) throw new Error('root must be one of ' + SKILL_ROOT_KINDS.join(', '))
  return value as SkillRootKind
}

function caseInput(value: MemoryJsonValue, skillName?: string): CaseInput {
  const input = record(value, 'case')
  const checks = input.checks
  if (!Array.isArray(checks) || checks.length > 8) throw new Error('checks must be an array of at most 8')
  return {
    ...(typeof input.id === 'string' && input.id.trim() !== '' ? { id: input.id.trim() } : {}),
    skillName: skillName ?? text(input.skillName, 'skillName', 64)!,
    title: text(input.title, 'title', 200)!,
    prompt: text(input.prompt, 'prompt', 8_000)!,
    ...(optionalText(input.context, 'context', 8_000) === undefined ? {} : { context: optionalText(input.context, 'context', 8_000)! }),
    checks: checks.map(item => {
      const check = record(item, 'check')
      return { ...(typeof check.id === 'string' ? { id: check.id } : {}), text: text(check.text, 'check', 600)!, must: check.must === true }
    }),
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    ...(input.requiresVision === undefined ? {} : { requiresVision: bool(input.requiresVision, 'requiresVision') }),
  }
}

function runTarget(value: MemoryJsonValue): RunTarget {
  const input = record(value, 'target')
  const kind = input.kind
  if (kind !== 'current' && kind !== 'draft' && kind !== 'version' && kind !== 'none') throw new Error('target kind must be current, draft, version or none')
  return {
    kind,
    ...(typeof input.hash === 'string' ? { hash: input.hash } : {}),
    ...(typeof input.skillKey === 'string' ? { skillKey: input.skillKey } : {}),
    ...(typeof input.draftId === 'string' ? { draftId: input.draftId } : {}),
    ...(typeof input.versionId === 'string' ? { versionId: input.versionId } : {}),
  }
}

function caseResult(value: MemoryJsonValue): CaseResult {
  const input = record(value, 'result')
  const verdict = input.verdict
  if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'error') throw new Error('verdict must be pass, fail or error')
  const unmeasuredReason = input.unmeasuredReason
  if (unmeasuredReason !== undefined && (unmeasuredReason !== 'requires-vision' || verdict !== 'error')) throw new Error('unmeasuredReason requires requires-vision and an ungraded error verdict')
  const score = typeof input.score === 'number' && Number.isFinite(input.score) ? Math.min(1, Math.max(0, input.score)) : 0
  const checks = Array.isArray(input.checks) ? input.checks.slice(0, 8).map(item => {
    const check = record(item, 'check result')
    return { checkId: text(check.checkId, 'checkId', 100)!, pass: check.pass === true, note: typeof check.note === 'string' ? check.note : '' }
  }) : []
  return {
    caseId: text(input.caseId, 'caseId', 100)!, title: text(input.title, 'title', 200)!, verdict, score, checks,
    steps: stringArray(input.steps, 'steps', 40) ?? [],
    answer: typeof input.answer === 'string' ? input.answer : '',
    ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
    ...(typeof input.error === 'string' ? { error: input.error } : {}),
    ...(unmeasuredReason === undefined ? {} : { unmeasuredReason }),
  }
}

function signal(value: MemoryJsonValue | undefined): EvolutionSignal {
  if (typeof value !== 'string' || !(EVOLUTION_SIGNALS as readonly string[]).includes(value)) throw new Error('unknown evolution signal: ' + String(value))
  return value as EvolutionSignal
}

function step(value: MemoryJsonValue): TrajectoryStep {
  const input = record(value, 'step')
  const kind = input.kind
  if (kind !== 'user' && kind !== 'assistant' && kind !== 'tool' && kind !== 'skill') throw new Error('step kind is invalid')
  const tool = input.tool === undefined ? undefined : record(input.tool, 'step tool')
  const skill = input.skill === undefined ? undefined : record(input.skill, 'step skill')
  return {
    index: Number(input.index), turn: Number(input.turn), kind, text: typeof input.text === 'string' ? input.text.slice(0, 2_000) : '',
    ...(tool === undefined ? {} : { tool: {
      name: text(tool.name, 'tool name', 200)!, ok: tool.ok === true,
      ...(typeof tool.input === 'string' ? { input: tool.input.slice(0, 1_000) } : {}),
      ...(typeof tool.error === 'string' ? { error: tool.error.slice(0, 1_000) } : {}),
    } }),
    ...(skill === undefined ? {} : { skill: { name: text(skill.name, 'skill name', 64)!, by: skill.by === 'user' ? 'user' : 'model' } }),
    ...(typeof input.at === 'string' ? { at: input.at } : {}),
  }
}

/** The admission rules the Host sends; each is checked again by the policy. */
function policyInput(value: MemoryJsonValue): Partial<SkillsPolicy> {
  const input = record(value, 'policy')
  const number = (key: keyof SkillsPolicy) => typeof input[key] === 'number' && Number.isFinite(input[key]) ? { [key]: input[key] as number } : {}
  return { ...number('minConfidence'), ...number('expiryDays'), ...number('maxPendingPerSession') }
}

/** The Host's record of one review; bounded here as well as there. */
function reviewRecord(value: MemoryJsonValue): ReviewRecordInput {
  const input = record(value, 'review record')
  const review = record(input.review ?? null, 'review')
  const trajectory = record(input.trajectory ?? null, 'trajectory')
  const stats = record(trajectory.stats ?? null, 'trajectory stats')
  const outcome = review.outcome
  if (outcome !== 'suggested' && outcome !== 'nothing' && outcome !== 'error') throw new Error('review outcome is invalid')
  const steps = trajectory.steps
  if (!Array.isArray(steps) || steps.length > 400) throw new Error('trajectory steps must be an array of at most 400')
  const list = (field: MemoryJsonValue | undefined, label: string, maximum: number) => {
    if (field === undefined) return []
    if (!Array.isArray(field) || field.length > maximum) throw new Error(`${label} must be an array of at most ${maximum}`)
    return field
  }
  const score = review.score === undefined ? undefined : record(review.score, 'score')
  return {
    review: {
      at: text(review.at, 'at', 64)!, sessionId: text(review.sessionId, 'sessionId', 300)!,
      ...(optionalText(review.sessionTitle, 'sessionTitle', 300) === undefined ? {} : { sessionTitle: optionalText(review.sessionTitle, 'sessionTitle', 300)! }),
      trigger: review.trigger === 'manual' ? 'manual' : 'automatic',
      ...(score === undefined ? {} : { score: score as never }),
      durationMs: typeof review.durationMs === 'number' ? review.durationMs : 0,
      outcome,
      ...(optionalText(review.summary, 'summary', 2_000) === undefined ? {} : { summary: optionalText(review.summary, 'summary', 2_000)! }),
      ...(optionalText(review.error, 'error', 2_000) === undefined ? {} : { error: optionalText(review.error, 'error', 2_000)! }),
      ...(Number.isInteger(review.turn) && Number(review.turn) >= 0 ? { turn: Number(review.turn) } : {}),
    },
    ...(input.policy === undefined ? {} : { policy: policyInput(input.policy) }),
    trajectory: {
      sessionId: text(trajectory.sessionId, 'sessionId', 300)!,
      ...(optionalText(trajectory.sessionTitle, 'sessionTitle', 300) === undefined ? {} : { sessionTitle: optionalText(trajectory.sessionTitle, 'sessionTitle', 300)! }),
      ...(optionalText(trajectory.workspace, 'workspace', 2_000) === undefined ? {} : { workspace: optionalText(trajectory.workspace, 'workspace', 2_000)! }),
      startedAt: text(trajectory.startedAt, 'startedAt', 64)!, endedAt: text(trajectory.endedAt, 'endedAt', 64)!,
      stats: {
        turns: Number(stats.turns) || 0, userCharacters: Number(stats.userCharacters) || 0, toolCalls: Number(stats.toolCalls) || 0,
        toolFailures: Number(stats.toolFailures) || 0, uniqueTools: Number(stats.uniqueTools) || 0, skills: stringArray(stats.skills, 'skills', 50) ?? [],
      },
      ...(trajectory.score === undefined ? {} : { score: record(trajectory.score, 'score') as never }),
      steps: steps.map(step),
      annotations: [],
    },
    annotations: list(input.annotations, 'annotations', 200).map(item => {
      const annotation = record(item, 'annotation')
      return { step: Number(annotation.step), signal: signal(annotation.signal), note: typeof annotation.note === 'string' ? annotation.note : '' }
    }),
    suggestions: list(input.suggestions, 'suggestions', 10).map(item => {
      const suggestion = record(item, 'suggestion')
      return {
        skillName: text(suggestion.skillName, 'skillName', 120)!, action: suggestion.action === 'update' ? 'update' : 'create',
        summary: text(suggestion.summary, 'summary', 2_000)!,
        ...(optionalText(suggestion.rationale, 'rationale', 4_000) === undefined ? {} : { rationale: optionalText(suggestion.rationale, 'rationale', 4_000)! }),
        confidence: Number(suggestion.confidence),
        signals: (stringArray(suggestion.signals, 'signals', 10) ?? []).filter((value): value is EvolutionSignal => (EVOLUTION_SIGNALS as readonly string[]).includes(value)),
        steps: integers(suggestion.steps, 'steps'),
      }
    }),
    cases: list(input.cases, 'cases', 10).map(item => {
      const entry = record(item, 'case')
      const checks = list(entry.checks, 'checks', 8)
      return {
        skillName: text(entry.skillName, 'skillName', 120)!, title: text(entry.title, 'title', 400)!, prompt: text(entry.prompt, 'prompt', 8_000)!,
        checks: checks.map(check => { const value = record(check, 'check'); return { text: typeof value.text === 'string' ? value.text : '', must: value.must === true } }),
        steps: integers(entry.steps, 'steps'),
      }
    }),
  }
}

export function skillsDataDir(config: Config, instanceKey: string): string {
  const dataDir = config.dataDir ?? join(homedir(), '.mnemon', 'sources', encodeURIComponent(instanceKey))
  if (!isAbsolute(dataDir)) throw new Error('Skills Source dataDir must be absolute')
  return dataDir
}

export function createSkillsMemorySource(config: Config = {}): MemorySourceDefinition {
  const configured = Object.freeze({ ...config })
  return defineMemorySource({
    manifest: {
      apiVersion: COMPOSABLE_MEMORY_API_VERSION,
      kind: 'source',
      typeId: SKILLS_SOURCE_TYPE_ID,
      packageName: 'dsh-mnemon-source-skills',
      role: SKILLS_SOURCE_ROLE,
      capabilities: [...CAPABILITIES],
      consistency: 'namespace-pinned-live-read',
      management: {
        label: 'Skills',
        description: 'DSH skills with their versions, evolution suggestions, evidence trajectories and eval sets.',
      },
    },
    create(context) {
      const effective = { ...context.configuration, ...configured } as Config
      const service = new SkillsService(skillsDataDir(effective, context.sourceInstanceKey), {
        ...(effective.dshHome === undefined ? {} : { dshHome: effective.dshHome }),
        ...(effective.agentsHome === undefined ? {} : { agentsHome: effective.agentsHome }),
      })
      const facts = (scope: { workspaceId?: string }, management: boolean): MemorySourceFacts => management ? {
        sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: SKILLS_SOURCE_TYPE_ID, role: SKILLS_SOURCE_ROLE, availability: 'ready',
        revision: service.revision(workspace(scope)), capabilities: [...CAPABILITIES], routeIds: [], actionIds: [],
      } : {
        // Skills reach the model through DSH's own skill tool and catalog; a View has nothing to add.
        sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: SKILLS_SOURCE_TYPE_ID, role: SKILLS_SOURCE_ROLE, availability: 'unavailable',
        revision: 'management-only', capabilities: ['status'], routeIds: [], actionIds: [], hints: { reason: 'management-only' },
      }
      return {
        facts(request) {
          return facts(request.scope, request.scenario.startsWith('management.'))
        },
        project() {
          return { fragments: [] }
        },
        async manage(request) {
          const root = workspace(request.scope)
          const input = (request.input ?? {}) as MemoryJsonValue
          const fields = typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {}
          const revision = () => service.revision(root)
          if (request.mode === 'read') {
            const value = (): unknown => {
              switch (request.operation) {
                case 'revision': return { revision: revision() }
                case 'overview': return service.overview(root)
                case 'catalog': return service.catalogView(root)
                case 'skill': return service.skill(root, text(fields.key, 'key', 200)!)
                case 'versions': return service.versions(text(fields.key, 'key', 200)!)
                case 'version': return service.version(text(fields.key, 'key', 200)!, text(fields.id, 'id', 100)!)
                case 'suggestions': return service.suggestions(stringArray(fields.status, 'status', 10))
                case 'suggestion': return service.suggestion(root, text(fields.id, 'id', 100)!)
                case 'trajectories': return service.trajectories({
                  ...(optionalText(fields.skill, 'skill', 64) === undefined ? {} : { skill: optionalText(fields.skill, 'skill', 64)! }),
                  ...(optionalText(fields.signal, 'signal', 40) === undefined ? {} : { signal: optionalText(fields.signal, 'signal', 40)! }),
                  ...(optionalText(fields.sessionId, 'sessionId', 300) === undefined ? {} : { sessionId: optionalText(fields.sessionId, 'sessionId', 300)! }),
                })
                case 'trajectory': return service.trajectory(text(fields.id, 'id', 100)!)
                case 'cases': return service.cases(optionalText(fields.skill, 'skill', 64))
                case 'runs': return service.runs(optionalText(fields.skill, 'skill', 64))
                case 'run': return service.run(text(fields.id, 'id', 100)!)
                case 'drafts': return service.drafts({
                  ...(optionalText(fields.suggestionId, 'suggestionId', 100) === undefined ? {} : { suggestionId: optionalText(fields.suggestionId, 'suggestionId', 100)! }),
                  ...(optionalText(fields.skill, 'skill', 64) === undefined ? {} : { skill: optionalText(fields.skill, 'skill', 64)! }),
                })
                case 'draft': return service.draft(root, text(fields.id, 'id', 100)!)
                case 'reviews': return service.reviews({ ...(typeof fields.sessionId === 'string' ? { sessionId: fields.sessionId } : {}), ...(typeof fields.limit === 'number' ? { limit: fields.limit } : {}) })
                case 'evidence-pack': return service.evidencePack(root, {
                  ...(optionalText(fields.suggestionId, 'suggestionId', 100) === undefined ? {} : { suggestionId: optionalText(fields.suggestionId, 'suggestionId', 100)! }),
                  ...(optionalText(fields.skill, 'skill', 64) === undefined ? {} : { skill: optionalText(fields.skill, 'skill', 64)! }),
                })
                case 'target-content': return service.targetContent(root, text(fields.skillName, 'skillName', 64)!, runTarget(fields.target!))
                case 'market': return service.marketView(root)
                // A skill the search index found is named by its index id, `owner/repo/skill`.
                case 'market-preview': return service.marketPreview(text(fields.registryId, 'registryId', 80)!, text(fields.name, 'name', 300)!, request.signal)
                case 'market-search': return service.searchMarket(root, text(fields.query, 'query', 200)!, request.signal)
                case 'installs': return service.installs()
                case 'trash':
                case 'trash-list': return service.trashItems()
                case 'trash-restore-preview': return service.previewTrashRestore(root, {
                  id: text(fields.id, 'id', 300)!,
                  ...(rootKind(fields.root) === undefined ? {} : { root: rootKind(fields.root)! }),
                  ...(optionalText(fields.name, 'name', 64) === undefined ? {} : { name: optionalText(fields.name, 'name', 64)! }),
                })
                default: throw new Error('unsupported Skills read operation: ' + request.operation)
              }
            }
            const result = await value()
            return { revision: revision(), value: JSON.parse(JSON.stringify(result ?? null)) as MemoryJsonValue }
          }
          if (!request.confirmed) throw new Error('Skills management mutation requires explicit confirmation')
          if (request.expectedRevision !== undefined && request.expectedRevision !== revision()) throw new Error('Skills Source changed since it was read; reload and try again')
          let value: unknown
          switch (request.operation) {
            case 'skill-create': value = await service.createSkill(root, {
              name: text(fields.name, 'name', 64)!, description: text(fields.description, 'description', 1_000)!,
              ...(rootKind(fields.root) === undefined ? {} : { root: rootKind(fields.root)! }),
              ...(typeof fields.content === 'string' && fields.content.trim() !== '' ? { content: fields.content } : {}),
            }); break
            case 'skill-save': value = await service.saveSkill(root, { key: text(fields.key, 'key', 200)!, content: typeof fields.content === 'string' ? fields.content : '', expectedHash: text(fields.expectedHash, 'expectedHash', 100)! }); break
            case 'skill-invocation': value = await service.setInvocation(root, {
              key: text(fields.key, 'key', 200)!, modelInvocable: bool(fields.modelInvocable, 'modelInvocable'), userInvocable: bool(fields.userInvocable, 'userInvocable'),
              expectedHash: text(fields.expectedHash, 'expectedHash', 100)!,
            }); break
            case 'skill-delete': value = await service.deleteSkill(root, { key: text(fields.key, 'key', 200)!, expectedHash: text(fields.expectedHash, 'expectedHash', 100)! }); break
            case 'trash-restore': value = await service.restoreTrash(root, {
              id: text(fields.id, 'id', 300)!,
              ...(rootKind(fields.root) === undefined ? {} : { root: rootKind(fields.root)! }),
              ...(optionalText(fields.name, 'name', 64) === undefined ? {} : { name: optionalText(fields.name, 'name', 64)! }),
              ...(fields.replace === true ? { replace: true } : {}),
              ...(optionalText(fields.expectedHash, 'expectedHash', 100) === undefined ? {} : { expectedHash: optionalText(fields.expectedHash, 'expectedHash', 100)! }),
            }); break
            case 'trash-purge': value = await service.purgeTrash({ id: text(fields.id, 'id', 300)! }); break
            case 'trash-empty': value = await service.emptyTrash(); break
            case 'version-restore': value = await service.restoreVersion(root, { key: text(fields.key, 'key', 200)!, versionId: text(fields.versionId, 'versionId', 100)!, expectedHash: text(fields.expectedHash, 'expectedHash', 100)! }); break
            case 'suggestion-dismiss': value = await service.dismissSuggestion(text(fields.id, 'id', 100)!); break
            case 'suggestion-status': {
              const status = fields.status
              if (status !== 'drafting' && status !== 'pending') throw new Error('status must be drafting or pending')
              value = await service.suggestionStatus({ id: text(fields.id, 'id', 100)!, status, ...(typeof fields.error === 'string' ? { error: fields.error } : {}) })
              break
            }
            case 'trajectory-pin': value = await service.pinTrajectory(text(fields.id, 'id', 100)!, bool(fields.pinned, 'pinned')); break
            case 'trajectory-delete': value = await service.deleteTrajectory(text(fields.id, 'id', 100)!); break
            case 'case-save': value = await service.saveCase(caseInput(fields.case ?? fields)); break
            case 'case-delete': value = await service.deleteCase(text(fields.id, 'id', 100)!); break
            case 'cases-add': {
              const skillName = text(fields.skillName, 'skillName', 64)!
              if (!Array.isArray(fields.cases) || fields.cases.length > 10) throw new Error('cases must be an array of at most 10')
              value = await service.addCases({
                skillName, cases: fields.cases.map(entry => caseInput(entry, skillName)),
                ...(optionalText(fields.trajectoryId, 'trajectoryId', 100) === undefined ? {} : { trajectoryId: optionalText(fields.trajectoryId, 'trajectoryId', 100)! }),
                ...(fields.steps === undefined ? {} : { steps: integers(fields.steps, 'steps') }),
              })
              break
            }
            case 'draft-record': value = await service.recordDraft(root, {
              ...(optionalText(fields.suggestionId, 'suggestionId', 100) === undefined ? {} : { suggestionId: optionalText(fields.suggestionId, 'suggestionId', 100)! }),
              skillName: text(fields.skillName, 'skillName', 64)!, content: typeof fields.content === 'string' ? fields.content : '',
              notes: typeof fields.notes === 'string' ? fields.notes : '', changes: stringArray(fields.changes, 'changes', 20) ?? [], guidance: stringArray(fields.guidance, 'guidance', 20) ?? [],
              ...(rootKind(fields.targetRoot) === undefined ? {} : { targetRoot: rootKind(fields.targetRoot)! }),
            }); break
            case 'draft-update': value = await service.updateDraft({ id: text(fields.id, 'id', 100)!, content: typeof fields.content === 'string' ? fields.content : '' }); break
            case 'draft-adopt': value = await service.adoptDraft(root, text(fields.id, 'id', 100)!, { ...(rootKind(fields.root) === undefined ? {} : { root: rootKind(fields.root)! }) }); break
            case 'draft-discard': value = await service.discardDraft(text(fields.id, 'id', 100)!); break
            case 'run-start': value = await service.startRun({ skillName: text(fields.skillName, 'skillName', 64)!, target: runTarget(fields.target!), caseIds: stringArray(fields.caseIds, 'caseIds', 20) ?? [] }); break
            case 'run-link': value = await service.linkRun(text(fields.draftId, 'draftId', 100)!, text(fields.runId, 'runId', 100)!); break
            case 'run-progress': value = await service.progressRun({ id: text(fields.id, 'id', 100)!, result: caseResult(fields.result!) }); break
            case 'run-finish': {
              const status = fields.status === 'completed' ? 'completed' : 'failed'
              value = await service.finishRun({ id: text(fields.id, 'id', 100)!, status, ...(typeof fields.error === 'string' ? { error: fields.error } : {}) })
              break
            }
            case 'review-record': value = await service.recordReview(root, reviewRecord(fields)); break
            case 'market-refresh': value = await service.refreshMarket(stringArray(fields.ids, 'ids', 50), request.signal); break
            case 'market-install': value = await service.installMarket(root, {
              registryId: text(fields.registryId, 'registryId', 80)!, name: text(fields.name, 'name', 300)!,
              ...(rootKind(fields.root) === undefined ? {} : { root: rootKind(fields.root)! }), ...(fields.overwrite === true ? { overwrite: true } : {}),
            }, request.signal); break
            case 'registry-add': value = await service.addRegistry(text(fields.location, 'location', 2_000)!, request.signal); break
            case 'registry-remove': value = await service.removeRegistry(text(fields.id, 'id', 80)!); break
            case 'registry-toggle': value = await service.toggleRegistry(text(fields.id, 'id', 80)!, bool(fields.enabled, 'enabled')); break
            default: throw new Error('unsupported Skills mutation: ' + request.operation)
          }
          return { revision: revision(), value: JSON.parse(JSON.stringify(value ?? null)) as MemoryJsonValue }
        },
      }
    },
  })
}

export const SKILLS_MEMORY_SOURCE = createSkillsMemorySource()
