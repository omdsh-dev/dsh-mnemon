import { allowedDirectories, readBoundedFile, resolveRipgrepPath, runBoundedProcess, digest } from 'dsh-mnemon/source-sdk'
import type { VisibleMessage } from 'dsh-mnemon-workspace-kit/dsh'
import { resolve } from 'node:path'

export interface ImportedSession { id: string; path: string; cwd?: string; messages: VisibleMessage[]; malformed: number }
/** Parse message-bearing JSONL records; tool calls, reasoning and system records never enter the transcript. */
export function parseImportedSession(text: string, path: string): ImportedSession {
  let cwd: string | undefined, malformed = 0
  const messages: VisibleMessage[] = [], fallback: VisibleMessage[] = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    if (line.length > 1024 * 1024) { malformed++; continue }
    let row: any
    try { row = JSON.parse(line) } catch { malformed++; continue }
    if (!row || typeof row !== 'object') { malformed++; continue }
    if (row.type === 'session_meta' && typeof row.payload?.cwd === 'string') cwd = resolve(row.payload.cwd)
    const payload = row.type === 'response_item' ? row.payload : row.type === 'message' ? row : null
    const at = typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : '1970-01-01T00:00:00.000Z'
    if (payload?.type === 'message' && ['user', 'assistant'].includes(payload.role) && payload.channel !== 'analysis') {
      const content = Array.isArray(payload.content) ? payload.content.flatMap((block: any) => ['input_text', 'output_text', 'text'].includes(block?.type) && typeof block.text === 'string' ? [block.text] : []).join('\n') : typeof payload.content === 'string' ? payload.content : ''
      if (content.trim()) messages.push({ seq: index + 1, role: payload.role, text: content, at })
    } else if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(row.payload?.type) && typeof row.payload.message === 'string') {
      fallback.push({ seq: index + 1, role: row.payload.type === 'user_message' ? 'user' : 'assistant', text: row.payload.message, at })
    }
  }
  return { id: 'imported-' + digest(path).slice(0, 24), path, ...(cwd ? { cwd } : {}), messages: messages.length ? messages : fallback, malformed }
}
export async function importedSessions(roots: string[], workspaceId: string | undefined, signal: AbortSignal, rgPath?: string): Promise<{ sessions: ImportedSession[]; truncated: boolean }> {
  if (!roots.length) return { sessions: [], truncated: false }
  const allowed = await allowedDirectories(roots)
  const listing = await runBoundedProcess(await resolveRipgrepPath(rgPath), ['--no-config', '--files', '--null', '--glob', '*.jsonl', '--', ...allowed], { signal, maxBytes: 256 * 1024 })
  if (listing.code !== 0 && listing.code !== 1 && !listing.truncated) throw new Error('Imported session discovery failed')
  const files = listing.stdout.split('\0').filter(Boolean).sort().reverse()
  const sessions: ImportedSession[] = []
  let skipped = false
  for (const file of files.slice(0, 300)) {
    signal.throwIfAborted()
    try {
      const session = parseImportedSession((await readBoundedFile(allowed, file, 8 * 1024 * 1024, signal)).toString('utf8'), file)
      if (workspaceId && session.cwd === resolve(workspaceId)) sessions.push(session)
    } catch (error) { signal.throwIfAborted(); skipped = true }
  }
  return { sessions, truncated: listing.truncated || files.length > 300 || skipped }
}
