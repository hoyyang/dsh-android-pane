/**
 * PaneHub：设备/认领/串流/操作的中枢。
 * 规则落地点（设计卡）：
 *  - 设备独占（规则2）：claims 单属主，冲突明确报错；
 *  - 人机互斥提示（规则3）：agent 每次操作刷新 busyUntil，路由暴露给 UI 亮徽标；
 *  - 闲置回收（规则4）：10 分钟无活动 → 释放认领 + 停流；模拟器额外 emu kill，真机仅断开；
 *  - 资源上限（规则7）：每会话 4 路、全局 8 路；
 *  - 降级（规则6/MVP）：scrcpy 启动失败 → 该设备进入 poll 模式（截图轮播），注入走 adb input；
 *  - 隐私（规则8）：截图只落 <dshHome>/dsh-android-pane/shots，路径透明。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, type WriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { Adb, isEmulatorSerial, type AdbDevice } from './adb.js'
import { PaneStateStore, type QualityPrefs } from './state.js'
import { ACTION_DOWN, ACTION_MOVE, ACTION_UP, StreamSession } from './scrcpy-host.js'
import { extractSecureState, HINT_DISABLE_FLAG_SECURE, type MitigateResult, type MitigateStep, type SecureFocus } from './flag-secure.js'

export interface DebugSegment {
  remote: string
  local?: string
  startEpoch: number
  endEpoch?: number
}
export interface DebugAct {
  t: number
  action: string
  detail?: string
}
export interface DebugSession {
  id: string
  serial: string
  mode: 'human' | 'agent'
  startedAt: number
  stoppedAt?: number
  segments: DebugSegment[]
  recordProc: ChildProcess | null
  logProc: ChildProcess | null
  logRing: string[]
  logRingBytes: number
  errFile: string
  errStream: WriteStream | null
  acts: DebugAct[]
  segIndex: number
  shortRotations: number
  rotateTimer: NodeJS.Timeout | null
  dir: string
}
export interface DebugSummary {
  id: string
  serial: string
  mode: 'human' | 'agent'
  startedAt: number
  durationMs: number
  mp4s: string[]
  errFile: string
  acts: number
}
export interface DebugAnalysis {
  id: string
  serial: string
  durationMs: number
  timeline: string[]
  frames: Array<{ file: string; label: string; t: number; kind: 'pre' | 'post' | 'sample' }>
  logSlices: string[]
  errorLines: string[]
  logTail: string[]
  mp4s: string[]
  errFile: string
}

export interface ClaimInfo {
  serial: string
  sessionId: string
  claimedAt: number
  lastActivityAt: number
}

export interface DeviceView {
  serial: string
  state: string
  model: string | null
  isEmulator: boolean
  claimedBy: string | null
  busy: boolean
  mode: 'h264' | 'poll' | null
}

export interface ActRequest {
  action: 'tap' | 'swipe' | 'key' | 'text' | 'scroll' | 'back' | 'home' | 'recents' | 'volume_up' | 'volume_down' | 'rotate'
  serial?: string
  x?: number
  y?: number
  x2?: number
  y2?: number
  durationMs?: number
  key?: string
  text?: string
}

const KEYCODE: Record<string, number> = {
  back: 4,
  home: 3,
  recents: 187,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  enter: 66,
  tab: 61,
  esc: 111,
  del: 67,
  move_end: 123,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
}

export class PaneHub {
  private devicesCache: AdbDevice[] = []
  private devicesAt = 0
  private readonly claims = new Map<string, ClaimInfo>()
  private readonly streams = new Map<string, StreamSession>()
  private readonly modes = new Map<string, 'h264' | 'poll'>()
  private readonly streamErrors = new Map<string, string>()
  private readonly busyUntil = new Map<string, number>()
  private readonly pollSince = new Map<string, number>()
  private readonly records = new Map<string, { proc: ChildProcess; file: string }>()
  private readonly deviceInfo = new Map<string, { brand: string; market: string; model: string; type: string }>()
  /** attach 时切换到 ADBKeyboard 前的原输入法（detach 时还原） */
  private readonly prevIme = new Map<string, string>()
  private readonly seenDetached = new Set<string>()
  private reaperTimer: ReturnType<typeof setInterval> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  /** dispose 竞态守卫（B22b）：start 在途的会话集合——dispose 时一并 stop，防孤儿 server 占编码器 */
  private readonly pendingStarts = new Set<StreamSession>()
  /** FLAG_SECURE（B22）：焦点窗口 SECURE 位缓存 / 检测与缓解链在-flight / root 能力缓存 */
  private readonly secureStates = new Map<string, SecureFocus>()
  private readonly secureInflight = new Map<string, Promise<SecureFocus>>()
  private readonly mitigateInflight = new Map<string, Promise<MitigateResult>>()
  private readonly lastMitigate = new Map<string, MitigateResult>()
  private readonly rootProbe = new Map<string, { buildType: string; su: boolean; framework: string | null; at: number }>()
  private secureTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly adb: Adb,
    private readonly state: PaneStateStore,
    private readonly opts: {
      jarPath: string
      shotsDir: string
      log: (msg: string) => void
      idleDetachMs: number
      maxPerSession: number
      globalMax: number
      autoBootEmulator: boolean
      flagSecureCheck: boolean
      emulatorBin?: string
    },
  ) {
    mkdirSync(this.opts.shotsDir, { recursive: true })
  }

  startTimers(): void {
    this.refreshTimer = setInterval(() => {
      void this.refreshDevices().catch(() => {
        /* adb 不在时静默，devices 查询会报最新错误 */
      })
    }, 2_000)
    this.reaperTimer = setInterval(() => {
      void this.reapIdle()
    }, 30_000)
    // FLAG_SECURE 识别轮询（B22）：只查「正在被观看/认领」的设备；2.5s 节流 + per-device 在-flight 去重
    if (this.opts.flagSecureCheck) {
      this.secureTimer = setInterval(() => {
        const serials = new Set<string>()
        for (const [serial, st] of this.streams) if (st.running) serials.add(serial)
        for (const serial of this.claims.keys()) serials.add(serial)
        for (const [serial, m] of this.modes) if (m === 'poll') serials.add(serial)
        for (const serial of serials) void this.checkSecure(serial).catch(() => undefined)
      }, 2_500)
    }
  }

  private async refreshDevices(): Promise<AdbDevice[]> {
    const list = await this.adb.devices()
    for (const d of list) {
      if (!this.deviceInfo.has(d.serial) && !d.isEmulator) {
        void this.adb.getDeviceInfo(d.serial).then((i) => this.deviceInfo.set(d.serial, i)).catch(() => undefined)
      }
    }
    this.devicesCache = list
    this.devicesAt = Date.now()
    // 设备消失时清认领与流
    const online = new Set(list.map((d) => d.serial))
    for (const serial of [...this.claims.keys()]) {
      if (!online.has(serial)) {
        this.claims.delete(serial)
        this.streams.get(serial)?.stop()
        this.streams.delete(serial)
        this.modes.delete(serial)
      }
    }
    return list
  }

  private async ensureDevices(): Promise<AdbDevice[]> {
    if (Date.now() - this.devicesAt > 2_000) await this.refreshDevices()
    return this.devicesCache
  }

  async listDevices(): Promise<{ devices: DeviceView[]; quality: QualityPrefs }> {
    const list = await this.ensureDevices()
    const now = Date.now()
    const devices: DeviceView[] = list.map((d) => {
      const info = this.deviceInfo.get(d.serial)
      const brand = info?.brand || d.model || d.serial
      const market = info?.market || ''
      const type = info?.type ?? '手机'
      const dedupMarket = market && brand && market.toLowerCase().startsWith(brand.toLowerCase()) ? market.slice(brand.length).trim() : market
      // B22d：brand/market/model 全空或同串时避免「25080RABDC 25080RABDC」式重复
      const parts = [brand, dedupMarket, d.model ?? ''].map((x) => x.trim()).filter((x) => x !== '')
      const uniq = [...new Set(parts)]
      const name = d.isEmulator
        ? `模拟器 ${d.model ?? d.serial}`
        : `${uniq.join(' ') || d.serial}（${type}）`
      return {
        serial: d.serial,
        state: d.state,
        model: d.model,
        isEmulator: d.isEmulator,
        claimedBy: this.claims.get(d.serial)?.sessionId ?? null,
        busy: (this.busyUntil.get(d.serial) ?? 0) > now,
        mode: this.modes.get(d.serial) ?? null,
        name: name.replace(/\s+/g, ' ').trim(),
      }
    })
    return { devices, quality: { ...this.state.data.quality } }
  }

  async sessionState(): Promise<{ claims: ClaimInfo[]; busy: Record<string, boolean>; streamErrors: Record<string, string>; debug: Record<string, { id: string; startedAt: number; mode: string }>; secure: Record<string, { secure: boolean; pkg: string | null; checkedAt: number; captureVisible?: boolean; lastMitigate: MitigateResult | null }> }> {
    const now = Date.now()
    const busy: Record<string, boolean> = {}
    for (const [serial, until] of this.busyUntil) busy[serial] = until > now
    const errors: Record<string, string> = {}
    for (const [serial, err] of this.streamErrors) errors[serial] = err
    const debug: Record<string, { id: string; startedAt: number; mode: string }> = {}
    for (const sess of this.debugSessions.values()) {
      if (sess.stoppedAt == null) debug[sess.serial] = { id: sess.id, startedAt: sess.startedAt, mode: sess.mode }
    }
    const secure: Record<string, { secure: boolean; pkg: string | null; checkedAt: number; captureVisible?: boolean; lastMitigate: MitigateResult | null }> = {}
    for (const [serial, info] of this.secureStates) {
      secure[serial] = { secure: info.secure, pkg: info.pkg, checkedAt: info.checkedAt, captureVisible: info.captureVisible, lastMitigate: this.lastMitigate.get(serial) ?? null }
    }
    return { claims: [...this.claims.values()], busy, streamErrors: errors, debug, secure }
  }

  /** 工具 attach（agent 路径）：DSH 工具审批 = 首次授权点，创建会话级认领。 */
  async attachForTool(sessionId: string, serial: string | undefined, signal?: AbortSignal): Promise<{
    serial: string
    model: string | null
    isEmulator: boolean
    mode: 'h264' | 'poll'
    size: { w: number; h: number } | null
    deviceName: string | null
    screenshotPath: string | null
    streamError: string | null
  }> {
    const devices = await this.ensureDevices()
    let target: AdbDevice | undefined
    if (serial == null || serial === '') {
      const online = devices.filter((d) => d.state === 'device')
      if (online.length === 0) throw new Error('没有在线设备（`adb devices` 为空）。请插入真机（开 USB 调试）或启动模拟器。')
      if (online.length > 1) {
        throw new Error(`检测到 ${online.length} 台设备，请指定 serial：${online.map((d) => d.serial).join(', ')}`)
      }
      target = online[0]
    } else {
      target = devices.find((d) => d.serial === serial)
      if (target == null) {
        if (isEmulatorSerial(serial)) throw new Error(`模拟器 ${serial} 当前不在线。可在面板设备菜单里启动，或先在 Android Studio 里启动它。`)
        throw new Error(`设备 ${serial} 不在线（adb devices 无此设备）。`)
      }
      if (target.state !== 'device') throw new Error(`设备 ${serial} 状态为 ${target.state}（ unauthorized 需在手机上确认 USB 调试授权）`)
    }
    const s = target.serial
    // human 模式调试进行中：AI 认领会 locks 面板并干扰操作序列 → 拒绝
    const dbgId = this.debugBySerial.get(s)
    if (dbgId != null) {
      const dbg = this.debugSessions.get(dbgId)
      if (dbg != null && dbg.stoppedAt == null && dbg.mode === 'human') {
        throw new Error(`调试会话进行中（人操作模式，${dbg.id}）——AI 请勿认领；结束调试会话后再 attach`)
      }
    }
    const existing = this.claims.get(s)
    if (existing != null && existing.sessionId !== sessionId) {
      throw new Error(`设备 ${s} 已被会话 ${existing.sessionId} 认领（设计规则：一台设备同时只归一个会话）。请先让该会话 detach，或换一台设备。`)
    }

    // 资源上限（规则7）
    const mine = [...this.claims.values()].filter((c) => c.sessionId === sessionId).length
    if (existing == null && mine >= this.opts.maxPerSession) {
      throw new Error(`本会话已认领 ${mine} 台设备（上限 ${this.opts.maxPerSession}），请先 detach。`)
    }
    if (existing == null && this.claims.size >= this.opts.globalMax) {
      throw new Error(`全局已认领 ${this.claims.size} 台设备（上限 ${this.opts.globalMax}）。`)
    }

    // 首次授权：走到这里的 attach 已经过 DSH 工具审批（或用户面板手动操作），记住设备
    this.state.trust(s)

    // 亮屏 + 解锁键盘（连接即点亮——熄屏/锁屏会让一切交互无效，实测教训）
    await this.adb.shell(s, 'input keyevent KEYCODE_WAKEUP', { signal, timeoutMs: 5_000 }).catch(() => undefined)
    await this.adb.shell(s, 'wm dismiss-keyguard', { signal, timeoutMs: 5_000 }).catch(() => undefined)

    // 中文输入前置：会话期间切到 ADBKeyboard（⚠️ 必须在点输入框之前切——后切会丢焦点，实测教训）
    if (!s.startsWith('emulator')) {
      const ime = await this.imeStatus(s, signal).catch(() => ({ installed: false, current: '' }))
      if (ime.installed && ime.current !== 'com.android.adbkeyboard/.AdbIME') {
        await this.adb.shellOk(s, 'ime set com.android.adbkeyboard/.AdbIME', { signal, timeoutMs: 8_000 }).catch(() => undefined)
        this.prevIme.set(s, ime.current)
        this.opts.log(`[${s}] IME → ADBKeyboard（原: ${ime.current}）`)
      }
    }

    // 串流：优先 h264，失败降级 poll（规则6/MVP）
    const mode = await this.ensureStream(s, signal)
    const streamError: string | null = mode === 'poll' ? (this.streamErrors.get(s) ?? 'poll 模式（此前 scrcpy 启动失败）') : null
    const meta = this.streams.get(s)?.info ?? null
    const size: { w: number; h: number } | null = meta != null ? { w: meta.streamWidth, h: meta.streamHeight } : null
    const deviceName: string | null = meta?.deviceName || null

    const claimedAt = existing?.claimedAt ?? Date.now()
    this.claims.set(s, { serial: s, sessionId, claimedAt, lastActivityAt: Date.now() })
    this.seenDetached.delete(s)
    void this.checkSecure(s, signal).catch(() => undefined) // B22: attach 即检，横幅最迟 2.5s 内出现
    const shot = await this.saveScreenshot(s, signal).catch(() => null)
    return { serial: s, model: target.model, isEmulator: target.isEmulator, mode, size, deviceName, screenshotPath: shot, streamError }
  }

  /** 面板 attach（观察者路径）：用户手势即授权；只确保串流在跑，不创建认领、不与 agent 抢设备。 */
  async attachViewer(serial: string, signal?: AbortSignal): Promise<{
    serial: string
    model: string | null
    isEmulator: boolean
    mode: 'h264' | 'poll'
    size: { w: number; h: number } | null
    streamError: string | null
  }> {
    const devices = await this.ensureDevices()
    const target = devices.find((d) => d.serial === serial)
    if (target == null) throw new Error(`设备 ${serial} 不在线`)
    if (target.state !== 'device') throw new Error(`设备 ${serial} 状态为 ${target.state}（unauthorized 需在手机上确认 USB 调试授权）`)
    const s = target.serial
    if (!s.startsWith('emulator')) {
      await this.adb.shell(s, 'input keyevent KEYCODE_WAKEUP', { signal, timeoutMs: 5_000 }).catch(() => undefined)
      await this.adb.shell(s, 'wm dismiss-keyguard', { signal, timeoutMs: 5_000 }).catch(() => undefined)
      const ime = await this.imeStatus(s, signal).catch(() => ({ installed: false, current: '' }))
      if (ime.installed && ime.current !== 'com.android.adbkeyboard/.AdbIME') {
        await this.adb.shellOk(s, 'ime set com.android.adbkeyboard/.AdbIME', { signal, timeoutMs: 8_000 }).catch(() => undefined)
        this.prevIme.set(s, ime.current)
      }
    }
    await this.ensureStream(s, signal)
    void this.checkSecure(s, signal).catch(() => undefined) // B22: 观察路径同检
    const meta = this.streams.get(s)?.info ?? null
    return {
      serial: s,
      model: target.model,
      isEmulator: target.isEmulator,
      mode: this.modes.get(s) ?? 'h264',
      size: meta != null ? { w: meta.streamWidth, h: meta.streamHeight } : null,
      streamError: this.streamErrors.get(s) ?? null,
    }
  }

  private ensuring = new Map<string, Promise<'h264' | 'poll'>>()

  /** 每设备最近一次成功流的坐标系（流↔物理），供 adb 兜底路径换算（adb input 只认物理坐标）。 */
  private lastDims = new Map<string, { sw: number; sh: number; dw: number; dh: number }>()

  private adbPoint(s: string, x: number, y: number): { x: number; y: number } {
    const d = this.lastDims.get(s)
    if (d != null && d.sw > 0 && d.sh > 0 && d.dw > 0 && d.dh > 0) {
      return {
        x: Math.max(0, Math.min(d.dw - 1, Math.round(x * d.dw / d.sw))),
        y: Math.max(0, Math.min(d.dh - 1, Math.round(y * d.dh / d.sh))),
      }
    }
    return { x, y }
  }

  /** /stream 订阅前保证可解码：重放缓存缺 config/IDR（溢出裁剪后）→ 重启会话换新关键帧。 */
  async ensureDecodableStream(s: string, signal?: AbortSignal): Promise<void> {
    const session = this.streams.get(s)
    if (session == null || !session.running) return // 无会话/已死：交给 attach/ensureStream 路径处理
    if (session.replayDecodable()) return
    try { (await import('node:fs')).appendFileSync('/tmp/dap-route.log', `${new Date().toISOString()} restart-for-decodability serial=${s}\n`) } catch { /* ignore */ }
    this.opts.log(`[${s}] 重放缓存不可解码（缺 config/IDR）→ 重启串流会话`)
    session.stop()
    this.streams.delete(s)
    this.modes.delete(s)
    await this.ensureStream(s, signal)
  }

  /** 设备保护保险丝：会话启动频率上限（每设备 60s 内 ≤6 次）。超限 → 拒绝再拉起，防 app_process/
   *  MediaCodec 高频 churn 伤设备（实测教训：粗暴对待 app_process 可致系统不稳/设备重启）。
   *  超限期间返回 'poll'（正常降级），冷却后自动恢复。 */
  private startTimes = new Map<string, number[]>()
  private static readonly FUSE_WINDOW_MS = 60_000
  private static readonly FUSE_MAX_STARTS = 6

  private fuseOpen(s: string): boolean {
    const now = Date.now()
    const times = (this.startTimes.get(s) ?? []).filter((t) => now - t < PaneHub.FUSE_WINDOW_MS)
    this.startTimes.set(s, times)
    return times.length >= PaneHub.FUSE_MAX_STARTS
  }

  /** 确保 h264 串流在跑（per-device 互斥：并发调用共享同一次启动，防双 server 冲突）。 */
  private async ensureStream(s: string, signal?: AbortSignal): Promise<'h264' | 'poll'> {
    const inflight = this.ensuring.get(s)
    if (inflight != null) return inflight
    const p = this.ensureStreamInner(s, signal).finally(() => this.ensuring.delete(s))
    this.ensuring.set(s, p)
    return p
  }

  private async ensureStreamInner(s: string, signal?: AbortSignal): Promise<'h264' | 'poll'> {
    // 冷却机制已移除（互斥防风暴；显式 attach/act 必须总是尝试恢复——否则自愈被挡，实测教训）
    let session = this.streams.get(s)
    if (session == null || !session.running) {
      // 保险丝：只在「需要新启动」时计数，健康流复用不计
      if (this.fuseOpen(s)) {
        this.opts.log(`[${s}] 会话重启保险丝熔断（60s 内 >6 次启动）→ 本分钟内降级 poll，保护设备`)
        this.modes.set(s, 'poll')
        this.pollSince.set(s, Date.now())
        this.streamErrors.set(s, '会话重启过频（设备保护保险丝），稍后自动恢复')
        return 'poll'
      }
      const times = this.startTimes.get(s) ?? []
      times.push(Date.now())
      this.startTimes.set(s, times)
      try {
        session = new StreamSession(this.adb.path, s, this.opts.jarPath, this.state.data.quality, this.opts.log)
        // dispose 与 start 竞态（B22b）：在途会话登记，dispose 会 stop 它，防孤儿 server
        this.pendingStarts.add(session)
        let meta: Awaited<ReturnType<StreamSession['start']>>
        try {
          meta = await session.start(signal)
        } finally {
          this.pendingStarts.delete(session)
        }
        this.lastDims.set(s, { sw: meta.streamWidth, sh: meta.streamHeight, dw: session.displayDim.w, dh: session.displayDim.h })
        session.onDead((reason) => {
          this.streamErrors.set(s, reason)
          this.streams.delete(s)
          this.modes.delete(s)
        })
        this.streams.set(s, session)
        this.streamErrors.delete(s)
        this.modes.delete(s)
        this.pollSince.delete(s)
        void meta
        return 'h264'
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e)
        this.opts.log(`[${s}] scrcpy 启动失败，降级 poll 模式：${msg}`)
        session?.stop()
        this.modes.set(s, 'poll')
        this.pollSince.set(s, Date.now())
        this.streamErrors.set(s, msg)
        return 'poll'
      }
    }
    return 'h264'
  }

  /** 面板强制解锁：人显式接管（记录原因；被锁会话的下一次操作会收到「未被认领」并需重新 attach）。 */
  forceRelease(serial: string): { released: boolean; note: string } {
    if (this.claims.get(serial) == null) return { released: false, note: '该设备未被认领' }
    this.releaseClaim(serial, '面板强制解锁（人工接管）')
    return { released: true, note: '已强制释放认领锁——原会话下次操作需重新 attach' }
  }

  detach(sessionId: string | null, serial: string): { released: boolean } {
    const claim = this.claims.get(serial)
    if (claim == null) return { released: false }
    if (sessionId != null && claim.sessionId !== sessionId) {
      throw new Error(`设备 ${serial} 由会话 ${claim.sessionId} 认领，无权从会话 ${sessionId} 释放。`)
    }
    this.releaseClaim(serial, 'manual detach')
    return { released: true }
  }

  private releaseClaim(serial: string, reason: string): void {
    this.restoreIme(serial)
    this.claims.delete(serial)
    this.seenDetached.add(serial)
    const stream = this.streams.get(serial)
    if (stream != null) {
      // 规则4：detach 后流保留由 reaper 在闲置期后回收；这里先停流（省资源），模拟器由 reaper 判断关机
      stream.stop()
      this.streams.delete(serial)
    }
    this.modes.delete(serial)
    const rec = this.records.get(serial)
    if (rec != null) void this.stopRecord(serial).catch(() => undefined)
    this.opts.log(`[${serial}] claim released: ${reason}`)
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now()
    for (const [serial, claim] of [...this.claims]) {
      if (now - claim.lastActivityAt > this.opts.idleDetachMs) {
        const isEmu = isEmulatorSerial(serial)
        this.releaseClaim(serial, `闲置 ${Math.round(this.opts.idleDetachMs / 60000)} 分钟`)
        if (isEmu) {
          // 模拟器关机（规则4）；失败不致命
          await this.adb.emuKill(serial).catch(() => undefined)
        }
      }
    }
    for (const [serial, stream] of [...this.streams]) {
      if (!this.claims.has(serial)) {
        // 有活跃观看者的流不回收（面板 viewer 不创建 claim，但正在被观看）
        if (stream.hasActiveViewer()) continue
        stream.stop()
        this.streams.delete(serial)
        this.modes.delete(serial)
      }
    }
  }

  getStream(serial: string): StreamSession | null {
    return this.streams.get(serial) ?? null
  }

  getMode(serial: string): 'h264' | 'poll' | null {
    return this.modes.get(serial) ?? null
  }

  // ───────────────── FLAG_SECURE 识别与缓解（B22） ─────────────────

  /** 焦点窗口 SECURE 位检测（dumpsys window windows → 解析）。2.5s 定时器 + attach 即检共用；在-flight 去重。 */
  async checkSecure(serial: string, signal?: AbortSignal): Promise<SecureFocus> {
    const inflight = this.secureInflight.get(serial)
    if (inflight != null) return inflight
    const p = (async (): Promise<SecureFocus> => {
      // ⚠️ 实测（Android 17/HyperOS）：`dumpsys window windows`（列表子命令）不含 mCurrentFocus 行；
      // 焦点行只在不带子命令的 `dumpsys window` 里（含窗口列表 + 焦点，单一命令拿全两种信息）
      const r = await this.adb.shell(serial, 'dumpsys window', { signal, timeoutMs: 12_000 }).catch(() => null)
      const info: SecureFocus =
        r != null && r.code === 0 && r.stdout.length > 200
          ? extractSecureState(r.stdout)
          : { secure: false, pkg: null, activity: null, focusTitle: null, source: 'none', checkedAt: Date.now() }
      this.secureStates.set(serial, info)
      // B22f：进入 FLAG_SECURE 页面（episode 开始）→ 实证一次截图通道可见性（零副作用），
      // 可见即不显示横幅（画面本就可看）；离开页面清标记（下一 episode 重测）
      if (info.secure && info.captureVisible === undefined) {
        const cap = await this.probeCaptureVisible(serial, signal).catch(() => ({ visible: false, metric: 'probe-failed' }))
        info.captureVisible = cap.visible
        this.secureStates.set(serial, info)
        this.opts.log(`[${serial}] FLAG_SECURE 页面截图通道实测: ${cap.visible ? '可见' : '黑帧'}（${cap.metric}）`)
      }
      if (!info.secure) info.captureVisible = undefined
      return info
    })().finally(() => this.secureInflight.delete(serial))
    this.secureInflight.set(serial, p)
    return p
  }

  secureInfo(serial: string): SecureFocus | null {
    return this.secureStates.get(serial) ?? null
  }

  /** root 能力探测（60s 缓存）：构建类型 / su / Magisk|LSPosed 框架。只探测，绝不执行提权。 */
  private async probeRootCapability(serial: string, signal?: AbortSignal): Promise<{ buildType: string; su: boolean; framework: string | null }> {
    const cached = this.rootProbe.get(serial)
    if (cached != null && Date.now() - cached.at < 60_000) return cached
    const bt = (await this.adb.shell(serial, 'getprop ro.build.type', { signal, timeoutMs: 6_000 }).catch(() => ({ stdout: '', code: 1 }))).stdout.trim()
    const su = (await this.adb.shell(serial, 'command -v su', { signal, timeoutMs: 6_000 }).catch(() => ({ stdout: '', code: 1 }))).code === 0
    const pkgs = (
      await this.adb.shell(serial, 'pm list packages 2>/dev/null | grep -iE "magisk|lsposed|edxposed" || true', { signal, timeoutMs: 15_000 }).catch(() => ({ stdout: '', code: 1 }))
    ).stdout.trim()
    const framework = /magisk/i.test(pkgs) ? 'Magisk' : /lsposed|edxposed/i.test(pkgs) ? 'LSPosed/EdXposed' : pkgs !== '' ? pkgs.split('\n')[0] : null
    const v = { buildType: bt === '' ? 'unknown' : bt, su, framework }
    this.rootProbe.set(serial, { ...v, at: Date.now() })
    return v
  }

  /** userdebug/eng：adb root（必须带 -s——多设备在线时裸 `adb root` 直接 exit 1，实测教训；
   *  adbd 重启后 id -u 重试确认）。保留原始输出用于 fail loud。user 构建绝不调用。 */
  private async tryAdbRoot(serial: string, signal?: AbortSignal): Promise<{ ok: boolean; note: string }> {
    const r = await this.adb
      .run(['-s', serial, 'root'], { signal, timeoutMs: 15_000 })
      .catch((e: unknown) => ({ code: -1, stdout: '', stderr: String(e instanceof Error ? e.message : e).slice(0, 160) }))
    if (r.code !== 0) {
      return { ok: false, note: `adb root 失败（exit=${r.code}）: ${(r.stderr || r.stdout || '无输出').slice(0, 160)}` }
    }
    for (let i = 0; i < 8; i++) {
      await new Promise((res) => setTimeout(res, 1_200))
      const id = await this.adb.shell(serial, 'id -u', { signal, timeoutMs: 6_000 }).catch(() => null)
      if (id != null && id.code === 0 && id.stdout.trim() === '0') return { ok: true, note: 'adbd 已 root（还原: adb unroot）' }
    }
    return { ok: false, note: 'adb root 已执行但 8 次重试内 id -u 非 0（adbd 未切 root，设备策略可能限制）' }
  }

  /** 串流重启（缓解链内用）：停旧会话 → 等编码器释放 → 重新拉起。 */
  private async restartStream(serial: string, signal?: AbortSignal): Promise<void> {
    const session = this.streams.get(serial)
    session?.stop()
    this.streams.delete(serial)
    this.modes.delete(serial)
    await new Promise((res) => setTimeout(res, 1_200))
    await this.ensureStream(serial, signal).catch(() => undefined)
  }

  /** B22d：实测截图通道可见性（原始帧缓冲采样）。双机校准：黑帧 distinct≈47/top2≈100%，
   *  内容帧 distinct 211-256/top2≤95%。零副作用：不改 root 态、不动流。 */
  private async probeCaptureVisible(serial: string, signal?: AbortSignal): Promise<{ visible: boolean; metric: string }> {
    const buf = await this.adb.execOutBinary(['-s', serial, 'exec-out', 'screencap'], { signal, timeoutMs: 20_000 }).catch(() => null)
    if (buf == null || buf.length < 100_000) return { visible: false, metric: 'capture-failed' }
    const hist = new Array<number>(256).fill(0)
    let n = 0
    for (let i = 12; i < buf.length; i += 89) {
      hist[buf[i]]++
      n++
    }
    hist.sort((a, b) => b - a)
    const top2 = (hist[0] + hist[1]) / n
    let distinct = 0
    for (const c of hist) if (c > 0) distinct++
    return { visible: distinct >= 100 && top2 <= 0.97, metric: `distinct=${distinct},top2=${Math.round(top2 * 100)}%` }
  }

  /** 缓解链（用户点「尝试显示」触发）。B22d 实证版：
   *  ① 无 root 态实测截图通道（零副作用）→ 可见即切快照流（部分 userdebug 机器 screencap 不受 FLAG_SECURE 限制）
   *  ② 不可见且 userdebug/eng → adb root 后复测 → 可见即【保持 root】+ 快照流（绝不无谓 unroot）
   *  ③ 全部不可见 → （试过 root 则还原）→ 降级内容通道。判定全部基于像素实测，不以 FLAG 位推断。 */
  async secureMitigate(serial: string, signal?: AbortSignal): Promise<MitigateResult> {
    const inflight = this.mitigateInflight.get(serial)
    if (inflight != null) return inflight
    const p = (async (): Promise<MitigateResult> => {
      const steps: MitigateStep[] = []
      let rootApplied = false
      // ① 实测截图通道（零副作用）——部分机器（尤其 userdebug）screencap 不受 FLAG_SECURE 限制
      const uid = (await this.adb.shell(serial, 'id -u', { signal, timeoutMs: 6_000 }).catch(() => ({ stdout: '', code: 1 }))).stdout.trim()
      const uidNote = uid === '0' ? 'adbd=root' : 'adbd=shell'
      let cap = await this.probeCaptureVisible(serial, signal)
      if (cap.visible) {
        steps.push({ step: '截图通道', status: 'ok', detail: `实测本机 screencap 不受 FLAG_SECURE 限制（${cap.metric}，${uidNote}）` })
      } else {
        steps.push({ step: '截图通道', status: 'skipped', detail: `screencap 为黑帧（${cap.metric}，${uidNote}）——尝试 adb root 路径` })
        const probe = await this.probeRootCapability(serial, signal)
        if (probe.buildType === 'user' || probe.buildType === 'unknown') {
          steps.push({ step: 'adb root', status: 'skipped', detail: `ro.build.type=${probe.buildType}——adb root 仅对 userdebug/eng 设备可用（生产构建 adbd 拒绝 root），跳过` })
        } else {
          const root = await this.tryAdbRoot(serial, signal)
          if (root.ok) {
            rootApplied = true
            steps.push({ step: 'adb root', status: 'ok', detail: `ro.build.type=${probe.buildType} → ${root.note}` })
            cap = await this.probeCaptureVisible(serial, signal)
            if (cap.visible) {
              steps.push({ step: 'root 截图通道', status: 'ok', detail: `root 态 screencap 实测可见（${cap.metric}）——adbd 保持 root（还原: adb unroot）` })
            } else {
              steps.push({ step: 'root 截图通道', status: 'failed', detail: `root 态 screencap 仍为黑帧（${cap.metric}）——root 无增益` })
            }
          } else {
            steps.push({ step: 'adb root', status: 'failed', detail: `ro.build.type=${probe.buildType} 但 ${root.note}` })
          }
        }
      }
      const pixelPossible = cap.visible
      if (pixelPossible) {
        // B22f：可见即无需任何模式切换——H.264（root 态）或截图通道本就直出内容，横幅自动隐藏
        steps.push({ step: '判定', status: 'ok', detail: '像素可见（实证）——画面保持当前通道实时显示，横幅不再提示' })
      } else {
        if (rootApplied) {
          const ur = await this.adb.run(['-s', serial, 'unroot'], { signal, timeoutMs: 15_000 }).catch(() => null)
          if (ur != null && ur.code === 0) {
            await new Promise((res) => setTimeout(res, 2_000))
            await this.restartStream(serial, signal).catch(() => undefined)
            steps.push({ step: '还原', status: 'ok', detail: 'adb unroot 已执行——root 对本场景无增益，设备回到原状态' })
          } else {
            steps.push({ step: '还原', status: 'failed', detail: 'adb unroot 失败——如需还原请手动执行 adb unroot' })
          }
        }
        // root 框架提示（仅像素不可见时模块路线才有意义）
        const probe2 = await this.probeRootCapability(serial, signal)
        if (probe2.framework != null) {
          steps.push({ step: 'root 框架', status: 'hint', detail: `${probe2.framework}——${HINT_DISABLE_FLAG_SECURE}` })
        } else if (probe2.su) {
          steps.push({ step: 'root 框架', status: 'hint', detail: '存在 su 但未检测到 Magisk/LSPosed——像素级镜像需 DisableFlagSecure 类模块（Zygisk/LSPosed）。本插件绝不代装模块。' })
        } else {
          steps.push({ step: 'root 框架', status: 'skipped', detail: '无 su、无 Magisk/LSPosed（command -v su + pm list packages 实测）——模块路径不可用' })
        }
        const after = await this.checkSecure(serial, signal)
        steps.push({
          step: '判定',
          status: 'failed',
          detail: `焦点窗口仍带 FLAG_SECURE${after.pkg != null ? `（${after.pkg}）` : ''}，截图通道实测黑帧 → 像素不可显示（系统级保护）；已切降级内容通道（控件树文本视图）`,
        })
      }
      const result: MitigateResult = { serial, pixelPossible, steps, checkedAt: Date.now() }
      this.lastMitigate.set(serial, result)
      return result
    })().finally(() => this.mitigateInflight.delete(serial))
    this.mitigateInflight.set(serial, p)
    return p
  }

  /** agent 操作：认领校验 + busy 徽标 + 动作 + 自动截图。 */
  async act(sessionId: string, req: ActRequest, signal?: AbortSignal): Promise<{ serial: string; performed: string; screenshotPath: string | null; secureHint?: string }> {
    const s = this.resolveSerialForSession(sessionId, req.serial)
    const now = Date.now()
    this.busyUntil.set(s, now + 4_000)
    this.claims.get(s)!.lastActivityAt = now
    // self-healing：流已死/降级时先尝试恢复 h264（act 是 agent 主路径，必须自愈）
    if (this.modes.get(s) === 'poll' || this.streams.get(s)?.running !== true) {
      await this.ensureStream(s, signal)
    }
    const performed = await this.performAct(s, req, signal, 'agent')
    const shot = await this.saveScreenshot(s, signal).catch(() => null)
    // B22：FLAG_SECURE 页面 agent 引导（教训⑭的姊妹篇——黑屏不是故障，必须告诉 agent 正确通道）
    const sec = this.secureStates.get(s)
    if (sec?.secure === true) {
      if (sec.captureVisible !== true) {
        return {
          serial: s,
          performed,
          screenshotPath: shot,
          secureHint: `当前页面受 FLAG_SECURE 保护（${sec.pkg ?? '未知包名'}）——串流画面为黑屏（系统行为，非故障）。读取内容/定位元素请改用 android_pane_uidump / android_pane_ui（无障碍通道不受影响）；面板可点「尝试显示」走缓解链。`,
        }
      }
    }
    return { serial: s, performed, screenshotPath: shot }
  }

  /** 面板手势：不需要认领；**设备被任一智能体会话认领即全程锁定**（用户预期：锁到任务完成才释放）。
   *  紧急接管：面板「强制解锁」按钮（POST /claim/release）或该会话 detach/闲置自动释放。 */
  async actPanel(req: ActRequest, signal?: AbortSignal): Promise<{ serial: string; performed: string }> {
    const serial = req.serial
    if (serial == null || serial === '') throw new Error('面板操作需要 serial')
    const claim = this.claims.get(serial)
    if (claim != null) {
      const err = new Error(`设备已被智能体会话锁定（${claim.sessionId.slice(0, 8)}）——任务完成后自动释放；紧急接管请点面板「强制解锁」`) as Error & { code?: string }
      err.code = 'agent-busy'
      throw err
    }
    const busyUntil = this.busyUntil.get(serial) ?? 0
    if (busyUntil > Date.now()) {
      const err = new Error('智能体正在操作此设备，请稍候（人机互斥）') as Error & { code?: string }
      err.code = 'agent-busy'
      throw err
    }
    // 自愈（同 agent act 路径 B2 教训——人点面板同样需要）：流不在时先尝试恢复，避免静默掉 adb 慢路径
    if (this.streams.get(serial)?.running !== true) {
      await this.ensureStream(serial, signal).catch(() => undefined)
    }
    const performed = await this.performAct(serial, req, signal, 'panel')
    return { serial, performed }
  }

  /** 工具层解析目标设备（公开入口）。 */
  serialForSession(sessionId: string, serial?: string): string {
    return this.resolveSerialForSession(sessionId, serial)
  }

  /** 解析会话目标设备：显式 serial 须是本会话认领的；缺省时本会话仅认领一台才可自动选。 */
  private resolveSerialForSession(sessionId: string, serial?: string): string {
    const mine = [...this.claims.entries()].filter(([, c]) => c.sessionId === sessionId)
    if (serial != null && serial !== '') {
      const claim = this.claims.get(serial)
      if (claim == null || claim.sessionId !== sessionId) {
        throw new Error(`设备 ${serial} 未被本会话认领。先调用 android_pane_attach。`)
      }
      return serial
    }
    if (mine.length === 1) return mine[0][0]
    if (mine.length === 0) throw new Error('本会话尚未 attach 任何设备。先调用 android_pane_attach。')
    throw new Error(`本会话认领了 ${mine.length} 台设备，请指定 serial：${mine.map(([s]) => s).join(', ')}`)
  }

  /** ⚠️ touch 注入通道决策（Android 17 + HyperOS 实测教训）：
   *  scrcpy 3.3.4 在此组合下把 touch 注入绑定到其虚拟 display（displayId 3, layerStack 3），
   *  事件到不了真实 display 0 的应用（keycode 不受影响）——故 touch 一律走 `adb input`（物理坐标），
   *  key/text/rotate 走 control socket（已实测可用）。adbPoint 负责流坐标→物理坐标换算。 */
  private static readonly TOUCH_VIA_CONTROL = false

  /** performAct：调试会话时间线钩子 + 内层分发。agent 与面板操作都经此（单一咽喉）。 */
  private async performAct(s: string, req: ActRequest, signal?: AbortSignal, via: 'agent' | 'panel' = 'agent'): Promise<string> {
    const dbgId = this.debugBySerial.get(s)
    const dbg = dbgId != null ? this.debugSessions.get(dbgId) : undefined
    // human 模式调试 = 人在操作，AI 注入会干扰录制与操作序列 → 拒绝（面板操作放行）
    if (via === 'agent' && dbg != null && dbg.stoppedAt == null && dbg.mode === 'human') {
      throw new Error('调试会话进行中（人操作模式）——AI 请勿注入干扰；如需接管先停止调试会话')
    }
    const performed = await this.performActInner(s, req, signal)
    if (dbg != null && dbg.stoppedAt == null) dbg.acts.push({ t: Date.now(), action: req.action, detail: performed })
    return performed
  }

  private async performActInner(s: string, req: ActRequest, signal?: AbortSignal): Promise<string> {
    const stream = this.streams.get(s)
    const h264 = stream != null && stream.running
    switch (req.action) {
      case 'tap': {
        const x = Math.round(req.x ?? 0)
        const y = Math.round(req.y ?? 0)
        if (PaneHub.TOUCH_VIA_CONTROL && h264) {
          stream!.injectTouch(x, y, ACTION_DOWN)
          stream!.injectTouch(x, y, ACTION_UP)
        } else {
          const p = this.adbPoint(s, x, y)
          await this.adb.shellOk(s, `input tap ${p.x} ${p.y}`, { signal, timeoutMs: 10_000 })
        }
        return `tap(${x},${y})${PaneHub.TOUCH_VIA_CONTROL && h264 ? '|ctl' : '|adb'}`
      }
      case 'swipe': {
        const x1 = Math.round(req.x ?? 0)
        const y1 = Math.round(req.y ?? 0)
        const x2 = Math.round(req.x2 ?? req.x ?? 0)
        const y2 = Math.round(req.y2 ?? req.y ?? 0)
        const dur = Math.min(2000, Math.max(80, req.durationMs ?? 300))
        if (PaneHub.TOUCH_VIA_CONTROL && h264) {
          await stream!.injectSwipe(x1, y1, x2, y2, dur)
        } else {
          const p1 = this.adbPoint(s, x1, y1)
          const p2 = this.adbPoint(s, x2, y2)
          await this.adb.shellOk(s, `input swipe ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${dur}`, { signal, timeoutMs: 12_000 })
        }
        return `swipe(${x1},${y1}→${x2},${y2},${dur}ms)${PaneHub.TOUCH_VIA_CONTROL && h264 ? '|ctl' : '|adb'}`
      }
      case 'key': {
        const name = req.key ?? ''
        const keycode = KEYCODE[name]
        if (keycode == null) throw new Error(`未知按键 ${name}（可用：${Object.keys(KEYCODE).join('/')}）`)
        if (h264) stream!.tapKey(keycode)
        else await this.adb.shellOk(s, `input keyevent ${keycode}`, { signal, timeoutMs: 10_000 })
        return `key(${name})`
      }
      case 'text': {
        const text = req.text ?? ''
        if (text === '') throw new Error('text 不能为空')
        const ascii = /^[\x20-\x7e]*$/.test(text) && Buffer.byteLength(text, 'utf8') <= 300
        if (h264) {
          if (ascii) {
            stream!.injectText(text)
          } else {
            // 非 ASCII：优先 ADBKeyboard（HyperOS 限制 shell 剪贴板写入，实测粘贴不上屏）
            const ime = await this.imeStatus(s, signal)
            if (ime.installed) return `text(${text.length} chars): ${await this.imeSend(s, text, signal)}`
            stream!.injectText(text) // 剪贴板+粘贴（AOSP 可用；HyperOS 可能不上屏）
            return `text(${text.length} chars via clipboard)`
          }
        } else {
          if (!ascii) throw new Error('poll 降级模式不支持非 ASCII 文本；请安装 ADBKeyboard（android_pane_install_ime）或恢复 h264 模式')
          await this.adb.shellOk(s, `input text ${JSON.stringify(text).slice(1, -1).replace(/ /g, '%s')}`, { signal, timeoutMs: 10_000 })
        }
        return `text(${text.length} chars)`
      }
      case 'scroll': {
        const x = Math.round(req.x ?? 0)
        const y = Math.round(req.y ?? 0)
        const dy = req.y2 != null ? Math.round(req.y2) : -1
        if (h264) stream!.scroll(x, y, 0, dy)
        else await this.adb.shellOk(s, `input swipe ${x} ${y} ${x} ${y + dy * 400} 300`, { signal, timeoutMs: 10_000 })
        return `scroll(${x},${y},dy=${dy})`
      }
      case 'back':
      case 'home':
      case 'recents':
      case 'volume_up':
      case 'volume_down': {
        const keycode = KEYCODE[req.action]
        if (h264) stream!.tapKey(keycode)
        else await this.adb.shellOk(s, `input keyevent ${keycode}`, { signal, timeoutMs: 10_000 })
        return req.action
      }
      case 'rotate': {
        return this.rotate(s, signal)
      }
      default:
        throw new Error(`未知动作 ${String((req as { action?: unknown }).action)}`)
    }
  }

  /** ADBKeyboard 输入法状态。 */
  async imeStatus(s: string, signal?: AbortSignal): Promise<{ installed: boolean; current: string }> {
    const all = (await this.adb.shell(s, 'ime list -a -s', { signal, timeoutMs: 8_000 }).catch(() => ({ stdout: '' }))).stdout
    const installed = all.split('\n').some((l) => l.trim().startsWith('com.android.adbkeyboard'))
    const cur = (await this.adb.shell(s, 'settings get secure default_input_method', { signal, timeoutMs: 6_000 }).catch(() => ({ stdout: '' }))).stdout.trim()
    return { installed, current: cur }
  }

  /** 中文等非 ASCII 文本：ADBKeyboard 已在 attach 时激活，直接广播注入。 */
  async imeSend(s: string, text: string, signal?: AbortSignal): Promise<string> {
    const escaped = text.replace(/'/g, "'\\''")
    await this.adb.shellOk(s, `am broadcast -a ADB_INPUT_TEXT --es msg '${escaped}'`, { signal, timeoutMs: 10_000 })
    await new Promise((r) => setTimeout(r, 350))
    return `text(${text.length} chars via ADBKeyboard)`
  }

  /** 安装 ADBKeyboard.apk 并启用输入法（一次性设置；MIUI 会弹设备端确认）。 */
  async installIme(serial: string, signal?: AbortSignal): Promise<{ installed: boolean; note: string }> {
    const imeApk = join(dirname(this.opts.jarPath), 'ADBKeyboard.apk')
    const r = await this.adb.run(['-s', serial, 'install', '-r', imeApk], { signal, timeoutMs: 90_000 })
    if (r.code !== 0 || /Failure/.test(r.stdout + r.stderr)) {
      throw new Error(`ADBKeyboard 安装失败：${(r.stderr || r.stdout).slice(0, 200)}（MIUI 需在手机上确认「USB 安装」并开启安装权限）`)
    }
    await this.adb.shellOk(serial, 'ime enable com.android.adbkeyboard/.AdbIME', { signal, timeoutMs: 8_000 })
    return { installed: true, note: 'ADBKeyboard 已安装并启用' }
  }

  /** 首个在线设备 serial。 */
  firstOnlineSerial(): string | null {
    return this.devicesCache.find((d) => d.state === 'device')?.serial ?? null
  }

    async rotate(s: string, signal?: AbortSignal): Promise<string> {
    const cur = (await this.adb.shell(s, 'settings get system user_rotation', { signal })).stdout.trim()
    const current = /^\d$/.test(cur) ? Number(cur) : 0
    const next = (current + 1) % 4
    await this.adb.shellOk(s, 'settings put system accelerometer_rotation 0', { signal, timeoutMs: 8_000 })
    await this.adb.shellOk(s, `settings put system user_rotation ${next}`, { signal, timeoutMs: 8_000 })
    return `rotate→user_rotation=${next}`
  }

  async saveScreenshot(serial: string, signal?: AbortSignal): Promise<string> {
    const png = await this.adb.screencap(serial, { signal })
    const file = join(this.opts.shotsDir, `${Date.now()}-${serial.replace(/[^A-Za-z0-9._-]/g, '_')}.png`)
    writeFileSync(file, png)
    return file
  }

  async screenshotBuffer(serial: string, signal?: AbortSignal): Promise<Buffer> {
    return this.adb.screencap(serial, { signal })
  }

  /** uiautomator 结构化控件树（规则：验证闭环增强）。 */
  async uidump(serial: string, signal?: AbortSignal): Promise<Array<{ text: string; desc: string; cls: string; clickable: boolean; center: [number, number]; depth: number }>> {
    const dump = async (cmd: string): Promise<string | null> => {
      const r = await this.adb.shell(serial, cmd, { signal, timeoutMs: 20_000 })
      return r.code === 0 ? r.stdout : null
    }
    let ok = await dump('uiautomator dump --compressed /data/local/tmp/dsh_uidump.xml')
    if (ok == null) ok = await dump('uiautomator dump /data/local/tmp/dsh_uidump.xml')
    if (ok == null) throw new Error('uiautomator dump 失败（设备可能不支持或 UI 自动化被系统限制）')
    const xml = await this.adb.shellOk(serial, 'cat /data/local/tmp/dsh_uidump.xml', { signal, timeoutMs: 10_000 })
    if (xml.length < 200) throw new Error(`uiautomator dump 输出异常（${xml.length} 字节）——设备可能正在转屏或 UI 自动化被占用`)
    const nodes: Array<{ text: string; desc: string; cls: string; clickable: boolean; center: [number, number]; depth: number }> = []
    // tokenizer 区分 <node …/>（自闭合）/ <node …>（开）/ </node>（闭）→ 维护层级深度（大纲缩进用，B22b）
    let depth = 0
    const tokenRe = /<node[^>]*?\/>|<node[^>]*>|<\/node>/g
    for (const tok of xml.match(tokenRe) ?? []) {
      if (tok === '</node>') {
        depth--
        continue
      }
      const selfClosing = tok.endsWith('/>')
      const nodeDepth = depth
      if (!selfClosing) depth++
      const attr = (name: string): string => {
        const m = new RegExp(`${name}="([^"]*)"`).exec(tok)
        return m?.[1] ?? ''
      }
      const b = /(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)/.exec(attr('bounds'))
      if (b == null) continue
      const x1 = Number(b[1])
      const y1 = Number(b[2])
      const x2 = Number(b[3])
      const y2 = Number(b[4])
      const text = attr('text')
      const desc = attr('content-desc')
      const clickable = attr('clickable') === 'true'
      if (!clickable && text === '' && desc === '') continue
      nodes.push({
        text: text.slice(0, 80),
        desc: desc.slice(0, 80),
        cls: attr('class').slice(0, 40),
        clickable,
        center: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)],
        depth: nodeDepth,
      })
      if (nodes.length >= 100) break
    }
    return nodes
  }

  /** 停止录制并 pull 出 mp4（幂等）。 */
  private async stopRecord(serial: string, outDir?: string, signal?: AbortSignal): Promise<string | undefined> {
    const rec = this.records.get(serial)
    if (rec == null) return undefined
    this.records.delete(serial)
    rec.proc.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 800))
    const dir = outDir ?? this.opts.shotsDir
    mkdirSync(dir, { recursive: true })
    const local = join(dir, `dsh-record-${Date.now()}-${serial.replace(/[^A-Za-z0-9._-]/g, '_')}.mp4`)
    await this.adb.runOk(['-s', serial, 'pull', rec.file, local], { signal, timeoutMs: 30_000 })
    await this.adb.shell(serial, `rm -f ${rec.file}`, { timeoutMs: 5_000 }).catch(() => undefined)
    return local
  }

  async record(serial: string, action: 'start' | 'stop', outDir?: string, signal?: AbortSignal): Promise<{ file?: string; note: string }> {
    if (action === 'start') {
      if (this.debugBySerial.has(serial)) throw new Error('调试会话进行中——录屏由调试会话托管（停止调试会话即出 mp4）')
      const existing = this.records.get(serial)
      if (existing != null) return { note: '已在录制中（screenrecord 最长 180 秒自动停止）' }
      const remote = '/data/local/tmp/dsh_screenrecord.mp4'
      const proc = spawn(this.adb.path, ['-s', serial, 'shell', `screenrecord --time-limit 180 ${remote}`], {
        stdio: 'ignore',
        windowsHide: true,
      })
      this.records.set(serial, { proc, file: remote })
      proc.on('exit', () => {
        /* 时间到自动退出；stop 时再 pull */
      })
      if (signal != null) signal.addEventListener('abort', () => proc.kill('SIGKILL'), { once: true })
      return { note: '录制已开始（最长 180 秒）' }
    }
    const file = await this.stopRecord(serial, outDir, signal)
    if (file == null) return { note: '当前没有进行中的录制' }
    return { file, note: '已保存' }
  }

  /** 元素级操作基础：按条件在 uiautomator 树里找节点（权威坐标，杜绝截图目测打偏）。 */
  async uiFind(
    serial: string,
    criteria: { target?: string; index?: number },
    signal?: AbortSignal,
  ): Promise<{ index: number; total: number; text: string; desc: string; cls: string; clickable: boolean; center: [number, number]; bounds: [number, number, number, number] }> {
    const nodes = await this.uidump(serial, signal)
    const target = (criteria.target ?? '').trim()
    let matched = nodes
    if (target !== '') {
      const t = target.toLowerCase()
      const hit = (n: { text: string; desc: string; cls: string }): boolean =>
        n.text.toLowerCase().includes(t) || n.desc.toLowerCase().includes(t) || n.cls.toLowerCase().includes(t)
      matched = nodes.filter(hit)
      if (matched.length === 0) {
        // 宽松兜底：去掉空白再比一次（text/desc）
        const t2 = t.replace(/\s+/g, '')
        matched = nodes.filter((n) => n.text.replace(/\s+/g, '').toLowerCase().includes(t2) || n.desc.replace(/\s+/g, '').toLowerCase().includes(t2))
      }
    }
    if (matched.length === 0) {
      const sample = nodes.slice(0, 8).map((n) => n.text || n.desc || n.cls).filter(Boolean).join(' | ')
      throw new Error(`未找到匹配元素（target="${target}"）。当前屏可交互元素样例：${sample || '（无）'}——可先调 action=find 不带 target 看全量，或滑动/翻页后再试`)
    }
    const idx = Math.max(0, Math.min(matched.length - 1, criteria.index ?? 0))
    const n = matched[idx]
    const dumpAll = criteria.target == null || criteria.target === ''
    return {
      index: idx,
      total: dumpAll ? nodes.length : matched.length,
      text: n.text,
      desc: n.desc,
      cls: n.cls,
      clickable: n.clickable,
      center: n.center,
      bounds: [n.center[0], n.center[1], n.center[0], n.center[1]],
    }
  }

  /** 元素点击：解析权威坐标后走统一注入通道。 */
  async uiTap(serial: string, criteria: { target?: string; index?: number }, signal?: AbortSignal): Promise<{ performed: string; node: Awaited<ReturnType<PaneHub['uiFind']>> }> {
    const node = await this.uiFind(serial, criteria, signal)
    const performed = await this.performAct(serial, { action: 'tap', x: node.center[0], y: node.center[1] }, signal, 'agent')
    return { performed: `${performed} @element(${node.text || node.desc || node.cls})`, node }
  }

  /** 元素设值：定位 → 点聚焦 → 按原内容长度清空 → ADBKeyboard/文本注入。中文可靠。 */
  async uiSetText(
    serial: string,
    args: { target?: string; index?: number; text: string; clear?: boolean },
    signal?: AbortSignal,
  ): Promise<{ performed: string; node: Awaited<ReturnType<PaneHub['uiFind']>>; screenshotPath: string | null }> {
    const node = await this.uiFind(serial, { target: args.target, index: args.index }, signal)
    // 聚焦
    await this.performAct(serial, { action: 'tap', x: node.center[0], y: node.center[1] }, signal, 'agent')
    await new Promise((r) => setTimeout(r, 400))
    // 清空原内容：按 uiautomator 报告的现有文本长度发 DEL（MOVE_END 先跳尾）
    if (args.clear !== false && node.text.length > 0) {
      const n = Math.min(node.text.length + 2, 60)
      await this.performAct(serial, { action: 'key', key: 'move_end' }, signal, 'agent')
      for (let i = 0; i < n; i++) await this.performAct(serial, { action: 'key', key: 'del' }, signal, 'agent')
    }
    const r = await this.performAct(serial, { action: 'text', text: args.text }, signal, 'agent')
    await new Promise((r2) => setTimeout(r2, 500))
    const shot = await this.saveScreenshot(serial, signal).catch(() => null)
    return { performed: `${r} @element(${node.text || node.desc || node.cls})`, node, screenshotPath: shot }
  }

  // ───────────────── 调试会话（host 托管的录屏+logcat+操作时间线） ─────────────────
  // 场景①（人操作）：面板「调试」开关一键开/关，免对话仪式；场景②（AI 操作）：agent 工具强制留证，
  // analyze 把每个操作的帧图+logcat 片段物化进工具结果——LLM 无法"声称看过"而没有证据在上下文里。

  private debugSessions = new Map<string, DebugSession>()
  private debugBySerial = new Map<string, string>()

  debugStart(serial: string, mode: 'human' | 'agent', signal?: AbortSignal): { id: string; note: string } {
    const existingId = this.debugBySerial.get(serial)
    if (existingId != null) return { id: existingId, note: '调试会话已在进行中' }
    if (this.records.has(serial)) throw new Error('普通录屏进行中——先停止录屏再开调试会话（两者共用设备端 screenrecord）')
    // human 模式 = 人操作调试：若当前会话持有认领锁，自动释放（否则全程锁会把人挡在面板外）
    if (mode === 'human' && this.claims.has(serial)) this.releaseClaim(serial, '人操作调试会话开始，自动释放认领')
    const id = `dbg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const dir = join(this.opts.shotsDir, 'debug', id)
    mkdirSync(dir, { recursive: true })
    const sess: DebugSession = {
      id, serial, mode, startedAt: Date.now(), segments: [], recordProc: null,
      logProc: null, logRing: [], logRingBytes: 0,
      errFile: join(dir, 'logcat-errors.log'), errStream: null, acts: [], segIndex: 0, shortRotations: 0, rotateTimer: null, dir,
    }
    this.debugSessions.set(id, sess)
    this.debugBySerial.set(serial, id)
    this.debugSpawnSegment(sess)
    this.debugSpawnLogcat(sess)
    if (signal != null) signal.addEventListener('abort', () => this.debugStop(serial).catch(() => undefined), { once: true })
    this.opts.log(`[${serial}] 调试会话开始 ${id}（mode=${mode}，录屏分段 170s + logcat 环形缓冲）`)
    return { id, note: mode === 'human' ? '调试会话已开始（人操作模式）：录屏+日志托管中，放心操作' : '调试会话已开始（agent 操作模式）：录屏（分段）+ logcat + 操作时间线托管中' }
  }

  private debugSpawnSegment(sess: DebugSession): void {
    if (sess.stoppedAt != null) return
    const segIndex = sess.segIndex++
    const remote = `/data/local/tmp/dsh_dbg_${sess.id}_${segIndex}.mp4`
    const startEpoch = Date.now()
    const proc = spawn(this.adb.path, ['-s', sess.serial, 'shell', `screenrecord --time-limit 170 ${remote}`], { stdio: 'ignore', windowsHide: true })
    sess.recordProc = proc
    const seg: DebugSegment = { remote, startEpoch }
    sess.segments.push(seg)
    proc.on('exit', () => {
      seg.endEpoch = Date.now()
      if (sess.stoppedAt == null && sess.recordProc === proc) this.debugRotate(sess)
    })
    if (sess.rotateTimer == null) {
      sess.rotateTimer = setInterval(() => {
        if (sess.stoppedAt != null) return
        if (sess.recordProc != null) this.debugRotate(sess)
      }, 165_000)
    }
  }

  /** 段轮转：杀当前 screenrecord（设备端自动落盘）→ 异步 pull → 拉起下一段。 */
  private debugRotate(sess: DebugSession): void {
    const proc = sess.recordProc
    sess.recordProc = null
    proc?.kill('SIGKILL')
    const seg = sess.segments[sess.segments.length - 1]
    if (seg != null && seg.endEpoch != null && seg.local == null) void this.debugPullSegment(sess, seg)
    if (sess.stoppedAt != null) return
    // ⚠️ 轮转失控防护（实测 288 段事故）：段过短=screenrecord 秒退（设备掉线/编码器被占），
    // 立即 respawn 会紧循环刷爆磁盘与进程。连续 3 个短段（<20s）→ 自动停会话；单次短段 → 30s 退避再拉起。
    const dur = seg != null && seg.endEpoch != null ? seg.endEpoch - seg.startEpoch : 999_999
    if (dur < 20_000) {
      sess.shortRotations = (sess.shortRotations ?? 0) + 1
      if (sess.shortRotations >= 3 || sess.segments.length >= 60) {
        this.opts.log(`[${sess.serial}] 调试会话自动停止：screenrecord 连续秒退（设备掉线/编码器占用）`)
        void this.debugStop(sess.serial).catch(() => undefined)
        return
      }
      this.opts.log(`[${sess.serial}] screenrecord 段仅 ${Math.round(dur / 1000)}s，30s 退避后再拉起`)
      setTimeout(() => {
        if (sess.stoppedAt == null && sess.recordProc == null) this.debugSpawnSegment(sess)
      }, 30_000)
      return
    }
    sess.shortRotations = 0
    this.debugSpawnSegment(sess)
  }

  private async debugPullSegment(sess: DebugSession, seg: DebugSegment): Promise<void> {
    try {
      await new Promise((r) => setTimeout(r, 800)) // 设备端 mp4 落盘
      const local = join(sess.dir, `seg-${String(sess.segments.indexOf(seg)).padStart(3, '0')}.mp4`)
      await this.adb.runOk(['-s', sess.serial, 'pull', seg.remote, local], { timeoutMs: 30_000 })
      seg.local = local
      await this.adb.shell(sess.serial, `rm -f ${seg.remote}`, { timeoutMs: 5_000 }).catch(() => undefined)
    } catch (e) {
      this.opts.log(`[${sess.serial}] 调试段 pull 失败: ${String(e).slice(0, 160)}`)
    }
  }

  private debugSpawnLogcat(sess: DebugSession): void {
    // ⚠️ MIUI 全量 logcat 实测 1.7 万行/秒（256MB/87s）——*:I 去掉 V/D 洪水；洪水源 tag 随场景变化，
    // 黑名单追不完 → 架构改为「内存环形缓冲（全保真 ~24MB）+ E 级实时落盘」：磁盘零洪水、事件周边全保真
    const proc = spawn(this.adb.path, ['-s', sess.serial, 'logcat', '-v', 'threadtime', '*:I'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    sess.logProc = proc
    const errStream = createWriteStream(sess.errFile, { flags: 'a' })
    sess.errStream = errStream
    let buf = ''
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      const now = Date.now()
      for (const line of lines) {
        if (line.trim() === '') continue
        const rec = `${now}\t${line}`
        sess.logRing.push(rec)
        sess.logRingBytes += rec.length + 1
        while (sess.logRingBytes > 24_000_000 && sess.logRing.length > 0) {
          sess.logRingBytes -= sess.logRing.shift()!.length + 1
        }
        if (/\sE\/ /.test(line)) errStream.write(`${rec}\n`)
      }
    })
    proc.on('exit', () => errStream.end())
  }
  async debugStop(serial: string): Promise<{ id: string; note: string; summary?: DebugSummary }> {
    const id = this.debugBySerial.get(serial)
    if (id == null) return { id: '', note: '当前没有进行中的调试会话' }
    this.debugBySerial.delete(serial)
    const sess = this.debugSessions.get(id)
    if (sess == null) return { id, note: '会话记录缺失' }
    sess.stoppedAt = Date.now()
    if (sess.rotateTimer != null) clearInterval(sess.rotateTimer)
    sess.rotateTimer = null
    sess.recordProc?.kill('SIGKILL')
    sess.logProc?.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 900))
    for (const seg of sess.segments) if (seg.local == null) await this.debugPullSegment(sess, seg)
    sess.errStream?.end()
    const summary = this.debugSummarize(sess)
    this.opts.log(`[${serial}] 调试会话结束 ${id}：${summary.durationMs}ms，${sess.segments.length} 段，${sess.acts.length} 个操作`)
    return { id, note: `调试会话已保存：${sess.segments.length} 段录屏 + logcat + ${sess.acts.length} 条操作时间线`, summary }
  }

  private debugSummarize(sess: DebugSession): DebugSummary {
    const durationMs = (sess.stoppedAt ?? Date.now()) - sess.startedAt
    return {
      id: sess.id,
      serial: sess.serial,
      mode: sess.mode,
      startedAt: sess.startedAt,
      durationMs,
      mp4s: sess.segments.map((s) => s.local).filter((x): x is string => x != null),
      errFile: sess.errFile,
      acts: sess.acts.length,
    }
  }

  debugStatus(serial?: string): { active: boolean; id?: string; startedAt?: number; mode?: string; acts?: number; sessions?: DebugSummary[] } {
    if (serial != null) {
      const id = this.debugBySerial.get(serial)
      if (id == null) return { active: false }
      const sess = this.debugSessions.get(id)
      return { active: true, id, startedAt: sess?.startedAt, mode: sess?.mode, acts: sess?.acts.length }
    }
    return { active: false, sessions: [...this.debugSessions.values()].map((s) => this.debugSummarize(s)) }
  }

  debugList(): DebugSummary[] {
    return [...this.debugSessions.values()].map((s) => this.debugSummarize(s))
  }

  /** analyze：把每个操作的「前后帧图 + logcat 片段」物化为文件返回——证据强制进入 agent 上下文。 */
  async debugAnalyze(id?: string): Promise<DebugAnalysis> {
    const sess =
      (id != null ? this.debugSessions.get(id) : undefined) ??
      [...this.debugSessions.values()].filter((s) => s.stoppedAt != null).sort((a, b) => (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0))[0]
    if (sess == null) throw new Error('没有可分析的调试会话（先 start 并 stop）')
    if (sess.stoppedAt == null) throw new Error('调试会话仍在进行中——先停止再分析')
    const stoppedAt: number = sess.stoppedAt
    const durationMs = stoppedAt - sess.startedAt
    // 取证窗口：有操作时间线 → 每操作一个窗口；无（纯人手物理操作）→ 均匀采样
    const windows: Array<{ t: number; label: string }> =
      sess.acts.length > 0
        ? sess.acts.slice(-12).map((a, i) => ({ t: a.t, label: `#${sess.acts.length - sess.acts.slice(-12).length + i + 1} ${a.action}` }))
        : Array.from({ length: Math.max(3, Math.min(8, Math.floor(durationMs / 6000))) }, (_, i) => ({
            t: sess.startedAt + Math.round((durationMs * (i + 1)) / (Math.min(8, Math.max(3, Math.floor(durationMs / 6000))) + 1)),
            label: `采样${i + 1}`,
          }))
    const framesDir = join(sess.dir, 'frames')
    mkdirSync(framesDir, { recursive: true })
    const { execFile } = await import('node:child_process')
    const runFfmpeg = (args: string[], timeout = 20_000): Promise<void> =>
      new Promise((resolve, reject) => {
        execFile('ffmpeg', args, { timeout }, (err) => (err == null ? resolve() : reject(err)))
      })
    const frames: Array<{ file: string; label: string; t: number; kind: 'pre' | 'post' | 'sample' }> = []
    for (const [i, w] of windows.entries()) {
      const seg = sess.segments.find((s) => s.startEpoch <= w.t && w.t <= (s.endEpoch ?? stoppedAt) && s.local != null)
      if (seg == null || seg.local == null) continue
      const segLocal: string = seg.local
      const segEnd: number = seg.endEpoch ?? stoppedAt
      const inSeg = (epoch: number): number | null => {
        if (epoch < seg.startEpoch || epoch > segEnd) return null
        return Math.max(0, (epoch - seg.startEpoch) / 1000)
      }
      const targets =
        sess.acts.length > 0
          ? [
              { kind: 'pre' as const, off: inSeg(w.t - 600) },
              { kind: 'post' as const, off: inSeg(w.t + 1200) },
            ]
          : [{ kind: 'sample' as const, off: inSeg(w.t) }]
      for (const tg of targets) {
        if (tg.off == null) continue
        const file = join(framesDir, `f${String(i + 1).padStart(2, '0')}-${tg.kind}.png`)
        try {
          await runFfmpeg(['-ss', tg.off.toFixed(2), '-i', segLocal, '-frames:v', '1', '-y', file])
          frames.push({ file, label: w.label, t: w.t, kind: tg.kind })
        } catch {
          /* 单帧失败跳过 */
        }
      }
    }
    // logcat 切片：来自内存环形缓冲（全保真最后 ~24MB）；E 级另有磁盘留档 errFile
    const logLines = sess.logRing.filter((l) => l.includes('\t'))
    const slices: string[] = []
    for (const w of windows) {
      const inWin = logLines.filter((l) => {
        const e = Number(l.slice(0, l.indexOf('\t')))
        return Number.isFinite(e) && e >= w.t - 2000 && e <= w.t + 2500
      })
      if (inWin.length > 0) {
        slices.push(`── ${w.label}（±2s，${inWin.length} 行）──`)
        slices.push(...inWin.slice(0, 40))
      }
    }
    const errLines = logLines.filter((l) => /\s[EF]\/ /.test(l)).slice(-60)
    const tail = logLines.slice(-50)
    const timeline =
      sess.acts.length > 0
        ? sess.acts.map((a) => `${new Date(a.t).toLocaleTimeString('zh-CN', { hour12: false })}  ${a.detail ?? a.action}`)
        : ['（无面板/agent 注入操作——纯物理操作，时间轴以采样帧为准）']
    return {
      id: sess.id,
      serial: sess.serial,
      durationMs,
      timeline,
      frames,
      logSlices: slices.slice(0, 400),
      errorLines: errLines,
      logTail: tail,
      mp4s: sess.segments.map((s) => s.local).filter((x): x is string => x != null),
      errFile: sess.errFile,
    }
  }


  async listAvds(): Promise<string[]> {
    const bin = this.opts.emulatorBin
    if (bin == null) return []
    const { execFile } = await import('node:child_process')
    return new Promise((resolve) => {
      execFile(bin, ['-list-avds'], { timeout: 5_000 }, (err, stdout) => {
        resolve(err ? [] : String(stdout).split('\n').map((s) => s.trim()).filter((s) => s !== ''))
      })
    })
  }

  /** 启动一台关机的模拟器（面板设备菜单手势）。MVP：等待 boot_completed，最长 120s。 */
  async bootEmulator(avd: string): Promise<{ serial?: string; note: string }> {
    const bin = this.opts.emulatorBin
    if (bin == null) throw new Error('未找到 emulator 可执行文件（未设置 ANDROID_SDK 或本机未装模拟器）')
    const proc = spawn(bin, ['-avd', avd, '-no-snapshot-save', '-no-boot-anim'], { stdio: 'ignore', detached: true, windowsHide: true })
    proc.unref()
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const devices = await this.adb.devices().catch(() => [])
      const emu = devices.find((d) => d.isEmulator && d.state === 'device')
      if (emu != null) {
        const boot = await this.adb.shell(emu.serial, 'getprop sys.boot_completed', { timeoutMs: 5_000 }).catch(() => null)
        if (boot?.stdout.trim() === '1') return { serial: emu.serial, note: `模拟器 ${avd} 已启动` }
      }
      await new Promise((r) => setTimeout(r, 1_500))
    }
    return { note: '模拟器启动超时（120s），请到 Android Studio 查看' }
  }

  async setQuality(patch: Partial<QualityPrefs>): Promise<QualityPrefs> {
    const q = this.state.setQuality(patch)
    // 对运行中的流重建（scrcpy 不支持热重配）；停流后等待设备端 MediaCodec 释放（实测竞态教训）
    for (const [serial, stream] of [...this.streams]) {
      const claim = this.claims.get(serial)
      stream.stop()
      this.streams.delete(serial)
      this.modes.delete(serial)
      if (claim != null) {
        void (async () => {
          await new Promise((r) => setTimeout(r, 1_500))
          await this.attachForTool(claim.sessionId, serial).catch((e: unknown) => this.opts.log(`[${serial}] 画质重建失败: ${String(e).slice(0, 200)}`))
        })()
      }
    }
    return q
  }

  /** 还原设备原输入法。 */
  private restoreIme(serial: string): void {
    const prev = this.prevIme.get(serial)
    if (prev != null) {
      this.prevIme.delete(serial)
      this.adb.shell(serial, `ime set ${prev}`, { timeoutMs: 8_000 }).catch(() => undefined)
      this.opts.log(`[${serial}] IME 还原 → ${prev}`)
    }
  }

  dispose(): void {
    if (this.refreshTimer != null) clearInterval(this.refreshTimer)
    for (const st of this.pendingStarts) st.stop()
    if (this.secureTimer != null) clearInterval(this.secureTimer)
    this.secureStates.clear()
    this.lastMitigate.clear()
    this.rootProbe.clear()
    for (const [serial] of this.prevIme) this.restoreIme(serial)
    if (this.reaperTimer != null) clearInterval(this.reaperTimer)
    for (const stream of this.streams.values()) stream.stop()
    for (const rec of this.records.values()) rec.proc.kill('SIGKILL')
    for (const sess of this.debugSessions.values()) {
      if (sess.rotateTimer != null) clearInterval(sess.rotateTimer)
      sess.recordProc?.kill('SIGKILL')
      sess.logProc?.kill('SIGKILL')
      sess.errStream?.end()
    }
    this.streams.clear()
    this.records.clear()
    this.claims.clear()
  }
}
