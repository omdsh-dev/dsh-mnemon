import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../src/host/process.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

function subprocess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn((signal: string) => { child.signalCode = signal; return true }),
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  return child
}

describe('bounded subprocess UTF-8 output', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('escalates to SIGKILL after grace timeout when a real child process ignores SIGTERM', async () => {
    const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    let spawned: ReturnType<typeof realSpawn> | undefined
    vi.mocked(spawn).mockImplementationOnce(((command: string, args: readonly string[], options: object) => {
      spawned = realSpawn(command, args as string[], options)
      return spawned
    }) as unknown as typeof spawn)

    const script = 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'
    await expect(
      runProcess(process.execPath, ['-e', script], { timeoutMs: 80, killGraceMs: 60, label: 'hung-child' }),
    ).rejects.toThrow('hung-child did not respond within 80ms')

    expect(spawned).toBeDefined()
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        spawned?.kill('SIGKILL')
        reject(new Error('SIGTERM-ignoring child was not terminated by SIGKILL within grace window'))
      }, 2_000)
      if (spawned!.exitCode !== null || spawned!.signalCode !== null) {
        clearTimeout(timer)
        resolve({ code: spawned!.exitCode, signal: spawned!.signalCode })
        return
      }
      spawned!.once('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal })
      })
    })
    // Windows lacks POSIX signal trapping, so child.kill('SIGTERM') invokes TerminateProcess immediately.
    expect(closed.signal).toBe(process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL')
    expect(() => process.kill(spawned!.pid!, 0)).toThrow()
  })

  it('escalates from SIGTERM to SIGKILL after killGraceMs when the subprocess stays open', async () => {
    vi.useFakeTimers()
    try {
      const child = subprocess()
      child.kill.mockImplementation((signal: string) => {
        if (signal === 'SIGKILL') child.signalCode = 'SIGKILL'
        return true
      })
      const rejected = expect(
        runProcess('test-cli', [], { timeoutMs: 80, killGraceMs: 60, label: 'hung-child' }),
      ).rejects.toThrow('hung-child did not respond within 80ms')

      await vi.advanceTimersByTimeAsync(80)
      await rejected
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenLastCalledWith('SIGTERM')

      await vi.advanceTimersByTimeAsync(59)
      expect(child.kill).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(child.kill).toHaveBeenCalledTimes(2)
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
      child.emit('close', null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves interleaved stdout and stderr even when every multibyte character is split', async () => {
    const child = subprocess()
    const stdout = '{"content":"配置键为 backend.rule.4，验证端口为 12004。𠮷"}\n'
    const stderr = '错误信息：保留原文 𠀀\n'
    const out = Buffer.from(stdout)
    const err = Buffer.from(stderr)
    const result = runProcess('test-cli', [], { timeoutMs: 1000, maxOutputBytes: out.length + err.length })
    expect(spawn).toHaveBeenCalledWith('test-cli', [], expect.objectContaining({ windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }))
    for (let index = 0; index < Math.max(out.length, err.length); index++) {
      if (index < out.length) child.stdout.emit('data', out.subarray(index, index + 1))
      if (index < err.length) child.stderr.emit('data', err.subarray(index, index + 1))
    }
    child.exitCode = 0
    child.emit('close', 0)
    expect(await result).toEqual({ stdout, stderr, exitCode: 0 })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('still bounds combined raw bytes, including incomplete UTF-8 sequences', async () => {
    const child = subprocess()
    const result = runProcess('test-cli', [], { timeoutMs: 1000, maxOutputBytes: 2 })
    const rejected = expect(result).rejects.toThrow('mnemon output exceeded 2 bytes')
    const character = Buffer.from('中')
    child.stdout.emit('data', character.subarray(0, 1))
    child.stderr.emit('data', character.subarray(0, 1))
    child.stdout.emit('data', character.subarray(1, 2))
    await rejected
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', null)
  })

  it('flushes a truncated final character independently on each stream at close', async () => {
    const child = subprocess()
    const result = runProcess('test-cli', [], { timeoutMs: 1000 })
    child.stdout.emit('data', Buffer.from('中').subarray(0, 2))
    child.stderr.emit('data', Buffer.from('𠀀').subarray(0, 3))
    child.exitCode = 1
    child.emit('close', 1)
    expect(await result).toEqual({ stdout: '�', stderr: '�', exitCode: 1 })
  })
})
