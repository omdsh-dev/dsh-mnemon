import { resolve } from 'node:path'
import type { HostAgent } from './dsh.ts'
import type { MnemonAgentRuntimeSource } from './runtime.ts'
import type { SkillsSourcePort } from './skill-evolution.ts'

export const SKILLS_SOURCE_TYPE = 'skills'

export function skillsSourceFor(runtime: Pick<MnemonAgentRuntimeSource, 'forAgent'>, agent: HostAgent): SkillsSourcePort | undefined {
  let graph
  try { graph = runtime.forAgent(agent) } catch { return undefined }
  if (graph.config.memoryTopology.layers[SKILLS_SOURCE_TYPE]?.enabled === false) return undefined
  const generation = graph.memoryComposition.current()
  if (generation === undefined || !generation.sourceInstances().some(source => source.sourceTypeId === SKILLS_SOURCE_TYPE)) return undefined
  const cwd = agent.session.header?.cwd?.trim()
  return graph.source(SKILLS_SOURCE_TYPE, { storage: graph.config.storageScope, ...(cwd ? { workspaceId: resolve(cwd) } : {}), sessionId: agent.id })
}
