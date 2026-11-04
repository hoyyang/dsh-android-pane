/**
 * PaneHub：设备/认领/串流/操作的中枢。
 * 规则落地点（设计卡）：
 *  - 设备独占（规则2）：claims 单属主，冲突明确报错；
 *  - 人机互斥提示（规则3）：agent 每次操作刷新 busyUntil，路由暴露给 UI 亮徽标；
 *  - 闲置回收（规则4）：10 分钟无活动 → 释放认领 + 停流；模拟器额外 emu kill，真机仅断开；
 *  - 资源上限（规则7）：每会话 4 路、全局 8 路；
 *  - 降级（规则6/MVP）：scrcpy 启动失败 → 该设备进入 poll 模式（截图轮播），注入走 adb input；
 *  - 隐私（规则8）：截图/录屏/调试写入宿主配置的绝对目录，路径透明。
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { isEmulatorSerial } from './adb.js';
import { MAX_CLOCK_WIDTH_MS, validateCaptureDirectory } from './state.js';
import { ACTION_DOWN, ACTION_UP, StreamSession, parsePanelInput } from './scrcpy-host.js';
import { extractSecureState, HINT_DISABLE_FLAG_SECURE } from './flag-secure.js';
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/**
 * Only a frame written by this exact extraction may become evidence: a stale PNG at the same deterministic
 * name, or a zero-byte "successful" decode, must never be reported as the requested frame.
 */
export function commitFrame(tmp, file) {
    // ffmpeg exits 0 without writing when a select filter matches nothing.
    if (!existsSync(tmp))
        throw new Error('没有生成新的有效PNG');
    const png = readFileSync(tmp);
    if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIG))
        throw new Error('没有生成新的有效PNG');
    renameSync(tmp, file);
}
/**
 * Native screenrecord trailer layout (verified against 12 real segments): 16-byte tag, u32 version=2,
 * i64 device wall clock at first frame in ns, u32 frame count, then i64 monotonic ns per frame.
 * Maps monotonic nanoseconds to device wall time, not host spawn time.
 */
