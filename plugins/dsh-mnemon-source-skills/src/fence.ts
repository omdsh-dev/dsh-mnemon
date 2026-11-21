export interface SplitSkill {
  frontmatter: string
  body: string
  frontmatterStart: number
  frontmatterEnd: number
}

export function splitFrontmatter(raw: string): SplitSkill | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const next = raw.indexOf('\n', lineStart)
    const lineEnd = next < 0 ? raw.length : next
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      return { frontmatter: raw.slice(start, lineStart), body: raw.slice(next < 0 ? raw.length : next + 1), frontmatterStart: start, frontmatterEnd: lineStart }
    }
    if (next < 0) return undefined
    lineStart = next + 1
  }
  return undefined
}
