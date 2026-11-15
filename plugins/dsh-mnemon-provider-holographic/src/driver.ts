import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { topScored } from './top-scored.ts'
import type { JsonValue } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import type { MemorySpaceAuthority } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import type {
  Insight,
  MemoryBody as MemorySpace,
  MemoryBodyStats as MemorySpaceStats,
  MemoryGraphSnapshot,
  MemoryListRequest,
  MemoryProviderConnection,
  RememberRequest,
  SearchRequest,
} from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { NORMALIZED_RELEVANCE_SCORE, type MemoryProviderAdapter, type ProviderBodyStatus as ProviderSpaceStatus, type ProviderMemorySpace, type ProviderSearchResult } from 'dsh-mnemon-source-memory-spaces/provider-sdk'

interface HolographicFact {
  id: string
  content: string
  category: string
  tags: string[]
  entities: string[]
  trustScore: number
  importance?: number
  createdAt: string
  updatedAt: string
}

interface HolographicStore {
  version: 1
  facts: HolographicFact[]
}

const WORD = /[\p{L}\p{N}_-]+/gu
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const QUOTED = /["“”'‘’]([^"“”'‘’]{2,100})["“”'‘’]/gu
const CAPITALIZED = /\b([A-Z][\p{L}\p{N}_-]+(?:\s+[A-Z][\p{L}\p{N}_-]+)*)\b/gu

function clampTrust(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function matchesEntity(queryLower: string, queryWords: ReadonlySet<string>, rawEntity: string): boolean {
  const entity = rawEntity.trim().toLocaleLowerCase()
  if (entity === '') return false
  if (HAS_CJK.test(entity)) return queryLower.includes(entity)
  const entityWords = entity.match(WORD) ?? []
  if (entityWords.length === 0) return queryLower.includes(entity)
  if (entityWords.length === 1 && entityWords[0] === entity) return queryWords.has(entity)
  const escaped = entity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'u').test(queryLower)
}

function terms(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase()
  const output = new Set((normalized.match(WORD) ?? []).filter(token => token.length > 1))
  for (const run of normalized.match(CJK) ?? []) {
    for (const character of run) output.add(character)
    for (let index = 0; index < run.length - 1; index += 1) output.add(run.slice(index, index + 2))
  }
  return output
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left]
  for (const value of smaller) if (larger.has(value)) shared += 1
  return shared / (left.size + right.size - shared)
}

function extractEntities(content: string, supplied: string[] = []): string[] {
  const values = [...supplied]
  for (const match of content.matchAll(QUOTED)) values.push(match[1]!)
  for (const match of content.matchAll(CAPITALIZED)) values.push(match[1]!)
  return [...new Set(values.map(value => value.trim()).filter(value => value.length >= 2 && value.length <= 100))].slice(0, 50)
}

function insight(fact: HolographicFact, score?: number): Insight {
  return {
    id: fact.id,
    content: fact.content,
    category: fact.category,
    ...(fact.importance === undefined ? {} : { importance: fact.importance }),
    tags: fact.tags,
    entities: fact.entities,
    source: 'external',
    createdAt: fact.createdAt,
    ...(score === undefined ? {} : { score }),
  }
}

export class HolographicProvider implements MemoryProviderAdapter {
  readonly id = 'holographic' as const
  readonly scoreSemantics = NORMALIZED_RELEVANCE_SCORE

  constructor(private readonly memorySpaces: MemorySpaceAuthority) {}

  async discover(connection: MemoryProviderConnection): Promise<ProviderMemorySpace[]> {
    const configured = String(connection.dataPath ?? '').trim()
    const path = configured === ''
      ? join(this.memorySpaces.runner.effectiveDataDir(), 'state', 'holographic', 'store.json')
      : isAbsolute(configured)
        ? configured
        : resolve(this.memorySpaces.runner.effectiveDataDir(), configured)
    const label = basename(path).replace(/\.json$/iu, '') || 'Holographic'
    return [{
      externalId: path,
      name: label === 'store' ? 'Holographic' : label,
      description: `Holographic fact store at ${path}`,
      connection: { defaultTrust: 0.5, minTrust: 0.3 },
    }]
  }

