import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsCss = readFileSync(new URL('../src/client/MnemonSettingsCard.module.css', import.meta.url), 'utf8')

describe('Settings layout invariants', () => {
  it('anchors visually hidden controls to their visible cards and switches', () => {
    expect(settingsCss).toContain('.providerToggle { display: inline-flex; position: relative; cursor: pointer; }')
    expect(settingsCss).toContain('.choiceCard { display: block; position: relative; min-width: 0; cursor: pointer; }')
    expect(settingsCss).toContain('.toggleRow {\n  display: flex;\n  position: relative;')
  })

  it('keeps the added enhancement controls compact in a host-constrained mobile column', () => {
    expect(settingsCss).toContain('.enhancementsSection { container-type: inline-size; }')
    expect(settingsCss).toContain('@container (max-width: 180px)')
    expect(settingsCss).toContain('.enhancementsSection .settingCopy small { display: none; }')
    expect(settingsCss).toContain('.enhancementsSection .switch { justify-self: end; }')
  })
})
