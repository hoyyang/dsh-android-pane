/**
 * scrcpy-server 3.3.4 宿主会话：单设备一路 H.264 串流 + 控制注入。
 *
 * 协议要点（以 vendored assets/scrcpy-server-v3.3.4 为准，模拟器实测校准）：
 *  1. push jar → `adb forward tcp:<port> localabstract:scrcpy_<scid>`
 *  2. `adb shell CLASSPATH=<jar> app_process / com.genymobile.scrcpy.Server 3.3.4 <key=value...>`
 *  3. 连接 #1（video）：读 1 字节 dummy → 64 字节设备名 → 帧流（每包 [u64 pts][u32 len][data]，
 *     首包为 H.264 codec config（SPS/PPS，AnnexB），pts = 0x8000000000000000）
 *  4. 连接 #2（control）：audio=false 时顺序为 video→control，同一 forward 端口接受多次连接
 *  5. control 消息（type 后跟定长字段）：0=keycode 11B / 1=text / 2=touch 31B / 3=scroll 21B /
 *     4=back-or-screen-on 2B / 5=展开通知 / 7=收起面板 / 9=set-clipboard(粘贴)
 * 坐标一律用设备物理分辨率（`wm size`），与视频 max_size 缩放无关。
 * 任何协议异常：fail loud（带 stderr 尾部与首字节 hex），由上层决定重建。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { connect as tcpConnect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'

export const NO_PTS = 0x8000000000000000n

export interface ScrcpyQuality {
  maxSize: number
  maxFps: number
  videoBitRate: number
}

export interface StreamMeta {
  deviceName: string
  streamWidth: number
  streamHeight: number
  codecString: string
}

export interface ScrcpyFrame {
  /** 已剥离标志位的纯 pts（µs）。 */
  pts: bigint
  /** AnnexB 数据（含起始码）。 */
  data: Buffer
  key: boolean
  /** CODEC_CONFIG 包（SPS/PPS）。 */
  config: boolean
}

export type FrameSink = (frame: ScrcpyFrame) => void
export type MetaSink = (meta: StreamMeta) => void
export type DeadSink = (reason: string) => void

/** MotionEvent action 常量（Android）。 */
export const ACTION_DOWN = 0
export const ACTION_UP = 1
export const ACTION_MOVE = 2

const SERVER_VERSION = '3.3.4'
const REMOTE_JAR = '/data/local/tmp/dsh_scrcpy_server.jar'

export class StreamSession {
  private proc: ChildProcess | null = null
  private videoSock: Socket | null = null
  private controlSock: Socket | null = null
  private videoBuf = Buffer.alloc(0)
  private gotConfig = false
  private closed = false
  private stderrTail = ''
  private readonly sinks = new Set<FrameSink>()
  private metaSink: MetaSink | null = null
  private deadSink: DeadSink | null = null
  private meta: StreamMeta | null = null
  private scid = ''
  private port = 0
  private gop: ScrcpyFrame[] = []
  private lastConfigFrame: ScrcpyFrame | null = null
  displaySize: { w: number; h: number } = { w: 1080, h: 1920 }

  constructor(
    private readonly adbPath: string,
    private readonly serial: string,
    private readonly jarPath: string,
    private quality: ScrcpyQuality,
    private readonly log: (msg: string) => void,
  ) {}

  get info(): StreamMeta | null {
    return this.meta
  }

  /** 物理分辨率（wm size 实测），供流↔物理坐标换算。 */
  get displayDim(): { w: number; h: number } {
    return this.displaySize
  }

  get running(): boolean {
    return !this.closed && this.proc != null
  }

  onFrame(fn: FrameSink): () => void {
    this.sinks.add(fn)
    return () => this.sinks.delete(fn)
  }

  onMeta(fn: MetaSink): void {
    this.metaSink = fn
    if (this.meta != null) fn(this.meta)
  }

  onDead(fn: DeadSink): void {
    this.deadSink = fn
  }

  /** 观察者心跳（/stream 路由 ping 时调用）：有活跃观看者的流不被 reaper 回收。 */
  viewerAt = 0
  touchViewer(): void {
    this.viewerAt = Date.now()
  }

  hasActiveViewer(windowMs = 60_000): boolean {
    return this.viewerAt > 0 && Date.now() - this.viewerAt < windowMs
  }

  /** 晚加入观看者的重放序列（config+自最近关键帧起的增量包）。 */
  replayGop(): ScrcpyFrame[] {
    return [...this.gop]
  }

  /** 重放缓存是否可独立解码（必须同时含 config=SPS/PPS 与关键帧）。 */
  replayDecodable(): boolean {
    return this.gop.some((f) => f.config) && this.gop.some((f) => f.key)
  }

