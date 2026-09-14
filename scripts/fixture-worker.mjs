#!/usr/bin/env node
// Local synthetic adapter used only by the isolated validation profile.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const prompt = process.argv[2] ?? '', resumed = process.argv[3]?.startsWith('--') ? undefined : process.argv[3]
console.log(JSON.stringify({ session_id: resumed || 'fixture-session', resumed: Boolean(resumed) }))
console.log('Fixture prompt: ' + prompt)
for (let index = 3; index < process.argv.length; index++) if (process.argv[index] === '--image' && process.argv[index + 1]) {
  const bytes = await readFile(process.argv[++index]); console.log(JSON.stringify({ imageBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))
}
if (prompt.includes('[fail]')) { console.error('Requested fixture failure'); process.exitCode = 7 }
else if (prompt.includes('[wait]')) { console.log('Waiting for cancellation'); setInterval(() => {}, 1000) }
else console.log('Fixture task completed. No external service was contacted.')
