/** Host-owned preferences and successful capture registry; atomic tmp + rename. */
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface QualityPrefs {
  maxSize: number
  maxFps: number
  videoBitRate: number
}
export interface CaptureOutput {
  id: string
  type: 'screenshot' | 'record' | 'debug'
  files: string[]
  at: number
  error?: string
  identities: Array<{ dev: number; ino: number }>
}
export interface DebugClock { minOffsetMs: number; maxOffsetMs: number }
/** One sampler round trip may bound the offset to ±1ms; both sides enforce this same ceiling. */
export const MAX_CLOCK_WIDTH_MS = 1000
export interface PendingCapture {
  id: string
  type: 'record' | 'debug'
  serial: string
  dir: string
  startedAt: number
  stoppedAt?: number
  error?: string
  captureError?: string
  remote?: string
  logRemote?: string
  clockStart?: DebugClock
  clockEnd?: DebugClock
  segments?: Array<{ remote: string; startEpoch: number; endEpoch?: number }>
  actions?: Array<{ t: number; endedAt?: number; action: string; detail?: string }>
}
function validPending(job: PendingCapture): boolean {
  if (!job || typeof job.id !== 'string' || !/^(record|dbg)-[0-9a-f-]{36}$/.test(job.id) || !['record', 'debug'].includes(job.type) || typeof job.serial !== 'string' || !job.serial || typeof job.dir !== 'string' || !isAbsolute(job.dir) || job.dir.includes('\0') || !Number.isFinite(job.startedAt)) return false
  if (job.stoppedAt != null && !Number.isFinite(job.stoppedAt)) return false
  for (const clock of [job.clockStart, job.clockEnd]) if (clock != null && (!Number.isFinite(clock.minOffsetMs) || !Number.isFinite(clock.maxOffsetMs) || clock.maxOffsetMs < clock.minOffsetMs || clock.maxOffsetMs - clock.minOffsetMs > MAX_CLOCK_WIDTH_MS)) return false
  if (job.type === 'record') return job.remote === '/data/local/tmp/dsh_' + job.id + '.mp4'
  return job.logRemote === '/data/local/tmp/dsh_' + job.id + '-logcat.log' && Array.isArray(job.segments) && job.segments.every((seg, i) => seg && seg.remote === '/data/local/tmp/dsh_' + job.id + '_' + i + '.mp4' && Number.isFinite(seg.startEpoch) && (seg.endEpoch == null || Number.isFinite(seg.endEpoch))) && Array.isArray(job.actions) && job.actions.every(a => a && Number.isFinite(a.t) && (a.endedAt == null || (Number.isFinite(a.endedAt) && a.endedAt >= a.t)) && typeof a.action === 'string' && (a.detail == null || typeof a.detail === 'string'))
}
export interface PaneState {
  trustedDevices: string[]
  quality: QualityPrefs
  updatedAt: string
  directory: string
  outputs: CaptureOutput[]
  pending: PendingCapture[]
  volumeRestore: Record<string, number>
}
export const DEFAULT_QUALITY: QualityPrefs = { maxSize: 1280, maxFps: 30, videoBitRate: 8_000_000 }

/** No relative/device/browser paths. Probe the actual host directory before committing a preference. */
export function validateCaptureDirectory(directory: string): string {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) {
    throw Object.assign(new Error('保存目录必须是宿主电脑的绝对路径'), { code: 'bad-request' })
  }
  const canonical = realpathSync(directory)
  if (!lstatSync(canonical).isDirectory()) throw new Error('目录不是文件夹：' + directory)
  const probe = join(canonical, '.dsh-write-' + randomUUID())
  try { writeFileSync(probe, '', { flag: 'wx', mode: 0o600 }) }
  finally { try { unlinkSync(probe) } catch { /* Failed creation leaves nothing to remove. */ } }
  return canonical
}

export class PaneStateStore {
  private constructor(private readonly file: string, private cached: PaneState) {}