  /** B22b：按 ARGS 精准清理设备端残留 scrcpy server（`com.genymobil[e]` 字符类防误杀自身 grep）。 */
  private async killOrphanServers(signal?: AbortSignal): Promise<void> {
    const FIND = "ps -A -o PID,ARGS | grep 'com.genymobil[e].scrcpy.Server' | grep -v grep | awk '{print $1}'"
    const listPids = async (): Promise<string[]> => {
      const r = await run(this.adbPath, ['-s', this.serial, 'shell', FIND], signal, 8_000)
      return r.stdout.split(/\s+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
    }
    try {
      const pids = await listPids()
      if (pids.length === 0) return
      this.log(`[${this.serial}] 清理孤儿 scrcpy server: ${pids.join(',')}`)
      await run(this.adbPath, ['-s', this.serial, 'shell', `kill ${pids.join(' ')} 2>/dev/null; true`], signal, 8_000)
      await new Promise((res) => setTimeout(res, 500))
      const left = await listPids()
      if (left.length > 0) {
        this.log(`[${this.serial}] 孤儿 server TERM 未退（${left.join(',')}）→ KILL 补刀`)
        await run(this.adbPath, ['-s', this.serial, 'shell', `kill -9 ${left.join(' ')} 2>/dev/null; true`], signal, 8_000)
      }
    } catch {
      /* 清理失败不阻断启动（fail-soft：下次 start 会再试；启动本身失败会走既有 fail loud） */
    }
  }

  /** 完整启动：push → forward → spawn server（tunnel_forward）→ 双连接 → 首包。 */
  async start(signal?: AbortSignal): Promise<StreamMeta> {
    // scrcpy 3.3.4 协议（源码核对 Server.java / Options.java / DesktopConnection.java）：
    // ① scid 以 radix 16 解析且不可超 int32；socket 名 = "scrcpy" + String.format("_%08x", scid)
    // ② args 带 tunnel_forward=true → server 在设备端 LocalServerSocket 监听，
    //    宿主 `adb forward tcp:<port> localabstract:scrcpy_<scid>` 后对同一端口连两次（video→control）
    const scidHex = Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0')
    this.scid = scidHex
    const port = await freePort()
    this.port = port
    // ⚠️ B22b：启动前清理孤儿 server。 dispose 竞态（start 未完成时 hub 已卸载，streams map 里没有它，
    // stop 够不到）或本地 adb shell 被杀但远端 app_process 存活时，残留 server 会占住编码器/隧道，
    // 新会话零帧。按 ARGS 精准匹配 scrcpy Server（绝不碰 zygote/应用进程——B13 教训），TERM 宽限后 KILL 补刀。
    await this.killOrphanServers(signal)
    this.log(`[${this.serial}] push server jar`)
    await run(this.adbPath, ['-s', this.serial, 'push', this.jarPath, REMOTE_JAR], signal, 30_000)
    await run(this.adbPath, ['-s', this.serial, 'forward', `tcp:${port}`, `localabstract:scrcpy_${scidHex}`], signal, 10_000)
    const wmSize = await run(
      this.adbPath,
      ['-s', this.serial, 'shell', 'wm size'],
      signal,
      8_000,
    ).then((r) => r.stdout, () => '')
    const m = /(\d+)x(\d+)/.exec(wmSize)
    if (m != null) this.displaySize = { w: Number(m[1]), h: Number(m[2]) }

    const serverArgs = [
      '-s',
      this.serial,
      'shell',
      `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${SERVER_VERSION} ` +
        [
          // ⚠️ 实测：scid 必须是第一个 key=value 参数（桌面版同序）；放后面 server 静默 exit 0 不绑 socket
          `scid=${scidHex}`,
          'log_level=info',
          'video=true',
          'audio=false',
          'control=true',
          'send_frame_meta=true',
          'send_dummy_byte=true',
          'cleanup=true',
          'tunnel_forward=true',
          // 熄屏冻结 app_process 导致流断（实测）：连接期间保持设备唤醒
          'stay_awake=true',
          'downsize_on_error=true',
          'video_codec=h264',
          `max_size=${this.quality.maxSize > 0 ? this.quality.maxSize : 0}`,
          `max_fps=${this.quality.maxFps}`,
          `video_bit_rate=${this.quality.videoBitRate}`,
          // ⚠️ 每 2s 强制 IDR：scrcpy 默认 GoP 间隔过长（MediaCodec 默认 ~10s+），晚加入观看者的
          // GoP 重放缓存会涨破上限被迫重启会话（实测重启跑步机：静态微动画桌面 ~20s 养肥 3MB）。
          // 周期性 IDR 让重放缓存恒可解码（config∧key ≤2s 内必刷新），晚加入 ≤2s 出画、零重启。
          'video_codec_options=i-frame-interval=2',
        ].join(' '),
    ]
    this.log(`[${this.serial}] spawn scrcpy server (port ${port})`)
    this.proc = spawn(this.adbPath, serverArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.proc.stdout?.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      if (s.includes('ERROR') || s.includes('WARN')) this.log(`[${this.serial}] server stdout: ${s.trim().slice(0, 300)}`)
    })
    this.proc.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-2000)
    })
    this.proc.on('exit', (code, sig) => {
      if (this.closed) return
      this.markDead(`scrcpy server 退出 code=${code ?? 'null'} signal=${sig ?? 'null'} stderr尾: ${this.stderrTail.slice(-400)}`)
    })

    try {
      // forward 隧道 + 顺序 accept（DesktopConnection.open 源码语义）：
      // video.accept → dummy 写 video → control.accept → open() 返回 → sendDeviceMeta 写 video。
      // ⚠️ 死锁教训：必须先连 control，server 才会写 64 字节设备名——等名字再连 control = 双方互等。
      const video = await this.connectSocketWithDummy(port, signal)
      const sock = video.sock
      this.videoSock = sock
      sock.on('error', (e) => this.markDead(`video socket 错误: ${String(e)}`))
      sock.on('close', () => this.markDead('video socket 关闭'))

      const ctl = await this.connectControl(port, signal)
      this.controlSock = ctl
      ctl.on('error', (e) => this.log(`[${this.serial}] control socket 错误: ${String(e)}`))

      // open() 已返回：video socket 上依次是 [64B 设备名][12B codec header: fourcc+width+height][帧流]
      const nameBuf = await readExactly(sock, 64, 6_000)
      const deviceName = nameBuf.toString('utf8').replace(/\0+$/, '')
      const codecHeader = await readExactly(sock, 12, 6_000)
      const codecId = codecHeader.readUInt32BE(0) // fourcc，H264 = 'h264'(0x68323634)（实测）
      if (codecId !== 0x68323634) throw new Error(`codec header 异常：期望 h264(0x68323634)，实得 0x${codecId.toString(16)}`)
      const w = codecHeader.readUInt32BE(4)
      const h = codecHeader.readUInt32BE(8)
      this.meta = { deviceName, streamWidth: w, streamHeight: h, codecString: 'avc1.640028' }
      this.metaSink?.(this.meta)
      sock.on('data', (d: Buffer) => this.onVideoData(d))
      await this.waitForConfig(signal)
      this.log(`[${this.serial}] stream ready: ${this.meta?.streamWidth}x${this.meta?.streamHeight} ${this.meta?.codecString} (${deviceName})`)
      return this.meta as StreamMeta
    } catch (e) {
      const hint = this.stderrTail !== '' ? ` | server stderr 尾部: ${this.stderrTail.slice(-500)}` : ''
      this.stop()
      throw new Error(`scrcpy 会话启动失败（${this.serial}）：${String(e instanceof Error ? e.message : e)}${hint}`)
    }
  }

  /** 连接 video socket 并读走 1 字节 dummy（设备名在 control 连上之后才发，见 start() 注释）。
   *  实测教训链：设备端 listener 未就绪时首个连接会 EOF，且 adbd 会随之拆掉 forward 监听
   *  （后续连接全部 ECONNREFUSED）。因此：① 先 poll 设备 abstract socket 出现再连；
   *  ② 每次重试前重新下发 forward（幂等）。 */
  private async connectSocketWithDummy(port: number, signal?: AbortSignal): Promise<{ sock: Socket }> {
    const deadline = Date.now() + 15_000
    // ① 等设备端 socket 就绪（grep exit=1 = 无匹配 = 继续轮询；仅其他错误才跳过）
    for (let i = 0; i < 25; i++) {
      if (this.proc?.exitCode != null) throw new Error(`scrcpy server 已退出（exit=${this.proc.exitCode}）${this.stderrTail.slice(-300)}`)
      try {
        const out = await run(this.adbPath, ['-s', this.serial, 'shell', 'cat /proc/net/unix 2>/dev/null | grep -c scrcpy_' + this.scid], signal, 3_000)
        if (out.stdout.trim() !== '' && out.stdout.trim() !== '0') break
      } catch (e) {
        if (!String(e).includes('exit=1')) break // 无权限/不支持 → 跳过轮询；exit=1 是 grep 无匹配，继续等
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    // ② 连接循环（EOF/REFUSED 容忍；每次重试前重发 forward）
    let lastErr = ''
    for (;;) {
      if (Date.now() > deadline) throw new Error(`video 握手超时（${lastErr || 'EOF'}）`)
      if (this.proc?.exitCode != null) throw new Error(`scrcpy server 已退出（exit=${this.proc.exitCode}）${this.stderrTail.slice(-300)}`)
      let sock: Socket | null = null
      try {
        sock = await this.connectWithRetry(port, signal, 1_500)
        // dummy 超时给足 10s：冷启动 server accept 后写首字节偶发慢，2.5s 误杀会引发 EPIPE 连锁（实测教训）
        const dummy = await readExactly(sock, 1, 10_000)
        if (dummy[0] !== 0x00) throw new Error(`协议头异常：期望 dummy 0x00，实得 0x${dummy[0].toString(16)}`)
        return { sock }
      } catch (e) {
        lastErr = String(e instanceof Error ? e.message : e).slice(0, 160)
        try {
          sock?.destroy()
        } catch {
          /* ignore */
        }
        if (lastErr.includes('协议头异常')) throw new Error(lastErr)
        // 重新下发 forward（幂等；覆盖 adbd 拆监听的场景）
        await run(this.adbPath, ['-s', this.serial, 'forward', `tcp:${this.port}`, `localabstract:scrcpy_${this.scid}`], signal, 5_000).catch(() => undefined)
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  }

  /** 连接 control socket（server accept 顺序在 video 之后）。 */
  private async connectControl(port: number, signal?: AbortSignal): Promise<Socket> {
    const deadline = Date.now() + 10_000
    for (;;) {
      if (Date.now() > deadline) throw new Error('control 连接超时')
      if (this.proc?.exitCode != null) throw new Error(`scrcpy server 已退出（exit=${this.proc.exitCode}）`)
      try {
        return await this.connectWithRetry(port, signal, 1_500)
      } catch (e) {
        if (signal?.aborted) throw e
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  }

  /** 画质重配 = 重建会话（由上层调用 stop + start）。 */
  updateQuality(q: ScrcpyQuality): void {
    this.quality = q
  }

  /** 连接 adb forward 出来的本地端口（server 未起时短重试）。 */
  private connectWithRetry(port: number, signal?: AbortSignal, totalMs = 8_000): Promise<Socket> {
    const deadline = Date.now() + totalMs
    const attempt = (): Promise<Socket> =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        const s = tcpConnect({ port, host: '127.0.0.1' }, () => resolve(s))
        s.once('error', (e) => reject(e))
      })
    return (async () => {
      for (;;) {
        try {
          return await attempt()
        } catch (e) {
          if (Date.now() >= deadline) throw new Error(`连接 scrcpy 端口 ${port} 超时（最后一次: ${String(e)}）`)
          await new Promise((r) => setTimeout(r, 150))
        }
      }
    })()
  }

  private onVideoData(d: Buffer): void {
    this.videoBuf = Buffer.concat([this.videoBuf, d])
    for (;;) {
      if (this.videoBuf.length < 12) return
      const ptsFlags = this.videoBuf.readBigUInt64BE(0)
      const len = this.videoBuf.readUInt32BE(8)
      if (this.videoBuf.length < 12 + len) return
      const data = this.videoBuf.subarray(12, 12 + len)
      this.videoBuf = this.videoBuf.subarray(12 + len)
      // Streamer.writeFrameMeta：64 位字段高 2 位是标志——bit63=CONFIG，bit62=KEY_FRAME（源码核对）
      const isConfig = (ptsFlags & 0x8000000000000000n) !== 0n
      const isKey = (ptsFlags & 0x4000000000000000n) !== 0n
      const pts = ptsFlags & 0x3fffffffffffffffn
      if (isConfig && this.meta != null) {
        // config 包 = SPS/PPS（AnnexB）→ 交叉校准 codec string（失败不致命，保持 header 默认值）
        const parsed = parseH264AnnexB(data)
        if (parsed != null && parsed.sps != null) {
          this.meta = { ...this.meta, codecString: parsed.codecString }
          this.metaSink?.(this.meta)
        }
      }
      const frame: ScrcpyFrame = { pts, data: Buffer.from(data), key: isConfig || isKey || isKeyAccessUnit(data), config: isConfig }
      // GoP 缓存（晚加入观看者重放：config+IDR+增量 → 秒出画面）
      // ⚠️ 不变量 = [config, IDR, ...deltas]：IDR 到达时带上最近一次 CONFIG 帧——
      // 直接 gop=[IDR] 会丢 SPS/PPS → 重放永远缺 config → 每个订阅者触发重启（实测重启风暴）。
      if (isConfig) {
        this.lastConfigFrame = frame
        this.gop = [frame]
      } else if (isKey) {
        this.gop = this.lastConfigFrame != null ? [this.lastConfigFrame, frame] : [frame]
      } else {
        this.gop.push(frame)
        // ⚠️ 溢出必须清空而非保留尾部 delta：缺 config/IDR 的重放不可解码，
        // 静态画面下编码器不再发新关键帧 → 晚加入者永久黑屏（实测缺陷）。
        // 配合 video_codec_options=i-frame-interval=2，新 IDR ≤2s 到达后缓存恢复可解码。
        if (this.gop.length > 512 || this.gop.reduce((a, f) => a + f.data.length, 0) > 3_000_000) this.gop = []
      }
      for (const fn of this.sinks) {
        try {
          fn(frame)
        } catch (e) {
          this.log(`[${this.serial}] frame sink 异常: ${String(e).slice(0, 200)}`)
        }
      }
    }
  }

  private waitForConfig(signal?: AbortSignal, timeoutMs = 12_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const timer = setInterval(() => {
        if (this.meta != null) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer)
          reject(new Error('等待 H.264 codec config 超时（12s）'))
        } else if (signal?.aborted) {
          clearInterval(timer)
          reject(new Error('aborted'))
        }
      }, 50)
    })
  }

  private send(buf: Buffer): void {
    const sock = this.controlSock
    if (sock == null || sock.destroyed) throw new Error('control socket 未就绪（设备串流未运行）')
    sock.write(buf)
  }

  injectTouch(x: number, y: number, action: number): void {
    // ⚠️ 协议语义（scrcpy Controller.injectTouch）：x/y 在 w/h 所标定的坐标系里，
    // server 按 (deviceSize / w,h) 缩放到设备坐标。客户端发的是「流坐标」（canvas 空间），
    // 因此 w/h 必须是流尺寸——此前误用物理分辨率导致缩放比=1，点按全部偏移到屏幕左上（用户实测教训）。
    // ⚠️⚠️ 精确 32 字节，且 actionButton 是 4 字节字段（offset 24-27）：
    // 历史缺陷：actionButton 只写了 1 字节 → server 读出 0x01000000（STYLUS_PRIMARY）→
    // MOVE 事件进入 InputVerifier 触发 system_server SIGABRT → 框架重启循环（=「设备时常重启」根因，
    // tap 无 MOVE 所以从未触发，B8 验证恰好是 tap 而漏网）。
    // 编码=真手指语义（对齐 adb input swipe 的 touchscreen 行为，App 侧滚动手势才生效）：
    // pointerId=0（FINGER 工具）、全程 buttons=0（手指无按钮态——button 类 abort 从根上消除）。
    const { w, h } = this.touchSpace()
    this.touchProbe(action, x, y, w, h)
    const b = Buffer.alloc(32)
    b.writeUInt8(2, 0) // TYPE_INJECT_TOUCH_EVENT
    b.writeUInt8(action, 1)
    b.writeBigUInt64BE(0n, 2) // pointerId = 0（真手指）
    b.writeUInt32BE(x, 10)
    b.writeUInt32BE(y, 14)
    b.writeUInt16BE(w, 18)
    b.writeUInt16BE(h, 20)
    b.writeUInt16BE(action === ACTION_UP ? 0 : 0xffff, 22) // pressure（UP=0）
    b.writeUInt32BE(0, 24) // actionButton = 0（手指无按钮）
    b.writeUInt32BE(0, 28) // buttons = 0
    this.send(b)
  }

  /** 诊断探针（注入器上下文里同步 require 不可用，必须动态 import）。 */
  private touchProbe(action: number, x: number, y: number, w: number, h: number): void {
    if (process.env.DAP_QUIET != null) return
    void import('node:fs')
      .then((fs) => fs.appendFileSync('/tmp/dap-route.log', `${new Date().toISOString()} touch a=${action} x=${x} y=${y} w=${w} h=${h} meta=${this.meta ? `${this.meta.streamWidth}x${this.meta.streamHeight}` : 'null'} ctl=${this.controlSock ? (this.controlSock.destroyed ? 'dead' : 'ok') : 'null'}\n`))
      .catch(() => undefined)
  }

  /** 触控坐标系 = 流尺寸（晚于 meta 到达前回退物理分辨率）。 */
  private touchSpace(): { w: number; h: number } {
    if (this.meta != null && this.meta.streamWidth > 0) {
      return { w: this.meta.streamWidth, h: this.meta.streamHeight }
    }
    return this.displaySize
  }

  /** 流坐标 → 设备物理坐标（poll 降级走 adb input 时必须换算，adb input 只认物理坐标）。 */
  mapToDisplay(x: number, y: number): { x: number; y: number } {
    const m = this.meta
    if (m != null && m.streamWidth > 0 && m.streamHeight > 0 && this.displaySize.w > 0 && this.displaySize.h > 0) {
      return {
        x: Math.max(0, Math.min(this.displaySize.w - 1, Math.round(x * this.displaySize.w / m.streamWidth))),
        y: Math.max(0, Math.min(this.displaySize.h - 1, Math.round(y * this.displaySize.h / m.streamHeight))),
      }
    }
    return { x, y }
  }

  /** ⚠️ MOVE 事件必须按 durationMs 真实间隔发送：一次性灌完 = Android 端 0 速度瞬移手势，
   *  被桌面/应用吞掉（实测「面板无法操作」根因之一——tap 正常所以此前漏网）。 */
  async injectSwipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    const steps = Math.max(2, Math.min(40, Math.round(durationMs / 16)))
    const interval = Math.max(8, Math.round(durationMs / steps))
    this.injectTouch(x1, y1, ACTION_DOWN)
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, interval))
      const t = i / steps
      const x = Math.round(x1 + (x2 - x1) * t)
      const y = Math.round(y1 + (y2 - y1) * t)
      this.injectTouch(x, y, ACTION_MOVE)
    }
    await new Promise((r) => setTimeout(r, interval))
    this.injectTouch(x2, y2, ACTION_UP)
  }

  injectKey(action: number, keycode: number, metaState = 0, repeat = 0): void {
    // ⚠️ 精确 14 字节：type1+action1+keycode4+repeat4+metaState4（3.3.4 协议，错位即控制线程死亡）
    const b = Buffer.alloc(14)
    b.writeUInt8(0, 0) // TYPE_INJECT_KEYCODE
    b.writeUInt8(action, 1)
    b.writeUInt32BE(keycode >>> 0, 2)
    b.writeUInt32BE(repeat >>> 0, 6)
    b.writeUInt32BE(metaState >>> 0, 10)
    this.send(b)
  }

  /** 按键按下+抬起。 */
  tapKey(keycode: number, metaState = 0): void {
    this.injectKey(ACTION_DOWN, keycode, metaState)
    this.injectKey(ACTION_UP, keycode, metaState)
  }

  /** 文本输入：ASCII 走 TYPE_TEXT，其余走剪贴板粘贴（对齐 scrcpy 桌面端行为）。 */
  injectText(text: string): void {
    const asciiPrintable = /^[\x20-\x7e]*$/.test(text)
    if (asciiPrintable && Buffer.byteLength(text, 'utf8') <= 300) {
      const payload = Buffer.from(text, 'utf8')
      const b = Buffer.alloc(5 + payload.length)
      b.writeUInt8(1, 0) // TYPE_INJECT_TEXT
      b.writeUInt32BE(payload.length, 1)
      payload.copy(b, 5)
      this.send(b)
      return
    }
    this.setClipboardPaste(text)
  }

  setClipboardPaste(text: string): void {
    const payload = Buffer.from(text, 'utf8')
    if (payload.length > 1_000_000) throw new Error(`文本过长（${payload.length} 字节 > 1MB 上限）`)
    // ⚠️ 3.x 协议：type1+sequence8+paste1+length4 = 14 字节头（缺 sequence 8 字节即错位）
    const b = Buffer.alloc(14 + payload.length)
    b.writeUInt8(8, 0) // TYPE_SET_CLIPBOARD
    b.writeBigUInt64BE(0n, 1) // sequence = 0
    b.writeUInt8(1, 9) // paste = true
    b.writeUInt32BE(payload.length, 10)
    payload.copy(b, 14)
    this.send(b)
  }

  scroll(x: number, y: number, deltaX: number, deltaY: number): void {
    // ⚠️ 3.x 协议：type1+position12(x4 y4 w2 h2)+hScroll4+vScroll4+buttons4 = 25 字节（缺 w/h 即错位）
    const { w, h } = this.touchSpace()
    const b = Buffer.alloc(25)
    b.writeUInt8(3, 0) // TYPE_INJECT_SCROLL_EVENT
    b.writeUInt32BE(x, 1)
    b.writeUInt32BE(y, 5)
    b.writeUInt16BE(w, 9)
    b.writeUInt16BE(h, 11)
    b.writeFloatBE(deltaX, 13)
    b.writeFloatBE(deltaY, 17)
    b.writeUInt32BE(0, 21)
    this.send(b)
  }

  backOrScreenOn(action: number): void {
    const b = Buffer.alloc(2)
    b.writeUInt8(4, 0)
    b.writeUInt8(action, 1)
    this.send(b)
  }

  expandNotifications(): void {
    this.send(Buffer.from([5]))
  }

  collapsePanels(): void {
    this.send(Buffer.from([6])) // TYPE_COLLAPSE_PANELS（7 是 GET_CLIPBOARD，会引发响应读取错位）
  }

  markDead(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.log(`[${this.serial}] stream dead: ${reason}`)
    this.stop()
    this.deadSink?.(reason)
  }

  /** 停止并清理（幂等）。 */
  stop(): void {
    this.closed = true
    for (const sock of [this.videoSock, this.controlSock]) {
      try {
        sock?.destroy()
      } catch {
        /* ignore */
      }
    }
    this.videoSock = null
    this.controlSock = null
    if (this.port !== 0) {
      // 移除 forward 隧道 + 精准清理设备端 server（proc.kill 只杀本地 adb 客户端，
      // 设备端 app_process 会变僵尸占住 abstract socket——实测教训）
      spawn(this.adbPath, ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`], { stdio: 'ignore', windowsHide: true }).unref()
      // 设备端 server 检测到 socket EOF 后自行优雅退出（释放编码器）。
      // ⚠️ 不要设备端 pkill：SIGTERM 直杀 app_process 可能引发系统服务不稳定（实测设备重启教训）。
      this.port = 0
      this.scid = ''
    }
    if (this.proc != null) {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      this.proc = null
    }
    this.sinks.clear()
  }
}

// ───────────────────────── H.264 AnnexB 解析 ─────────────────────────

export interface ParsedH264 {
  sps: Buffer | null
  pps: Buffer | null
  width: number
  height: number
  codecString: string
}

/** 解析 AnnexB：提取 SPS/PPS、分辨率、avc1.PPCCLL codec string。 */
export function parseH264AnnexB(data: Buffer): ParsedH264 | null {
  const nals = splitAnnexB(data)
  let sps: Buffer | null = null
  let pps: Buffer | null = null
  for (const nal of nals) {
    if (nal.length === 0) continue
    const type = nal[0] & 0x1f
    if (type === 7 && sps == null) sps = nal
    if (type === 8 && pps == null) pps = nal
  }
  if (sps == null) return null
  const dims = parseSpsSize(sps)
  const profile = sps[1] ?? 0x42
  const compat = sps[2] ?? 0x00
  const level = sps[3] ?? 0x1f
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return {
    sps,
    pps,
    width: dims.w,
    height: dims.h,
    codecString: `avc1.${hex(profile)}${hex(compat)}${hex(level)}`,
  }
}

/** 按 00 00 01 / 00 00 00 01 起始码切 NAL（保留 NAL 头字节）。 */
export function splitAnnexB(data: Buffer): Buffer[] {
  const out: Buffer[] = []
  let i = 0
  let start = -1
  while (i < data.length - 2) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const scLen = i > 0 && data[i - 1] === 0 ? 4 : 3
      const nalStart = i - (scLen - 3)
      if (start >= 0 && nalStart > start) out.push(data.subarray(start, nalStart))
      start = i + 3
      i += 3
    } else {
      i++
    }
  }
  if (start >= 0 && start < data.length) out.push(data.subarray(start))
  return out
}

function isKeyAccessUnit(data: Buffer): boolean {
  for (const nal of splitAnnexB(data)) {
    if (nal.length === 0) continue
    const t = nal[0] & 0x1f
    if (t === 5) return true
  }
  return false
}

/** 极简 SPS 解析（Exp-Golomb），取 coded width/height（不含 crop 校正的场合足够用）。 */
export function parseSpsSize(sps: Buffer): { w: number; h: number } {
  try {
    // 跳过 NAL 头（1 byte）+ profile/compat/level（3 bytes）→ 从 seq_parameter_set_data 读
    const body = sps.subarray(4)
    const br = new BitReader(body)
    br.readBits(8) // profile_idc（重复，无实际用途）
    br.readBits(8) // constraint flags + reserved
    br.readBits(8) // level_idc
    br.readUe() // seq_parameter_set_id
    const chromaFormatIdc = br.readUe() // 不校验 1/2（chroma_format_idc 存在时需读附加位）
    if (chromaFormatIdc === 3) br.readBits(1)
    br.readUe() // bits_per_luma_minus8
    br.readUe() // bits_per_chroma_minus8
    br.readBits(1) // qpprime_y_zero_transform_bypass
    br.readBits(1) // seq_scaling_matrix_present
    const log2MaxFrameNumMinus4 = br.readUe()
    void log2MaxFrameNumMinus4
    const picOrderCntType = br.readUe()
    if (picOrderCntType === 0) br.readUe()
    else if (picOrderCntType === 1) {
      br.readBits(1)
      br.readSe()
      br.readSe()
      const n = br.readUe()
      for (let i = 0; i < n; i++) br.readSe()
    }
    br.readUe() // max_num_ref_frames
    br.readBits(1) // gaps_in_frame_num_value_allowed
    const picWidthInMbsMinus1 = br.readUe()
    const picHeightInMapUnitsMinus1 = br.readUe()
    br.readBits(1) // frame_mbs_only_flag
    br.readBits(1) // mb_adaptive_frame_field_flag
    br.readBits(1) // direct_8x8_inference_flag
    const cropL = br.readBits(1) // frame_cropping_flag
    let crop = { l: 0, r: 0, t: 0, b: 0 }
    if (cropL === 1) {
      crop = { l: br.readUe(), r: br.readUe(), t: br.readUe(), b: br.readUe() }
    }
    const width = (picWidthInMbsMinus1 + 1) * 16 - (crop.l + crop.r) * (chromaFormatIdc === 0 ? 1 : 2)
    const height = (2 - 1) * 16 * (picHeightInMapUnitsMinus1 + 1) - (crop.t + crop.b) * (chromaFormatIdc === 0 ? 1 : 2) * 2
    return { w: width, h: Math.max(16, height) }
  } catch {
    return { w: 1080, h: 1920 }
  }
}

class BitReader {
  private pos = 0
  constructor(private readonly buf: Buffer) {}
  readBit(): number {
    const byte = this.buf[Math.floor(this.pos / 8)]
    if (byte === undefined) throw new Error('SPS 越界')
    const bit = (byte >> (7 - (this.pos % 8))) & 1
    this.pos++
    return bit
  }
  readBits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit()
    return v
  }
  readUe(): number {
    let zeros = 0
    while (this.readBit() === 0) {
      zeros++
      if (zeros > 31) throw new Error('SPS Exp-Golomb 异常')
    }
    return (1 << zeros) - 1 + (zeros > 0 ? this.readBits(zeros) : 0)
  }
  readSe(): number {
    const ue = this.readUe()
    return ue % 2 === 0 ? -(ue / 2) : (ue + 1) / 2
  }
}

// ───────────────────────── 工具 ─────────────────────────

function run(
  adbPath: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`adb ${args[0]} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        // fail loud：push/shell 等失败必须带 stderr 上抛（曾静默吞错导致 jar 未推上设备）
        reject(new Error(`adb ${args.slice(0, 3).join(' ')}… 失败 exit=${code} stderr=${stderr.slice(0, 300)}`))
        return
      }
      resolve({ code: code ?? -1, stdout, stderr })
    })
    if (signal != null) {
      if (signal.aborted) child.kill('SIGKILL')
      else signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
    }
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr != null ? addr.port : 0
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('无可用本地端口'))))
    })
    srv.on('error', reject)
  })
}

