import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { RecordValue } from 'dsh-mnemon/source-sdk'

export const libraryFields = Object.fromEntries(['name', 'category', 'tag', 'summary'].map(key => [key, { type: 'string', maxLength: 200 }]))
export function filterLibrary(records: RecordValue[], input: { [key: string]: MemoryJsonValue }): RecordValue[] {
  const terms = Object.fromEntries(Object.keys(libraryFields).map(key => {
    const value = input[key]
    if (value !== undefined && (typeof value !== 'string' || value.length > 200)) throw new Error('Invalid playbook filter: ' + key)
    return [key, (value ?? '').toString().trim().toLocaleLowerCase()]
  }))
  return records.filter(record => (!terms.name || record.title.toLocaleLowerCase().includes(terms.name))
    && (!terms.category || String(record.data.category ?? '').toLocaleLowerCase() === terms.category)
    && (!terms.tag || String(record.data.tags ?? '').toLocaleLowerCase().includes(terms.tag))
    && (!terms.summary || String(record.data.summary ?? '').toLocaleLowerCase().includes(terms.summary)))
}