export function nativeFrameEpochs(bytes, pts) {
    const at = bytes.indexOf('#VV1NSC0PET1ME2#');
    if (at < 0 || at + 32 > bytes.length || bytes.readUInt32LE(at + 16) !== 2)
        throw new Error('缺少受支持的原生帧时间元数据');
    const count = bytes.readUInt32LE(at + 28);
    if (!count || count !== pts.length || at + 32 + count * 8 > bytes.length)
        throw new Error('原生帧时间数量或长度不匹配');
    const offset = bytes.readBigInt64LE(at + 20);
    const epochs = pts.map((_, i) => Number(bytes.readBigInt64LE(at + 32 + i * 8) + offset) / 1e6);
    if (epochs.some((t, i) => !Number.isFinite(t) || !Number.isFinite(pts[i]) || (i > 0 && (t <= epochs[i - 1] || pts[i] <= pts[i - 1])) || Math.abs((t - epochs[0]) / 1000 - (pts[i] - pts[0])) > 0.001))
        throw new Error('原生帧时间与视频时间不一致');
    return epochs;
}
export function debugClockBounds(start, end) {
    if (!start || !end || Math.max(start.minOffsetMs, end.minOffsetMs) > Math.min(start.maxOffsetMs, end.maxOffsetMs))
        return;
    return { minOffsetMs: Math.min(start.minOffsetMs, end.minOffsetMs), maxOffsetMs: Math.max(start.maxOffsetMs, end.maxOffsetMs) };
}
export function selectDebugFrame(epochs, clock, target, kind) {
    // Pre and post are one-sided: an action after the last presented frame still has a valid pre frame.
    if (kind === 'pre')
        return epochs.findLastIndex(t => t + clock.maxOffsetMs <= target);
    return epochs.findIndex(t => t + clock.minOffsetMs >= target);
}
const KEYCODE = {
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
};
export class PaneHub {
    adb;
    state;
    opts;
    devicesCache = [];
    devicesAt = 0;
    claims = new Map();
    streams = new Map();
    modes = new Map();
    streamErrors = new Map();
    busyUntil = new Map();
    pollSince = new Map();
    records = new Map();
    // ponytail: one host-wide capture; use per-device API slots if simultaneous captures are required.
    captureStarting = false;
    captureWrites = 0;
    disposed = false;
    muteQueue = Promise.resolve();
    captureProcesses = new WeakMap();
    deviceInfo = new Map();
    /** attach 时切换到 ADBKeyboard 前的原输入法（detach 时还原） */
    prevIme = new Map();
    seenDetached = new Set();
    reaperTimer = null;
    refreshTimer = null;
    /** dispose 竞态守卫（B22b）：start 在途的会话集合——dispose 时一并 stop，防孤儿 server 占编码器 */
    pendingStarts = new Set();
    /** FLAG_SECURE（B22）：焦点窗口 SECURE 位缓存 / 检测与缓解链在-flight / root 能力缓存 */
    secureStates = new Map();
    secureInflight = new Map();
    mitigateInflight = new Map();
    lastMitigate = new Map();
    rootProbe = new Map();
    secureTimer = null;
    constructor(adb, state, opts) {
        this.adb = adb;
        this.state = state;
        this.opts = opts;
        mkdirSync(this.opts.shotsDir, { recursive: true });
        for (const job of state.data.pending) {
            const error = job.error ?? '服务重载，采集已转待保存；请重试保存（先结束可能仍在运行的设备采集）。';
            if (job.type === 'record')
                this.records.set(job.serial, { proc: null, file: job.remote, ...job, status: 'pending-save', error });
            else {
                this.debugSessions.set(job.id, { ...job, captureOptions: '', mode: 'human', stoppedAt: job.stoppedAt ?? Date.now(), segments: job.segments, acts: job.actions, recordProc: null, logProc: null, logRing: [], logRingBytes: 0, errFile: join(job.dir, job.id + '-logcat.log'), errStream: null, segIndex: job.segments.length, shortRotations: 0, rotateTimer: null, logRemote: job.logRemote, error });
                this.debugBySerial.set(job.serial, job.id);
            }
        }
    }
    persistRecord(serial) {
        const r = this.records.get(serial);
        this.state.upsertPending({ id: r.id, type: 'record', serial, dir: r.dir, startedAt: r.startedAt, stoppedAt: r.stoppedAt, remote: r.file, error: r.error, captureError: r.captureError });
    }
    persistDebug(sess) {
        this.state.upsertPending({ id: sess.id, type: 'debug', serial: sess.serial, dir: sess.dir, startedAt: sess.startedAt, stoppedAt: sess.stoppedAt, logRemote: sess.logRemote, clockStart: sess.clockStart, clockEnd: sess.clockEnd, segments: sess.segments, actions: sess.acts, error: sess.error, captureError: sess.captureError });
    }
    async stopRecoveredCapture(serial, remote, signal) {
        // Never replay a persisted PID: stop only the exact generated command still owning this remote file.
        const command = remote.endsWith('.log') ? 'logcat -v epoch -f ' + remote : 'screenrecord --time-limit ' + (remote.includes('dsh_record-') ? '180 ' : '170 ') + remote;
        const pids = async () => {
            const ps = await this.adb.runOk(['-s', serial, 'shell', 'ps', '-A', '-o', 'PID,ARGS'], { signal, timeoutMs: 8_000 });
            return ps.split('\n').flatMap(line => {
                const match = /^\s*(\d+)\s+(.*)$/.exec(line);
                if (!match)
                    return [];
                const argv = match[2].trim();
                if (argv === command || argv === '/system/bin/' + command)
                    return [match[1]]; // Earlier pending captures had no size/bitrate options.
                const words = argv.split(/\s+/), executable = words.shift(), file = words.pop();
                const limit = remote.includes('dsh_record-') ? 180 : 170;
                return !remote.endsWith('.log') && (executable === 'screenrecord' || executable === '/system/bin/screenrecord') && file === remote && new RegExp('^--size [0-9]+x[0-9]+ --bit-rate [0-9]+ --time-limit ' + limit + '$').test(words.join(' ')) ? [match[1]] : [];
            });
        };
        for (const pid of await pids())
            await this.adb.runOk(['-s', serial, 'shell', 'kill', '-2', pid], { signal, timeoutMs: 8_000 });
        const deadline = Date.now() + 15_000;
        while ((await pids()).length) {
            if (Date.now() >= deadline)
                throw new Error('重载采集停止超时；原件已保留：' + remote);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    startTimers() {
        this.refreshTimer = setInterval(() => {
            void this.refreshDevices().catch(() => {
                /* adb 不在时静默，devices 查询会报最新错误 */
            });
        }, 2_000);
        this.reaperTimer = setInterval(() => {
            void this.reapIdle();
        }, 30_000);
        // FLAG_SECURE 识别轮询（B22）：只查「正在被观看/认领」的设备；2.5s 节流 + per-device 在-flight 去重
        if (this.opts.flagSecureCheck) {
            this.secureTimer = setInterval(() => {
                const serials = new Set();
                for (const [serial, st] of this.streams)
                    if (st.running)
                        serials.add(serial);
                for (const serial of this.claims.keys())
                    serials.add(serial);
                for (const [serial, m] of this.modes)
                    if (m === 'poll')
                        serials.add(serial);
                for (const serial of serials)
                    void this.checkSecure(serial).catch(() => undefined);
            }, 2_500);
        }
    }
    async refreshDevices() {
        const list = await this.adb.devices();
        for (const d of list) {
            if (!this.deviceInfo.has(d.serial) && !d.isEmulator) {
                void this.adb.getDeviceInfo(d.serial).then((i) => this.deviceInfo.set(d.serial, i)).catch(() => undefined);
            }
        }
        this.devicesCache = list;
        this.devicesAt = Date.now();
        // 设备消失时清认领与流
        const online = new Set(list.map((d) => d.serial));
        for (const serial of [...this.claims.keys()]) {
            if (!online.has(serial)) {
                this.claims.delete(serial);
                this.streams.get(serial)?.stop();
                this.streams.delete(serial);
                this.modes.delete(serial);
            }
        }
        return list;
    }
    async ensureDevices() {
        if (Date.now() - this.devicesAt > 2_000)
            await this.refreshDevices();
        return this.devicesCache;
    }
    async listDevices() {
        const list = await this.ensureDevices();
        const now = Date.now();
        const devices = list.map((d) => {
            const info = this.deviceInfo.get(d.serial);
            const brand = info?.brand || d.model || d.serial;
            const market = info?.market || '';
            const type = info?.type ?? '手机';
            const dedupMarket = market && brand && market.toLowerCase().startsWith(brand.toLowerCase()) ? market.slice(brand.length).trim() : market;
            // B22d：brand/market/model 全空或同串时避免「25080RABDC 25080RABDC」式重复
            const parts = [brand, dedupMarket, d.model ?? ''].map((x) => x.trim()).filter((x) => x !== '');
            const uniq = [...new Set(parts)];
            const name = d.isEmulator
                ? `模拟器 ${d.model ?? d.serial}`
                : `${uniq.join(' ') || d.serial}（${type}）`;
            return {
                serial: d.serial,
                state: d.state,
                model: d.model,
                isEmulator: d.isEmulator,
                claimedBy: this.claims.get(d.serial)?.sessionId ?? null,
                busy: (this.busyUntil.get(d.serial) ?? 0) > now,
                mode: this.modes.get(d.serial) ?? null,
                name: name.replace(/\s+/g, ' ').trim(),
            };
        });
        return { devices, quality: { ...this.state.data.quality } };
    }
    async sessionState() {
        const now = Date.now();
        const busy = {};
        for (const [serial, until] of this.busyUntil)
            busy[serial] = until > now;
        const errors = {};
        // A running stream is healthy evidence: do not report a stale error from a previous session.
        for (const [serial, err] of this.streamErrors)
            if (this.streams.get(serial)?.running !== true)
                errors[serial] = err;
        const debug = {};
        for (const sess of this.debugSessions.values()) {
            if (sess.stoppedAt == null)
                debug[sess.serial] = { id: sess.id, startedAt: sess.startedAt, mode: sess.mode };
        }
        const secure = {};
        for (const [serial, info] of this.secureStates) {
            secure[serial] = { secure: info.secure, pkg: info.pkg, checkedAt: info.checkedAt, captureVisible: info.captureVisible, lastMitigate: this.lastMitigate.get(serial) ?? null };
        }
        return { claims: [...this.claims.values()], busy, streamErrors: errors, debug, secure };
    }
    /** 工具 attach（agent 路径）：DSH 工具审批 = 首次授权点，创建会话级认领。 */
    async attachForTool(sessionId, serial, signal) {
        const devices = await this.ensureDevices();
        let target;
        if (serial == null || serial === '') {
            const online = devices.filter((d) => d.state === 'device');
            if (online.length === 0)
                throw new Error('没有在线设备（`adb devices` 为空）。请插入真机（开 USB 调试）或启动模拟器。');
            if (online.length > 1) {
                throw new Error(`检测到 ${online.length} 台设备，请指定 serial：${online.map((d) => d.serial).join(', ')}`);
            }
            target = online[0];
        }
        else {
            target = devices.find((d) => d.serial === serial);
            if (target == null) {
                if (isEmulatorSerial(serial))
                    throw new Error(`模拟器 ${serial} 当前不在线。可在面板设备菜单里启动，或先在 Android Studio 里启动它。`);
                throw new Error(`设备 ${serial} 不在线（adb devices 无此设备）。`);
            }
            if (target.state !== 'device')
                throw new Error(`设备 ${serial} 状态为 ${target.state}（ unauthorized 需在手机上确认 USB 调试授权）`);
        }
        const s = target.serial;
        // human 模式调试进行中：AI 认领会 locks 面板并干扰操作序列 → 拒绝
        const dbgId = this.debugBySerial.get(s);
        if (dbgId != null) {
            const dbg = this.debugSessions.get(dbgId);
            if (dbg != null && dbg.stoppedAt == null && dbg.mode === 'human') {
                throw new Error(`调试会话进行中（人操作模式，${dbg.id}）——AI 请勿认领；结束调试会话后再 attach`);
            }
        }
        const existing = this.claims.get(s);
        if (existing != null && existing.sessionId !== sessionId) {
            throw new Error(`设备 ${s} 已被会话 ${existing.sessionId} 认领（设计规则：一台设备同时只归一个会话）。请先让该会话 detach，或换一台设备。`);
        }
        // 资源上限（规则7）
        const mine = [...this.claims.values()].filter((c) => c.sessionId === sessionId).length;
        if (existing == null && mine >= this.opts.maxPerSession) {
            throw new Error(`本会话已认领 ${mine} 台设备（上限 ${this.opts.maxPerSession}），请先 detach。`);
        }
        if (existing == null && this.claims.size >= this.opts.globalMax) {
            throw new Error(`全局已认领 ${this.claims.size} 台设备（上限 ${this.opts.globalMax}）。`);
        }
        // 首次授权：走到这里的 attach 已经过 DSH 工具审批（或用户面板手动操作），记住设备
        this.streams.get(s)?.cancelPanelTouch();
        this.state.trust(s);
        // 亮屏 + 解锁键盘（连接即点亮——熄屏/锁屏会让一切交互无效，实测教训）
        await this.adb.shell(s, 'input keyevent KEYCODE_WAKEUP', { signal, timeoutMs: 5_000 }).catch(() => undefined);
        await this.adb.shell(s, 'wm dismiss-keyguard', { signal, timeoutMs: 5_000 }).catch(() => undefined);
        // 中文输入前置：会话期间切到 ADBKeyboard（⚠️ 必须在点输入框之前切——后切会丢焦点，实测教训）
        if (!s.startsWith('emulator')) {
            const ime = await this.imeStatus(s, signal).catch(() => ({ installed: false, current: '' }));
            if (ime.installed && ime.current !== 'com.android.adbkeyboard/.AdbIME') {
                await this.activateIme(s, ime.current, signal);
                this.opts.log(`[${s}] IME → ADBKeyboard（原: ${ime.current}）`);
            }
        }
        // 串流：优先 h264，失败降级 poll（规则6/MVP）
        const mode = await this.ensureStream(s, signal);
        const streamError = mode === 'poll' ? (this.streamErrors.get(s) ?? 'poll 模式（此前 scrcpy 启动失败）') : null;
        const meta = this.streams.get(s)?.info ?? null;
        const size = meta != null ? { w: meta.streamWidth, h: meta.streamHeight } : null;
        const deviceName = meta?.deviceName || null;
        this.streams.get(s)?.cancelPanelTouch();
        const claimedAt = existing?.claimedAt ?? Date.now();
        this.claims.set(s, { serial: s, sessionId, claimedAt, lastActivityAt: Date.now() });
        this.seenDetached.delete(s);
        void this.checkSecure(s, signal).catch(() => undefined); // B22: attach 即检，横幅最迟 2.5s 内出现
        const shot = await this.saveScreenshot(s, signal).catch(() => null);
        return { serial: s, model: target.model, isEmulator: target.isEmulator, mode, size, deviceName, screenshotPath: shot, streamError };
    }
    /** 面板 attach（观察者路径）：用户手势即授权；只确保串流在跑，不创建认领、不与 agent 抢设备。 */
    async attachViewer(serial, signal) {
        const devices = await this.ensureDevices();
        const target = devices.find((d) => d.serial === serial);
        if (target == null)
            throw new Error(`设备 ${serial} 不在线`);
        if (target.state !== 'device')
            throw new Error(`设备 ${serial} 状态为 ${target.state}（unauthorized 需在手机上确认 USB 调试授权）`);
        const s = target.serial;
        if (!s.startsWith('emulator')) {
            await this.adb.shell(s, 'input keyevent KEYCODE_WAKEUP', { signal, timeoutMs: 5_000 }).catch(() => undefined);
            await this.adb.shell(s, 'wm dismiss-keyguard', { signal, timeoutMs: 5_000 }).catch(() => undefined);
            const ime = await this.imeStatus(s, signal).catch(() => ({ installed: false, current: '' }));
            if (ime.installed && ime.current !== 'com.android.adbkeyboard/.AdbIME') {
                await this.activateIme(s, ime.current, signal);
            }
        }
        await this.ensureStream(s, signal);
        void this.checkSecure(s, signal).catch(() => undefined); // B22: 观察路径同检
        const meta = this.streams.get(s)?.info ?? null;
        return {
            serial: s,
            model: target.model,
            isEmulator: target.isEmulator,
            mode: this.modes.get(s) ?? 'h264',
            size: meta != null ? { w: meta.streamWidth, h: meta.streamHeight } : null,
            streamError: this.streamErrors.get(s) ?? null,
        };
    }
    ensuring = new Map();
    /** 每设备最近一次成功流的坐标系（流↔物理），供 adb 兜底路径换算（adb input 只认物理坐标）。 */
    lastDims = new Map();
    adbPoint(s, x, y) {
        const d = this.lastDims.get(s);
        if (d != null && d.sw > 0 && d.sh > 0 && d.dw > 0 && d.dh > 0) {
            return {
                x: Math.max(0, Math.min(d.dw - 1, Math.round(x * d.dw / d.sw))),
                y: Math.max(0, Math.min(d.dh - 1, Math.round(y * d.dh / d.sh))),
            };
        }
        return { x, y };
    }
    /** /stream 订阅前保证可解码：重放缓存缺 config/IDR（溢出裁剪后）→ 重启会话换新关键帧。 */
    async ensureDecodableStream(s, signal) {
        const session = this.streams.get(s);
        if (session == null || !session.running)
            return; // 无会话/已死：交给 attach/ensureStream 路径处理
        if (session.replayDecodable())
            return;
        try {
            (await import('node:fs')).appendFileSync('/tmp/dap-route.log', `${new Date().toISOString()} restart-for-decodability serial=${s}\n`);
        }
        catch { /* ignore */ }
        this.opts.log(`[${s}] 重放缓存不可解码（缺 config/IDR）→ 重启串流会话`);
        session.stop();
        this.streams.delete(s);
        this.modes.delete(s);
        await this.ensureStream(s, signal);
    }
    /** 设备保护保险丝：会话启动频率上限（每设备 60s 内 ≤6 次）。超限 → 拒绝再拉起，防 app_process/
     *  MediaCodec 高频 churn 伤设备（实测教训：粗暴对待 app_process 可致系统不稳/设备重启）。
     *  超限期间返回 'poll'（正常降级），冷却后自动恢复。 */
    startTimes = new Map();
    static FUSE_WINDOW_MS = 60_000;
    static FUSE_MAX_STARTS = 6;
    fuseOpen(s) {
        const now = Date.now();
        const times = (this.startTimes.get(s) ?? []).filter((t) => now - t < PaneHub.FUSE_WINDOW_MS);
        this.startTimes.set(s, times);
        return times.length >= PaneHub.FUSE_MAX_STARTS;
    }
    /** 确保 h264 串流在跑（per-device 互斥：并发调用共享同一次启动，防双 server 冲突）。 */
    async ensureStream(s, signal) {
        const inflight = this.ensuring.get(s);
        if (inflight != null)
            return inflight;
        const p = this.ensureStreamInner(s, signal).finally(() => this.ensuring.delete(s));
        this.ensuring.set(s, p);
        return p;
    }
    async ensureStreamInner(s, signal) {
        // 冷却机制已移除（互斥防风暴；显式 attach/act 必须总是尝试恢复——否则自愈被挡，实测教训）
        let session = this.streams.get(s);
        if (session == null || !session.running) {
            // 保险丝：只在「需要新启动」时计数，健康流复用不计
            if (this.fuseOpen(s)) {
                this.opts.log(`[${s}] 会话重启保险丝熔断（60s 内 >6 次启动）→ 本分钟内降级 poll，保护设备`);
                this.modes.set(s, 'poll');
                this.pollSince.set(s, Date.now());
                this.streamErrors.set(s, '会话重启过频（设备保护保险丝），稍后自动恢复');
                return 'poll';
            }
            const times = this.startTimes.get(s) ?? [];
            times.push(Date.now());
            this.startTimes.set(s, times);
            try {
                session = new StreamSession(this.adb.path, s, this.opts.jarPath, this.state.data.quality, this.opts.log);
                // dispose 与 start 竞态（B22b）：在途会话登记，dispose 会 stop 它，防孤儿 server
                this.pendingStarts.add(session);
                let meta;
                try {
                    meta = await session.start(signal);
                }
                finally {
                    this.pendingStarts.delete(session);
                }
                this.lastDims.set(s, { sw: meta.streamWidth, sh: meta.streamHeight, dw: session.displayDim.w, dh: session.displayDim.h });
                session.onDead((reason) => {
                    // A replaced session may die after its successor started: never evict or flag the live one.
                    if (this.streams.get(s) !== session)
                        return;
                    this.streamErrors.set(s, reason);
                    this.streams.delete(s);
                    this.modes.delete(s);
                });
                this.streams.set(s, session);
                this.streamErrors.delete(s);
                this.modes.delete(s);
                this.pollSince.delete(s);
                void meta;
                return 'h264';
            }
            catch (e) {
                const msg = String(e instanceof Error ? e.message : e);
                this.opts.log(`[${s}] scrcpy 启动失败，降级 poll 模式：${msg}`);
                session?.stop();
                this.modes.set(s, 'poll');
                this.pollSince.set(s, Date.now());
                this.streamErrors.set(s, msg);
                return 'poll';
            }
        }
        return 'h264';
    }
    /** 面板强制解锁：人显式接管（记录原因；被锁会话的下一次操作会收到「未被认领」并需重新 attach）。 */
    forceRelease(serial) {
        if (this.claims.get(serial) == null)
            return { released: false, note: '该设备未被认领' };
        this.releaseClaim(serial, '面板强制解锁（人工接管）');
        return { released: true, note: '已强制释放认领锁——原会话下次操作需重新 attach' };
    }
    detach(sessionId, serial) {
        const claim = this.claims.get(serial);
        if (claim == null)
            return { released: false };
        if (sessionId != null && claim.sessionId !== sessionId) {
            throw new Error(`设备 ${serial} 由会话 ${claim.sessionId} 认领，无权从会话 ${sessionId} 释放。`);
        }
        this.releaseClaim(serial, 'manual detach');
        return { released: true };
    }
    releaseClaim(serial, reason) {
        this.restoreIme(serial);
        this.claims.delete(serial);
        this.seenDetached.add(serial);
        const stream = this.streams.get(serial);
        if (stream != null) {
            // 规则4：detach 后流保留由 reaper 在闲置期后回收；这里先停流（省资源），模拟器由 reaper 判断关机
            stream.stop();
            this.streams.delete(serial);
        }
        this.modes.delete(serial);
        const rec = this.records.get(serial);
        if (rec != null)
            void this.stopRecord(serial).catch(e => this.opts.log('停止录屏失败：' + String(e)));
        this.opts.log(`[${serial}] claim released: ${reason}`);
    }
    async reapIdle() {
        const now = Date.now();
        for (const [serial, claim] of [...this.claims]) {
            if (now - claim.lastActivityAt > this.opts.idleDetachMs) {
                const isEmu = isEmulatorSerial(serial);
                this.releaseClaim(serial, `闲置 ${Math.round(this.opts.idleDetachMs / 60000)} 分钟`);
                if (isEmu) {
                    // 模拟器关机（规则4）；失败不致命
                    await this.adb.emuKill(serial).catch(() => undefined);
                }
            }
        }
        for (const [serial, stream] of [...this.streams]) {
            if (!this.claims.has(serial)) {
                // 有活跃观看者的流不回收（面板 viewer 不创建 claim，但正在被观看）
                if (stream.hasActiveViewer())
                    continue;
                stream.stop();
                this.streams.delete(serial);
                this.modes.delete(serial);
            }
        }
    }
    getStream(serial) {
        return this.streams.get(serial) ?? null;
    }
    getMode(serial) {
        return this.modes.get(serial) ?? null;
    }
    // ───────────────── FLAG_SECURE 识别与缓解（B22） ─────────────────
    /** 焦点窗口 SECURE 位检测（dumpsys window windows → 解析）。2.5s 定时器 + attach 即检共用；在-flight 去重。 */
    async checkSecure(serial, signal) {
        const inflight = this.secureInflight.get(serial);
        if (inflight != null)
            return inflight;
        const p = (async () => {
            // ⚠️ 实测（Android 17/深度定制系统）：`dumpsys window windows`（列表子命令）不含 mCurrentFocus 行；
            // 焦点行只在不带子命令的 `dumpsys window` 里（含窗口列表 + 焦点，单一命令拿全两种信息）
            const r = await this.adb.shell(serial, 'dumpsys window', { signal, timeoutMs: 12_000 }).catch(() => null);
            const info = r != null && r.code === 0 && r.stdout.length > 200
                ? extractSecureState(r.stdout)
                : { secure: false, pkg: null, activity: null, focusTitle: null, source: 'none', checkedAt: Date.now() };
            this.secureStates.set(serial, info);
            // B22f：进入 FLAG_SECURE 页面（episode 开始）→ 实证一次截图通道可见性（零副作用），
            // 可见即不显示横幅（画面本就可看）；离开页面清标记（下一 episode 重测）
            if (info.secure && info.captureVisible === undefined) {
                const cap = await this.probeCaptureVisible(serial, signal).catch(() => ({ visible: false, metric: 'probe-failed' }));
                info.captureVisible = cap.visible;
                this.secureStates.set(serial, info);
                this.opts.log(`[${serial}] FLAG_SECURE 页面截图通道实测: ${cap.visible ? '可见' : '黑帧'}（${cap.metric}）`);
            }
            if (!info.secure)
                info.captureVisible = undefined;
            return info;
        })().finally(() => this.secureInflight.delete(serial));
        this.secureInflight.set(serial, p);
        return p;
    }
    secureInfo(serial) {
        return this.secureStates.get(serial) ?? null;
    }
    /** root 能力探测（60s 缓存）：构建类型 / su / Magisk|LSPosed 框架。只探测，绝不执行提权。 */
    async probeRootCapability(serial, signal) {
        const cached = this.rootProbe.get(serial);
        if (cached != null && Date.now() - cached.at < 60_000)
            return cached;
        const bt = (await this.adb.shell(serial, 'getprop ro.build.type', { signal, timeoutMs: 6_000 }).catch(() => ({ stdout: '', code: 1 }))).stdout.trim();
        const su = (await this.adb.shell(serial, 'command -v su', { signal, timeoutMs: 6_000 }).catch(() => ({ stdout: '', code: 1 }))).code === 0;
        const pkgs = (await this.adb.shell(serial, 'pm list packages 2>/dev/null | grep -iE "magisk|lsposed|edxposed" || true', { signal, timeoutMs: 15_000 }).catch(() => ({ stdout: '', code: 1 }))).stdout.trim();
        const framework = /magisk/i.test(pkgs) ? 'Magisk' : /lsposed|edxposed/i.test(pkgs) ? 'LSPosed/EdXposed' : pkgs !== '' ? pkgs.split('\n')[0] : null;
        const v = { buildType: bt === '' ? 'unknown' : bt, su, framework };
        this.rootProbe.set(serial, { ...v, at: Date.now() });
        return v;
    }
    /** userdebug/eng：adb root（必须带 -s——多设备在线时裸 `adb root` 直接 exit 1，实测教训；
     *  adbd 重启后 id -u 重试确认）。保留原始输出用于 fail loud。user 构建绝不调用。 */
    async tryAdbRoot(serial, signal) {
        const r = await this.adb
            .run(['-s', serial, 'root'], { signal, timeoutMs: 15_000 })
            .catch((e) => ({ code: -1, stdout: '', stderr: String(e instanceof Error ? e.message : e).slice(0, 160) }));
        if (r.code !== 0) {
            return { ok: false, note: `adb root 失败（exit=${r.code}）: ${(r.stderr || r.stdout || '无输出').slice(0, 160)}` };
        }
        for (let i = 0; i < 8; i++) {
            await new Promise((res) => setTimeout(res, 1_200));
            const id = await this.adb.shell(serial, 'id -u', { signal, timeoutMs: 6_000 }).catch(() => null);
            if (id != null && id.code === 0 && id.stdout.trim() === '0')
                return { ok: true, note: 'adbd 已 root（还原: adb unroot）' };
        }
        return { ok: false, note: 'adb root 已执行但 8 次重试内 id -u 非 0（adbd 未切 root，设备策略可能限制）' };
    }
    /** 串流重启（缓解链内用）：停旧会话 → 等编码器释放 → 重新拉起。 */
    async restartStream(serial, signal) {
        const session = this.streams.get(serial);
        session?.stop();
        this.streams.delete(serial);
        this.modes.delete(serial);
        await new Promise((res) => setTimeout(res, 1_200));
        await this.ensureStream(serial, signal).catch(() => undefined);
    }
    /** B22d：实测截图通道可见性（原始帧缓冲采样）。双机校准：黑帧 distinct≈47/top2≈100%，
     *  内容帧 distinct 211-256/top2≤95%。零副作用：不改 root 态、不动流。 */
    async probeCaptureVisible(serial, signal) {
        const buf = await this.adb.execOutBinary(['-s', serial, 'exec-out', 'screencap'], { signal, timeoutMs: 20_000 }).catch(() => null);
        if (buf == null || buf.length < 100_000)
            return { visible: false, metric: 'capture-failed' };
        const hist = new Array(256).fill(0);
        let n = 0;
        for (let i = 12; i < buf.length; i += 89) {
            hist[buf[i]]++;
            n++;
        }
        hist.sort((a, b) => b - a);
        const top2 = (hist[0] + hist[1]) / n;
        let distinct = 0;
        for (const c of hist)
            if (c > 0)
                distinct++;
        return { visible: distinct >= 100 && top2 <= 0.97, metric: `distinct=${distinct},top2=${Math.round(top2 * 100)}%` };
    }
    /** 缓解链（用户点「尝试显示」触发）。B22d 实证版：
     *  ① 无 root 态实测截图通道（零副作用）→ 可见即切快照流（部分 userdebug 机器 screencap 不受 FLAG_SECURE 限制）
     *  ② 不可见且 userdebug/eng → adb root 后复测 → 可见即【保持 root】+ 快照流（绝不无谓 unroot）
     *  ③ 全部不可见 → （试过 root 则还原）→ 降级内容通道。判定全部基于像素实测，不以 FLAG 位推断。 */
    async secureMitigate(serial, signal) {
        const inflight = this.mitigateInflight.get(serial);
        if (inflight != null)
            return inflight;
        const p = (async () => {
            const steps = [];
            let rootApplied = false;
            // ① 实测截图通道（零副作用）——部分机器（尤其 userdebug）screencap 不受 FLAG_SECURE 限制
            const uid = (await this.adb.shell(serial, 'id -u', { signal, timeoutMs: 6_000 }).catch(() => ({ stdout: '', code: 1 }))).stdout.trim();
            const uidNote = uid === '0' ? 'adbd=root' : 'adbd=shell';
            let cap = await this.probeCaptureVisible(serial, signal);
            if (cap.visible) {
                steps.push({ step: '截图通道', status: 'ok', detail: `实测本机 screencap 不受 FLAG_SECURE 限制（${cap.metric}，${uidNote}）` });
            }
            else {
                steps.push({ step: '截图通道', status: 'skipped', detail: `screencap 为黑帧（${cap.metric}，${uidNote}）——尝试 adb root 路径` });
                const probe = await this.probeRootCapability(serial, signal);
                if (probe.buildType === 'user' || probe.buildType === 'unknown') {
                    steps.push({ step: 'adb root', status: 'skipped', detail: `ro.build.type=${probe.buildType}——adb root 仅对 userdebug/eng 设备可用（生产构建 adbd 拒绝 root），跳过` });
                }
                else {
                    const root = await this.tryAdbRoot(serial, signal);
                    if (root.ok) {
                        rootApplied = true;
                        steps.push({ step: 'adb root', status: 'ok', detail: `ro.build.type=${probe.buildType} → ${root.note}` });
                        cap = await this.probeCaptureVisible(serial, signal);
                        if (cap.visible) {
                            steps.push({ step: 'root 截图通道', status: 'ok', detail: `root 态 screencap 实测可见（${cap.metric}）——adbd 保持 root（还原: adb unroot）` });
                        }
                        else {
                            steps.push({ step: 'root 截图通道', status: 'failed', detail: `root 态 screencap 仍为黑帧（${cap.metric}）——root 无增益` });
                        }
                    }
                    else {
                        steps.push({ step: 'adb root', status: 'failed', detail: `ro.build.type=${probe.buildType} 但 ${root.note}` });
                    }
                }
            }
            const pixelPossible = cap.visible;
            if (pixelPossible) {
                // B22f：可见即无需任何模式切换——H.264（root 态）或截图通道本就直出内容，横幅自动隐藏
                steps.push({ step: '判定', status: 'ok', detail: '像素可见（实证）——画面保持当前通道实时显示，横幅不再提示' });
            }
            else {
                if (rootApplied) {
                    const ur = await this.adb.run(['-s', serial, 'unroot'], { signal, timeoutMs: 15_000 }).catch(() => null);
                    if (ur != null && ur.code === 0) {
                        await new Promise((res) => setTimeout(res, 2_000));
                        await this.restartStream(serial, signal).catch(() => undefined);
                        steps.push({ step: '还原', status: 'ok', detail: 'adb unroot 已执行——root 对本场景无增益，设备回到原状态' });
                    }
                    else {
                        steps.push({ step: '还原', status: 'failed', detail: 'adb unroot 失败——如需还原请手动执行 adb unroot' });
                    }
                }
                // root 框架提示（仅像素不可见时模块路线才有意义）
                const probe2 = await this.probeRootCapability(serial, signal);
                if (probe2.framework != null) {
                    steps.push({ step: 'root 框架', status: 'hint', detail: `${probe2.framework}——${HINT_DISABLE_FLAG_SECURE}` });
                }
                else if (probe2.su) {
                    steps.push({ step: 'root 框架', status: 'hint', detail: '存在 su 但未检测到 Magisk/LSPosed——像素级镜像需 DisableFlagSecure 类模块（Zygisk/LSPosed）。本插件绝不代装模块。' });
                }
                else {
                    steps.push({ step: 'root 框架', status: 'skipped', detail: '无 su、无 Magisk/LSPosed（command -v su + pm list packages 实测）——模块路径不可用' });
                }
                const after = await this.checkSecure(serial, signal);
                steps.push({
                    step: '判定',
                    status: 'failed',
                    detail: `焦点窗口仍带 FLAG_SECURE${after.pkg != null ? `（${after.pkg}）` : ''}，截图通道实测黑帧 → 像素不可显示（系统级保护）；已切降级内容通道（控件树文本视图）`,
                });
            }
            const result = { serial, pixelPossible, steps, checkedAt: Date.now() };
            this.lastMitigate.set(serial, result);
            return result;
        })().finally(() => this.mitigateInflight.delete(serial));
        this.mitigateInflight.set(serial, p);
        return p;
    }
    /** agent 操作：认领校验 + busy 徽标 + 动作 + 自动截图。 */
    async act(sessionId, req, signal) {
        const s = this.resolveSerialForSession(sessionId, req.serial);
        const now = Date.now();
        this.busyUntil.set(s, now + 4_000);
        this.claims.get(s).lastActivityAt = now;
        // self-healing：流已死/降级时先尝试恢复 h264（act 是 agent 主路径，必须自愈）
        if (this.modes.get(s) === 'poll' || this.streams.get(s)?.running !== true) {
            await this.ensureStream(s, signal);
        }
        const performed = await this.performAct(s, req, signal, 'agent');
        const shot = await this.saveScreenshot(s, signal).catch(() => null);
        // B22：FLAG_SECURE 页面 agent 引导（教训⑭的姊妹篇——黑屏不是故障，必须告诉 agent 正确通道）
        const sec = this.secureStates.get(s);
        if (sec?.secure === true) {
            if (sec.captureVisible !== true) {
                return {
                    serial: s,
                    performed,
                    screenshotPath: shot,
                    secureHint: `当前页面受 FLAG_SECURE 保护（${sec.pkg ?? '未知包名'}）——串流画面为黑屏（系统行为，非故障）。读取内容/定位元素请改用 android_pane_uidump / android_pane_ui（无障碍通道不受影响）；面板可点「尝试显示」走缓解链。`,
                };
            }
        }
        return { serial: s, performed, screenshotPath: shot };
    }
    /** 面板手势：不需要认领；**设备被任一智能体会话认领即全程锁定**（用户预期：锁到任务完成才释放）。
     *  紧急接管：面板「强制解锁」按钮（POST /claim/release）或该会话 detach/闲置自动释放。 */
    async actPanel(req, signal) {
        const serial = req.serial;
        if (req.coordinateSpace != null && req.coordinateSpace !== 'stream' && req.coordinateSpace !== 'physical')
            throw Object.assign(new Error('coordinateSpace 须为 stream|physical'), { code: 'bad-request' });
        if (req.coordinateSpace === 'physical' && (req.action !== 'tap' || !Number.isFinite(req.x) || !Number.isFinite(req.y) || req.x < 0 || req.y < 0 || req.x > 65535 || req.y > 65535))
            throw Object.assign(new Error('physical 仅允许有效物理坐标的 tap'), { code: 'bad-request' });
        if (serial == null || serial === '')
            throw new Error('面板操作需要 serial');
        this.assertPanelAvailable(serial);
        // 自愈（同 agent act 路径 B2 教训——人点面板同样需要）：流不在时先尝试恢复，避免静默掉 adb 慢路径
        if (this.streams.get(serial)?.running !== true) {
            await this.ensureStream(serial, signal).catch(() => undefined);
        }
        this.assertPanelAvailable(serial); // Recheck after asynchronous stream recovery.
        const performed = await this.performAct(serial, req, signal, 'panel');
        return { serial, performed };
    }
    assertPanelAvailable(serial) {
        const claim = this.claims.get(serial);
        if (claim != null) {
            const err = new Error(`设备已被智能体会话锁定（${claim.sessionId.slice(0, 8)}）——任务完成后自动释放；紧急接管请点面板「强制解锁」`);
            err.code = 'agent-busy';
            throw err;
        }
        const busyUntil = this.busyUntil.get(serial) ?? 0;
        if (busyUntil > Date.now()) {
            const err = new Error('智能体正在操作此设备，请稍候（人机互斥）');
            err.code = 'agent-busy';
            throw err;
        }
    }
    /** Panel input stays separate from agent act: no session header can bypass the human lock. */
    panelInput(serial, raw) {
        if (serial == null || serial === '')
            throw Object.assign(new Error('Panel input requires serial'), { code: 'bad-request' });
        const input = parsePanelInput(raw);
        const stream = this.streams.get(serial);
        if (input.events.every(e => e.p === 'up')) {
            stream?.cancelPanelTouch(input.gesture);
            return { serial, performed: 'input(released)' };
        }
        this.assertPanelAvailable(serial);
        if (stream == null || !stream.running)
            throw Object.assign(new Error('Panel control stream unavailable; reconnect'), { code: 'no-stream' });
        stream.injectPanelInput(input);
        const dbg = this.debugSessions.get(this.debugBySerial.get(serial) ?? '');
        const performed = 'input(' + input.events.map(e => e.p).join(',') + ')|ctl';
        if (dbg != null && dbg.stoppedAt == null) {
            dbg.acts.push({ t: Date.now(), action: 'input', detail: performed });
            this.persistDebug(dbg);
        }
        return { serial, performed };
    }
    /** 工具层解析目标设备（公开入口）。 */
    serialForSession(sessionId, serial) {
        return this.resolveSerialForSession(sessionId, serial);
    }
    /** 解析会话目标设备：显式 serial 须是本会话认领的；缺省时本会话仅认领一台才可自动选。 */
    resolveSerialForSession(sessionId, serial) {
        const mine = [...this.claims.entries()].filter(([, c]) => c.sessionId === sessionId);
        if (serial != null && serial !== '') {
            const claim = this.claims.get(serial);
            if (claim == null || claim.sessionId !== sessionId) {
                throw new Error(`设备 ${serial} 未被本会话认领。先调用 android_pane_attach。`);
            }
            return serial;
        }
        if (mine.length === 1)
            return mine[0][0];
        if (mine.length === 0)
            throw new Error('本会话尚未 attach 任何设备。先调用 android_pane_attach。');
        throw new Error(`本会话认领了 ${mine.length} 台设备，请指定 serial：${mine.map(([s]) => s).join(', ')}`);
    }
    /** ⚠️ touch 注入通道决策（Android 17 + 深度定制系统 实测教训）：
     *  scrcpy 3.3.4 在此组合下把 touch 注入绑定到其虚拟 display（displayId 3, layerStack 3），
     *  事件到不了真实 display 0 的应用（keycode 不受影响）——故 touch 一律走 `adb input`（物理坐标），
     *  key/text/rotate 走 control socket（已实测可用）。adbPoint 负责流坐标→物理坐标换算。 */
    static TOUCH_VIA_CONTROL = false;
    /** performAct：调试会话时间线钩子 + 内层分发。agent 与面板操作都经此（单一咽喉）。 */
    async performAct(s, req, signal, via = 'agent') {
        const dbgId = this.debugBySerial.get(s);
        const dbg = dbgId != null ? this.debugSessions.get(dbgId) : undefined;
        // human 模式调试 = 人在操作，AI 注入会干扰录制与操作序列 → 拒绝（面板操作放行）
        if (via === 'agent' && dbg != null && dbg.stoppedAt == null && dbg.mode === 'human') {
            throw new Error('调试会话进行中（人操作模式）——AI 请勿注入干扰；如需接管先停止调试会话');
        }
        if (via === 'agent')
            this.streams.get(s)?.cancelPanelTouch();
        const act = dbg != null && dbg.stoppedAt == null ? { t: Date.now(), action: req.action } : undefined;
        let completed;
        let pending;
        if (act != null) {
            dbg.acts.push(act);
            this.persistDebug(dbg);
            pending = new Promise(resolve => { completed = resolve; });
            (dbg.pendingActions ??= new Set()).add(pending);
        }
        try {
            const performed = await this.performActInner(s, req, signal, via);
            if (act != null)
                act.detail = performed;
            return performed;
        }
        catch (e) {
            if (act != null)
                act.detail = 'FAILED: ' + String(e instanceof Error ? e.message : e);
            throw e;
        }
        finally {
            if (act != null) {
                act.endedAt = Date.now();
                completed();
                dbg.pendingActions.delete(pending);
                if (!dbg.saved && !this.disposed)
                    this.persistDebug(dbg);
            }
        }
    }
    async performActInner(s, req, signal, via = 'agent') {
        const stream = this.streams.get(s);
        const h264 = stream != null && stream.running;
        switch (req.action) {
            case 'tap': {
                const x = Math.round(req.x ?? 0);
                const y = Math.round(req.y ?? 0);
                if (PaneHub.TOUCH_VIA_CONTROL && h264) {
                    stream.injectTouch(x, y, ACTION_DOWN);
                    stream.injectTouch(x, y, ACTION_UP);
                }
                else {
                    const p = via === 'panel' && req.coordinateSpace !== 'physical' ? this.adbPoint(s, x, y) : { x, y };
                    await this.adb.shellOk(s, `input tap ${p.x} ${p.y}`, { signal, timeoutMs: 10_000 });
                }
                return `tap(${x},${y})${PaneHub.TOUCH_VIA_CONTROL && h264 ? '|ctl' : '|adb'}`;
            }
            case 'swipe': {
                const x1 = Math.round(req.x ?? 0);
                const y1 = Math.round(req.y ?? 0);
                const x2 = Math.round(req.x2 ?? req.x ?? 0);
                const y2 = Math.round(req.y2 ?? req.y ?? 0);
                const dur = Math.min(2000, Math.max(80, req.durationMs ?? 300));
                if (PaneHub.TOUCH_VIA_CONTROL && h264) {
                    await stream.injectSwipe(x1, y1, x2, y2, dur);
                }
                else {
                    const p1 = via === 'panel' ? this.adbPoint(s, x1, y1) : { x: x1, y: y1 };
                    const p2 = via === 'panel' ? this.adbPoint(s, x2, y2) : { x: x2, y: y2 };
                    await this.adb.shellOk(s, `input swipe ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${dur}`, { signal, timeoutMs: 12_000 });
                }
                return `swipe(${x1},${y1}→${x2},${y2},${dur}ms)${PaneHub.TOUCH_VIA_CONTROL && h264 ? '|ctl' : '|adb'}`;
            }
            case 'key': {
                const name = req.key ?? '';
                const keycode = KEYCODE[name];
                if (keycode == null)
                    throw new Error(`未知按键 ${name}（可用：${Object.keys(KEYCODE).join('/')}）`);
                if (h264)
                    stream.tapKey(keycode);
                else
                    await this.adb.shellOk(s, `input keyevent ${keycode}`, { signal, timeoutMs: 10_000 });
                return `key(${name})`;
            }
            case 'text': {
                const text = req.text ?? '';
                if (text === '')
                    throw new Error('text 不能为空');
                const ascii = /^[\x20-\x7e]*$/.test(text) && Buffer.byteLength(text, 'utf8') <= 300;
                if (h264) {
                    if (ascii) {
                        stream.injectText(text);
                    }
                    else {
                        // 非 ASCII：优先 ADBKeyboard（深度定制系统 限制 shell 剪贴板写入，实测粘贴不上屏）
                        const ime = await this.imeStatus(s, signal);
                        if (ime.installed)
                            return `text(${text.length} chars): ${await this.imeSend(s, text, signal)}`;
                        stream.injectText(text); // 剪贴板+粘贴（AOSP 可用；深度定制系统 可能不上屏）
                        return `text(${text.length} chars via clipboard)`;
                    }
                }
                else {
                    if (!ascii)
                        throw new Error('poll 降级模式不支持非 ASCII 文本；请安装 ADBKeyboard（android_pane_install_ime）或恢复 h264 模式');
                    await this.adb.shellOk(s, `input text ${JSON.stringify(text).slice(1, -1).replace(/ /g, '%s')}`, { signal, timeoutMs: 10_000 });
                }
                return `text(${text.length} chars)`;
            }
            case 'scroll': {
                const x = Math.round(req.x ?? 0);
                const y = Math.round(req.y ?? 0);
                const dy = req.y2 != null ? Math.round(req.y2) : -1;
                if (h264) {
                    const meta = stream.info;
                    const dim = stream.displayDim;
                    // Tools use display pixels; scrcpy scroll uses the encoded frame space.
                    const sx = via === 'agent' && meta != null ? x * meta.streamWidth / dim.w : x;
                    const sy = via === 'agent' && meta != null ? y * meta.streamHeight / dim.h : y;
                    stream.scroll(sx, sy, 0, dy);
                }
                else {
                    const p = via === 'panel' ? this.adbPoint(s, x, y) : { x, y };
                    await this.adb.shellOk(s, `input swipe ${p.x} ${p.y} ${p.x} ${p.y + dy * 400} 300`, { signal, timeoutMs: 10_000 });
                }
                return `scroll(${x},${y},dy=${dy})`;
            }
            case 'back':
            case 'home':
            case 'recents':
            case 'volume_up':
            case 'volume_down': {
                const keycode = KEYCODE[req.action];
                if (h264)
                    stream.tapKey(keycode);
                else
                    await this.adb.shellOk(s, `input keyevent ${keycode}`, { signal, timeoutMs: 10_000 });
                return req.action;
            }
            case 'rotate': {
                return this.rotate(s, signal);
            }
            default:
                throw new Error(`未知动作 ${String(req.action)}`);
        }
    }
    /** ADBKeyboard 输入法状态。 */
    async imeStatus(s, signal) {
        const all = (await this.adb.shell(s, 'ime list -a -s', { signal, timeoutMs: 8_000 }).catch(() => ({ stdout: '' }))).stdout;
        const installed = all.split('\n').some((l) => l.trim().startsWith('com.android.adbkeyboard'));
        const cur = (await this.adb.shell(s, 'settings get secure default_input_method', { signal, timeoutMs: 6_000 }).catch(() => ({ stdout: '' }))).stdout.trim();
        return { installed, current: cur };
    }
    async activateIme(s, previous, signal) {
        // Installed does not mean enabled: Android refuses to select a disabled input method.
        await this.adb.shellOk(s, 'ime enable com.android.adbkeyboard/.AdbIME', { signal, timeoutMs: 8_000 });
        await this.adb.shellOk(s, 'ime set com.android.adbkeyboard/.AdbIME', { signal, timeoutMs: 8_000 });
        if ((await this.imeStatus(s, signal)).current !== 'com.android.adbkeyboard/.AdbIME')
            throw new Error('ADBKeyboard 激活回读失败，不能保证中文输入');
        if (!this.prevIme.has(s))
            this.prevIme.set(s, previous);
    }
    /** Input method must still be active; never report a broadcast to an inactive IME as typed text. */
    async imeSend(s, text, signal) {
        if ((await this.imeStatus(s, signal)).current !== 'com.android.adbkeyboard/.AdbIME')
            throw new Error('ADBKeyboard 未激活，中文未发送；重新连接设备后再聚焦输入框');
        const escaped = text.replace(/'/g, "'\\''");
        await this.adb.shellOk(s, `am broadcast -a ADB_INPUT_TEXT --es msg '${escaped}'`, { signal, timeoutMs: 10_000 });
        await new Promise((r) => setTimeout(r, 350));
        return `text(${text.length} chars via ADBKeyboard)`;
    }
    /** 安装 ADBKeyboard.apk 并启用输入法（一次性设置；深度定制系统 会弹设备端确认）。 */
    async installIme(serial, signal) {
        const imeApk = join(dirname(this.opts.jarPath), 'ADBKeyboard.apk');
        const r = await this.adb.run(['-s', serial, 'install', '-r', imeApk], { signal, timeoutMs: 90_000 });
        if (r.code !== 0 || /Failure/.test(r.stdout + r.stderr)) {
            throw new Error(`ADBKeyboard 安装失败：${(r.stderr || r.stdout).slice(0, 200)}（深度定制系统 需在手机上确认「USB 安装」并开启安装权限）`);
        }
        await this.adb.shellOk(serial, 'ime enable com.android.adbkeyboard/.AdbIME', { signal, timeoutMs: 8_000 });
        return { installed: true, note: 'ADBKeyboard 已安装并启用' };
    }
    /** 首个在线设备 serial。 */
    firstOnlineSerial() {
        return this.devicesCache.find((d) => d.state === 'device')?.serial ?? null;
    }
    async rotate(s, signal) {
        const cur = (await this.adb.shell(s, 'settings get system user_rotation', { signal })).stdout.trim();
        const current = /^\d$/.test(cur) ? Number(cur) : 0;
        const next = (current + 1) % 4;
        await this.adb.shellOk(s, 'settings put system accelerometer_rotation 0', { signal, timeoutMs: 8_000 });
        await this.adb.shellOk(s, `settings put system user_rotation ${next}`, { signal, timeoutMs: 8_000 });
        return `rotate→user_rotation=${next}`;
    }
    captureState() {
        const state = this.state.reload();
        const rec = [...this.records.entries()][0];
        const dbg = [...this.debugBySerial.values()].map(id => this.debugSessions.get(id)).find(s => s != null);
        return {
            directory: this.state.data.directory,
            record: rec == null ? null : { serial: rec[0], startedAt: rec[1].startedAt, stoppedAt: rec[1].stoppedAt, status: rec[1].status, ...(rec[1].error ? { error: rec[1].error } : {}) },
            debug: dbg == null ? null : { id: dbg.id, serial: dbg.serial, startedAt: dbg.startedAt, stoppedAt: dbg.stoppedAt, status: this.debugCapturing(dbg) ? 'recording' : 'pending-save', ...(dbg.error ? { error: dbg.error } : {}) },
            outputs: this.state.data.outputs.map(({ identities: _identities, ...output }) => output),
            muted: Object.fromEntries(Object.keys(state.volumeRestore).map(serial => [serial, true])),
        };
    }
    debugCapturing(sess) {
        return sess.stoppedAt == null || [sess.recordProc, sess.logProc].some(proc => proc != null && !this.captureProcesses.get(proc)?.done);
    }
    setCaptureDirectory(directory) {
        if (this.captureStarting || this.captureWrites > 0 || [...this.records.values()].some(r => r.status === 'recording') || [...this.debugBySerial.values()].some(id => { const sess = this.debugSessions.get(id); return sess != null && this.debugCapturing(sess); })) {
            throw Object.assign(new Error('采集或保存中不能修改目录；停止后保存失败可修改并重试'), { code: 'capture-busy' });
        }
        this.state.setDirectory(directory);
    }
    async capturePanel(serial, type, action) {
        this.assertPanelAvailable(serial);
        const device = (await this.ensureDevices()).find(d => d.serial === serial && d.state === 'device');
        if (device == null)
            throw new Error('设备不在线：' + serial);
        this.assertPanelAvailable(serial);
        if (type === 'screenshot')
            await this.saveScreenshot(serial);
        else if (type === 'record')
            await this.record(serial, action);
        else if (type === 'debug') {
            if (action === 'stop')
                await this.debugStop(serial);
            else {
                const { id } = await this.debugStart(serial, 'human');
                const sess = this.debugSessions.get(id);
                try {
                    await Promise.all([this.captureReady(sess.recordProc), this.captureReady(sess.logProc)]);
                }
                catch (e) {
                    sess.error = String(e instanceof Error ? e.message : e);
                    await this.debugStop(serial).catch(() => undefined);
                    throw e;
                }
            }
        }
        else
            await this.toggleMute(serial);
    }
    async toggleMute(serial) {
        const work = this.muteQueue.then(async () => {
            if (this.disposed)
                throw new Error('采集服务已关闭');
            this.assertPanelAvailable(serial);
            const read = async () => {
                const out = await this.adb.runOk(['-s', serial, 'shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--get'], { timeoutMs: 8_000 });
                const match = /volume is (\d+)/i.exec(out);
                if (match == null)
                    throw new Error('无法读取媒体音量（stream 3）：' + out.slice(0, 200));
                return Number(match[1]);
            };
            const current = await read();
            this.assertPanelAvailable(serial);
            const previous = this.state.reload().volumeRestore[serial];
            const desired = previous ?? 0;
            // Persist restoration intent before changing the device, including an original volume of zero.
            if (previous == null)
                this.state.setVolumeRestore(serial, current);
            try {
                await this.adb.runOk(['-s', serial, 'shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', String(desired)], { timeoutMs: 8_000 });
                if (await read() !== desired)
                    throw new Error('设备媒体音量回读与目标不一致；静音状态未改变');
            }
            catch (e) {
                // A write may have reached the device even when its acknowledgment/readback failed.
                try {
                    await this.adb.runOk(['-s', serial, 'shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', String(current)], { timeoutMs: 8_000 });
                    if (await read() !== current)
                        throw new Error('媒体音量回滚回读失败');
                    if (previous == null)
                        this.state.setVolumeRestore(serial);
                }
                catch (err) {
                    this.opts.log('媒体音量失败后还原失败，已保留恢复意图：' + String(err));
                }
                throw e;
            }
            if (previous != null)
                this.state.setVolumeRestore(serial); // Original zero is a valid restore target.
        });
        this.muteQueue = work.catch(() => undefined);
        await work;
    }
    captureFile(id, index) {
        const output = this.state.data.outputs.find(o => o.id === id);
        const file = output?.files[index];
        const identity = output?.identities[index];
        if (file == null || identity == null || !Number.isSafeInteger(index) || index < 0)
            throw Object.assign(new Error('未登记的保存文件'), { code: 'not-found' });
        const stat = lstatSync(file);
        if (!stat.isFile() || realpathSync(file) !== file || stat.dev !== identity.dev || stat.ino !== identity.ino)
            throw Object.assign(new Error('保存文件已被替换或不是普通文件'), { code: 'not-found' });
        return { file, ...identity };
    }
    activeDirectory() {
        return [...this.records.values()][0]?.dir ?? [...this.debugBySerial.values()].map(id => this.debugSessions.get(id)?.dir).find(d => d != null) ?? this.state.data.directory;
    }
    async saveScreenshot(serial, signal) {
        this.captureWrites++;
        const id = 'shot-' + randomUUID();
        let tmp;
        try {
            const dir = validateCaptureDirectory(this.activeDirectory());
            const secure = await this.checkSecure(serial, signal);
            if (secure.secure && secure.captureVisible !== true)
                throw new Error('受保护页面不可截图：截图通道为黑屏，请改用内容大纲');
            const png = await this.adb.screencap(serial, { signal });
            if (this.disposed)
                throw new Error('采集服务已关闭；截图未保存');
            if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
                throw new Error('设备未返回有效 PNG；截图未保存');
            const file = join(dir, id + '.png');
            tmp = file + '.tmp';
            writeFileSync(tmp, png, { flag: 'wx', mode: 0o600 });
            renameSync(tmp, file);
            this.state.registerOutput(id, 'screenshot', [file]);
            return file;
        }
        finally {
            if (tmp != null)
                try {
                    unlinkSync(tmp);
                }
                catch { /* already renamed */ }
            this.captureWrites--;
        }
    }
    async screenshotBuffer(serial, signal) {
        return this.adb.screencap(serial, { signal });
    }
    /** uiautomator 结构化控件树（规则：验证闭环增强）。 */
    async uidump(serial, signal) {
        const dump = async (cmd) => {
            const r = await this.adb.shell(serial, cmd, { signal, timeoutMs: 20_000 });
            return r.code === 0 ? r.stdout : null;
        };
        let ok = await dump('uiautomator dump --compressed /data/local/tmp/dsh_uidump.xml');
        if (ok == null)
            ok = await dump('uiautomator dump /data/local/tmp/dsh_uidump.xml');
        if (ok == null)
            throw new Error('uiautomator dump 失败（设备可能不支持或 UI 自动化被系统限制）');
        const xml = await this.adb.shellOk(serial, 'cat /data/local/tmp/dsh_uidump.xml', { signal, timeoutMs: 10_000 });
        if (xml.length < 200)
            throw new Error(`uiautomator dump 输出异常（${xml.length} 字节）——设备可能正在转屏或 UI 自动化被占用`);
        const nodes = [];
        // tokenizer 区分 <node …/>（自闭合）/ <node …>（开）/ </node>（闭）→ 维护层级深度（大纲缩进用，B22b）
        let depth = 0;
        const tokenRe = /<node[^>]*?\/>|<node[^>]*>|<\/node>/g;
        for (const tok of xml.match(tokenRe) ?? []) {
            if (tok === '</node>') {
                depth--;
                continue;
            }
            const selfClosing = tok.endsWith('/>');
            const nodeDepth = depth;
            if (!selfClosing)
                depth++;
            const attr = (name) => {
                const m = new RegExp(`${name}="([^"]*)"`).exec(tok);
                return m?.[1] ?? '';
            };
            const b = /(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)/.exec(attr('bounds'));
            if (b == null)
                continue;
            const x1 = Number(b[1]);
            const y1 = Number(b[2]);
            const x2 = Number(b[3]);
            const y2 = Number(b[4]);
            const text = attr('text');
            const desc = attr('content-desc');
            const clickable = attr('clickable') === 'true';
            if (!clickable && text === '' && desc === '')
                continue;
            nodes.push({
                text: text.slice(0, 80),
                desc: desc.slice(0, 80),
                cls: attr('class').slice(0, 40),
                clickable,
                center: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)],
                depth: nodeDepth,
            });
            if (nodes.length >= 100)
                break;
        }
        return nodes;
    }
    async nativeCaptureOptions(serial, signal) {
        const { maxSize, videoBitRate } = this.state.data.quality;
        if (!Number.isSafeInteger(maxSize) || maxSize < 128 || maxSize > 4096 || !Number.isSafeInteger(videoBitRate) || videoBitRate < 1)
            throw new Error('录制画质参数无效');
        const png = await this.adb.screencap(serial, { signal });
        if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIG))
            throw new Error('无法读取录制画面尺寸');
        const w = png.readUInt32BE(16), height = png.readUInt32BE(20);
        if (!w || !height)
            throw new Error('设备录制画面尺寸无效');
        const scale = Math.min(1, maxSize / Math.max(w, height));
        // Use existing quality bounds, not native screenrecord's full-size/high-refresh default.
        return '--size ' + Math.max(8, Math.round(w * scale / 8) * 8) + 'x' + Math.max(8, Math.round(height * scale / 8) * 8) + ' --bit-rate ' + videoBitRate + ' ';
    }
    /** Only generated remote paths enter this command; host directories never enter a shell. */
    spawnCapture(serial, command) {
        if (this.disposed)
            throw new Error('采集服务已关闭');
        const proc = spawn(this.adb.path, ['-s', serial, 'shell', 'echo $$; exec ' + command], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let resolveReady, rejectReady, resolveClosed;
        const ready = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; });
        const closed = new Promise(yes => { resolveClosed = yes; });
        const info = { ready, closed, stderr: '', done: false, pid: undefined, error: undefined };
        this.captureProcesses.set(proc, info);
        void ready.catch(() => undefined); // Startup and finalization both consume this promise.
        const timer = setTimeout(() => rejectReady(new Error('采集进程启动超时：' + serial)), 8_000);
        let output = '';
        proc.stdout?.on('data', (data) => {
            if (info.pid != null)
                return;
            output += data.toString('utf8');
            const match = /^(\d+)\r?\n/.exec(output);
            if (match != null) {
                info.pid = match[1];
                clearTimeout(timer);
                resolveReady(match[1]);
            }
        });
        proc.stderr?.on('data', (data) => { info.stderr = (info.stderr + data.toString('utf8')).slice(-4000); });
        proc.once('error', e => { info.error = e.message; rejectReady(e); });
        proc.once('close', code => {
            info.done = true;
            clearTimeout(timer);
            rejectReady(new Error('采集进程未启动：' + (info.error ?? info.stderr)));
            resolveClosed(code);
        });
        return proc;
    }
    async captureReady(proc) {
        const info = this.captureProcesses.get(proc);
        await info.ready;
        await new Promise(resolve => setTimeout(resolve, 250));
        if (info.done || info.error)
            throw new Error('设备采集启动失败：' + (info.error ?? info.stderr));
    }
    async stopCaptureProcess(serial, proc, signal) {
        const info = this.captureProcesses.get(proc);
        if (info.done)
            return;
        const pid = await info.ready;
        // Native SIGINT writes the MP4 trailer; the old SIGKILL path lost frames/trailers.
        await this.adb.runOk(['-s', serial, 'shell', 'kill', '-2', pid], { signal, timeoutMs: 8_000 });
        let timer;
        try {
            await Promise.race([info.closed, new Promise((_, no) => { timer = setTimeout(() => no(new Error('设备采集停止超时：' + serial)), 15_000); })]);
        }
        finally {
            if (timer != null)
                clearTimeout(timer);
        }
    }
    async pullCapture(serial, remote, file, signal, allowEmpty = false) {
        const tmp = file + '.' + randomUUID() + '.tmp';
        try {
            await this.adb.runOk(['-s', serial, 'pull', remote, tmp], { signal, timeoutMs: 120_000 });
            if (this.disposed)
                throw new Error('采集服务已重载；设备原件已保留，请在当前面板重试保存');
            const stat = lstatSync(tmp);
            if (stat.isFile() && stat.size === 0 && allowEmpty)
                return false;
            if (!stat.isFile() || stat.size === 0)
                throw new Error('设备采集文件为空：' + remote);
            if (file.endsWith('.mp4')) {
                const fd = openSync(tmp, 'r'), header = Buffer.alloc(16), atoms = new Set();
                try {
                    // ponytail: MP4 container/trailer check only; use ffprobe if codec-level validation is required.
                    for (let offset = 0; offset < stat.size;) {
                        if (readSync(fd, header, 0, 8, offset) !== 8)
                            throw new Error('录屏 MP4 头被截断：' + remote);
                        let size = header.readUInt32BE(0);
                        const headerSize = size === 1 ? 16 : 8;
                        if (size === 1) {
                            if (readSync(fd, header, 8, 8, offset + 8) !== 8)
                                throw new Error('录屏 MP4 大文件头被截断');
                            size = Number(header.readBigUInt64BE(8));
                        }
                        if (size === 0)
                            size = stat.size - offset;
                        if (!Number.isSafeInteger(size) || size < headerSize || offset + size > stat.size)
                            throw new Error('录屏 MP4 文件不完整：' + remote);
                        atoms.add(header.toString('ascii', 4, 8));
                        offset += size;
                    }
                    if (!['ftyp', 'mdat', 'moov'].every(atom => atoms.has(atom)))
                        throw new Error('录屏 MP4 未完成封装：' + remote);
                }
                finally {
                    closeSync(fd);
                }
            }
            renameSync(tmp, file);
            return true;
        }
        finally {
            try {
                unlinkSync(tmp);
            }
            catch { /* moved or not created */ }
        }
    }
    async stopRecord(serial, outDir, signal) {
        const rec = this.records.get(serial);
        if (rec == null)
            return undefined;
        if (rec.saving != null)
            return rec.saving;
        const retry = rec.status === 'pending-save';
        this.captureWrites++;
        rec.saving = (async () => {
            try {
                if (rec.proc == null)
                    await this.stopRecoveredCapture(serial, rec.file, signal);
                else
                    await this.stopCaptureProcess(serial, rec.proc, signal);
                if (this.disposed)
                    throw new Error('采集服务已重载，请在当前面板重试保存');
                rec.status = 'pending-save';
                rec.stoppedAt ??= Date.now();
                this.persistRecord(serial);
                const dir = validateCaptureDirectory(retry ? (outDir ?? this.state.data.directory) : rec.dir);
                const local = join(dir, rec.id + '.mp4');
                await this.pullCapture(serial, rec.file, local, signal);
                this.state.registerOutput(rec.id, 'record', [local], rec.captureError);
                this.records.delete(serial);
                if (!this.disposed)
                    await this.adb.run(['-s', serial, 'shell', 'rm', '-f', rec.file], { timeoutMs: 5_000 }).catch(e => this.opts.log('设备原片清理失败：' + String(e)));
                return local;
            }
            catch (e) {
                rec.error = String(e instanceof Error ? e.message : e);
                if (rec.proc == null || this.captureProcesses.get(rec.proc)?.done)
                    rec.status = 'pending-save';
                if (!this.disposed)
                    this.persistRecord(serial);
                throw e;
            }
            finally {
                rec.saving = undefined;
                this.captureWrites--;
            }
        })();
        return rec.saving;
    }
    async record(serial, action, outDir, signal) {
        if (action === 'start') {
            if (this.disposed || this.captureStarting || this.captureWrites > 0)
                throw Object.assign(new Error('采集服务正忙或已关闭'), { code: 'capture-busy' });
            if (this.debugBySerial.size > 0)
                throw Object.assign(new Error('存在调试或待保存会话——先停止并保存'), { code: 'capture-busy' });
            const existing = this.records.get(serial);
            if (existing?.status === 'recording')
                return { note: '已在录制中（最长 180 秒）' };
            if (this.records.size > 0)
                throw Object.assign(new Error('存在录屏或待保存记录——先停止并保存'), { code: 'capture-busy' });
            this.captureStarting = true;
            try {
                const dir = validateCaptureDirectory(outDir ?? this.state.data.directory);
                // Screenshot visibility does not prove Android screenrecord can capture a protected window.
                if ((await this.checkSecure(serial, signal)).secure)
                    throw new Error('受保护页面不能开始普通录屏；调试可继续，但视频可能黑屏');
                const id = 'record-' + randomUUID(), remote = '/data/local/tmp/dsh_' + id + '.mp4';
                const options = await this.nativeCaptureOptions(serial, signal);
                const rec = { proc: null, file: remote, id, dir, startedAt: Date.now(), status: 'recording', error: undefined, captureError: undefined, saving: undefined };
                this.state.upsertPending({ id, type: 'record', serial, dir, startedAt: rec.startedAt, remote });
                this.records.set(serial, rec);
                const proc = this.spawnCapture(serial, 'screenrecord ' + options + '--time-limit 180 ' + remote);
                rec.proc = proc;
                proc.once('close', code => {
                    if (rec.status !== 'recording')
                        return;
                    if (code !== 0 && rec.saving == null)
                        rec.captureError = '设备录屏提前结束：' + (this.captureProcesses.get(proc)?.stderr ?? String(code));
                    void this.stopRecord(serial).catch(e => this.opts.log('自动保存录屏失败：' + String(e)));
                });
                if (signal != null) {
                    const abort = () => { void this.stopRecord(serial).catch(e => this.opts.log('取消录屏保存失败：' + String(e))); };
                    if (signal.aborted)
                        abort();
                    else {
                        signal.addEventListener('abort', abort, { once: true });
                        proc.once('close', () => signal.removeEventListener('abort', abort));
                    }
                }
                await this.captureReady(proc);
                return { note: '录制已开始（最长 180 秒，届时宿主自动保存）' };
            }
            catch (e) {
                const rec = this.records.get(serial);
                if (rec != null) {
                    rec.error = String(e instanceof Error ? e.message : e);
                    void this.stopRecord(serial).catch(err => this.opts.log('启动失败后保存录屏失败：' + String(err)));
                }
                throw e;
            }
            finally {
                this.captureStarting = false;
            }
        }
        const file = await this.stopRecord(serial, outDir, signal);
        return file == null ? { note: '当前没有进行中的录制' } : { file, note: '已保存' };
    }
    /** 元素级操作基础：按条件在 uiautomator 树里找节点（权威坐标，杜绝截图目测打偏）。 */
    async uiFind(serial, criteria, signal) {
        const nodes = await this.uidump(serial, signal);
        const target = (criteria.target ?? '').trim();
        let matched = nodes;
        if (target !== '') {
            const t = target.toLowerCase();
            const hit = (n) => n.text.toLowerCase().includes(t) || n.desc.toLowerCase().includes(t) || n.cls.toLowerCase().includes(t);
            matched = nodes.filter(hit);
            if (matched.length === 0) {
                // 宽松兜底：去掉空白再比一次（text/desc）
                const t2 = t.replace(/\s+/g, '');
                matched = nodes.filter((n) => n.text.replace(/\s+/g, '').toLowerCase().includes(t2) || n.desc.replace(/\s+/g, '').toLowerCase().includes(t2));
            }
        }
        if (matched.length === 0) {
            const sample = nodes.slice(0, 8).map((n) => n.text || n.desc || n.cls).filter(Boolean).join(' | ');
            throw new Error(`未找到匹配元素（target="${target}"）。当前屏可交互元素样例：${sample || '（无）'}——可先调 action=find 不带 target 看全量，或滑动/翻页后再试`);
        }
        const idx = Math.max(0, Math.min(matched.length - 1, criteria.index ?? 0));
        const n = matched[idx];
        const dumpAll = criteria.target == null || criteria.target === '';
        return {
            index: idx,
            total: dumpAll ? nodes.length : matched.length,
            text: n.text,
            desc: n.desc,
            cls: n.cls,
            clickable: n.clickable,
            center: n.center,
            bounds: [n.center[0], n.center[1], n.center[0], n.center[1]],
        };
    }
    /** 元素点击：解析权威坐标后走统一注入通道。 */
    async uiTap(serial, criteria, signal) {
        const node = await this.uiFind(serial, criteria, signal);
        const performed = await this.performAct(serial, { action: 'tap', x: node.center[0], y: node.center[1] }, signal, 'agent');
        return { performed: `${performed} @element(${node.text || node.desc || node.cls})`, node };
    }
    /** 元素设值：定位 → 点聚焦 → 按原内容长度清空 → ADBKeyboard/文本注入。中文可靠。 */
    async uiSetText(serial, args, signal) {
        const node = await this.uiFind(serial, { target: args.target, index: args.index }, signal);
        // 聚焦
        await this.performAct(serial, { action: 'tap', x: node.center[0], y: node.center[1] }, signal, 'agent');
        await new Promise((r) => setTimeout(r, 400));
        // 清空原内容：按 uiautomator 报告的现有文本长度发 DEL（MOVE_END 先跳尾）
        if (args.clear !== false && node.text.length > 0) {
            const n = Math.min(node.text.length + 2, 60);
            await this.performAct(serial, { action: 'key', key: 'move_end' }, signal, 'agent');
            for (let i = 0; i < n; i++)
                await this.performAct(serial, { action: 'key', key: 'del' }, signal, 'agent');
        }
        const r = await this.performAct(serial, { action: 'text', text: args.text }, signal, 'agent');
        await new Promise((r2) => setTimeout(r2, 500));
        const shot = await this.saveScreenshot(serial, signal).catch(() => null);
        return { performed: `${r} @element(${node.text || node.desc || node.cls})`, node, screenshotPath: shot };
    }
    // ───────────────── 调试会话（host 托管的录屏+logcat+操作时间线） ─────────────────
    // 场景①（人操作）：面板「调试」开关一键开/关，免对话仪式；场景②（AI 操作）：agent 工具强制留证，
    // analyze 把每个操作的帧图+logcat 片段物化进工具结果——LLM 无法"声称看过"而没有证据在上下文里。
    debugSessions = new Map();
    debugBySerial = new Map();
    async debugStart(serial, mode, signal) {
        const existingId = this.debugBySerial.get(serial);
        if (existingId != null) {
            const sess = this.debugSessions.get(existingId);
            if (sess.stoppedAt != null)
                throw Object.assign(new Error('调试已停止，保存失败；请停止按钮重试保存'), { code: 'capture-busy' });
            return { id: existingId, note: '调试会话已在进行中' };
        }
        if (this.disposed || this.captureStarting || this.captureWrites > 0 || this.records.size > 0 || this.debugBySerial.size > 0)
            throw Object.assign(new Error('已有采集或待保存记录——先停止并保存'), { code: 'capture-busy' });
        if (mode === 'human')
            this.assertPanelAvailable(serial); // No implicit release of an agent claim.
        this.captureStarting = true;
        let captureOptions;
        let clockStart;
        try {
            captureOptions = await this.nativeCaptureOptions(serial, signal);
            clockStart = await this.sampleDebugClock(serial, signal);
        }
        finally {
            this.captureStarting = false;
        }
        if (this.disposed)
            throw new Error('采集服务已关闭');
        if (mode === 'human')
            this.assertPanelAvailable(serial);
        const id = 'dbg-' + randomUUID();
        const dir = validateCaptureDirectory(this.state.data.directory);
        const sess = {
            id, serial, mode, captureOptions, clockStart, startedAt: Date.now(), segments: [], recordProc: null,
            logProc: null, logRing: [], logRingBytes: 0, errFile: join(dir, id + '-logcat.log'),
            errStream: null, acts: [], segIndex: 0, shortRotations: 0, rotateTimer: null, dir,
            logRemote: '/data/local/tmp/dsh_' + id + '-logcat.log',
        };
        this.persistDebug(sess);
        this.debugSessions.set(id, sess);
        this.debugBySerial.set(serial, id);
        try {
            await this.debugSpawnSegment(sess);
            this.debugSpawnLogcat(sess);
        }
        catch (e) {
            sess.error = String(e);
            void this.debugStop(serial).catch(err => this.opts.log('调试启动失败：' + String(err)));
            throw e;
        }
        if (signal != null) {
            const abort = () => { void this.debugStop(serial).catch(e => this.opts.log('取消调试保存失败：' + String(e))); };
            if (signal.aborted)
                abort();
            else {
                signal.addEventListener('abort', abort, { once: true });
                sess.logProc?.once('close', () => signal.removeEventListener('abort', abort));
            }
        }
        return { id, note: '调试已启动：录屏分段、全量 logcat 与操作时间线；受保护页面可能黑屏' };
    }
    async sampleDebugClock(serial, signal) {
        try {
            const before = Date.now();
            const out = (await this.adb.runOk(['-s', serial, 'shell', 'date', '+%s%N'], { signal, timeoutMs: 2000 })).trim();
            const after = Date.now();
            if (!/^\d{19}$/.test(out) || after < before || after - before > MAX_CLOCK_WIDTH_MS - 2)
                throw new Error('设备时钟精度或往返时间不可用');
            const deviceMs = Number(BigInt(out)) / 1e6;
            return { minOffsetMs: before - deviceMs - 1, maxOffsetMs: after - deviceMs + 1 };
        }
        catch (e) {
            this.opts.log('调试时间未校准（仍保留录屏与日志）：' + String(e));
            return undefined;
        }
    }
    async debugSpawnSegment(sess) {
        if (sess.stoppedAt != null || this.disposed)
            return;
        // Sample before spawning screenrecord: adb start-up traffic makes a concurrent sample miss its bound.
        const clock = await this.sampleDebugClock(sess.serial);
        if (sess.stoppedAt != null || this.disposed)
            return;
        const remote = '/data/local/tmp/dsh_' + sess.id + '_' + sess.segIndex++ + '.mp4';
        const seg = { remote, startEpoch: Date.now(), ...(clock == null ? {} : { clock }) };
        sess.segments.push(seg);
        this.persistDebug(sess);
        const proc = this.spawnCapture(sess.serial, 'screenrecord ' + sess.captureOptions + '--time-limit 170 ' + remote);
        sess.recordProc = proc;
        proc.once('close', code => {
            seg.endEpoch = Date.now();
            try {
                if (!this.disposed)
                    this.persistDebug(sess);
                if (sess.stoppedAt != null || this.disposed)
                    return;
                const info = this.captureProcesses.get(proc);
                if (code !== 0 || seg.endEpoch - seg.startEpoch < 20_000)
                    throw new Error('设备录屏提前退出：' + (info.error ?? info.stderr ?? String(code)));
                void this.debugSpawnSegment(sess).catch(e => { sess.captureError = String(e instanceof Error ? e.message : e); void this.debugStop(sess.serial).catch(err => this.opts.log('调试异常停止：' + String(err))); });
            }
            catch (e) {
                sess.captureError = String(e instanceof Error ? e.message : e);
                void this.debugStop(sess.serial).catch(err => this.opts.log('调试异常停止：' + String(err)));
            }
        });
    }
    debugSpawnLogcat(sess) {
        // Full logcat lives on the device until successful saving, so a host write failure cannot drop logs.
        const proc = this.spawnCapture(sess.serial, 'logcat -v epoch -f ' + sess.logRemote);
        sess.logProc = proc;
        proc.once('close', code => {
            if (sess.stoppedAt != null || this.disposed)
                return;
            sess.captureError = '设备 logcat 提前退出：' + (this.captureProcesses.get(proc)?.stderr ?? String(code));
            void this.debugStop(sess.serial).catch(e => this.opts.log('日志异常停止：' + String(e)));
        });
    }
    async loadDebugLog(sess, file) {
        sess.logRing = [];
        sess.logRingBytes = 0;
        const input = createReadStream(file, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        // ponytail: analysis keeps the newest 24MB; prune dead prefixes in batches, never shift every line.
        // Full unfiltered logcat remains in the saved .log.
        let first = 0;
        const clock = debugClockBounds(sess.clockStart, sess.clockEnd);
        const offset = clock ? (clock.minOffsetMs + clock.maxOffsetMs) / 2 : 0;
        for await (const line of lines) {
            const match = /^\s*(\d+\.\d+)/.exec(line);
            const rec = (match == null ? sess.startedAt : Math.round(Number(match[1]) * 1000 + offset)) + '\t' + line;
            sess.logRing.push(rec);
            sess.logRingBytes += Buffer.byteLength(rec) + 1;
            while (sess.logRingBytes > 24_000_000 && first < sess.logRing.length)
                sess.logRingBytes -= Buffer.byteLength(sess.logRing[first++]) + 1;
            if (first >= 10_000) {
                sess.logRing.splice(0, first);
                first = 0;
            }
        }
        if (first)
            sess.logRing.splice(0, first);
    }
    async debugStop(serial) {
        const id = this.debugBySerial.get(serial);
        if (id == null)
            return { id: '', note: '当前没有进行中的调试会话' };
        const sess = this.debugSessions.get(id);
        if (sess.saving != null)
            return sess.saving;
        const retry = sess.stoppedAt != null;
        if (sess.rotateTimer != null) {
            clearTimeout(sess.rotateTimer);
            sess.rotateTimer = null;
        }
        sess.stoppedAt ??= Date.now();
        this.captureWrites++;
        sess.saving = (async () => {
            try {
                await Promise.all([...(sess.pendingActions ?? [])]);
                await Promise.all([sess.recordProc == null ? Promise.all(sess.segments.map(seg => this.stopRecoveredCapture(serial, seg.remote))) : this.stopCaptureProcess(serial, sess.recordProc), sess.logProc == null ? this.stopRecoveredCapture(serial, sess.logRemote) : this.stopCaptureProcess(serial, sess.logProc)]);
                if (this.disposed)
                    throw new Error('采集服务已重载，请在当前面板重试保存');
                if (!retry)
                    sess.clockEnd = await this.sampleDebugClock(serial);
                this.persistDebug(sess);
                const dir = validateCaptureDirectory(retry ? this.state.data.directory : sess.dir);
                const files = [];
                for (const [index, seg] of sess.segments.entries()) {
                    const file = join(dir, sess.id + '-seg-' + String(index).padStart(3, '0') + '.mp4');
                    if (await this.pullCapture(serial, seg.remote, file, undefined, sess.captureError != null)) {
                        seg.local = file;
                        files.push(file);
                    }
                    else
                        seg.error = '此段采集启动失败，设备原件为空；已保留其余视频与日志';
                }
                if (files.length === 0)
                    throw new Error('调试没有录屏段，不能报告保存成功');
                const log = join(dir, sess.id + '-logcat.log');
                await this.pullCapture(serial, sess.logRemote, log);
                await this.loadDebugLog(sess, log);
                if (this.disposed)
                    throw new Error('采集服务已重载；设备原件已保留，请重试保存');
                const acts = join(dir, sess.id + '-actions.json'), tmp = acts + '.' + randomUUID() + '.tmp';
                try {
                    writeFileSync(tmp, JSON.stringify({ id: sess.id, serial, startedAt: sess.startedAt, stoppedAt: sess.stoppedAt, segments: sess.segments, actions: sess.acts, clockStart: sess.clockStart, clockEnd: sess.clockEnd, captureError: sess.captureError }, null, 2), { flag: 'wx', mode: 0o600 });
                    renameSync(tmp, acts);
                }
                finally {
                    try {
                        unlinkSync(tmp);
                    }
                    catch { /* moved */ }
                }
                files.push(log, acts);
                this.state.registerOutput(sess.id, 'debug', files, sess.captureError);
                sess.dir = dir;
                sess.errFile = log;
                sess.logLocal = log;
                sess.saved = true;
                this.debugBySerial.delete(serial);
                if (!this.disposed)
                    await this.adb.run(['-s', serial, 'shell', 'rm', '-f', ...sess.segments.map(s => s.remote), sess.logRemote], { timeoutMs: 5_000 }).catch(e => this.opts.log('调试原件清理失败：' + String(e)));
                return { id, note: '调试文件已保存' + (sess.captureError ? '；采集曾异常：' + sess.captureError : ''), summary: this.debugSummarize(sess) };
            }
            catch (e) {
                sess.error = String(e instanceof Error ? e.message : e);
                if (!this.disposed)
                    this.persistDebug(sess);
                throw e;
            }
            finally {
                sess.saving = undefined;
                this.captureWrites--;
            }
        })();
        return sess.saving;
    }
    debugSummarize(sess) {
        const durationMs = (sess.stoppedAt ?? Date.now()) - sess.startedAt;
        return {
            id: sess.id,
            serial: sess.serial,
            mode: sess.mode,
            startedAt: sess.startedAt,
            durationMs,
            mp4s: sess.segments.map((s) => s.local).filter((x) => x != null),
            errFile: sess.errFile,
            acts: sess.acts.length,
        };
    }
    debugStatus(serial) {
        if (serial != null) {
            const id = this.debugBySerial.get(serial);
            if (id == null)
                return { active: false };
            const sess = this.debugSessions.get(id);
            return { active: sess != null && this.debugCapturing(sess), id, startedAt: sess?.startedAt, mode: sess?.mode, acts: sess?.acts.length };
        }
        return { active: false, sessions: [...this.debugSessions.values()].map((s) => this.debugSummarize(s)) };
    }
    debugList() {
        return [...this.debugSessions.values()].map((s) => this.debugSummarize(s));
    }
    /** analyze：把每个操作的「前后帧图 + logcat 片段」物化为文件返回——证据强制进入 agent 上下文。 */
    async debugAnalyze(id) {
        const sess = (id != null ? this.debugSessions.get(id) : undefined) ??
            [...this.debugSessions.values()].filter((s) => s.stoppedAt != null).sort((a, b) => (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0))[0];
        if (sess == null)
            throw new Error('没有可分析的调试会话（先 start 并 stop）');
        if (sess.stoppedAt == null)
            throw new Error('调试会话仍在进行中——先停止再分析');
        if (!sess.saved)
            throw new Error('调试尚未完整保存——先重试保存再分析');
        const stoppedAt = sess.stoppedAt;
        const durationMs = stoppedAt - sess.startedAt;
        // 取证窗口：有操作时间线 → 每操作一个窗口；无（纯人手物理操作）→ 均匀采样
        const windows = sess.acts.length > 0
            ? sess.acts.slice(-12).map((a, i) => ({ t: a.t, endedAt: a.endedAt, label: `#${sess.acts.length - sess.acts.slice(-12).length + i + 1} ${a.action}` }))
            : Array.from({ length: Math.max(3, Math.min(8, Math.floor(durationMs / 6000))) }, (_, i) => ({
                t: sess.startedAt + Math.round((durationMs * (i + 1)) / (Math.min(8, Math.max(3, Math.floor(durationMs / 6000))) + 1)),
                label: `采样${i + 1}`,
            }));
        const { execFile } = await import('node:child_process');
        const runMedia = (bin, args) => new Promise((resolve, reject) => {
            execFile(bin, args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => err == null ? resolve(String(out)) : reject(err));
        });
        // Declared dependency of analyze, not of the pane itself: fail before touching any saved segment.
        for (const bin of ['ffmpeg', 'ffprobe']) {
            try {
                await runMedia(bin, ['-version']);
            }
            catch {
                throw new Error('调试分析需要 ' + bin + '（macOS: brew install ffmpeg；Ubuntu: apt install ffmpeg）');
            }
        }
        const framesDir = join(sess.dir, sess.id + '-frames');
        try {
            // Stale frames from a previous analyze of this session must never read as today's evidence.
            rmSync(framesDir, { recursive: true, force: true });
            mkdirSync(framesDir, { recursive: true });
        }
        catch (e) {
            throw new Error('无法准备取证帧目录：' + framesDir + '（' + (e instanceof Error ? e.message : String(e)) + '）');
        }
        const clock = debugClockBounds(sess.clockStart, sess.clockEnd);
        const frameIssues = [];
        if (!clock)
            frameIssues.push(sess.segments.some(s => s.clock)
                ? '会话起止时钟未校准或已漂移：日志切片不可对齐；帧改用各分段启动时的时钟采样'
                : '设备/宿主时钟未校准或已漂移：仅返回视频采样，不能证明操作前后；日志切片不可对齐');
        if (sess.acts.length > 12)
            frameIssues.push('只分析最近 12 个操作；更早的 ' + (sess.acts.length - 12) + ' 个未取前后帧（完整时间线仍在上方）');
        const sources = [];
        for (const seg of sess.segments) {
            if (!seg.local)
                continue;
            try {
                const probe = JSON.parse(await runMedia('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', seg.local]));
                const pts = probe.frames.map((f) => Number(f.best_effort_timestamp_time));
                if (!pts.length || pts.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= pts[i - 1])))
                    throw new Error('视频帧时间不可用');
                const source = { seg, pts };
                sources.push(source);
                const segClock = seg.clock ?? clock;
                if (segClock != null) {
                    const size = lstatSync(seg.local).size, fd = openSync(seg.local, 'r');
                    // ponytail: native metadata must fit the final 1MB; stream-scan if future formats exceed it.
                    const bytes = Buffer.alloc(Math.min(size, 1024 * 1024));
                    try {
                        if (readSync(fd, bytes, 0, bytes.length, size - bytes.length) !== bytes.length)
                            throw new Error('元数据读取不完整');
                    }
                    finally {
                        closeSync(fd);
                    }
                    source.epochs = nativeFrameEpochs(bytes, pts);
                    source.clock = segClock;
                }
            }
            catch (e) {
                frameIssues.push((seg.local ?? seg.remote) + '：' + String(e));
            }
        }
        const frames = [];
        const targets = [];
        for (const w of windows) {
            for (const tg of sess.acts.length ? [{ kind: 'pre', epoch: w.t - 600 }, { kind: 'post', epoch: (w.endedAt ?? w.t) + 1200 }] : [{ kind: 'sample', epoch: w.t }]) {
                const source = sources.find(s => s.epochs && s.seg.startEpoch <= tg.epoch && tg.epoch <= (s.seg.endEpoch ?? stoppedAt));
                if (!source) {
                    frameIssues.push(w.label + ' ' + tg.kind + '：该时刻不在已保存录屏段内（分段间隙或临近起止）');
                    continue;
                }
                if (source.clock == null)
                    continue;
                const index = selectDebugFrame(source.epochs, source.clock, tg.epoch, tg.kind);
                if (index >= 0) {
                    targets.push({ source, index, t: w.t, label: w.label, kind: tg.kind, requestedAt: tg.epoch });
                    continue;
                }
                if (tg.kind === 'pre') {
                    frameIssues.push(w.label + ' pre：录屏早于该操作，没有可证明的"操作前"画面');
                    continue;
                }
                // Sparse recordings only carry frames when the screen changes: no frame after the action is itself
                // evidence that nothing visibly changed. Return the last presented frame, explicitly not as a post frame.
                frameIssues.push(w.label + ' post：该操作后设备未产生新帧（画面无可见变化），已附最后可见画面');
                targets.push({ source, index: source.pts.length - 1, t: w.t, label: w.label + '（操作后无新帧）', kind: 'sample' });
            }
        }
        for (const source of sources.filter(s => !s.epochs).slice(-4)) {
            for (let i = 1; i <= 3; i++)
                targets.push({ source, index: Math.min(source.pts.length - 1, Math.floor(source.pts.length * i / 4)), t: source.seg.startEpoch, label: '未校准视频采样（不代表操作前后）', kind: 'sample' });
        }
        for (const [i, target] of targets.entries()) {
            const { source, index, kind } = target;
            const file = join(framesDir, 'f' + String(i + 1).padStart(2, '0') + '-' + kind + '.png');
            const tmp = file + '.' + randomUUID() + '.png';
            try {
                // Decode/select the exact probed frame index: input seek would select the next sparse frame.
                await runMedia('ffmpeg', ['-v', 'error', '-i', source.seg.local, '-map', '0:v:0', '-vf', 'select=eq(n\\,' + index + ')', '-fps_mode', 'vfr', '-frames:v', '1', '-n', tmp]);
                commitFrame(tmp, file);
                const sourceClock = source.clock;
                const calibrated = source.epochs != null && sourceClock != null;
                frames.push({ file, label: target.label, t: target.t, kind, pts: source.pts[index], requestedAt: target.requestedAt, timing: calibrated ? 'calibrated' : 'uncalibrated', ...(calibrated ? { frameAt: source.epochs[index] + (sourceClock.minOffsetMs + sourceClock.maxOffsetMs) / 2, uncertaintyMs: (sourceClock.maxOffsetMs - sourceClock.minOffsetMs) / 2 } : {}) });
            }
            catch (e) {
                frameIssues.push(target.label + ' ' + kind + '：' + (e instanceof Error ? e.message : String(e)).split(tmp).join(file));
            }
            finally {
                try {
                    unlinkSync(tmp);
                }
                catch { /* Only this unique extraction's temporary file. */ }
            }
        }
        // logcat 切片：内存保留最后 ~24MB，完整未过滤日志已保存到 errFile。
        const logLines = sess.logRing.filter((l) => l.includes('\t'));
        const slices = [];
        for (const w of clock ? windows : []) {
            const inWin = logLines.filter((l) => {
                const e = Number(l.slice(0, l.indexOf('\t')));
                return Number.isFinite(e) && e >= w.t - 2000 && e <= (w.endedAt ?? w.t) + 2500;
            });
            if (inWin.length > 0) {
                slices.push(`── ${w.label}（操作区间前2s/后2.5s，${inWin.length} 行）──`);
                slices.push(...inWin.slice(0, 40));
            }
        }
        const errLines = logLines.filter((l) => /\s[EF]\s/.test(l)).slice(-60);
        const tail = logLines.slice(-50);
        const timeline = sess.acts.length > 0
            ? sess.acts.map((a) => `${new Date(a.t).toLocaleTimeString('zh-CN', { hour12: false })}  ${a.detail ?? a.action}`)
            : ['（无面板/agent 注入操作——纯物理操作，时间轴以采样帧为准）'];
        return {
            id: sess.id,
            serial: sess.serial,
            durationMs,
            timeline,
            frames,
            frameIssues,
            logSlices: slices.slice(0, 400),
            errorLines: errLines,
            logTail: tail,
            mp4s: sess.segments.map((s) => s.local).filter((x) => x != null),
            errFile: sess.errFile,
        };
    }
    async listAvds() {
        const bin = this.opts.emulatorBin;
        if (bin == null)
            return [];
        const { execFile } = await import('node:child_process');
        return new Promise((resolve) => {
            execFile(bin, ['-list-avds'], { timeout: 5_000 }, (err, stdout) => {
                resolve(err ? [] : String(stdout).split('\n').map((s) => s.trim()).filter((s) => s !== ''));
            });
        });
    }
    /** 启动一台关机的模拟器（面板设备菜单手势）。MVP：等待 boot_completed，最长 120s。 */
    async bootEmulator(avd) {
        const bin = this.opts.emulatorBin;
        if (bin == null)
            throw new Error('未找到 emulator 可执行文件（未设置 ANDROID_SDK 或本机未装模拟器）');
        const proc = spawn(bin, ['-avd', avd, '-no-snapshot-save', '-no-boot-anim'], { stdio: 'ignore', detached: true, windowsHide: true });
        proc.unref();
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            const devices = await this.adb.devices().catch(() => []);
            const emu = devices.find((d) => d.isEmulator && d.state === 'device');
            if (emu != null) {
                const boot = await this.adb.shell(emu.serial, 'getprop sys.boot_completed', { timeoutMs: 5_000 }).catch(() => null);
                if (boot?.stdout.trim() === '1')
                    return { serial: emu.serial, note: `模拟器 ${avd} 已启动` };
            }
            await new Promise((r) => setTimeout(r, 1_500));
        }
        return { note: '模拟器启动超时（120s），请到 Android Studio 查看' };
    }
    async setQuality(patch) {
        for (const serial of new Set([...this.claims.keys(), ...this.busyUntil.keys()]))
            this.assertPanelAvailable(serial);
        if (this.captureStarting || this.captureWrites || this.records.size || this.debugBySerial.size)
            throw Object.assign(new Error('采集或待保存时不能重建画质'), { code: 'capture-busy' });
        const q = this.state.setQuality(patch);
        // 对运行中的流重建（scrcpy 不支持热重配）；停流后等待设备端 MediaCodec 释放（实测竞态教训）
        for (const [serial, stream] of [...this.streams]) {
            const claim = this.claims.get(serial);
            stream.stop();
            this.streams.delete(serial);
            this.modes.delete(serial);
            if (claim != null) {
                void (async () => {
                    await new Promise((r) => setTimeout(r, 1_500));
                    await this.attachForTool(claim.sessionId, serial).catch((e) => this.opts.log(`[${serial}] 画质重建失败: ${String(e).slice(0, 200)}`));
                })();
            }
        }
        return q;
    }
    /** 还原设备原输入法。 */
    restoreIme(serial) {
        const prev = this.prevIme.get(serial);
        if (prev != null) {
            this.prevIme.delete(serial);
            this.adb.shell(serial, `ime set ${prev}`, { timeoutMs: 8_000 }).catch(() => undefined);
            this.opts.log(`[${serial}] IME 还原 → ${prev}`);
        }
    }
    dispose() {
        this.disposed = true;
        void this.muteQueue.then(async () => {
            for (const [serial, previous] of Object.entries(this.state.reload().volumeRestore)) {
                try {
                    await this.adb.runOk(['-s', serial, 'shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', String(previous)], { timeoutMs: 8_000 });
                    const out = await this.adb.runOk(['-s', serial, 'shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--get'], { timeoutMs: 8_000 });
                    if (Number(/volume is (\d+)/i.exec(out)?.[1]) !== previous)
                        throw new Error('媒体音量还原回读失败');
                    this.state.setVolumeRestore(serial);
                }
                catch (e) {
                    this.opts.log('卸载时媒体音量还原失败（' + serial + '）：' + String(e));
                }
            }
        });
        if (this.refreshTimer != null)
            clearInterval(this.refreshTimer);
        for (const st of this.pendingStarts)
            st.stop();
        if (this.secureTimer != null)
            clearInterval(this.secureTimer);
        this.secureStates.clear();
        this.lastMitigate.clear();
        this.rootProbe.clear();
        for (const [serial] of this.prevIme)
            this.restoreIme(serial);
        if (this.reaperTimer != null)
            clearInterval(this.reaperTimer);
        for (const stream of this.streams.values())
            stream.stop();
        // Stop natively, retain pending objects and all device originals; unload never deletes captures.
        for (const [serial, rec] of this.records) {
            rec.status = 'pending-save';
            rec.stoppedAt ??= Date.now();
            try {
                this.persistRecord(serial);
            }
            catch (e) {
                this.opts.log('卸载时录屏清单保存失败：' + String(e));
            }
            if (rec.proc != null)
                void this.stopCaptureProcess(serial, rec.proc).catch(e => this.opts.log('卸载时录屏停止失败：' + String(e)));
        }
        for (const sess of this.debugSessions.values()) {
            if (sess.rotateTimer != null)
                clearInterval(sess.rotateTimer);
            sess.stoppedAt ??= Date.now();
            if (!sess.saved) {
                try {
                    this.persistDebug(sess);
                }
                catch (e) {
                    this.opts.log('卸载时调试清单保存失败：' + String(e));
                }
            }
            for (const proc of [sess.recordProc, sess.logProc])
                if (proc != null)
                    void this.stopCaptureProcess(sess.serial, proc).catch(e => this.opts.log('卸载时调试停止失败：' + String(e)));
            sess.errStream?.end();
        }
        this.streams.clear();
        this.claims.clear();
    }
}
//# sourceMappingURL=pane-service.js.map