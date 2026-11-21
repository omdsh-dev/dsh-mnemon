import type { Context } from '@deepseek-ai/cordis'
import { prepareStarterResolution } from './starter-resolution.ts'

const groupKey = Symbol.for('cordis.group')
const init = Symbol.for('cordis.init')

interface NativeGroup {
  update(config: unknown): Promise<void>
  stop(): void
}
type NativeGroupClass = new (ctx: Context, config: unknown) => NativeGroup
type EntryOptions = { id?: string; name?: string }

async function starterEntries(ctx: Context, config: unknown): Promise<unknown> {
  if (!Array.isArray(config)) return config
  const owner = ctx.fiber as unknown as { entry?: { options: EntryOptions; parent: { data: EntryOptions[]; unlink(options: EntryOptions): void } } }
  if (owner.entry?.options.id !== 'mnemon-bundle') return config
  const profile = ctx.get('profileContext') as import('@deepseek-ai/dsh-app-boot').ProfileContext | undefined
  if (!profile?.startedBundles.some(name => name.startsWith('dsh-mnemon-strategy-'))) return config
  const app = await import('@deepseek-ai/dsh-app-boot')
  const loaded = app.loadProfileDirectory('dsh-mnemon', profile.dir, profile.installAnchor)
  if (!loaded.layers.some(layer => layer.packageName === 'dsh-mnemon')) return config
  const duplicates = loaded.layers.filter(layer => {
    if (!layer.packageName.startsWith('dsh-mnemon-strategy-') || layer.patches.length !== 1) return false
    const patch = layer.patches[0]!
    if (Object.keys(patch).length !== 1 || patch.insert?.length !== 1) return false
    const row = patch.insert[0]!
    return typeof row.id === 'string' && row.disabled === true && Object.keys(row).every(key => ['id', 'name', 'disabled'].includes(key))
      && config.some(child => child.id === row.id && child.name === row.name)
  })
  if (duplicates.length === 0) return config
  const redundant = duplicates.map(layer => layer.packageName)
  const duplicateIds = new Set(duplicates.map(layer => layer.patches[0]!.insert![0]!.id))
  const layers = loaded.layers.filter(layer => !redundant.includes(layer.packageName))
  const rows = app.composeEntries([app.readProfilePatches('dsh-mnemon', profile, { ...loaded, layers })])
  const owners = rows.filter(row => row.id === 'mnemon-bundle' && row.name === 'dsh-mnemon/bundle')
  const bundle = owners[0]
  if (owners.length !== 1 || !Array.isArray(bundle?.config)) return config
  const flatten = (values: typeof rows): typeof rows => values.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])])
  const canonical = flatten(rows)
  if ([...duplicateIds].some(id => canonical.filter(row => row.id === id).length !== 1)) return config
  const manifest = app.readProfileManifest('dsh-mnemon', profile.dir)
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return config
  try {
    app.writeProfileManifest(profile.dir, { ...manifest, dsh: { ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: bundles.filter(name => !redundant.includes(name)) },
    } })
  } catch (error) {
    ctx.logger.warn('Cannot remove redundant Mnemon strategy bundle selections; keep the Starter bundle and deselect %s: %s', redundant.join(', '), String(error))
    return config
  }
  for (const sibling of [...owner.entry.parent.data]) {
    if (sibling.id !== undefined && duplicateIds.has(sibling.id)
      && config.some(child => child.id === sibling.id && child.name === sibling.name)) {
      owner.entry.parent.unlink(sibling)
    }
  }
  return bundle.config
}

export default class MnemonBundle {
  static inject = ['loader']
  static [groupKey] = true

  constructor(private readonly ctx: Context, private readonly config: unknown) {}

  async *[init](): AsyncGenerator<() => void, void, unknown> {
    await prepareStarterResolution(this.ctx)
    const Group = (this.ctx as unknown as { loader?: { builtins?: { group?: NativeGroupClass } } }).loader?.builtins?.group
    if (typeof Group !== 'function') throw new Error('dsh-mnemon/bundle needs the Loader\'s cordis:group builtin')
    const entries = await starterEntries(this.ctx, this.config)
    const group = new Group(this.ctx, entries)
    yield () => group.stop()
    await group.update(entries)
  }
}