  static open(dir: string): PaneStateStore {
    const file = join(dir, 'state.json')
    let raw: Partial<PaneState> = {}
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PaneState>
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('状态须为 JSON 对象')
    }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('dsh-android-pane 状态文件损坏（' + file + '）：' + String(e))
    }
    if (raw.pending != null && (!Array.isArray(raw.pending) || !raw.pending.every(validPending))) throw new Error('dsh-android-pane 待保存清单损坏；保留原件并修复 state.json 后重试')
    if (raw.volumeRestore != null && (typeof raw.volumeRestore !== 'object' || Array.isArray(raw.volumeRestore) || Object.values(raw.volumeRestore).some(v => !Number.isSafeInteger(v) || v < 0))) throw new Error('dsh-android-pane 音量还原状态损坏')
    const state: PaneState = {
      pending: raw.pending ?? [],
      volumeRestore: raw.volumeRestore ?? {},
      trustedDevices: Array.isArray(raw.trustedDevices) ? raw.trustedDevices.filter(s => typeof s === 'string') : [],
      quality: { ...DEFAULT_QUALITY, ...(raw.quality ?? {}) },
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      directory: typeof raw.directory === 'string' && isAbsolute(raw.directory) ? raw.directory : resolve(dir, 'shots'),
      // Old state upgrades without moving/deleting old shots or granting arbitrary file previews.
      outputs: Array.isArray(raw.outputs) ? raw.outputs.filter(o => o && typeof o.id === 'string' && ['screenshot', 'record', 'debug'].includes(o.type) && Array.isArray(o.files) && o.files.every(f => typeof f === 'string' && isAbsolute(f)) && Array.isArray(o.identities) && o.identities.length === o.files.length) : [],
    }
    mkdirSync(dir, { recursive: true })
    return new PaneStateStore(file, state)
  }

  get data(): Readonly<PaneState> { return this.cached }
  reload(): Readonly<PaneState> { this.cached = PaneStateStore.open(dirname(this.file)).cached; return this.cached }
  isTrusted(serial: string): boolean { return this.cached.trustedDevices.includes(serial) }
  trust(serial: string): void {
    if (!this.isTrusted(serial)) this.flush({ trustedDevices: [...this.cached.trustedDevices, serial] })
  }
  untrust(serial: string): void { this.flush({ trustedDevices: this.cached.trustedDevices.filter(s => s !== serial) }) }
  setQuality(patch: Partial<QualityPrefs>): QualityPrefs {
    this.flush({ quality: { ...this.cached.quality, ...patch } })
    return { ...this.cached.quality }
  }
  setDirectory(directory: string): string {
    const validated = validateCaptureDirectory(directory)
    this.flush({ directory: validated })
    return validated
  }
  upsertPending(job: PendingCapture): void {
    if (!validPending(job)) throw new Error('无效待保存采集清单')
    const pending = PaneStateStore.open(dirname(this.file)).data.pending.filter(p => p.id !== job.id)
    this.flush({ pending: [...pending, job] })
  }
  setVolumeRestore(serial: string, value?: number): void {
    const volumeRestore = { ...PaneStateStore.open(dirname(this.file)).data.volumeRestore }
    if (value == null) delete volumeRestore[serial]
    else volumeRestore[serial] = value
    this.flush({ volumeRestore })
  }
  registerOutput(id: string, type: CaptureOutput['type'], files: string[], error?: string): void {
    const identities = files.map(file => {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.size === 0 || realpathSync(file) !== file) throw new Error('保存文件无效：' + file)
      return { dev: stat.dev, ino: stat.ino }
    })
    const output = { id, type, files: [...files], at: Date.now(), identities, ...(error ? { error } : {}) }
    const latest = PaneStateStore.open(dirname(this.file)).data
    this.flush({ pending: latest.pending.filter(job => job.id !== id), outputs: [...latest.outputs.filter(o => o.id !== id), output] })
  }
  private flush(patch: Partial<PaneState>): void {
    // A retiring hub may still finish volume restoration; merge only changed fields from disk.
    const tmp = this.file + '.' + randomUUID() + '.tmp'
    try {
      const next: PaneState = { ...PaneStateStore.open(dirname(this.file)).data, ...patch, updatedAt: new Date().toISOString() }
      writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 })
      renameSync(tmp, this.file)
      this.cached = next // Failed persistence never changes the in-memory preference/registry.
    } catch (e) {
      try { unlinkSync(tmp) } catch { /* no temp file */ }
      throw new Error('dsh-android-pane 状态写入失败（' + this.file + '）：' + String(e))
    }
  }
}
