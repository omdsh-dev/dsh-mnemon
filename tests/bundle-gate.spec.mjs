import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const patch = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: expression => expression }],
})
const [{ insert: [{ disabled: expression }] }] = patch
const entrySymbol = Symbol.for('cordis.entry')

function disabled(bundle, entries) {
  return runInNewContext(expression, {
    ctx: { [entrySymbol]: bundle },
    loader: { entries: () => entries.values() },
  })
}

it('uses the native bundle core boolean flag', () => {
  const subgroup = {}
  const bundle = { options: { id: 'mnemon-bundle' }, subgroup }
  const core = { options: { id: 'mnemon', disabled: true }, parent: subgroup }

  expect(disabled(bundle, [core])).toBe(true)
  core.options.disabled = false
  expect(disabled(bundle, [core])).toBe(false)
})

it('evaluates the core in its owning bundle when its entry has a prefix', () => {
  const subgroup = {}
  const bundle = { options: { id: 'workspace-mnemon-bundle' }, subgroup }
  const child = { options: { id: 'workspace-mnemon-source-runtime' }, parent: { ctx: { fiber: { entry: bundle } } } }
  const other = { options: { id: 'mnemon', disabled: false }, parent: {} }
  const evaluate = vi.fn(() => true)
  const core = { options: { id: 'workspace-mnemon', disabled: { __jsExpr: 'enabled' } }, parent: subgroup, evaluate }

  expect(disabled(child, [other, core])).toBe(true)
  expect(evaluate).toHaveBeenCalledWith('enabled')
})

it('ignores unrelated entries while the owning core is being created', () => {
  const bundle = { options: { id: 'mnemon-bundle' }, subgroup: {} }
  const other = { options: { id: 'mnemon', disabled: true }, parent: {} }
  expect(disabled(bundle, [other])).toBe(false)
})