  async status(body: MemorySpace): Promise<ProviderSpaceStatus> {
    try {
      const path = this.path(body)
      const store = this.loadFromPath(path)
      return { healthy: true, stats: this.stats(store, path) }
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async search(body: MemorySpace, request: SearchRequest): Promise<ProviderSearchResult> {
    const store = this.load(body)
    const connection = this.connection(body)
    const minTrust = clampTrust(Number(connection.minTrust ?? 0.3))
    const queryTerms = terms(request.query)
    const query = request.query.toLocaleLowerCase()
    const queryWords = new Set(query.match(WORD) ?? [])
    const limit = Math.min(Math.max(request.limit ?? 10, 1), 50)
    const results = topScored(store.facts.flatMap(fact => {
      if (fact.trustScore < minTrust || (request.category !== undefined && fact.category !== request.category)) return []
      const lexical = overlap(queryTerms, terms(`${fact.content} ${fact.tags.join(' ')} ${fact.entities.join(' ')}`))
      const phrase = fact.content.toLocaleLowerCase().includes(query) ? 1 : 0
      const entity = fact.entities.some(value => matchesEntity(query, queryWords, value)) ? 1 : 0
      const relevance = Math.max(lexical, phrase * 0.9, entity * 0.8)
      return relevance <= 0 ? [] : [{ fact, score: relevance * fact.trustScore }]
    }), limit)
    return { results: results.map(result => insight(result.fact, result.score)) }
  }

  async list(body: MemorySpace, request: MemoryListRequest): Promise<Insight[]> {
    if (request.query !== undefined && request.query.trim() !== '') {
      return (await this.search(body, {
        query: request.query,
        ...(request.category === undefined ? {} : { category: request.category }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      })).results
    }
    const store = this.load(body)
    const minTrust = clampTrust(Number(this.connection(body).minTrust ?? 0.3))
    return store.facts
      .filter(fact => fact.trustScore >= minTrust && (request.category === undefined || fact.category === request.category))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.min(Math.max(request.limit ?? 200, 1), 1000))
      .map(fact => insight(fact))
  }

  async graph(body: MemorySpace): Promise<MemoryGraphSnapshot> {
    const facts = (await this.list(body, { limit: 500 }))
    const entities = [...new Set(facts.flatMap(fact => fact.entities ?? []))]
    return {
      nodes: [
        ...facts.map(fact => ({ ...fact, color: '#6574d9', kind: 'memory' as const })),
        ...entities.map(entity => ({ id: `entity:${encodeURIComponent(entity)}`, content: entity, color: '#2ecc71', kind: 'entity' as const })),
      ],
      edges: facts.flatMap(fact => (fact.entities ?? []).map(entity => ({
        sourceId: fact.id,
        targetId: `entity:${encodeURIComponent(entity)}`,
        label: 'entity',
        color: '#2ecc71',
        type: 'entity' as const,
      }))),
      generatedAt: new Date().toISOString(),
    }
  }

  async related(body: MemorySpace, id: string, _depth: number): Promise<Insight[]> {
    const store = this.load(body)
    const source = store.facts.find(fact => fact.id === id)
    if (source === undefined) return []
    const sourceEntities = new Set(source.entities.map(value => value.toLocaleLowerCase()))
    const sourceTerms = terms(source.content)
    const minTrust = clampTrust(Number(this.connection(body).minTrust ?? 0.3))
    return topScored(store.facts.flatMap(fact => {
      if (fact.id === id || fact.trustScore < minTrust) return []
      const sharedEntities = fact.entities.filter(value => sourceEntities.has(value.toLocaleLowerCase())).length
      const score = Math.max(sharedEntities === 0 ? 0 : Math.min(1, 0.5 + sharedEntities * 0.2), overlap(sourceTerms, terms(fact.content))) * fact.trustScore
      return score <= 0 ? [] : [{ fact, score }]
    }), 20).map(result => insight(result.fact, result.score))
  }

  async remember(body: MemorySpace, request: RememberRequest): Promise<JsonValue> {
    if (request.importance !== undefined && (!Number.isInteger(request.importance) || request.importance < 1 || request.importance > 5)) {
      throw new Error('importance must be an integer from 1 through 5')
    }
    const store = this.load(body)
    const existing = store.facts.find(fact => fact.content === request.content.trim())
    if (existing !== undefined) return { action: 'skipped', provider: this.id, id: existing.id, summary: 'Holographic already contains this fact.' }
    const now = new Date().toISOString()
    const connection = this.connection(body)
    const fact: HolographicFact = {
      id: `holo-${randomUUID()}`,
      content: request.content.trim(),
      category: request.category ?? 'general',
      tags: [...new Set(request.tags ?? [])],
      entities: extractEntities(request.content, request.entities),
      trustScore: request.importance === undefined ? clampTrust(Number(connection.defaultTrust ?? 0.5)) : request.importance / 5,
      importance: request.importance ?? 3,
      createdAt: now,
      updatedAt: now,
    }
    store.facts.push(fact)
    this.save(body, store)
    return { action: 'stored', provider: this.id, id: fact.id, summary: 'Holographic stored the structured fact.' }
  }

  async forget(body: MemorySpace, id: string): Promise<JsonValue> {
    const store = this.load(body)
    const before = store.facts.length
    store.facts = store.facts.filter(fact => fact.id !== id)
    if (store.facts.length === before) throw new Error(`unknown Holographic fact: ${id}`)
    this.save(body, store)
    return { action: 'deleted', provider: this.id, id }
  }

  private connection(body: MemorySpace): Record<string, string | number | boolean> {
    if ((body.provider.typeId ?? body.provider.id) !== this.id) throw new Error(`Holographic cannot serve provider ${body.provider.id}`)
    return this.memorySpaces.providerConnection(body.id, body.provider.id)
  }

  private path(body: MemorySpace): string {
    const configured = String(this.connection(body).dataPath ?? '').trim()
    if (configured === '') return join(this.memorySpaces.runner.effectiveDataDir(), 'state', 'holographic', 'store.json')
    return isAbsolute(configured) ? configured : resolve(this.memorySpaces.runner.effectiveDataDir(), configured)
  }

  private load(body: MemorySpace): HolographicStore {
    return this.loadFromPath(this.path(body))
  }

  private loadFromPath(path: string): HolographicStore {
    if (!existsSync(path)) return { version: 1, facts: [] }
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<HolographicStore>
    if (value.version !== 1 || !Array.isArray(value.facts)) throw new Error(`invalid Holographic fact store: ${path}`)
    return { version: 1, facts: value.facts }
  }

  private save(body: MemorySpace, store: HolographicStore): void {
    const path = this.path(body)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, path)
      chmodSync(path, 0o600)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  private stats(store: HolographicStore, path: string): MemorySpaceStats {
    const byCategory: Record<string, number> = {}
    const entityCounts = new Map<string, number>()
    for (const fact of store.facts) {
      byCategory[fact.category] = (byCategory[fact.category] ?? 0) + 1
      for (const entity of fact.entities) entityCounts.set(entity, (entityCounts.get(entity) ?? 0) + 1)
    }
    return {
      totalInsights: store.facts.length,
      deletedInsights: 0,
      edgeCount: store.facts.reduce((total, fact) => total + fact.entities.length, 0),
      oplogCount: 0,
      dbSizeBytes: existsSync(path) ? statSync(path).size : 0,
      byCategory,
      topEntities: [...entityCounts].map(([entity, count]) => ({ entity, count })).sort((left, right) => right.count - left.count).slice(0, 20),
    }
  }
}
