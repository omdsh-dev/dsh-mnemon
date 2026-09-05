import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDocuments, documentLinks, headingIds, withoutFences } from '../scripts/verify-docs.mjs'

const directories = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'mnemon-docs-test-'))
  directories.push(root)
  for (const [file, text] of Object.entries(files)) { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
  return checkDocuments(root, Object.keys(files))
}

describe('documentation checks', () => {
  it('keeps line numbers while ignoring backtick and tilde fences', () => {
    expect(withoutFences('a\n```md\n[no](missing)\n```\nb\n~~~\nno\n~~~')).toBe('a\n\n\n\nb\n\n\n')
  })
  it('recognizes Unicode, inline code, links and duplicate headings', () => {
    expect([...headingIds('## 设置：`displayMode`\n## A [link](./b.md)\n## A link\n<a id="explicit"></a>')]).toEqual(['设置displaymode', 'a-link', 'a-link-1', 'explicit'])
  })
  it('finds linked images, HTML and reference-style targets without inline-code examples', () => {
    expect(documentLinks('[![x](a.png)](b.md)\n<img src="c.png">\n[x]: d.md\n`[no](missing)`').map(link => link.url).sort()).toEqual(['a.png', 'b.md', 'c.png', 'd.md'])
  })
  it('accepts existing images, directories, encoded paths and local anchors', () => {
    const report = fixture({ 'README.md': '# Home\n[a](#home) [b](./a%20b.md#中文) [c](./dir/) ![d](./dir/a.png)', 'a b.md': '# 中文', 'dir/a.png': 'fixture' })
    expect(report.failures).toEqual([])
    expect(report.anchors).toBe(2)
  })
  it('reports missing files and anchors rather than treating them as external', () => {
    const report = fixture({ 'README.md': '[a](./absent.md)\n[b](./a.md#old)', 'a.md': '# New' })
    expect(report.failures).toEqual(['README.md:1: missing ./absent.md', 'README.md:2: missing anchor ./a.md#old'])
  })
  it('reports malformed encoding and missing translation files', () => {
    const report = fixture({ 'docs/en/page.md': '[bad](./%ZZ.md)' })
    expect(report.failures).toHaveLength(2)
    expect(report.failures[1]).toContain('docs/zh-CN/page.md')
  })
  it('does not make network availability a local documentation requirement', () => {
    expect(fixture({ 'README.md': '[web](https://example.invalid/x#y) [mail](mailto:a@example.invalid)' }).failures).toEqual([])
  })
  it('checks current repository URLs used in npm READMEs without rewriting historical links', () => {
    const report = fixture({ 'README.md': '[ok](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/a.md#one) [missing](https://github.com/omdsh-dev/dsh-mnemon/tree/main/absent) [history](https://github.com/omdsh-dev/dsh-mnemon/blob/v0.4.0/old.md)', 'docs/a.md': '# One' })
    expect(report.localLinks).toBe(2)
    expect(report.failures).toEqual(['README.md:1: missing https://github.com/omdsh-dev/dsh-mnemon/tree/main/absent'])
  })
})