function readExactly(sock: Socket, n: number, timeoutMs?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let have = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (timer != null) clearTimeout(timer)
      sock.off('readable', onReadable)
      sock.off('end', onEnd)
      sock.off('error', onErr)
    }
    const fail = (e: Error): void => {
      cleanup()
      if (timeoutMs != null) {
        // 超时路径：连接可能仍健康，销毁以防错位
        sock.destroy()
      }
      reject(e)
    }
    const onReadable = (): void => {
      try {
        for (;;) {
          const chunk: Buffer | null = sock.read()
          if (chunk == null) break
          chunks.push(chunk)
          have += chunk.length
          if (have >= n) {
            cleanup()
            const all = Buffer.concat(chunks)
            const rest = all.subarray(n)
            if (rest.length > 0) sock.unshift(rest)
            resolve(all.subarray(0, n))
            return
          }
        }
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    }
    const onEnd = (): void => {
      fail(new Error(`scrcpy 连接提前关闭（需要 ${n} 字节，实得 ${have}）`))
    }
    const onErr = (e: Error): void => {
      fail(e)
    }
    sock.on('readable', onReadable)
    sock.once('end', onEnd)
    sock.once('error', onErr)
    if (timeoutMs != null) {
      timer = setTimeout(() => {
        fail(new Error(`读取超时（${timeoutMs}ms，实得 ${have}/${n} 字节）`))
      }, timeoutMs)
    }
    onReadable()
  })
}

export function jarPathIn(pluginRoot: string): string {
  return join(pluginRoot, 'assets', 'scrcpy-server-v3.3.4')
}

/** 从编译产物路径反推插件包根（lib/scrcpy-host.js → 包根）。 */
export function pluginRootFromImportMeta(importMetaUrl: string): string {
  const here = new URL('.', importMetaUrl).pathname
  return join(here, '..')
}
