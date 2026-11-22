import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { createMemorySpacesSource } from './source.ts'
import { PrivateMemorySpaceProviderHost } from './providers/host.ts'
import { defineMemorySpaceProvider, type MemorySpaceProviderEntry, type MemorySpaceProviderModule } from './providers/definitions.ts'
import { createMemorySpaceProviderPlugin } from './providers/plugin.ts'
import { MemorySpacesConfig, resolveMemorySpacesConfig, type MemorySpacesConfig as SourceConfig } from './config.ts'

export { resolveEmbedding, resolvePersistenceStrategy, resolveRecallQuality } from './config.ts'

export const name = 'dsh-mnemon-source-memory-spaces'
export const inject = ['mnemonMemory']

export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Memory Spaces', 'zh-CN': '记忆空间', ja: 'メモリスペース', es: 'Espacios de memoria', fr: 'Espaces de mémoire', de: 'Speicherbereiche', ru: 'Пространства памяти', pt: 'Espaços de memória' },
  description: { en: 'Provider-backed durable evidence recalled on demand across tasks and sessions.', 'zh-CN': '由 Provider 支撑的持久证据，按需跨任务与会话召回。', ja: 'プロバイダーが保持する永続的な記憶を、タスクやセッションを跨いでオンデマンドに検索。', es: 'Evidencia duradera respaldada por Proveedores, recuperada bajo demanda entre tareas y sesiones.', fr: 'Preuves durables adossées à des Fournisseurs, rappelées à la demande entre tâches et sessions.', de: 'Anbieter-gestützte dauerhafte Belege, die bei Bedarf aufgaben- und sitzungsübergreifend abgerufen werden.', ru: 'Долгосрочные данные на базе Провайдеров, извлекаемые по запросу между задачами и сессиями.', pt: 'Evidências duráveis mantidas por Provedores e recuperadas sob demanda entre tarefas e sessões.' },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.durable-evidence' }],
})

export interface Config extends SourceConfig {
  providers: Array<string | MemorySpaceProviderDeclaration>
}

export const MemorySpaceProviderDeclarationSchema = z.object({
  use: z.string().required(),
  instanceId: z.string(),
  config: z.any(),
}) as unknown as z<MemorySpaceProviderDeclaration>

export const Config = z.intersect([MemorySpacesConfig, z.object({
  providers: z.array(z.union([z.string(), MemorySpaceProviderDeclarationSchema] as const)).default([]),
})]) as unknown as z<Config>

interface LoaderLike {
  locate(fiber?: unknown): string | undefined
  import(specifier: string): Promise<unknown>
  unwrapExports(module: unknown): unknown
}

function sourceInstanceId(ctx: Context, explicit?: string): string {
  const configured = explicit?.trim()
  if (configured !== undefined && configured !== '') return configured
  const loader = ctx.get('loader', false) as LoaderLike | undefined
  const located = loader?.locate(ctx.fiber)?.trim()
  if (located !== undefined && located !== '') return located
  throw new Error('Memory Spaces requires a stable Loader Entry id; pass instanceId for a direct mount')
}

export interface InstallMemorySpacesOptions {
  config?: SourceConfig
  instanceId?: string
}

export interface MemorySpaceProviderDeclaration {
  use: string
  instanceId?: string
  config?: unknown
}

function importedProviderModule(loader: LoaderLike, value: unknown, specifier: string): MemorySpaceProviderModule<unknown> {
  const unwrapped = loader.unwrapExports(value)
  if (typeof unwrapped !== 'object' || unwrapped === null) {
    throw new Error(`Memory Space Provider module ${specifier} did not export a typed child module`)
  }
  return defineMemorySpaceProvider(unwrapped as MemorySpaceProviderModule<unknown>)
}

export async function resolveMemorySpaceProviderEntries(
  ctx: Context,
  declarations: readonly (string | MemorySpaceProviderDeclaration)[],
): Promise<MemorySpaceProviderEntry[]> {
  if (declarations.length === 0) throw new Error('Memory Spaces requires at least one explicit Provider child')
  const loader = ctx.get('loader', false) as LoaderLike | undefined
  const entries: MemorySpaceProviderEntry[] = []
  const instanceIds = new Set<string>()
  for (const declaration of declarations) {
    const use = (typeof declaration === 'string' ? declaration : declaration.use).trim()
    if (use === '') throw new Error('Memory Space Provider declaration use is required')
    if (loader === undefined) throw new Error('cannot resolve installed Memory Space Provider module without the DSH Loader: ' + use)
    const module = importedProviderModule(loader, await loader.import(use), use)
    const entry: MemorySpaceProviderEntry = {
      instanceId: typeof declaration === 'string' ? module.id : declaration.instanceId?.trim() || module.id,
      module,
      config: typeof declaration === 'string' ? undefined : declaration.config,
    }
    if (instanceIds.has(entry.instanceId)) throw new Error(`duplicate Memory Space Provider child: ${entry.instanceId}`)
    instanceIds.add(entry.instanceId)
    entries.push(entry)
  }
  return entries
}

export async function installMemorySpaces(
  ctx: Context,
  entries: readonly MemorySpaceProviderEntry[],
  options: InstallMemorySpacesOptions = {},
): Promise<void> {
  if (entries.length === 0) throw new Error('Memory Spaces requires at least one explicit Provider child')
  const entryId = sourceInstanceId(ctx, options.instanceId)
  resolveMemorySpacesConfig(options.config, entryId)
  const privateHost = new PrivateMemorySpaceProviderHost(entryId)
  const children: Array<ReturnType<typeof ctx.plugin>> = []
  try {
    for (const entry of entries) children.push(ctx.plugin(createMemorySpaceProviderPlugin(entry, privateHost), entry.config))
    await Promise.all(children.map(child => child.await()))
    for (const entry of entries) {
      if (!privateHost.has(entry.instanceId)) throw new Error(`Memory Space Provider child did not install a definition: ${entry.instanceId}`)
    }
    const snapshot = privateHost.snapshot()
    installMemory(ctx, { plugin: memoryPlugin, sources: [createMemorySpacesSource(snapshot, options.config, async reference => {
      const credentials = ctx.get('credentials', false) as { readRecord(key: string): Promise<unknown> } | undefined
      if (credentials === undefined) throw new Error('DSH credentials service is unavailable')
      return credentials.readRecord(reference)
    })] }, {
      instanceId: entryId,
      effectiveDigest: 'providers:' + memoryConfigurationDigest({ providers: snapshot.digest, config: options.config ?? {} }).slice('config:'.length),
    })
  } catch (error) {
    await Promise.allSettled(children.reverse().map(child => child.dispose()))
    throw error
  }
}

function isMarketClientShim(ctx: Context): boolean {
  const loader = ctx.get('loader', false) as LoaderLike | undefined
  return /(?:^|:)mkt-client-[^:]*$/u.test(loader?.locate(ctx.fiber)?.trim() ?? '')
}

export async function apply(ctx: Context, config: Config = { providers: [] }): Promise<void> {
  if (isMarketClientShim(ctx)) return
  const { providers, ...sourceConfig } = config
  await installMemorySpaces(ctx, await resolveMemorySpaceProviderEntries(ctx, providers), { config: sourceConfig })
}

export type * from './contracts.ts'
