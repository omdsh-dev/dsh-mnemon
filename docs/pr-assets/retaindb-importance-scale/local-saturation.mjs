// What RetainDB Local 0.2.2 stores as importance for the Source's importance 1 to 5, on main and with the fix,
// for a few texts of rising richness. RetainDB Local stores
//   clamp(importance + quality * 0.28 + typeWeight * 0.12, 0.1, 0.99)
// so richer texts reach the 0.99 cap at lower importances. The quality, type and weight rules below are
// transcribed from RetainDB/RetainDB@2ad2cc4d (Apache-2.0) packages/local/src/cli.ts: lines 73-95, 117-119,
// 145-171, 173-201 (the fallback), 302-324 and 728. A single-line text keeps its wording through durableContent.
// The first text is the live probe's; its values match what RetainDB Local stored in the live run.
//   node docs/pr-assets/retaindb-importance-scale/local-saturation.mjs [out.json]
import { writeFileSync } from 'node:fs'

const WEIGHT = {
  decision: 0.78, constraint: 0.75, preference: 0.72, instruction: 0.68, workflow: 0.7, solution: 0.72, correction: 0.66,
  relationship: 0.58, opinion: 0.48, goal: 0.62, project_state: 0.56, factual: 0.42, semantic: 0.42, session_summary: 0.45, event: 0.18,
}
const LOW_SIGNAL_PATTERNS = [
  /^\s*(ok|okay|thanks|thank you|done|yes|no|hi|hello)\s*[.!?]*\s*$/i,
  /^(read|list|open|show)\s+file$/i,
  /^session_(start|end|idle) captured$/i,
]
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const tokenize = text => text.toLowerCase().match(/[a-z0-9_./-]{2,}/g) || []
const uniqueTokens = text => Array.from(new Set(tokenize(text)))
const normalizeMemoryText = text => String(text || '').trim().replace(/\s+/g, ' ')
  .replace(/^(prompt|message|event|session_start|session_end|tool_result|post_tool_use|pre_tool_use|user asked|agent responded)\s*:\s*/i, '').trim()

function signalQuality(text) {
  const trimmed = text.trim()
  const normalized = normalizeMemoryText(trimmed)
  if (!trimmed) return 0
  if (LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(normalized || trimmed))) return 0.05
  const value = normalized || trimmed
  const tokens = uniqueTokens(value)
  const hasCodePath = /\b[\w.-]+\/[\w./-]+\b|\b[\w.-]+\.(ts|tsx|js|jsx|py|rs|go|md|json|toml|yaml|yml)\b/i.test(value)
  const hasDecision = /\b(decided|decision|prefer|preference|use|avoid|because|constraint|fixed|root cause|regression|todo|next|deploy|test|auth|rate limit|schema|migration|standardize|chosen|picked)\b/i.test(value)
  const hasOutcome = /\b(pass|passed|fail|failed|error|resolved|implemented|created|updated|removed|blocked|deprecated|superseded)\b/i.test(value)
  const hasStructure = /[:;]|\b(before|after|when|if|then|because|instead|so that)\b/i.test(value)
  const noisy = /\b(console\.log|stack trace|node_modules|dist\/|build\/|coverage\/)\b/i.test(value)
  return clamp(0.12 + Math.min(tokens.length, 80) / 120 + (hasCodePath ? 0.18 : 0) + (hasDecision ? 0.25 : 0) + (hasOutcome ? 0.18 : 0) + (hasStructure ? 0.08 : 0) - (noisy ? 0.12 : 0))
}

// The Provider sends no type RetainDB Local knows for the Source's default category, so its fallback is factual.
function inferMemoryType(content) {
  const text = normalizeMemoryText(content)
  if (/\b(error|failed|failing|root cause|regression|bug|deprecated|correct(ed|ion)|supersedes?|wrong|broken)\b/i.test(text)) return 'correction'
  if (/\b(fixed|resolved|solution|solved|accepted fix)\b/i.test(text)) return 'solution'
  if (/\b(prefer|prefers|preference|likes|wants|style|tone)\b/i.test(text)) return 'preference'
  if (/\b(must|must not|should|should not|cannot|can't|avoid|required|requirement|constraint|never|always)\b/i.test(text)) return 'constraint'
  if (/\b(decided|decision|chose|chosen|picked|standardize|standardized|settled on|use\b|uses\b|switch(ed)? to)\b/i.test(text)) return 'decision'
  if (/\b(goal|todo|next step|plan|roadmap|milestone|target|need to|should ship)\b/i.test(text)) return 'goal'
  if (/\b(command|workflow|steps?|run|deploy|release|test|build|install|before|after|procedure|playbook)\b/i.test(text)) return 'workflow'
  if (/\b(always|when asked|format|respond|write|include|omit)\b/i.test(text)) return 'instruction'
  if (/\b(reports to|works with|partner|manager|teammate|customer|vendor|depends on)\b/i.test(text)) return 'relationship'
  if (/\bsummary|handoff|session ended\b/i.test(content)) return 'session_summary'
  return 'factual'
}

const sentOnMain = importance => importance
const sentWithFix = importance => Math.round((0.7 + (importance - 3) * 0.1) * 100) / 100
const texts = [
  'Release step one: check the changelog before tagging the version',
  'The user prefers concise answers in Chinese.',
  'Use pnpm 10 for installs because npm breaks the lockfile in CI.',
  'We decided to keep plain chunk retrieval and only add semantic signal where information is lost; the hybrid test passed on LoCoMo and LME.',
  'Never push to main without a reviewed PR; the release workflow in .github/workflows/publish.yml must pass first.',
]
const rows = texts.map(text => {
  const quality = signalQuality(normalizeMemoryText(text))
  const type = inferMemoryType(text)
  const bonus = quality * 0.28 + (WEIGHT[type] || 0.3) * 0.12
  const stored = send => [1, 2, 3, 4, 5].map(importance => Number(clamp(send(importance) + bonus, 0.1, 0.99).toFixed(3)))
  return { text, type, quality: Number(quality.toFixed(3)), bonus: Number(bonus.toFixed(3)), main: stored(sentOnMain), fix: stored(sentWithFix) }
})
const live = rows[0].fix
if (live[0] !== 0.661 || live[2] !== 0.861 || live[4] !== 0.99) throw new Error(`transcription no longer matches the live run: ${live}`)
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(rows, null, 2)}\n`)
for (const row of rows) console.log(`${row.type.padEnd(10)} quality ${row.quality.toFixed(3)} bonus ${row.bonus.toFixed(3)}  main ${row.main.join(' ')}  fix ${row.fix.join(' ')}  ${row.text.slice(0, 50)}`)
