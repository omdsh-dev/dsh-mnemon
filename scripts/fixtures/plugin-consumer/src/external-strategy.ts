import type { Context } from '@deepseek-ai/cordis'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'

export const name = 'dsh-mnemon-strategy-external-focus'
export const inject = ['mnemonMemory']
export interface Config { sourceKeys: string[]; mode: 'eager' | 'routed' }

/** A Strategy knows Source facts and instance identities, never their implementations. */
export function apply(ctx: Context, config: Config): void {
  const selected = new Set(config.sourceKeys)
  const mode = config.mode
  installMemory(ctx, { strategies: [defineMemoryStrategy({
    manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'external-focus', packageName: name,
      deterministic: true, supportedSourceRoles: ['notes', 'working-context', 'narrative', 'durable-evidence'],
      maxSources: 8, maxRoutes: 16, maxActions: 16 },
    compose(request, facts) {
      const chosen = facts.filter(fact => selected.has(fact.sourceInstanceKey) && fact.availability !== 'unavailable')
        .sort((left, right) => left.sourceInstanceKey.localeCompare(right.sourceInstanceKey))
      return { strategyTypeId: 'external-focus', explanation: 'Only explicitly selected Source instances enter this View.',
        sources: chosen.map(source => ({ sourceInstanceKey: source.sourceInstanceKey,
          ...(source.projection?.actions.includes('wake') ? {
            projection: { mode, maxCharacters: Math.max(1, Math.floor(request.budget.maxProjectionCharacters / Math.max(1, chosen.length))) },
          } : {}),
          routeIds: source.routes.filter(route => route.semantics?.actions.includes('read')).map(route => route.id),
          actionIds: source.actions.filter(action => action.semantics?.actions.some(action => ['record', 'compress', 'forget'].includes(action))).map(action => action.id),
          routeOptions: Object.fromEntries(source.routes.filter(route => route.semantics?.actions.includes('read')).map(route => [route.id, {
            ...(route.semantics?.representations.includes('raw') ? { representation: 'raw' as const } : {}),
            budgets: [{ resource: 'output' as const, unit: 'characters' as const, measurement: 'exact' as const, amount: 'auto' as const }],
          }])),
        })) }
    },
  })] })
}
