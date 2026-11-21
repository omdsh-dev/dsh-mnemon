import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { machineLabelValid, MNEMON_MACHINE_LABEL_MAX, type MnemonMachineIdentity, type MnemonMachineLabelSource } from './protocol.ts'
import type { StorageRoot } from './storage-root.ts'

export const MNEMON_MACHINE_DIRECTORY = 'state'
export const MNEMON_MACHINE_FILE = 'machine.json'
const MNEMON_MACHINE_VERSION = 1

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function defaultMachineLabel(): string {
  const name = hostname().trim()
  const label = name === '' ? 'this machine' : name
  return label.length > MNEMON_MACHINE_LABEL_MAX ? label.slice(0, MNEMON_MACHINE_LABEL_MAX) : label
}

export function machineLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : ''
  if (!machineLabelValid(label)) throw new Error('machine name must be 1 to ' + String(MNEMON_MACHINE_LABEL_MAX) + ' characters on one line')
  return label
}

export interface MnemonMachineRecord {
  identity: MnemonMachineIdentity
  source: MnemonMachineLabelSource
}

export class MnemonMachineStore {
  private readonly root: string

  constructor(runner: Pick<StorageRoot, 'effectiveDataDir'>) {
    this.root = resolve(runner.effectiveDataDir())
  }

  directory(): string {
    return join(this.root, MNEMON_MACHINE_DIRECTORY)
  }

  path(): string {
    return join(this.directory(), MNEMON_MACHINE_FILE)
  }

  read(): MnemonMachineIdentity {
    return this.current().identity
  }

  current(): MnemonMachineRecord {
    const stored = this.stored()
    if (stored === undefined) return this.write({ id: randomUUID(), label: defaultMachineLabel(), createdAt: new Date().toISOString() }, 'hostname')
    if (stored.source === 'hostname') {
      const label = defaultMachineLabel()
      if (stored.identity.label !== label || !stored.marked) return this.write({ ...stored.identity, label }, 'hostname')
    } else if (!stored.marked) {
      return this.write(stored.identity, 'custom')
    }
    return { identity: stored.identity, source: stored.source }
  }

  rename(value: unknown): MnemonMachineRecord {
    const label = value === null || value === '' ? undefined : machineLabel(value)
    const identity = this.current().identity
    return label === undefined
      ? this.write({ ...identity, label: defaultMachineLabel() }, 'hostname')
      : this.write({ ...identity, label }, 'custom')
  }

  private stored(): (MnemonMachineRecord & { marked: boolean }) | undefined {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.path(), 'utf8')) as unknown
    } catch {
      return undefined
    }
    const parsed = record(value)
    if (parsed?.version !== MNEMON_MACHINE_VERSION) return undefined
    if (typeof parsed.id !== 'string' || parsed.id.trim() === '') return undefined
    if (typeof parsed.label !== 'string' || parsed.label.trim() === '') return undefined
    if (typeof parsed.createdAt !== 'string') return undefined
    const identity = { id: parsed.id, label: parsed.label, createdAt: parsed.createdAt }
    if (parsed.labelSource === 'hostname' || parsed.labelSource === 'custom') return { identity, source: parsed.labelSource, marked: true }
    return { identity, source: parsed.label === defaultMachineLabel() ? 'hostname' : 'custom', marked: false }
  }

  private write(identity: MnemonMachineIdentity, source: MnemonMachineLabelSource): MnemonMachineRecord {
    mkdirSync(this.directory(), { recursive: true, mode: 0o700 })
    const temporary = `${this.path()}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: MNEMON_MACHINE_VERSION, ...identity, labelSource: source }, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.path())
    } finally {
      rmSync(temporary, { force: true })
    }
    return { identity, source }
  }
}
