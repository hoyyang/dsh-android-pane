/**
 * adb 命令薄封装：所有设备交互的唯一出口。
 * - run(): execFile + AbortSignal 转发 + 超时（工具取消 → 进程杀掉）
 * - devices(): `devices -l` 解析 + 模拟器识别（emulator-N / 127.0.0.1:N）
 * - shell/push/forward/emu-kill/screencap/uiautomator 等原语
 * 约定：命令失败时抛出点名 adb 与参数的 Error（fail loud，无静默回退）。
 */
import { execFile } from 'node:child_process'

export interface AdbDevice {
  serial: string
  state: string
  model: string | null
  device: string | null
  product: string | null
  isEmulator: boolean
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export class AdbError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`${message} (adb ${args.join(' ')}${code === null ? '' : ` exit=${code}`}${stderr ? ` stderr=${stderr.slice(0, 300)}` : ''})`)
    this.name = 'AdbError'
  }
}

export class Adb {
  constructor(
    private readonly adbPath: string,
    private readonly defaultTimeoutMs = 15_000,
  ) {}

  /** adb 可执行文件路径（供 spawn 场景复用）。 */
  get path(): string {
    return this.adbPath
  }

  /** 执行一条 adb 子命令；signal 取消会 kill 进程。 */
  run(args: readonly string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.adbPath,
        [...args],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL', windowsHide: true },
        (err, stdout, stderr) => {
          if (err != null && typeof (err as NodeJS.ErrnoException).code !== 'string') {
            // execFile 的非退出错误（ENOENT 等）
            reject(new AdbError(`adb 启动失败：${String((err as NodeJS.ErrnoException).code ?? err.message)}`, args, null, String(stderr ?? '')))
            return
          }
          resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        },
      )
      if (opts.signal != null) {
        const onAbort = () => child.kill('SIGKILL')
        if (opts.signal.aborted) onAbort()
        else opts.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /** 期待退出码 0 的 run，否则抛 AdbError。 */
  async runOk(args: readonly string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    const r = await this.run(args, opts)
    if (r.code !== 0) throw new AdbError('adb 命令失败', args, r.code, r.stderr)
    return r.stdout
  }

  async devices(signal?: AbortSignal): Promise<AdbDevice[]> {
    const out = await this.runOk(['devices', '-l'], { signal })
    const list: AdbDevice[] = []
    for (const line of out.split('\n').slice(1)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const parts = trimmed.split(/\s+/)
      if (parts.length < 2) continue
      const serial = parts[0]
      const state = parts[1]
      const kv: Record<string, string> = {}
      for (const p of parts.slice(2)) {
        const i = p.indexOf(':')
        if (i > 0) kv[p.slice(0, i)] = p.slice(i + 1)
      }
      list.push({
        serial,
        state,
        model: kv.model ?? null,
        device: kv.device ?? null,
        product: kv.product ?? null,
        isEmulator: /^emulator-\d+$/.test(serial) || /^127\.0\.0\.1:\d+$/.test(serial),
      })
    }
    return list
  }

  async shell(serial: string, cmd: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    return this.run(['-s', serial, 'shell', cmd], opts)
  }

  async shellOk(serial: string, cmd: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    const r = await this.shell(serial, cmd, opts)
    if (r.code !== 0) throw new AdbError(`设备 shell 失败`, ['-s', serial, 'shell', cmd], r.code, r.stderr)
    return r.stdout
  }

  /** 二进制输出命令（exec-out），返回原始 buffer。 */
  execOutBinary(args: readonly string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.adbPath,
        [...args],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL', encoding: 'buffer' as never, windowsHide: true },
        (err, stdout, stderr) => {
          const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
          if (err != null && (err as { code?: number }).code !== 0 && (err as { code?: number }).code !== undefined) {
            reject(new AdbError('adb exec-out 失败', args, (err as { code?: number }).code ?? null, stderrText))
            return
          }
          resolve(stdout as Buffer)
        },
      )
      if (opts.signal != null) {
        const onAbort = () => child.kill('SIGKILL')
        if (opts.signal.aborted) onAbort()
        else opts.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  async screencap(serial: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
    return this.execOutBinary(['-s', serial, 'exec-out', 'screencap', '-p'], { timeoutMs: opts.timeoutMs ?? 20_000, signal: opts.signal })
  }

  async push(serial: string, local: string, remote: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    await this.runOk(['-s', serial, 'push', local, remote], opts)
  }

  async forward(serial: string, localPort: number, abstractName: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await this.runOk(['-s', serial, 'forward', `tcp:${localPort}`, `localabstract:${abstractName}`], opts)
  }

  async removeForward(serial: string, localPort: number): Promise<void> {
    await this.run(['-s', serial, 'forward', '--remove', `tcp:${localPort}`], { timeoutMs: 5_000 })
  }

  /** 关停模拟器（仅模拟器使用；真机禁用）。 */
  async emuKill(serial: string): Promise<void> {
    await this.run(['-s', serial, 'emu', 'kill'], { timeoutMs: 8_000 })
  }

  /** 设备品牌信息（一次 getprop 批量取回）。 */
  async getDeviceInfo(serial: string, opts: { signal?: AbortSignal } = {}): Promise<{ brand: string; market: string; model: string; type: string }> {
    const fallback = { brand: '', market: '', model: '', type: '手机' }
    try {
      const out = await this.shell(serial, 'getprop ro.product.brand; getprop ro.product.marketname; getprop ro.product.model; getprop ro.build.characteristics', { ...opts, timeoutMs: 6_000 })
      const lines = out.stdout.split('\n').map((l) => l.trim().replace(/\r/g, ''))
      const brand = lines[0] ?? ''
      const market = lines[1] ?? ''
      const model = lines[2] ?? ''
      const chars = (lines[3] ?? '').toLowerCase()
      return { brand, market, model, type: chars.includes('tablet') ? '平板' : '手机' }
    } catch {
      return fallback
    }
  }

  /** 设备物理/覆盖分辨率（`wm size`，如 "Physical size: 1080x2400"）。 */
  async displaySize(serial: string, opts: { signal?: AbortSignal } = {}): Promise<{ w: number; h: number } | null> {
    const out = await this.shell(serial, 'wm size', opts).catch(() => null)
    if (out == null) return null
    const m = /(\d+)x(\d+)/.exec(out.stdout)
    if (m == null) return null
    return { w: Number(m[1]), h: Number(m[2]) }
  }
}

export function isEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+$/.test(serial) || /^127\.0\.0\.1:\d+$/.test(serial)
}
