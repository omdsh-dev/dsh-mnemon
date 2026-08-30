import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { createMemorySpacesSource, MEMORY_SPACES_SOURCE } from './source.ts'
import {
  PrivateMemorySpaceProviderHost,
  defineMemorySpaceProvider,
  type MemorySpaceProviderEntry,
  type MemorySpaceProviderModule,
  type MemorySpaceProviderSnapshot,
} from './providers/host.ts'
import { createMemorySpaceProviderPlugin } from './providers/plugin.ts'
import { MemorySpacesConfig, resolveMemorySpacesConfig, type MemorySpacesConfig as SourceConfig } from './config.ts'

export const name = 'dsh-mnemon-source-memory-spaces'
export const inject = ['mnemonMemory']

export interface Config extends SourceConfig {
  /** Explicit Source-private children; strings retain the bundled-id syntax. */
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
  import?(specifier: string): Promise<unknown>
  unwrapExports?(module: unknown): unknown
}

interface EntryLike {
  options?: { id?: unknown }
}

function sourceInstanceId(ctx: Context, explicit?: string): string {
  const configured = explicit?.trim()
  if (configured !== undefined && configured !== '') return configured
  const loader = typeof ctx.get === 'function' ? ctx.get('loader', false) as LoaderLike | undefined : undefined
  const located = loader?.locate(ctx.fiber)?.trim()
  if (located !== undefined && located !== '') return located
  const entryId = (ctx.fiber as unknown as { entry?: EntryLike }).entry?.options?.id
  if (typeof entryId === 'string' && entryId.trim() !== '') return entryId.trim()
  throw new Error('Memory Spaces requires a stable Loader Entry id; pass instanceId for a direct mount')
}

export interface InstallMemorySpacesOptions {
  config?: SourceConfig
  instanceId?: string
}

export interface MemorySpaceProviderDeclaration {
  /** Bundled logical package name or an installed package specifier. */
  use: string
  /** Stable child identity; defaults to the module type id when omitted. */
  instanceId?: string
  /** Validated by the child module's Cordis Config schema, when supplied. */
  config?: unknown
}

function bundledProviderEntry(use: string, available: readonly MemorySpaceProviderEntry[]): MemorySpaceProviderEntry | undefined {
  const normalized = use.trim()
  const id = normalized.startsWith('dsh-mnemon-provider-')
    ? normalized.slice('dsh-mnemon-provider-'.length)
    : normalized
  return available.find(candidate => candidate.instanceId === id)
}

function importedProviderModule(loader: LoaderLike, value: unknown, specifier: string): MemorySpaceProviderModule<unknown> {
  const unwrapped = loader.unwrapExports?.(value)
    ?? (typeof value === 'object' && value !== null && 'default' in value ? (value as { default: unknown }).default : value)
  if (typeof unwrapped !== 'object' || unwrapped === null) {
    throw new Error(`Memory Space Provider module ${specifier} did not export a typed child module`)
  }
  return defineMemorySpaceProvider(unwrapped as MemorySpaceProviderModule<unknown>)
}

/** Resolve only the explicitly listed children; no dependency scanning occurs. */
export async function resolveMemorySpaceProviderEntries(
  ctx: Context,
  declarations: readonly (string | MemorySpaceProviderDeclaration)[],
  available: readonly MemorySpaceProviderEntry[] = [],
): Promise<MemorySpaceProviderEntry[]> {
  if (declarations.length === 0) throw new Error('Memory Spaces requires at least one explicit Provider child')
  const loader = typeof ctx.get === 'function' ? ctx.get('loader', false) as LoaderLike | undefined : undefined
  const entries: MemorySpaceProviderEntry[] = []
  const instanceIds = new Set<string>()
  for (const declaration of declarations) {
    const use = (typeof declaration === 'string' ? declaration : declaration.use).trim()
    if (use === '') throw new Error('Memory Space Provider declaration use is required')
    const bundled = bundledProviderEntry(use, available)
    let entry: MemorySpaceProviderEntry
    if (bundled !== undefined) {
      if (typeof declaration !== 'string' && declaration.config !== undefined) {
        throw new Error(`bundled Memory Space Provider ${use} does not accept child config`)
      }
      entry = {
        ...bundled,
        instanceId: typeof declaration === 'string' ? bundled.instanceId : declaration.instanceId?.trim() || bundled.instanceId,
      }
    } else {
      if (loader?.import === undefined) throw new Error(`cannot resolve installed Memory Space Provider module without the DSH Loader: ${use}`)
      const module = importedProviderModule(loader, await loader.import(use), use)
      entry = {
        instanceId: typeof declaration === 'string' ? module.id : declaration.instanceId?.trim() || module.id,
        module,
        config: typeof declaration === 'string' ? undefined : declaration.config,
      }
    }
    if (instanceIds.has(entry.instanceId)) throw new Error(`duplicate Memory Space Provider child: ${entry.instanceId}`)
    instanceIds.add(entry.instanceId)
    entries.push(entry)
  }
  return entries
}

/** Compose an explicit Provider child list into one effective Source. */
export async function installMemorySpaces(
  ctx: Context,
  entries: readonly MemorySpaceProviderEntry[],
  options: InstallMemorySpacesOptions = {},
): Promise<MemorySpaceProviderSnapshot> {
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
    installMemory(ctx, { sources: [createMemorySpacesSource(snapshot, options.config)] }, {
      instanceId: entryId,
      effectiveDigest: 'providers:' + memoryConfigurationDigest({ providers: snapshot.digest, config: options.config ?? {} }).slice('config:'.length),
    })
    return snapshot
  } catch (error) {
    await Promise.allSettled(children.reverse().map(child => child.dispose()))
    throw error
  }
}

export async function apply(ctx: Context, config: Config = { providers: [] }): Promise<void> {
  const { providers, ...sourceConfig } = config
  await installMemorySpaces(ctx, await resolveMemorySpaceProviderEntries(ctx, providers), { config: sourceConfig })
}

export { MEMORY_SPACES_SOURCE }

export { createMemorySpacesSource } from './source.ts'
export { MemorySpacesService } from './service.ts'
export { MemoryBodyRegistry } from './memory-bodies.ts'
export { createRunner } from './runner.ts'
export { resolveMemorySpacesConfig, MemorySpacesConfig } from './config.ts'
export type { ResolvedMemorySpacesConfig } from './config.ts'
export type * from './contracts.ts'
