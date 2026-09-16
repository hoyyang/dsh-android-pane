/**
 * 插件状态：受信设备 + 默认画质。
 * 落盘 <dshHome>/dsh-android-pane/state.json，原子写（tmp+rename），损坏时 fail loud 报错但不炸进程。
 * 无凭据、无敏感数据（设计卡规则 8：隐私红线只涉及提示，不落任何账号信息）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface QualityPrefs {
  /** 视频最大边长（0 = 原生分辨率） */
  maxSize: number
  maxFps: number
  videoBitRate: number
}

export interface PaneState {
  /** 已授权设备序列号（首次 attach 经 DSH 工具审批后记住） */
  trustedDevices: string[]
  quality: QualityPrefs
  updatedAt: string
}

export const DEFAULT_QUALITY: QualityPrefs = { maxSize: 1280, maxFps: 30, videoBitRate: 8_000_000 }

export class PaneStateStore {
  private constructor(
    private readonly file: string,
    private cached: PaneState,
  ) {}

  static open(dir: string): PaneStateStore {
    const file = join(dir, 'state.json')
    let state: PaneState = { trustedDevices: [], quality: { ...DEFAULT_QUALITY }, updatedAt: new Date().toISOString() }
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PaneState>
        state = {
          trustedDevices: Array.isArray(raw.trustedDevices) ? raw.trustedDevices.filter((s) => typeof s === 'string') : [],
          quality: { ...DEFAULT_QUALITY, ...(raw.quality ?? {}) },
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : state.updatedAt,
        }
      } catch (e) {
        throw new Error(`dsh-android-pane 状态文件损坏（${file}）：${String(e).slice(0, 200)}。请删除该文件后重试。`)
      }
    }
    mkdirSync(dir, { recursive: true })
    return new PaneStateStore(file, state)
  }

  get data(): Readonly<PaneState> {
    return this.cached
  }

  isTrusted(serial: string): boolean {
    return this.cached.trustedDevices.includes(serial)
  }

  trust(serial: string): void {
    if (!this.cached.trustedDevices.includes(serial)) {
      this.cached.trustedDevices.push(serial)
      this.flush()
    }
  }

  untrust(serial: string): void {
    this.cached.trustedDevices = this.cached.trustedDevices.filter((s) => s !== serial)
    this.flush()
  }

  setQuality(patch: Partial<QualityPrefs>): QualityPrefs {
    this.cached.quality = { ...this.cached.quality, ...patch }
    this.flush()
    return { ...this.cached.quality }
  }

  private flush(): void {
    this.cached.updatedAt = new Date().toISOString()
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(this.cached, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      try {
        if (existsSync(tmp)) renameSync(tmp, tmp) // no-op 保留现场
      } catch {
        /* ignore */
      }
      throw new Error(`dsh-android-pane 状态写入失败（${this.file}）：${String(e).slice(0, 200)}`)
    }
  }
}
