import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sidebarCss = readFileSync(new URL('../src/client/MnemonSidebarView.module.css', import.meta.url), 'utf8')
const workspaceCss = readFileSync(new URL('../src/client/MnemonWorkspace.module.css', import.meta.url), 'utf8')
const viewCss = readFileSync(new URL('../src/client/MnemonView.module.css', import.meta.url), 'utf8')
const memoryPluginCss = readFileSync(new URL('../src/client/MemoryPluginDialog.module.css', import.meta.url), 'utf8')

const sidebarSurface = 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base))'

describe('Sidebar layout invariants', () => {
  it('keeps the workspace surfaces opaque under transparent-base skins with a default-theme fallback', () => {
    expect(viewCss).toContain('--mn-bg: var(--dsw-alias-bg-base);')
    expect(viewCss).toContain('--mn-backdrop: var(--dsw-alias-bg-overlay, var(--mn-bg));')
    expect(viewCss).toContain('--mn-surface: linear-gradient(var(--mn-bg), var(--mn-bg)), linear-gradient(var(--mn-backdrop), var(--mn-backdrop)) var(--mn-bg);')
    expect(sidebarCss).toContain('.shell.shell {\n  background: var(--mn-surface);')
    expect(workspaceCss).toContain(`background: ${sidebarSurface};`)
  })

  it('keeps the sidebar artifact launcher-only and never hides DSH conversation content', () => {
    expect(workspaceCss).toContain('.entry {')
    expect(workspaceCss).toContain('.workspacePanel > * {')
    expect(workspaceCss).toContain('width: 100%;')
    expect(workspaceCss).toContain('flex: 1 1 auto;')
    expect(workspaceCss).not.toContain('[data-dsh-mnemon-view]')
    expect(workspaceCss).not.toContain('data-dsh-mnemon-active')
    expect(workspaceCss).not.toContain('.dshDesktopConversationSurface')
  })

  it('pins primary page headers at the canvas origin without an initial sticky settling distance', () => {
    expect(sidebarCss).toContain(".shell .canvas[data-lock-page-header] [class*='pageHeader'] {\n  position: sticky;\n  z-index: 12;\n  top: 0;")
    expect(sidebarCss).not.toContain("top: -14px")
  })

  it('keeps the connected label visible in the compact Sidebar header', () => {
    expect(sidebarCss).toContain(".shell .statusCluster > span:not([class*='statusDot']) { display: inline; }")
  })

  it('keeps DSH as the only sidebar and preserves the established Mnemon tab strip', () => {
    expect(viewCss).toContain('.workspace { display: flex; min-height: 0; flex: 1; flex-direction: column; }')
    expect(viewCss).toContain('.topNavigation { display: flex;')
    expect(sidebarCss).toContain('.shell .topNavigation {\n  min-height: 0;')
    expect(sidebarCss).toContain('border-bottom-color: var(--dsw-alias-state-business-primary);')
    expect(viewCss).not.toContain('.sideNavigation')
    expect(sidebarCss).not.toContain('.sideNavigation')
  })

  it('keeps plugin composition dense on desktop and single-column on narrow dialogs', () => {
    expect(memoryPluginCss).toContain('.strategyGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));')
    expect(memoryPluginCss).toContain('@media (max-width: 680px)')
    expect(memoryPluginCss).toContain('.sourceGrid, .strategyGrid { grid-template-columns: minmax(0, 1fr); }')
  })

  it('renders runtime metadata as real chips while keeping form values at normal weight', () => {
    expect(sidebarCss).toContain(".shell [class*='runtimeEntryBadges'] > span {")
    expect(sidebarCss).toContain('border-radius: 999px;')
    expect(sidebarCss).toContain(".shell [class*='runtimeEntryBadges'] > [class*='runtimeEntryTarget'] {")
    expect(sidebarCss).toContain(".shell textarea { font-family: var(--dsw-font-family); font-size: 13px; font-weight: 400; }")
    expect(sidebarCss).toContain('.shell select { cursor: pointer; font-weight: 400; }')
  })

  it('keeps memory-space footer blocks aligned and safely truncatable', () => {
    expect(sidebarCss).toContain(".shell [class*='bodyGrid'] {\n  grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));")
    expect(sidebarCss).toContain('grid-template-columns: minmax(0, 1fr) max-content;')
    expect(sidebarCss).toContain(".shell .bodyCardFooter {\n  display: grid;")
    expect(sidebarCss).toContain('white-space: nowrap;')
    expect(sidebarCss).toContain(".shell .bodyCardStats {\n  display: flex;\n  min-width: 0;\n  flex-wrap: nowrap;")
    expect(sidebarCss).toContain('  overflow: hidden;')
  })
})
